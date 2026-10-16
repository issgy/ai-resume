import type { Profile } from "./types";
import { norm } from "./validate";

/** 粘贴导入的字数限制 */
export const IMPORT_MIN = 50;
export const IMPORT_MAX = 8000;

export type ImportedFact = { text: string; source: string };
export type ImportedExperience = { company: string; title: string; start: string; end: string; facts: ImportedFact[] };

/** /api/import 的返回 */
export type ImportResponse = {
  experiences: ImportedExperience[];
  profile: Partial<Profile>;
  /** 行号范围无效的经历段数 + 在原文中找不到对应片段而丢弃的事实条数 */
  rejected: number;
  /** 带项目符号、看起来是经历描述，却没有被归到任何经历的行数；这些行已放入「未归类」 */
  unassigned: number;
};

/** 同一段经历的判定键：company + title，忽略空白和大小写；两者都为空时返回空串（未归类） */
export function experienceKey(e: { company: string; title: string }) {
  const c = e.company.replace(/\s/g, "").toLowerCase();
  const t = e.title.replace(/\s/g, "").toLowerCase();
  return c || t ? `${c}|${t}` : "";
}

/**
 * 行首项目符号 / 序号。「-」「*」必须后跟空白，「1.」后面不能紧跟数字，
 * 以免把「-20%」「1.5 万用户」这类数字开头的内容误当成符号去掉。
 */
export const BULLET_RE =
  /^\s*(?:[-–—*](?=\s)|[•·●○■□▪]|\d{1,2}[.．、)）](?![\d.．])|\d{1,2}[.．](?=(?:19|20)\d{2}\s*年)|[（(]\d{1,2}[)）])\s*/;

/** 常见板块标题（整行只有它），不作为事实 */
const SECTION_LABEL_RE =
  /^[\s#*【\[]*((教育|学习)(经历|背景)?|学历|(工作|实习|实践|校园|科研)(经历|经验)?|(主要)?项目(经历|经验)?|(专业|个人)?技能(特长|清单)?|技术栈|(个人|基本)(信息|资料)|自我评价|荣誉|获奖(情况)?|证书|education|(work |professional )?experience|projects?|skills?)[\]】:：\s]*$/i;

/** 是否为板块标题行（整行只有「技能」「教育经历」之类） */
export function isSectionLabel(line: string): boolean {
  return SECTION_LABEL_RE.test(line);
}

/** 给原文每行加行号，交给模型判断结构；模型只返回行号范围，不复制经历描述 */
export function numberLines(lines: string[]): string {
  return lines.map((l, i) => `[${i + 1}] ${l}`).join("\n");
}

const CJK = "\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
/** 两个中文字符（含中文标点）之间的空白：PDF 两端对齐复制出来的「基 于 LangGraph 编 排」 */
const CJK_SPACE_RE = new RegExp(`(?<=[${CJK}])[ \\t\\u00a0\\u3000]+(?=[${CJK}])`, "g");
/** 短于这个长度、且句末没有标点的行，视为独立的一条，而不是被折行的半句 */
const SHORT_LINE = 20;
/** 中文标点前后的空白（「、 SQL」「执行 ，」） */
const CJK_PUNCT_SPACE_RE = /[ \t\u00a0\u3000]+(?=[，。、；：！？）」』])|(?<=[，。、；：！？（「『])[ \t\u00a0\u3000]+/g;
/** 句子结束的标点：在这里断开成一条事实 */
const SENTENCE_END_RE = /[。；;！!？?]/;
/** 常见的小标题前缀，如「项目简介：」「主要工作：」，单独成行时跳过，和内容写在一行时去掉 */
const LABEL_PREFIX_RE =
  /^(项目(简介|描述|背景|介绍|成果|职责)|主要(工作|职责|贡献|成果)|工作(内容|职责|成果)|核心贡献|个人(职责|贡献)|职责(描述)?|技术栈)\s*[：:]\s*/;

/** 整理一条事实的文字：只去掉多余空白（中文字之间的空格、换行），不改动任何字词 */
export function tidy(s: string): string {
  return s
    .replace(/\s*\n\s*/g, "")
    .replace(CJK_SPACE_RE, "")
    .replace(CJK_PUNCT_SPACE_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 拼接两行：英文、数字直接相连时补一个空格，其余（中文折行）直接接上 */
function joinLines(a: string, b: string): string {
  if (!a) return b;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b;
}

/**
 * 把一段经历的描述行整理成事实（以句子为单位，而不是以行为单位）：
 * - PDF 复制会在句子中间折行、甚至夹空行，所以忽略换行和空行，把行拼回整句；
 * - 遇到句号、分号等句末标点，或新的一行以项目符号/序号开头时，断开成一条；
 * - 以冒号结尾的短行是小标题（「主要工作：」），跳过；「项目简介：…」这类前缀去掉；
 * - 去掉中文字之间多余的空格。
 * 返回整理后的文字；调用方再用 literalSpan 回到原文核对并保存原文片段。
 */
export function linesToSentences(lines: string[], skip: (line: string) => boolean = () => false): string[] {
  const out: string[] = [];
  let buf = "";
  const emit = (s: string) => {
    const t = tidy(s).replace(LABEL_PREFIX_RE, "").replace(/^[，,、\s]+/, "").trim();
    if (t.replace(/[\s\p{P}\p{S}]/gu, "").length >= 4) out.push(t);
  };
  const flush = () => {
    emit(buf);
    buf = "";
  };
  /** 上一行（整理后）的长度和结尾；用来判断它是排版折行，还是一条独立的短句 */
  let prevLen = 0;
  let prevEnd = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue; // 空行可能只是 PDF 折行，不当作句子结束
    if (SECTION_LABEL_RE.test(line) || skip(raw)) {
      flush();
      continue;
    }
    const bullet = BULLET_RE.test(line);
    let body = bullet ? line.replace(BULLET_RE, "") : line;
    if (bullet) flush();
    // 只有小标题的行：「主要工作：」「核心贡献：」
    if (/[：:]$/.test(body) && tidy(body).length <= 12) {
      flush();
      continue;
    }
    body = tidy(body);
    // 折行通常发生在排满的长行末尾；上一行很短、又不是以「，、」这类话没说完的标点结尾时，
    // 它是一条独立的短句（如「负责商家后台前端开发」「带教实习生」），不和下一行拼在一起
    if (buf && !bullet && prevLen < SHORT_LINE && !/[，,、：:（(]$/.test(prevEnd)) flush();
    buf = joinLines(buf, body);
    prevLen = body.length;
    prevEnd = body.slice(-1);
    // 句末标点处断开，剩下的半句留到下一行继续拼
    let at: number;
    while ((at = buf.search(SENTENCE_END_RE)) >= 0) {
      emit(buf.slice(0, at + 1));
      buf = buf.slice(at + 1);
    }
  }
  flush();
  return out;
}

/**
 * 这一行是否只由某段经历的公司、岗位、起止时间组成（即经历标题行），这类行不作为事实。
 * metas 是各段经历的 [公司, 岗位, 开始, 结束]。
 */
export function isMetaLine(line: string, metas: string[][]): boolean {
  const n = norm(line.replace(BULLET_RE, "")).replace(/[|｜/\-–—~～至到]/g, "");
  if (!n) return true;
  return metas.some((meta) => {
    let rest = n;
    let hit = false;
    for (const m of meta) {
      const k = norm(m).replace(/[|｜/\-–—~～至到]/g, "");
      if (k && rest.includes(k)) {
        rest = rest.replace(k, "");
        hit = true;
      }
    }
    return hit && rest.replace(/至今|现在|今/g, "").length <= 1;
  });
}

/**
 * 在原文中找到与 s 对应的连续片段（比较时忽略空白和标点，和 sourceInUserText 一致），返回原文里那一段的原样文字；
 * 找不到时返回空串。保证入库的永远是用户原文，而不是模型去掉标点后的版本。
 */
export function literalSpan(s: string, original: string): string {
  if (!s) return "";
  if (original.includes(s)) return s;
  const target = norm(s);
  if (!target) return "";
  // 原文逐字符做同样的规范化，并记录每个保留字符在原文中的位置
  let normalized = "";
  const pos: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = norm(original[i]);
    if (ch) {
      normalized += ch;
      pos.push(i);
    }
  }
  const at = normalized.indexOf(target);
  if (at < 0) return "";
  return original.slice(pos[at], pos[at + target.length - 1] + 1).trim();
}

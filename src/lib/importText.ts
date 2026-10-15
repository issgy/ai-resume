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
  /** 模型给出的行号范围无效、无法定位到原文的经历段数 */
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
export const BULLET_RE = /^\s*(?:[-–—*](?=\s)|[•·●○■□▪]|\d{1,2}[.、)）](?![\d.])|[（(]\d{1,2}[)）])\s*/;

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

/**
 * 把一行描述拆成若干条事实：去掉行首项目符号后按句号、分号切开。
 * 每条都是原文的连续片段，逐字保存，不做任何改写。
 */
export function lineToFacts(line: string): string[] {
  if (SECTION_LABEL_RE.test(line)) return [];
  return line
    .replace(BULLET_RE, "")
    .split(/(?<=[。；;！!？?])/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/[\s\p{P}\p{S}]/gu, "").length >= 4);
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

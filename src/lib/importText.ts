import type { Profile } from "./types";

/** 粘贴导入的字数限制 */
export const IMPORT_MIN = 50;
export const IMPORT_MAX = 8000;
/** 超过这个长度就切块并行解析，保证在路由 maxDuration 内完成 */
const SPLIT_OVER = 600;
/** 每块的目标长度：输出要逐字复制原文，块越小单次调用越快 */
const CHUNK_TARGET = 500;

export type ImportedFact = { text: string; source: string };
export type ImportedExperience = { company: string; title: string; start: string; end: string; facts: ImportedFact[] };

/** /api/import 的返回 */
export type ImportResponse = {
  experiences: ImportedExperience[];
  profile: Partial<Profile>;
  /** 在原文中找不到依据而丢弃的事实条数 */
  rejected: number;
  /** 解析失败的块数（其余块的结果照常返回） */
  failedChunks: number;
  totalChunks: number;
};

/** 同一段经历的判定键：company + title，忽略空白和大小写；两者都为空时返回空串，表示不参与合并 */
export function experienceKey(e: { company: string; title: string }) {
  const c = e.company.replace(/\s/g, "").toLowerCase();
  const t = e.title.replace(/\s/g, "").toLowerCase();
  return c || t ? `${c}|${t}` : "";
}

/** 学历关键词：本行带这些词的年份行属于教育经历，不算工作/项目经历标题 */
const EDUCATION_RE = /教育|学历|本科|硕士|研究生|博士|专科|大专|毕业|学士|MBA/i;

/** 像经历标题的行：含年份起止，如「2022.03 - 2024.06」「2021年7月至今」 */
export const HEADER_RE = /(19|20)\d{2}\s*[./\-年]?\s*\d{0,2}\s*月?\s*[-–—~～至到]+\s*((19|20)\d{2}|至今|今|现在)/;

/**
 * 行首项目符号 / 序号。「-」「*」必须后跟空白，「1.」后面不能紧跟数字，
 * 以免把「-20%」「1.5 万用户」这类数字开头的内容误当成符号去掉。
 */
export const BULLET_RE = /^\s*(?:[-–—*](?=\s)|[•·●○■□▪]|\d{1,2}[.、)）](?![\d.])|[（(]\d{1,2}[)）])\s*/;

/** 板块标题行，如「教育经历」「工作经历」「【项目经验】」 */
const SECTION_RE = /^[\s#*【\[]*([\u4e00-\u9fa5A-Za-z ]{2,12})[\]】:：\s]*$/;
/** 只认常见的板块名，避免把单独一行的学校名、公司名、人名当成板块标题 */
const SECTION_NAME_RE =
  /^((教育|学习)(经历|背景|情况)?|学历|(工作|实习|实践|社会实践|校园|科研)(经历|经验)|(主要)?项目(经历|经验)|(专业|个人)?技能(特长|清单)?|技术栈|(个人|基本)(信息|资料)|自我评价|个人(简介|总结|优势)|荣誉(奖项)?|获奖(情况|经历)?|(资格)?证书|培训经历|语言能力|兴趣爱好|求职意向|其他|education|(work |professional )?experience|projects?|skills?)$/i;
const EDU_SECTION_RE = /^((教育|学习)(经历|背景|情况)?|学历|education)$/i;

/**
 * 标出每行是否为工作/项目经历标题：含年份起止、本行不含学历关键词，且不在「教育经历」板块里
 * （常见排版是「教育经历」单独一行，下一行才是日期）。
 */
function isSectionLabel(line: string): boolean {
  const m = line.trim().match(SECTION_RE);
  return !!m && SECTION_NAME_RE.test(m[1].trim()) && !HEADER_RE.test(line);
}

function markHeaders(lines: string[]): boolean[] {
  let inEducation = false;
  return lines.map((line) => {
    const section = line.trim().match(SECTION_RE);
    if (section && SECTION_NAME_RE.test(section[1].trim()) && !HEADER_RE.test(line)) {
      inEducation = EDU_SECTION_RE.test(section[1].trim());
      return false;
    }
    return HEADER_RE.test(line) && !inEducation && !EDUCATION_RE.test(line);
  });
}

/** 文本里工作/项目经历标题的行数，用于检查模型是否漏掉了整段经历 */
export function countHeaders(text: string): number {
  return markHeaders(text.split(/\r?\n/)).filter(Boolean).length;
}

/** 一块待解析的原文，以及这块里应当解析出的经历段数 */
export type ResumeChunk = { text: string; expected: number };

/** 超长的一行按句号等切开，仍超长的按长度硬切（例如整篇没有换行的粘贴） */
function splitLine(line: string): string[] {
  if (line.length <= CHUNK_TARGET) return [line];
  return line
    .split(/(?<=[。；;！!？?])/)
    .flatMap((s) => (s.length <= CHUNK_TARGET ? [s] : (s.match(new RegExp(`[\\s\\S]{1,${CHUNK_TARGET}}`, "g")) ?? [])));
}

/**
 * 把原文切成若干块并行解析：每段工作/项目经历（以经历标题开头的段落）单独成块，一次只让模型处理一段经历，避免整段被漏掉；
 * 其他段落（个人信息、板块标题等）按目标长度装块。单段过长时硬切，后续每块都带上这段的标题行。
 */
export function splitResume(text: string): ResumeChunk[] {
  const lines = text.split(/\r?\n/);
  const isHeader = markHeaders(lines);
  const total = isHeader.filter(Boolean).length;
  if (text.length <= SPLIT_OVER && total <= 1) return [{ text, expected: total }];

  /** h：经历标题行；c：硬切后的续块里复制的标题行（续块至少应解析出一段经历） */
  type Line = { s: string; h: boolean; c?: boolean };
  const blocks: Line[][] = [];
  let cur: Line[] = [];
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
  };
  lines.forEach((s, i) => {
    if (!s.trim()) return flush();
    if (isHeader[i] && cur.length) {
      // 「公司 / 岗位 / 日期」分行写时，日期前紧挨着的短行（公司、岗位）属于这段经历，一起带走
      const carry: Line[] = [];
      while (carry.length < 2 && cur.length > 0) {
        const prev = cur[cur.length - 1];
        if (prev.h || prev.s.trim().length > 30 || BULLET_RE.test(prev.s) || isSectionLabel(prev.s)) break;
        carry.unshift(cur.pop()!);
      }
      flush();
      cur.push(...carry);
    }
    cur.push({ s, h: isHeader[i] });
  });
  flush();

  const chunks: ResumeChunk[] = [];
  let buf: Line[] = [];
  const size = (b: Line[]) => b.reduce((n, l) => n + l.s.length + 1, 0);
  const emit = () => {
    const t = buf.map((l) => l.s).join("\n").trim();
    const headers = buf.filter((l) => l.h).length;
    const continuation = buf.some((l) => l.c) && buf.length > 1;
    if (t) chunks.push({ text: t, expected: Math.max(headers, continuation ? 1 : 0) });
    buf = [];
  };
  for (const block of blocks) {
    if (size(block) <= CHUNK_TARGET) {
      if (buf.length && (block.some((l) => l.h) || size(buf) + size(block) > CHUNK_TARGET)) emit();
      buf.push(...block);
      continue;
    }
    emit();
    // 标题部分：到经历标题行为止的前几行（可能是「公司 / 岗位 / 日期」分行），续块都带上
    const hIdx = block.findIndex((l) => l.h);
    const header = hIdx >= 0 && hIdx <= 2 ? block.slice(0, hIdx + 1).map((l) => l.s).join("\n") : "";
    const pieces = block.flatMap((l) => splitLine(l.s).map((s, j) => ({ s, h: l.h && j === 0 })));
    for (const piece of pieces) {
      if (buf.length && size(buf) + piece.s.length + 1 > CHUNK_TARGET) {
        emit();
        // 复制过来的标题行只为提供上下文，不重复计入应解析的经历段数
        if (header && header.length < CHUNK_TARGET) buf.push({ s: header, h: false, c: true });
      }
      buf.push(piece);
    }
  }
  emit();
  return chunks;
}

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
const EDU_SECTION_RE = /^(教育|学历|学习)/;

/**
 * 标出每行是否为工作/项目经历标题：含年份起止、本行不含学历关键词，且不在「教育经历」板块里
 * （常见排版是「教育经历」单独一行，下一行才是日期）。
 */
function markHeaders(lines: string[]): boolean[] {
  let inEducation = false;
  return lines.map((line) => {
    const section = line.trim().match(SECTION_RE);
    if (section && !HEADER_RE.test(line)) {
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

  type Line = { s: string; h: boolean };
  const blocks: Line[][] = [];
  let cur: Line[] = [];
  const flush = () => {
    if (cur.length) blocks.push(cur);
    cur = [];
  };
  lines.forEach((s, i) => {
    if (!s.trim()) return flush();
    if (isHeader[i] && cur.length) flush();
    cur.push({ s, h: isHeader[i] });
  });
  flush();

  const chunks: ResumeChunk[] = [];
  let buf: Line[] = [];
  const size = (b: Line[]) => b.reduce((n, l) => n + l.s.length + 1, 0);
  const emit = () => {
    const t = buf.map((l) => l.s).join("\n").trim();
    if (t) chunks.push({ text: t, expected: buf.filter((l) => l.h).length });
    buf = [];
  };
  for (const block of blocks) {
    if (size(block) <= CHUNK_TARGET) {
      if (buf.length && (block[0].h || size(buf) + size(block) > CHUNK_TARGET)) emit();
      buf.push(...block);
      continue;
    }
    emit();
    const header = block[0].h ? block[0].s : "";
    const pieces = block.flatMap((l) => splitLine(l.s).map((s, j) => ({ s, h: l.h && j === 0 })));
    for (const piece of pieces) {
      if (buf.length && size(buf) + piece.s.length + 1 > CHUNK_TARGET) {
        emit();
        // 复制过来的标题行只为提供上下文，不重复计入应解析的经历段数
        if (header && header.length < CHUNK_TARGET) buf.push({ s: header, h: false });
      }
      buf.push(piece);
    }
  }
  emit();
  return chunks;
}

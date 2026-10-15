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

/** 像经历标题的行：含年份起止，如「2022.03 - 2024.06」「2021年7月至今」 */
const EDUCATION_RE = /教育|学历|本科|硕士|研究生|博士|专科|大专|毕业|学士|MBA/i;

export const HEADER_RE = /(19|20)\d{2}\s*[./\-年]?\s*\d{0,2}\s*月?\s*[-–—~～至到]+\s*((19|20)\d{2}|至今|今|现在)/;

/**
 * 把较长的原文切成若干块：先按空行分段，没有空行时在「像经历标题」的行前分段，
 * 再把相邻段落装进不超过目标长度的块；单段过长时按行硬切。短文本原样作为一块。
 */
export function splitResume(text: string): string[] {
  if (text.length <= SPLIT_OVER && countHeaders(text) <= 1) return [text];
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const b = cur.join("\n").trim();
    if (b) blocks.push(b);
    cur = [];
  };
  for (const line of lines) {
    if (!line.trim()) flush();
    else {
      if (HEADER_RE.test(line) && cur.length > 0) flush();
      cur.push(line);
    }
  }
  flush();

  const chunks: string[] = [];
  let buf = "";
  const push = (piece: string) => {
    // 每段经历（以经历标题开头的段落）单独成块：一次只让模型处理一段经历，避免整段被漏掉
    const startsExperience = HEADER_RE.test(piece.split("\n")[0]);
    if (buf && (startsExperience || buf.length + piece.length + 1 > CHUNK_TARGET)) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${piece}` : piece;
  };
  for (const block of blocks) {
    if (block.length <= CHUNK_TARGET) {
      push(block);
      continue;
    }
    // 单段经历过长被硬切时，后续每块都带上这段的标题行，否则模型不知道这些事实属于哪段经历
    const [head, ...rest] = block.split("\n");
    const header = HEADER_RE.test(head) ? head : "";
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
    buf = head;
    for (const line of rest) {
      for (const s of line.length <= CHUNK_TARGET ? [line] : line.split(/(?<=[。；;！!？?])/)) {
        if (buf.length + s.length + 1 > CHUNK_TARGET) {
          chunks.push(buf);
          buf = header;
        }
        buf = buf ? `${buf}\n${s}` : s;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 文本里像经历标题的行数（含年份起止的行），用于检查模型是否漏掉了整段经历 */
export function countHeaders(text: string): number {
  // 教育经历也带年份，但不会产出事实，不计入
  return text.split(/\r?\n/).filter((l) => HEADER_RE.test(l) && !EDUCATION_RE.test(l)).length;
}

import type { Profile } from "./types";

/** 粘贴导入的字数限制 */
export const IMPORT_MIN = 50;
export const IMPORT_MAX = 8000;
/** 超过这个长度就切块并行解析，保证在路由 maxDuration 内完成 */
const SPLIT_OVER = 2500;
/** 每块的目标长度：输出要逐字复制原文，块越小单次调用越快 */
const CHUNK_TARGET = 1500;

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
const HEADER_RE = /(19|20)\d{2}\s*[./\-年]?\s*\d{0,2}\s*月?\s*[-–—~～至到]+\s*((19|20)\d{2}|至今|今|现在)/;

/**
 * 把较长的原文切成若干块：先按空行分段，没有空行时在「像经历标题」的行前分段，
 * 再把相邻段落装进不超过目标长度的块；单段过长时按行硬切。短文本原样作为一块。
 */
export function splitResume(text: string): string[] {
  if (text.length <= SPLIT_OVER) return [text];
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
    if (buf && buf.length + piece.length + 1 > CHUNK_TARGET) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${piece}` : piece;
  };
  for (const block of blocks) {
    if (block.length <= CHUNK_TARGET) push(block);
    else for (const line of block.split("\n")) for (const s of line.length <= CHUNK_TARGET ? [line] : line.split(/(?<=[。；;！!？?])/)) push(s);
  }
  if (buf) chunks.push(buf);
  return chunks;
}

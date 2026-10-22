import { callLLMJson } from "./llm";
import { VERIFIER } from "./prompts";
import { isInstructionFact, parseVerifyResults } from "./validate";
import type { VerifyVerdict } from "./validate";
import type { Fact } from "./types";

/**
 * 调用核验模型（03-M5）检查一组句子能否在给定事实的原话中找到依据。简历句和面试参考回答共用这一个核验口径（R13）。
 * 调用失败或结论结构不可信时返回 null，由调用方按技术错误处理。
 */
export async function callVerifier(facts: Fact[], sentences: { text: string; factIds: string[] }[]): Promise<Map<number, VerifyVerdict> | null> {
  if (sentences.length === 0) return new Map();
  const payload = {
    facts: facts.map((f) => ({ id: f.id, source: f.source, text: f.text, ...(isInstructionFact(f) ? { isInstruction: true } : {}) })),
    sentences: sentences.map((s, index) => ({ index, text: s.text, factIds: s.factIds })),
  };
  try {
    const data = await callLLMJson<unknown>([
      { role: "system", content: VERIFIER },
      { role: "user", content: JSON.stringify(payload) },
    ]);
    return parseVerifyResults(typeof data === "object" && data !== null ? (data as { results?: unknown }).results : undefined, sentences.length);
  } catch {
    return null;
  }
}

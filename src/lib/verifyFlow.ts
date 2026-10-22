import { failVerification, fallbackText, ruleIssues, tidyBullet, verdictPasses } from "./validate";
import type { VerifyVerdict } from "./validate";
import type { Experience, Fact, Highlight } from "./types";

/** 核验函数：给定事实和句子，返回逐句结论；调用失败或结构不可信时返回 null */
export type Verifier = (facts: Fact[], sentences: { text: string; factIds: string[] }[]) => Promise<Map<number, VerifyVerdict> | null>;

const quote = (claims: string[]) => claims.map((c) => `「${c}」`).join("");

const TECH_NOTE = "核验请求出错或没有返回结论，这句暂未核验，不会导出；可以点「重试这段」";

/** 一轮核验的结论分类：技术错误 / 明确矛盾 / 通过 / 有无依据说法 */
type Outcome = { kind: "technical" } | { kind: "conflict"; v: VerifyVerdict } | { kind: "pass"; v: VerifyVerdict } | { kind: "unsupported"; v: VerifyVerdict; claims: string[] };

function classify(v: VerifyVerdict | undefined, text: string, facts: Experience["facts"]): Outcome {
  if (!v) return { kind: "technical" };
  if (v.issue === "source_conflict" || v.checks.some((c) => c.conflict)) return { kind: "conflict", v };
  const modelClaims = v.checks.filter((c) => !c.supported).map((c) => c.claim);
  // 规则发现的数字/英文名词已包含在模型指出的说法里时不重复列出
  const claims = [...new Set([...modelClaims, ...ruleIssues(text, facts).filter((t) => !modelClaims.some((c) => c.includes(t)))])];
  if (verdictPasses(v) && claims.length === 0) return { kind: "pass", v };
  return { kind: "unsupported", v, claims };
}

function conflictNote(v: VerifyVerdict): string {
  const conflicts = v.checks.filter((c) => c.conflict);
  return `与你的原话存在矛盾${conflicts.length ? `：${quote(conflicts.map((c) => c.claim))}` : ""}${conflicts[0]?.reason ? `（${conflicts[0].reason}）` : ""}，请到履历库核对来源`;
}

/**
 * 一段经历的逐句核验，最多三轮调用：
 * 第 1 轮核验候选句；部分无依据的，第 2 轮核验模型给出的缩小句（给不出缩小句的直接核验退回的原话）；
 * 缩小句仍无依据的，第 3 轮核验退回的原话。退回的原话也必须通过核验（确认是候选人的行为描述、不是资料指令）才可导出。
 * 每一轮：技术错误 → pending；明确矛盾 → blocked；退回原话仍无依据 → blocked。
 */
export async function verifyExperience(exp: Experience, items: Highlight[], callVerifier: Verifier): Promise<Highlight[]> {
  const out = new Map<number, Highlight>();
  items.forEach((h, i) => {
    if (h.exportStatus === "blocked") out.set(i, h);
  });
  const todo = items.map((h, i) => ({ h, i })).filter(({ h }) => h.exportStatus !== "blocked");
  const result = () => items.map((h, i) => out.get(i) ?? h);
  if (todo.length === 0) return result();

  const factsOf = (h: Highlight) => exp.facts.filter((f) => h.factIds.includes(f.id));
  // 只把所引事实交给核验模型：结论只针对这句引用的来源，跨阶段沿用同一组事实 id
  const cited = exp.facts.filter((f) => todo.some(({ h }) => h.factIds.includes(f.id)));
  const pending = (h: Highlight): Highlight => ({ ...h, exportStatus: "pending", issueType: "technical_error", note: TECH_NOTE });
  const blockedFallback = (h: Highlight, claims: string[]): Highlight => ({
    ...h,
    exportStatus: "blocked",
    issueType: "unsupported_assertion",
    note: `${quote(claims)}在你的原话中找不到依据，且所引原话无法直接作为简历句（可能是资料备注或写给 AI 的要求），不会导出；请到履历库核对`,
  });

  const round1 = await callVerifier(cited, todo.map(({ h }) => h));
  if (!round1) {
    failVerification(todo.map(({ h }) => h)).forEach((h, k) => out.set(todo[k].i, h));
    return result();
  }

  type Next = { i: number; h: Highlight; text: string; mode: "revise" | "fallback"; claims: string[]; checks: VerifyVerdict["checks"] };
  const round2: Next[] = [];
  todo.forEach(({ h, i }, k) => {
    const o = classify(round1.get(k), h.text, factsOf(h));
    if (o.kind === "technical") return out.set(i, pending(h));
    if (o.kind === "conflict") return out.set(i, { ...h, exportStatus: "blocked", issueType: "source_conflict", assertionChecks: o.v.checks, note: conflictNote(o.v) });
    if (o.kind === "pass") return out.set(i, { ...h, exportStatus: "ready", issueType: null, assertionChecks: o.v.checks });
    // 部分无依据：先缩小句子再重验（02 ResumeBullet.assertion_checks）；给不出可用缩小句时直接核验退回的原话
    const facts = factsOf(h);
    const tidied = tidyBullet(o.v.revised);
    const revised = tidied && tidied !== h.text && ruleIssues(tidied, facts).length === 0 ? tidied : "";
    if (revised) return round2.push({ i, h, text: revised, mode: "revise", claims: o.claims, checks: o.v.checks });
    const fb = fallbackText(facts);
    if (!fb) return out.set(i, blockedFallback(h, o.claims));
    round2.push({ i, h, text: fb, mode: "fallback", claims: o.claims, checks: o.v.checks });
  });

  const settle = async (batch: Next[]): Promise<Next[]> => {
    if (batch.length === 0) return [];
    const verdicts = await callVerifier(cited, batch.map((n) => ({ text: n.text, factIds: n.h.factIds })));
    const again: Next[] = [];
    batch.forEach((n, j) => {
      const o = classify(verdicts?.get(j), n.text, factsOf(n.h));
      if (o.kind === "technical") return out.set(n.i, pending(n.h));
      if (o.kind === "conflict") return out.set(n.i, { ...n.h, exportStatus: "blocked", issueType: "source_conflict", assertionChecks: o.v.checks, note: conflictNote(o.v) });
      if (o.kind === "pass") {
        return out.set(n.i, {
          ...n.h,
          text: n.text,
          originalText: n.h.text,
          exportStatus: "ready",
          issueType: null,
          assertionChecks: n.checks,
          note: n.mode === "revise" ? `已删去原话中找不到依据的说法：${quote(n.claims)}` : `已退回你的原话（删去了${quote(n.claims)}）`,
        });
      }
      // 缩小句仍无依据 → 下一轮核验退回的原话；退回的原话仍无依据 → blocked
      if (n.mode === "revise") {
        const fb = fallbackText(factsOf(n.h));
        if (fb) return again.push({ ...n, text: fb, mode: "fallback" });
      }
      out.set(n.i, blockedFallback(n.h, n.claims));
    });
    return again;
  };

  const round3 = await settle(round2);
  await settle(round3);
  return result();
}

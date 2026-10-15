import type { Experience, Fact, Highlight, DroppedHighlight, QA } from "./types";

const NUM_RE = /\d+(?:\.\d+)?/g;
/** 英文技术名、产品名、缩写（React、Redis、GMV 等），用来发现参考回答里凭空出现的专有名词 */
const TERM_RE = /[A-Za-z][A-Za-z0-9.+#-]*[A-Za-z0-9+#]/g;

/** 归一化：去空白和常见标点，便于做"是否逐字出现"的比较 */
function norm(s: string) {
  return s.replace(/[\s，。、,.;；:：！!？?“”"'‘’（）()]/g, "");
}

/** source 是否确实出自用户发言（允许模型少量改动标点空格） */
export function sourceInUserText(source: string, userText: string) {
  const s = norm(source);
  return s.length > 0 && norm(userText).includes(s);
}

/**
 * 校验亮点：必须引用本段经历下存在的事实；亮点里的每个数字都要出现在所引事实（含原话）中。
 * 不通过的亮点被剔除并记录原因。
 */
export function checkHighlights(raw: Highlight[], experiences: Experience[]) {
  const kept: Highlight[] = [];
  const dropped: DroppedHighlight[] = [];

  for (const h of raw) {
    // 模型偶尔会写错 experienceId，此时按所引用事实反推归属经历
    const exp =
      experiences.find((e) => e.id === h.experienceId) ??
      experiences.find((e) => e.facts.some((f) => (h.factIds ?? []).includes(f.id)));
    if (!exp) {
      dropped.push({ text: h.text, reason: "未关联到任何经历" });
      continue;
    }
    const facts = exp.facts.filter((f) => (h.factIds ?? []).includes(f.id));
    if (facts.length === 0) {
      dropped.push({ text: h.text, reason: "没有引用任何事实，无法溯源" });
      continue;
    }
    const evidence = facts.map((f) => `${f.text} ${f.source}`).join(" ");
    const evidenceNums = new Set(evidence.match(NUM_RE) ?? []);
    const unknown = (h.text.match(NUM_RE) ?? []).filter((n) => !evidenceNums.has(n));
    if (unknown.length > 0) {
      dropped.push({ text: h.text, reason: `数字 ${unknown.join("、")} 在你的原始描述中找不到` });
      continue;
    }
    const questions = (h.questions ?? []).map((qa) => checkAnswer(qa, exp.facts, facts));
    kept.push({ ...h, experienceId: exp.id, factIds: facts.map((f) => f.id), questions });
  }
  return { kept, dropped };
}

export const INSUFFICIENT_PREFIX = "（素材不足";

/**
 * 校验面试参考回答：回答里的数字和英文专有名词必须出现在所引事实（含原话）中。
 * 回答未单独引用事实时，以所属亮点引用的事实为依据。不通过的回答替换为补充提示，不展示编造内容。
 */
export function checkAnswer(qa: QA, expFacts: Fact[], highlightFacts: Fact[]): QA {
  const a = (qa.a ?? "").trim();
  if (a.startsWith(INSUFFICIENT_PREFIX)) return { ...qa, a, insufficient: true };

  const cited = expFacts.filter((f) => (qa.factIds ?? []).includes(f.id));
  const facts = cited.length > 0 ? cited : highlightFacts;
  const evidence = facts.map((f) => `${f.text} ${f.source}`).join(" ");
  const nums = new Set(evidence.match(NUM_RE) ?? []);
  const terms = new Set((evidence.match(TERM_RE) ?? []).map((t) => t.toLowerCase()));

  const unknownNums = (a.match(NUM_RE) ?? []).filter((n) => !nums.has(n));
  const unknownTerms = (a.match(TERM_RE) ?? []).filter((t) => !terms.has(t.toLowerCase()));
  if (unknownNums.length === 0 && unknownTerms.length === 0 && a) {
    return { ...qa, a, factIds: facts.map((f) => f.id) };
  }
  const missing = [...unknownNums, ...unknownTerms];
  return {
    ...qa,
    a: `${INSUFFICIENT_PREFIX}，建议面试前补充：结合你的真实经历准备这道题的具体做法和结果${
      missing.length ? `（AI 草稿里出现了你没提过的「${[...new Set(missing)].slice(0, 3).join("、")}」，已隐藏）` : ""
    }）`,
    factIds: facts.map((f) => f.id),
    insufficient: true,
  };
}

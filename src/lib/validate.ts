import type { Experience, Highlight, DroppedHighlight } from "./types";

const NUM_RE = /\d+(?:\.\d+)?/g;

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
    const exp = experiences.find((e) => e.id === h.experienceId);
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
    kept.push({ ...h, factIds: facts.map((f) => f.id), questions: h.questions ?? [] });
  }
  return { kept, dropped };
}

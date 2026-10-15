import type { Experience, Fact, Highlight, DroppedHighlight, QA, ResumeResult } from "./types";

const NUM_RE = /\d+(?:\.\d+)?/g;
/** 英文技术名、产品名、缩写（React、Redis、GMV 等），用来发现参考回答里凭空出现的专有名词 */
export const TERM_RE =/[A-Za-z][A-Za-z0-9.+#-]*[A-Za-z0-9+#]/g;

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
 * 校验亮点（规则部分）：必须引用本段经历下存在的事实；亮点里的每个数字和英文专有名词都要出现在所引事实（含原话）中；
 * 每个面试追问都要能基于原始描述给出可信回答。不通过的亮点被剔除并记录原因。
 * 技能、职责、效果等中文说法由 /api/verify 的大模型核验把关；/api/resume 只写亮点、不带问答，
 * 问答在核验通过后由 /api/qa 生成并经 applyQA 用同一套 checkAnswer / indefensibleReason 校验。
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
      dropped.push({ text: h.text, reason: "没有引用任何事实，无法溯源", experienceId: exp.id, factIds: [] });
      continue;
    }
    const evidence = facts.map((f) => `${f.text} ${f.source}`).join(" ");
    const evidenceNums = new Set(evidence.match(NUM_RE) ?? []);
    const unknown = (h.text.match(NUM_RE) ?? []).filter((n) => !evidenceNums.has(n));
    const factIds = facts.map((f) => f.id);
    if (unknown.length > 0) {
      dropped.push({ text: h.text, reason: `数字 ${unknown.join("、")} 在你的原始描述中找不到`, experienceId: exp.id, factIds });
      continue;
    }
    // 英文技术名、工具名、缩写同样不能凭空出现（如事实没提 SQL，亮点就不能写 SQL）
    const evidenceTerms = new Set((evidence.match(TERM_RE) ?? []).map((t) => t.toLowerCase()));
    const unknownTerms = [...new Set((h.text.match(TERM_RE) ?? []).filter((t) => !evidenceTerms.has(t.toLowerCase())))];
    if (unknownTerms.length > 0) {
      dropped.push({ text: h.text, reason: `「${unknownTerms.join("、")}」在你的原始描述中找不到`, experienceId: exp.id, factIds });
      continue;
    }
    const questions = (h.questions ?? []).map((qa) => checkAnswer(qa, exp.facts, facts));
    const reason = indefensibleReason(questions);
    if (reason) {
      dropped.push({ text: h.text, reason, experienceId: exp.id, factIds });
      continue;
    }
    const sources = Object.fromEntries(facts.map((f) => [f.id, f.source]));
    kept.push({ ...h, experienceId: exp.id, factIds, questions, sources });
  }
  return { kept, dropped };
}

export const VERIFY_FAILED = "内容核验服务出错或超时，未能确认这条亮点有据可查，请稍后重新生成";
export const VERIFY_MISSING = "内容核验没有返回这条亮点的结论，请重新生成";

/**
 * 大模型返回的 results 只经过 JSON 解析，没有任何结构保证，这里严格校验后才采信：
 * results 不是数组，或任一条目不是对象、index 不是 [0, count) 内的整数、index 重复，
 * 说明结论与亮点的对应关系不可信，返回 null，整批按核验失败处理。
 */
function indexVerifyResults(results: unknown, count: number): Map<number, unknown> | null {
  if (!Array.isArray(results)) return null;
  const byIndex = new Map<number, unknown>();
  for (const r of results) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
    const { index, unsupported } = r as { index?: unknown; unsupported?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) return null;
    if (byIndex.has(index)) return null;
    byIndex.set(index, unsupported);
  }
  return byIndex;
}

/** unsupported 必须存在且是由非空字符串组成的数组（全部有依据时为空数组），否则返回 null 表示结论无效 */
function parseUnsupported(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((s) => typeof s === "string" && s.trim().length > 0)) return null;
  return (value as string[]).map((s) => s.trim());
}

/**
 * 按大模型核验结论筛选亮点（items 与 results 用下标对应）：
 * 核验明确指出无依据说法时剔除并写出这些说法；某条没有拿到结论或结论格式不对时按核验失败剔除，
 * 整体结构不可信时整批剔除，不放行未核验的内容。
 */
export function applyVerification(items: Highlight[], results: unknown) {
  const byIndex = indexVerifyResults(results, items.length);
  if (!byIndex) return { kept: [] as Highlight[], dropped: failVerification(items) };

  const kept: Highlight[] = [];
  const dropped: DroppedHighlight[] = [];
  items.forEach((h, i) => {
    const base = { text: h.text, experienceId: h.experienceId, factIds: h.factIds };
    if (!byIndex.has(i)) {
      dropped.push({ ...base, reason: VERIFY_MISSING });
      return;
    }
    const unsupported = parseUnsupported(byIndex.get(i));
    if (!unsupported) {
      dropped.push({ ...base, reason: VERIFY_FAILED });
      return;
    }
    if (unsupported.length > 0) {
      dropped.push({ ...base, reason: `${[...new Set(unsupported)].map((s) => `「${s}」`).join("")}在你的原始描述中找不到依据` });
      return;
    }
    kept.push(h);
  });
  return { kept, dropped };
}

/** 核验服务整体出错时，这批亮点全部剔除 */
export function failVerification(items: Highlight[]): DroppedHighlight[] {
  return items.map((h) => ({ text: h.text, reason: VERIFY_FAILED, experienceId: h.experienceId, factIds: h.factIds }));
}

export const QA_FAILED = "面试追问生成服务出错或超时，未能确认这条亮点经得起追问，请稍后重新生成";
export const QA_MISSING = "没有拿到这条亮点的面试追问与参考回答，请重新生成";

/** 问答服务整体出错时，这批亮点全部剔除（与核验失败一致，fail-closed） */
export function failQA(items: Highlight[]): DroppedHighlight[] {
  return items.map((h) => ({ text: h.text, reason: QA_FAILED, experienceId: h.experienceId, factIds: h.factIds }));
}

/**
 * 给已核验的亮点挂上面试问答：raw 是模型返回的 questions，只经过 JSON 解析，没有结构保证。
 * 只采信 q、a 都是非空字符串的条目；一条有效问答都没有时按「没拿到问答」剔除。
 * 每个参考回答按 checkAnswer 校验，任一回答不可信的亮点按 indefensibleReason 剔除（GAPS#1）。
 */
export function applyQA(h: Highlight, raw: unknown, experiences: Experience[]): { kept?: Highlight; dropped?: DroppedHighlight } {
  const base = { text: h.text, experienceId: h.experienceId, factIds: h.factIds };
  const exp = experiences.find((e) => e.id === h.experienceId);
  if (!exp) return { dropped: { text: h.text, reason: "未关联到任何经历", factIds: h.factIds } };
  const facts = exp.facts.filter((f) => h.factIds.includes(f.id));
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  const parsed: QA[] = items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { q, a, factIds } = item as { q?: unknown; a?: unknown; factIds?: unknown };
    if (typeof q !== "string" || !q.trim() || typeof a !== "string" || !a.trim()) return [];
    const ids = Array.isArray(factIds) ? factIds.filter((id): id is string => typeof id === "string") : [];
    return [{ q: q.trim(), a, factIds: ids }];
  });
  // 有任何格式异常的条目（可能正是答不上来的那题）或不足 2 组问答（PRD 要求 2-3 个追问）时一律剔除，不挑着放行
  if (parsed.length < 2 || parsed.length !== items.length) return { dropped: { ...base, reason: QA_MISSING } };
  const questions = parsed.map((qa) => checkAnswer(qa, exp.facts, facts));
  const reason = indefensibleReason(questions);
  if (reason) return { dropped: { ...base, reason } };
  // 先核验全部回答（多出来的题答不上来同样剔除），通过后只展示前 3 组，符合 PRD「2-3 个追问」
  return { kept: { ...h, questions: questions.slice(0, 3) } };
}

/**
 * 生成简历后履历库又被修改：亮点所引事实被删除或原话已变，核验结论就不再成立，读取时移入 dropped。
 * 只处理经过核验流程的简历；旧简历没有原话快照，本身不允许导出。
 */
export function dropStale(resume: ResumeResult, experiences: Experience[]): ResumeResult {
  if (!resume.provenanceChecked) return resume;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  const highlights: Highlight[] = [];
  const dropped: DroppedHighlight[] = [...resume.dropped];
  for (const h of resume.highlights) {
    const stale =
      h.factIds.length === 0 || h.factIds.some((id) => factById.get(id)?.source !== h.sources?.[id] || h.sources?.[id] === undefined);
    if (stale) {
      dropped.push({ text: h.text, reason: "所引用的履历事实在生成简历后被修改或删除，请重新生成", experienceId: h.experienceId, factIds: h.factIds });
    } else highlights.push(h);
  }
  return { ...resume, highlights, dropped };
}

export const INSUFFICIENT_PREFIX = "（素材不足";

/**
 * 参考回答是否不可信：带 insufficient 标记，或回答以 INSUFFICIENT_PREFIX 开头
 * （e24ceda 之前存下的数据没有 insufficient 字段，只能靠前缀识别）
 */
export function isInsufficient(qa: QA): boolean {
  return qa.insufficient === true || (qa.a ?? "").trim().startsWith(INSUFFICIENT_PREFIX);
}

/** 任一追问答不上来（参考回答不可信）的亮点不能写进简历；返回剔除原因，全部可信时返回 null */
export function indefensibleReason(questions: QA[]): string | null {
  const bad = questions.filter(isInsufficient);
  if (bad.length === 0) return null;
  return bad.map((qa) => `面试追问「${qa.q}」无法基于你的原始描述给出可信回答`).join("；");
}

/** 旧版本存下的简历里，回答不可信的亮点仍在 highlights 中；读取时按同一规则移入 dropped */
export function dropIndefensible(resume: ResumeResult): ResumeResult {
  const highlights: Highlight[] = [];
  const dropped: DroppedHighlight[] = [...(resume.dropped ?? [])];
  for (const h of resume.highlights ?? []) {
    const reason = indefensibleReason(h.questions ?? []);
    if (reason) dropped.push({ text: h.text, reason, experienceId: h.experienceId, factIds: h.factIds });
    else highlights.push(h);
  }
  return { ...resume, highlights, dropped };
}

/**
 * 校验面试参考回答：回答里的数字和英文专有名词必须出现在所引事实（含原话）中。
 * 回答未单独引用事实时，以所属亮点引用的事实为依据。不通过的回答替换为补充提示，不展示编造内容。
 */
export function checkAnswer(qa: QA, expFacts: Fact[], highlightFacts: Fact[]): QA {
  const a = (qa.a ?? "").trim();
  if (isInsufficient({ ...qa, a })) return { ...qa, a, insufficient: true };

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

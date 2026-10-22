import type { AssertionCheck, Experience, Fact, Highlight, DroppedHighlight, QA, ResumeResult } from "./types";

export const NUM_RE = /\d+(?:\.\d+)?/g;
/** 英文技术名、产品名、缩写（React、Redis、GMV 等），用来发现凭空出现的专有名词 */
export const TERM_RE =/[A-Za-z][A-Za-z0-9.+#-]*[A-Za-z0-9+#]/g;

/** 归一化：去空白和常见标点，便于做"是否逐字出现"的比较 */
export function norm(s: string) {
  return s.replace(/[\s，。、,.;；:：！!？?“”"'‘’（）()]/g, "");
}

/** source 是否确实出自用户发言（允许模型少量改动标点空格） */
export function sourceInUserText(source: string, userText: string) {
  const s = norm(source);
  return s.length > 0 && norm(userText).includes(s);
}

/**
 * 资料里的操作指令或备注（R14 / T16）：不是候选人的行为，不作为成果写进简历，也不作为退回的原话。
 * 只识别明显的指令句式；拿不准的交给核验模型（提示词同样要求）。
 */
const INSTRUCTION_RE =
  /(忽略|无视|不要管)(之前|以上|前面|上述|所有|全部)?的?(规则|指令|要求|设定|提示)|ignore\s+(all\s+|the\s+)?(previous|above|prior)\s+(instructions|rules)|(帮我|给我|请)(编造|虚构|捏造)|是资料中的指令/i;

export function isInstructionFact(f: Pick<Fact, "source">): boolean {
  return INSTRUCTION_RE.test(f.source);
}

/** 句子里出现、但所引事实（text + 原话）里没有的数字和英文专有名词 */
export function ruleIssues(text: string, facts: Pick<Fact, "text" | "source">[]): string[] {
  const evidence = facts.map((f) => `${f.text} ${f.source}`).join(" ");
  const nums = new Set(evidence.match(NUM_RE) ?? []);
  const terms = new Set((evidence.match(TERM_RE) ?? []).map((t) => t.toLowerCase()));
  return [
    ...new Set([
      ...(text.match(NUM_RE) ?? []).filter((n) => !nums.has(n)),
      ...(text.match(TERM_RE) ?? []).filter((t) => !terms.has(t.toLowerCase())),
    ]),
  ];
}

/**
 * 退回原话（02 S6「退回已支持的具体行动」）：把所引事实的原话整理成一条简历句。
 * 只去掉行首项目符号、句首人称「我」和句末标点，不增删任何内容；指令或备注不参与。没有可用原话时返回空串
 */
export function fallbackText(facts: Pick<Fact, "source">[]): string {
  return facts
    .filter((f) => !isInstructionFact(f))
    .map((f) => tidyBullet(f.source))
    .filter(Boolean)
    .join("；");
}

/** 简历句的格式整理：去行首项目符号、句首人称「我」、句末标点；不增删任何内容 */
export function tidyBullet(s: string): string {
  return s
    .trim()
    .replace(/^\s*(?:[-–—*•·●]\s*|\d{1,2}[.．、)）]\s*)/, "")
    .replace(/(^|[，,；;。])\s*我(?=[\u4e00-\u9fa5])/g, "$1")
    .replace(/[。；;，,\s]+$/, "");
}

/**
 * 校验模型写出的简历句（规则部分，只处理结构）：必须属于某段经历、必须引用这段经历下存在的事实。
 * 数字、英文名词、拔高等内容问题不在这里删除——交给 /api/verify 逐句核验后缩小或退回原话（02 S6、R07）。
 * 只引用了资料指令/备注的句子标 blocked，不导出。
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
      dropped.push({ text: h.text, reason: "模型给出的句子没有对应任何经历（不影响履历库里的事实）" });
      continue;
    }
    const facts = exp.facts.filter((f) => (h.factIds ?? []).includes(f.id));
    if (facts.length === 0) {
      dropped.push({ text: h.text, reason: "模型给出的句子没有引用任何事实，无法溯源（不影响履历库里的事实）", experienceId: exp.id, factIds: [] });
      continue;
    }
    const factIds = facts.map((f) => f.id);
    const sources = Object.fromEntries(facts.map((f) => [f.id, f.source]));
    const base: Highlight = { ...h, experienceId: exp.id, factIds, questions: [], sources };
    if (facts.every(isInstructionFact)) {
      kept.push({ ...base, exportStatus: "blocked", issueType: "unsupported_assertion", note: "这句引用的是资料里的指令或备注，不是你的经历，不会写进简历" });
      continue;
    }
    kept.push(base);
  }
  return { kept, dropped };
}

export type VerifyVerdict = {
  checks: AssertionCheck[];
  revised: string;
  issue: "unsupported_assertion" | "source_conflict" | null;
};

/**
 * 大模型返回的 results 只经过 JSON 解析，这里严格校验后才采信。
 * results 不是数组，或条目不是对象、index 越界或重复，说明结论与句子的对应关系不可信，返回 null（整批按技术错误处理）。
 * 单条结论格式不对时该条不放进结果（调用方按技术错误处理该条）。
 */
export function parseVerifyResults(results: unknown, count: number): Map<number, VerifyVerdict> | null {
  if (!Array.isArray(results)) return null;
  const out = new Map<number, VerifyVerdict>();
  const seen = new Set<number>();
  for (const r of results) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
    const { index, checks, revised_text, issue_type } = r as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return null;
    seen.add(index);
    // 必须给出非空断言列表，且显式给出 issue_type（null 也要写出）；缺失按技术错误处理，不能默认通过
    if (!Array.isArray(checks) || checks.length === 0 || !("issue_type" in (r as object))) continue;
    const parsed: AssertionCheck[] = [];
    let ok = true;
    for (const c of checks) {
      if (typeof c !== "object" || c === null) {
        ok = false;
        break;
      }
      const { claim, type, supported, conflict, reason } = c as Record<string, unknown>;
      if (typeof claim !== "string" || !claim.trim() || typeof supported !== "boolean") {
        ok = false;
        break;
      }
      parsed.push({
        claim: claim.trim(),
        type: typeof type === "string" ? type : "",
        supported,
        conflict: conflict === true,
        reason: typeof reason === "string" ? reason : undefined,
      });
    }
    if (!ok) continue;
    const issue = issue_type === "unsupported_assertion" || issue_type === "source_conflict" ? issue_type : issue_type === null ? null : undefined;
    if (issue === undefined) continue;
    out.set(index, { checks: parsed, revised: typeof revised_text === "string" ? revised_text.trim() : "", issue });
  }
  return out;
}

/** 结论是否全部有依据（无矛盾、无无依据断言、issue 为空） */
export function verdictPasses(v: VerifyVerdict): boolean {
  return v.issue === null && v.checks.every((c) => c.supported && !c.conflict);
}

export const VERIFY_FAILED = "内容核验请求出错或超时，这句暂未核验，不会导出；可以点「重试」";
export const QA_FAILED = "面试追问生成出错或超时，可以点「重试」";

/** 核验调用失败（技术错误）：句子保留为待处理，不导出、可重试；不判为「找不到依据」 */
export function failVerification(items: Highlight[]): Highlight[] {
  return items.map((h) => ({ ...h, exportStatus: "pending", issueType: "technical_error", note: VERIFY_FAILED }));
}

/** 问答调用失败：只标记面试准备失败，简历句照常可用 */
export function failQA(items: Highlight[]): Highlight[] {
  return items.map((h) => ({ ...h, questions: [], qaFailed: true }));
}

/** 解析模型返回的追问；q 必须是非空字符串，a 允许为空（表示来源不足） */
export function parseQuestions(raw: unknown): QA[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: QA[] = raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { q, a, factIds, missing_details } = item as Record<string, unknown>;
    if (typeof q !== "string" || !q.trim()) return [];
    const ids = Array.isArray(factIds) ? factIds.filter((id): id is string => typeof id === "string") : [];
    const missing = Array.isArray(missing_details) ? missing_details.filter((m): m is string => typeof m === "string" && !!m.trim()) : [];
    return [{ q: q.trim(), a: typeof a === "string" ? a.trim() : "", factIds: ids, missingDetails: missing }];
  });
  return parsed.length > 0 ? parsed : null;
}

/**
 * 参考回答的规则检查：没有回答、或回答里有所引事实没有的数字/英文名词时，不展示草稿，标 needs_details。
 * 引用了不属于本段经历的 id 时以亮点所引事实为依据。中文断言由 /api/qa 再调用核验模型检查。
 */
export function checkAnswer(qa: QA, expFacts: Fact[], highlightFacts: Fact[]): QA {
  const cited = expFacts.filter((f) => (qa.factIds ?? []).includes(f.id) && !isInstructionFact(f));
  const facts = cited.length > 0 ? cited : highlightFacts;
  const factIds = facts.map((f) => f.id);
  const a = (qa.a ?? "").trim();
  if (!a || a.startsWith(INSUFFICIENT_PREFIX)) return needsDetails({ ...qa, factIds }, []);
  const unknown = ruleIssues(a, facts);
  if (unknown.length > 0) return needsDetails({ ...qa, factIds }, [`AI 草稿里出现了你没提过的「${unknown.slice(0, 3).join("、")}」，已隐藏`]);
  return { ...qa, a, factIds, preparationStatus: "ready", insufficient: false };
}

/** 标为需要补充：隐藏草稿，保留问题和待补细节（不影响简历句和事实） */
export function needsDetails(qa: QA, extra: string[]): QA {
  const missing = [...new Set([...(qa.missingDetails ?? []), ...extra])];
  return { ...qa, a: "", preparationStatus: "needs_details", insufficient: true, missingDetails: missing.length ? missing : ["这道题的具体做法和结果"] };
}

/** 展示前 3 组追问（PRD「2-3 个追问」）：答得上来的在前，有待补充的至少保留一道 */
export function pickQuestions(questions: QA[]): QA[] {
  const good = questions.filter((q) => !isInsufficient(q));
  const weak = questions.filter(isInsufficient);
  return weak.length > 0 ? [...good.slice(0, 2), ...weak].slice(0, 3) : good.slice(0, 3);
}

/** 旧数据用的前缀；新数据以 preparationStatus 为准 */
export const INSUFFICIENT_PREFIX = "（素材不足";

/** 参考回答是否需要用户补充 */
export function isInsufficient(qa: QA): boolean {
  return qa.preparationStatus === "needs_details" || qa.insufficient === true || (qa.a ?? "").trim().startsWith(INSUFFICIENT_PREFIX);
}

/** 亮点里需要用户补充的追问数 */
export function needsInput(h: Highlight): number {
  // 可重试的（模型出错、来源已修改）不算「需要你补充」
  return (h.questions ?? []).filter((q) => isInsufficient(q) && !q.retryable).length;
}

/** 亮点能否导出：经过核验流程的简历里，状态为 ready（旧数据没有状态，按 ready） */
export function isExportable(h: Highlight, resume: Pick<ResumeResult, "provenanceChecked">): boolean {
  return !!resume.provenanceChecked && (h.exportStatus ?? "ready") === "ready";
}

/** 是否选入本份简历：低相关的可选内容、用户移出的不放进简历（可恢复） */
export function isIncluded(h: Highlight): boolean {
  return h.selection !== "optional" && h.selection !== "hidden_by_user";
}

/**
 * 生成简历后履历库又被修改：亮点所引事实被删除或原话已变，只把受影响的句子标为「来源已修改，待重验」（02 §5、T12），
 * 不删除、不影响其他句子。旧简历没有原话快照，本身不允许导出，原样返回。
 */
export function markStale(resume: ResumeResult, experiences: Experience[]): ResumeResult {
  if (!resume.provenanceChecked) return resume;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  const changed = (ids: string[], snap: Record<string, string> | undefined) =>
    ids.some((id) => snap?.[id] === undefined || factById.get(id)?.source !== snap?.[id]);
  const highlights = resume.highlights.map((h) => {
    if (h.factIds.length === 0 || changed(h.factIds, h.sources)) {
      return { ...h, exportStatus: "pending" as const, issueType: "stale" as const, note: "引用的履历事实在生成后被修改或删除，需要重新核验" };
    }
    // 参考回答可能引用了简历句之外的事实：这些事实变了，只隐藏受影响的回答（R13、T12）
    const questions = h.questions.map((q) => {
      if (isInsufficient(q)) return q;
      // 新数据按回答自己的来源快照判断；旧回答没有快照时，只要引用了简历句之外的事实就无法确认仍然成立，保守隐藏
      const stale = q.sources
        ? changed(Object.keys(q.sources), q.sources)
        : (q.factIds ?? []).some((id) => !h.factIds.includes(id) || !factById.has(id));
      return stale ? { ...needsDetails(q, ["参考回答引用的事实已修改或无法确认，点「重新生成追问」更新"]), retryable: true } : q;
    });
    return { ...h, questions };
  });
  // 旧版本（没有导出状态字段）按「追问答不上来」「核验失败」等旧规则剔除的句子：迁移为待重新核验，不直接放行
  const legacy = !resume.highlights.some((h) => h.exportStatus);
  const migrated: Highlight[] = legacy
    ? resume.dropped
        .filter((d) => d.experienceId && d.factIds?.length && d.factIds.every((id) => factById.has(id)))
        .map((d) => ({
          experienceId: d.experienceId!,
          text: d.text,
          factIds: d.factIds!,
          questions: [],
          sources: {},
          exportStatus: "pending" as const,
          issueType: "stale" as const,
          note: `旧版本按以前的规则未写入（${d.reason}），可以点「重试这段」重新核验`,
        }))
    : [];
  const dropped = legacy ? resume.dropped.filter((d) => !migrated.some((m) => m.text === d.text && m.experienceId === d.experienceId)) : resume.dropped;
  return { ...resume, highlights: [...highlights, ...migrated], dropped };
}

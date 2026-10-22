import type { AbilityEvidence, Education, Evidence, Experience, HardGateResult, MatchResult, MatchStatus, Requirement, RequirementCategory } from "./types";
import { checkEducation, isEducationRequirement } from "./education";
import { checkWorkYears, experienceYears, isGenericYearsRequirement, requiredYears } from "./match";
import { isInstructionFact, norm } from "./validate";

/**
 * 多对多匹配结果的服务端校验（交接包 02 Requirement / AbilityEvidence / Match、03 M1–M3）。
 * 模型给出要求、能力推断、证据边和状态；这里只做结构与边界校验，不做关键词打分、不截断证据条数（R04、R06）：
 * - 只接受输入里存在的事实 id / 能力 id；每条证据必须有理由；没有有效证据的「支持」降为 needs_evidence
 * - 学历、年限是程序可以确定的硬门槛：由程序判断（区间整条判断，上限不单独计分）
 * - actual_gap 只由程序给出；模型判的「缺口」改为 unknown（材料没写 ≠ 不具备）
 * - 可迁移支持不能让硬门槛变成已满足；JD 没写的证书/考试不能作为缺失点（R11）
 */

const CATEGORIES: RequirementCategory[] = ["hard_gate", "core_responsibility", "professional_ability", "soft_ability", "bonus"];
const STATUSES: MatchStatus[] = ["direct_support", "transferable_support", "expression_gap", "needs_evidence", "actual_gap", "unknown"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 只有上限的年限条件（「5 年以下」「不超过 5 年」）：不是对候选人的最低要求，不单独计为已覆盖 */
const UPPER_ONLY_RE = /(\d+|[一二两三四五六七八九十])\s*年\s*(以下|以内|之内)|(不超过|不多于|最多|至多)\s*(\d+|[一二两三四五六七八九十])\s*年/;
/** 证书、考试类说法：JD 原文没提时不能作为缺失点 */
const CERT_RE = /证书|证件|考试|资格证|cet|雅思|ielts|托福|toefl|tem|四级|六级|专八|专四|pmp|cpa|执照/i;

/** 要求级状态 → 旧版三档覆盖（撰写、旧页面沿用） */
export function coverageOf(status: MatchStatus, hardGate?: HardGateResult): Requirement["coverage"] {
  if (hardGate === "not_met") return "none";
  if (status === "direct_support") return hardGate === "unknown" ? "partial" : "full";
  if (status === "transferable_support" || status === "expression_gap") return "partial";
  return "none";
}

type Ctx = { experiences: Experience[]; education: Education[]; now: Date; jd: string };

/** 校验并整理模型返回的多对多匹配结果；结构整体不可用时返回 null */
export function normalizeMatch(raw: unknown, jd: string, experiences: Experience[], education: Education[], now = new Date()): Omit<MatchResult, "jd"> | null {
  const data = obj(raw);
  if (!data || !Array.isArray(data.requirements)) return null;
  const ctx: Ctx = { experiences, education, now, jd };
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, { fact: f, exp: e }] as const)));
  const validFacts = (ids: unknown) => [...new Set(strs(ids).filter((id) => factById.has(id) && !isInstructionFact(factById.get(id)!.fact)))];

  // 能力推断：至少引用一条有效事实，且写明理由
  const abilities: AbilityEvidence[] = [];
  const abilityIds = new Set<string>();
  (Array.isArray(data.abilities) ? data.abilities : []).forEach((a, i) => {
    const r = obj(a);
    if (!r) return;
    const factIds = validFacts(r.fact_ids);
    const ability = str(r.ability);
    const reasoning = str(r.reasoning);
    if (!ability || !reasoning || factIds.length === 0) return;
    let id = str(r.id) || `A${i + 1}`;
    if (abilityIds.has(id)) id = `${id}_${i + 1}`;
    abilityIds.add(id);
    abilities.push({
      id,
      ability,
      factIds,
      relation: r.relation === "transferable" ? "transferable" : "direct",
      reasoning,
      boundary: str(r.boundary),
      missingDetails: strs(r.missing_details),
    });
  });

  // 要求：稳定 id，保留原文与逻辑
  const seenReq = new Set<string>();
  const reqs = data.requirements.flatMap((x, i) => {
    const r = obj(x);
    const text = str(r?.text) || str(r?.normalized_requirement);
    if (!r || !text) return [];
    let id = str(r.id) || `R${i + 1}`;
    if (seenReq.has(id)) id = `${id}_${i + 1}`;
    seenReq.add(id);
    const category = CATEGORIES.includes(r.category as RequirementCategory) ? (r.category as RequirementCategory) : "professional_ability";
    const priority = r.priority === "nice" || category === "bonus" ? "nice" : "must";
    return [{ id, text, jdQuote: str(r.jd_quote) || text, category, type: priority as "must" | "nice", logic: str(r.logic), ambiguity: str(r.ambiguity) }];
  });
  if (reqs.length === 0) return null;

  // 证据边：按要求 id 归集；不认识的要求 id、事实 id、能力 id 一律丢弃
  const matchByReq = new Map<string, Record<string, unknown>>();
  for (const m of Array.isArray(data.matches) ? data.matches : []) {
    const r = obj(m);
    const rid = str(r?.requirement_id);
    if (r && rid && seenReq.has(rid) && !matchByReq.has(rid)) matchByReq.set(rid, r);
  }

  // 同一年限区间被模型拆成「上限」单独一条时并回去（T07：不出现「5 年以下已覆盖」）
  const hasLowerYears = reqs.some((r) => requiredYears(r.text) !== null);
  const requirements: Requirement[] = reqs
    .filter((r) => !(hasLowerYears && requiredYears(r.text) === null && UPPER_ONLY_RE.test(r.text)))
    .map((r) => judge(r, matchByReq.get(r.id), abilities, validFacts, factById, ctx));

  // 每段经历关联了哪些要求；模型漏掉的经历由程序按证据反查补上，没有关联的写明原因
  const modelCov = new Map<string, string>();
  for (const c of Array.isArray(data.experience_coverage) ? data.experience_coverage : []) {
    const r = obj(c);
    if (r && str(r.experience_id)) modelCov.set(str(r.experience_id), str(r.reason));
  }
  const abilityFacts = new Map(abilities.map((a) => [a.id, a.factIds]));
  const experienceCoverage = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => {
      const own = new Set(e.facts.map((f) => f.id));
      const requirementIds = requirements
        .filter((r) => (r.evidence ?? []).some((ev) => [...ev.factIds, ...ev.abilityIds.flatMap((a) => abilityFacts.get(a) ?? [])].some((id) => own.has(id))))
        .map((r) => r.id!);
      return { experienceId: e.id, requirementIds, reason: requirementIds.length ? "" : modelCov.get(e.id) || "这段经历和本 JD 的要求暂未找到对应关系" };
    });

  return {
    version: 2,
    requirements,
    abilities,
    experienceCoverage,
    questions: strs(data.questions).slice(0, 5),
  };
}

function judge(
  r: { id: string; text: string; jdQuote: string; category: RequirementCategory; type: "must" | "nice"; logic: string; ambiguity: string },
  m: Record<string, unknown> | undefined,
  abilities: AbilityEvidence[],
  validFacts: (ids: unknown) => string[],
  factById: Map<string, { fact: Experience["facts"][number]; exp: Experience }>,
  ctx: Ctx,
): Requirement {
  const base = { id: r.id, text: r.text, jdQuote: r.jdQuote, type: r.type, logic: r.logic, ambiguity: r.ambiguity };

  // 学历、专业：程序按教育背景判断（硬门槛）
  if (isEducationRequirement(r.text)) {
    const e = checkEducation(r.text, ctx.education, ctx.now);
    const status: MatchStatus = e.coverage === "full" ? "direct_support" : e.coverage === "partial" ? "needs_evidence" : ctx.education.length ? "actual_gap" : "unknown";
    const hardGate: HardGateResult = e.coverage === "full" ? "met" : e.coverage === "none" && ctx.education.length ? "not_met" : "unknown";
    return { ...base, category: r.type === "nice" ? "bonus" : "hard_gate", status, hardGate, evidence: [], factIds: [], coverage: coverageOf(status, hardGate), missing: e.missing, educationIds: e.educationIds };
  }

  // 证据边
  const abilityById = new Map(abilities.map((a) => [a.id, a]));
  const evidence: Evidence[] = [];
  for (const ev of Array.isArray(m?.evidence) ? m!.evidence : []) {
    const e = obj(ev);
    if (!e) continue;
    const factIds = validFacts(e.fact_ids);
    const abilityIds = strs(e.ability_ids).filter((id) => abilityById.has(id));
    const rationale = str(e.rationale);
    if ((factIds.length === 0 && abilityIds.length === 0) || !rationale) continue;
    evidence.push({ factIds, abilityIds, relation: e.relation === "transferable" ? "transferable" : "direct", rationale });
  }
  const allFactIds = [...new Set([...evidence.flatMap((e) => e.factIds), ...evidence.flatMap((e) => e.abilityIds.flatMap((a) => abilityById.get(a)!.factIds))])];

  // 缺失点：JD 原文没提证书/考试时，模型补的证书类缺失点删除（R11、F05）
  const jdMentionsCert = CERT_RE.test(r.jdQuote) || CERT_RE.test(r.text);
  const missing = strs(m?.missing).filter((s) => jdMentionsCert || !CERT_RE.test(s));

  let status: MatchStatus = STATUSES.includes(m?.status as MatchStatus) ? (m!.status as MatchStatus) : "unknown";
  // 材料没写不等于不具备：模型给的 actual_gap 改为 unknown；只有程序能确定时才是 actual_gap
  if (status === "actual_gap") status = "unknown";
  const supportive = status === "direct_support" || status === "transferable_support" || status === "expression_gap";
  if (supportive && evidence.length === 0) status = "needs_evidence";
  if (!supportive && evidence.length > 0 && status === "unknown") status = evidence.some((e) => e.relation === "direct") ? "direct_support" : "transferable_support";
  // 只有可迁移证据时不能是「直接支持」
  if (status === "direct_support" && evidence.every((e) => e.relation === "transferable")) status = "transferable_support";

  let category = r.category;
  let hardGate: HardGateResult = category === "hard_gate" ? "unknown" : "not_applicable";

  // 年限：程序按证据所在经历的起止时间计算（不重复累计重叠时间，R05）；区间按下限判断，上限不单独计分
  const minYears = requiredYears(r.text);
  if (minYears !== null) {
    category = r.type === "nice" ? "bonus" : "hard_gate";
    if (isGenericYearsRequirement(r.text)) {
      const w = checkWorkYears(minYears, ctx.experiences, ctx.now, r.text);
      const st: MatchStatus = w.coverage === "full" ? "direct_support" : w.coverage === "partial" ? "needs_evidence" : "actual_gap";
      const hg: HardGateResult = w.coverage === "full" ? "met" : w.coverage === "partial" ? "unknown" : "not_met";
      return { ...base, category, status: st, hardGate: hg, evidence: [], factIds: [], coverage: coverageOf(st, hg), missing: w.missing, experienceIds: w.experienceIds };
    }
    const exps = [...new Map(allFactIds.map((id) => [factById.get(id)!.exp.id, factById.get(id)!.exp])).values()];
    const have = exps.length ? experienceYears(exps, ctx.now) : null;
    const yearsMissing = missing.filter((s) => !/年/.test(s));
    // 模型没给出相关经历时，用全部经历的合计年限做上界：连全部经历都不够下限，才能确定不满足
    const allHave = experienceYears(ctx.experiences.filter((e) => e.facts.length > 0), ctx.now);
    if (exps.length === 0 && allHave !== null && allHave < minYears) {
      hardGate = "not_met";
      status = "actual_gap";
      yearsMissing.push(`需要 ${minYears} 年以上，全部经历合计约 ${Math.round(allHave * 10) / 10} 年（重叠时间不重复计算）`);
    } else if (exps.length === 0) {
      hardGate = "unknown";
      status = "needs_evidence";
    } else if (have === null) {
      hardGate = "unknown";
      yearsMissing.push(`经历起止时间不完整，无法核实 ${minYears} 年年限`);
    } else if (have < minYears) {
      hardGate = "not_met";
      status = "actual_gap";
      yearsMissing.push(`需要 ${minYears} 年以上，相关经历合计约 ${Math.round(have * 10) / 10} 年（重叠时间不重复计算）`);
    } else {
      hardGate = status === "direct_support" ? "met" : "unknown";
    }
    return { ...base, category, status, hardGate, evidence, factIds: allFactIds, coverage: coverageOf(status, hardGate), missing: yearsMissing };
  }

  // 硬门槛：可迁移支持不能当作已满足（R06、R11）
  if (category === "hard_gate") {
    hardGate = status === "direct_support" ? "met" : "unknown";
    if (status === "transferable_support") missing.push("可迁移经验不能直接满足这项硬性条件");
  }
  // 直接支持但仍写明有缺失点（如只有英语邮件场景、口语未知）：覆盖最多算部分（T08）
  let coverage = coverageOf(status, hardGate);
  if (coverage === "full" && missing.length > 0) coverage = "partial";
  // 依赖能力推断的支持：推断确认前只算部分（R09），由页面按确认记录再调整
  return { ...base, category, status, hardGate, evidence, factIds: allFactIds, coverage, missing };
}

/** 能力推断的确认记录键：能力 + 事实 + 原话快照；事实被修改后旧确认自动失效（02 §5） */
export function abilityKey(a: Pick<AbilityEvidence, "ability" | "factIds">, experiences: Experience[]): string {
  const src = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f.source] as const)));
  const ids = [...a.factIds].sort();
  let h = 5381;
  for (const ch of ids.map((id) => norm(src.get(id) ?? "")).join("|")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return `${norm(a.ability)}|${ids.join(",")}|${h}`;
}

export type AbilityDecisions = Record<string, "confirmed" | "rejected">;

/**
 * 按用户的确认记录合并能力推断状态，并更新受影响的要求（P1：确认/拒绝后对应匹配更新）：
 * - 拒绝的推断从证据里移除；某要求只靠被拒绝/已失效的推断支持时降为 needs_evidence
 * - 只靠未确认推断支持的要求，覆盖最多算部分（R09）
 * 拒绝推断不删除来源事实。
 */
export function applyAbilityDecisions(match: MatchResult, decisions: AbilityDecisions, experiences: Experience[]): MatchResult {
  if (match.version !== 2) return match;
  const facts = new Set(experiences.flatMap((e) => e.facts.map((f) => f.id)));
  const abilities = (match.abilities ?? [])
    .filter((a) => a.factIds.every((id) => facts.has(id)))
    .map((a): AbilityEvidence => ({ ...a, confirmation: decisions[abilityKey(a, experiences)] ?? "pending" }));
  const byId = new Map(abilities.map((a) => [a.id, a]));
  const requirements = match.requirements.map((r) => {
    if (!r.evidence || r.evidence.length === 0 || !r.status) return r;
    const evidence = r.evidence
      .map((e) => ({ ...e, factIds: e.factIds.filter((id) => facts.has(id)), abilityIds: e.abilityIds.filter((id) => byId.has(id) && byId.get(id)!.confirmation !== "rejected") }))
      .filter((e) => e.factIds.length > 0 || e.abilityIds.length > 0);
    let status = r.status;
    const supportive = status === "direct_support" || status === "transferable_support" || status === "expression_gap";
    if (supportive && evidence.length === 0) status = "needs_evidence";
    const onlyPending =
      evidence.length > 0 && evidence.every((e) => e.factIds.length === 0 && e.abilityIds.every((id) => byId.get(id)!.confirmation === "pending"));
    let coverage = coverageOf(status, r.hardGate);
    if ((onlyPending || (r.missing ?? []).length > 0) && coverage === "full") coverage = "partial";
    const factIds = [...new Set([...evidence.flatMap((e) => e.factIds), ...evidence.flatMap((e) => e.abilityIds.flatMap((a) => byId.get(a)!.factIds))])];
    return { ...r, evidence, status, coverage, factIds };
  });
  return { ...match, abilities, requirements };
}

/** 旧格式匹配结果（只有 coverage/factIds）转成新状态，便于同一页面显示；不做关键词判断 */
export function fromLegacy(match: MatchResult, experiences: Experience[]): MatchResult {
  if (match.version === 2) return match;
  const facts = new Set(experiences.flatMap((e) => e.facts.map((f) => f.id)));
  return {
    ...match,
    requirements: match.requirements.map((r, i) => {
      const factIds = (r.factIds ?? []).filter((id) => facts.has(id));
      const coverage = r.coverage ?? (factIds.length ? "full" : "none");
      const status: MatchStatus = coverage === "full" && factIds.length ? "direct_support" : coverage === "partial" && factIds.length ? "needs_evidence" : "unknown";
      return {
        ...r,
        id: r.id ?? `R${i + 1}`,
        status: r.educationIds || r.experienceIds ? (coverage === "full" ? "direct_support" : coverage === "none" ? "actual_gap" : "needs_evidence") : status,
        evidence: factIds.length ? [{ factIds, abilityIds: [], relation: "direct" as const, rationale: "旧版匹配结果，请重新分析以查看理由" }] : [],
        factIds,
      };
    }),
  };
}

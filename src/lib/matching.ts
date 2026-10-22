import type { AbilityEvidence, Education, Evidence, Experience, HardGateResult, MatchResult, MatchStatus, Requirement, RequirementCategory } from "./types";
import { checkEducation, isEducationRequirement } from "./education";
import { checkWorkYears, experienceYears, isGenericYearsRequirement, requiredYears } from "./match";
import { isInstructionFact, norm } from "./validate";

/**
 * 多对多匹配（交接包 02 Requirement / AbilityEvidence / Match、03 M1–M3）。
 * 模型给出要求、能力推断、证据边；程序只做结构与边界校验，不做关键词打分、不截断证据（R04、R06）。
 * 要求级状态统一由 derive() 按「当前有效证据」推导：首次分析、用户确认/拒绝推断、来源修改、撰写前都走同一逻辑。
 * - 只接受输入里存在的事实/能力 id；每条证据必须有理由
 * - 学历、年限这类程序能确定的门槛由程序判断；年限只按直接证据计算（可迁移经历不计入行业年限）
 * - actual_gap 只用于程序能确定不满足；资料没提供、模型判的「缺口」都是 unknown / needs_evidence
 * - 硬门槛必须能在 JD 原文中定位；JD 没写的证书/考试既不能成为要求，也不能成为缺失点（R11）
 * - 未确认的能力推断：页面显示为待确认，覆盖最多算部分；撰写时不作为依据（R09）
 */

const CATEGORIES: RequirementCategory[] = ["hard_gate", "core_responsibility", "professional_ability", "soft_ability", "bonus"];
const STATUSES: MatchStatus[] = ["direct_support", "transferable_support", "expression_gap", "needs_evidence", "actual_gap", "unknown"];
const SUPPORTIVE: MatchStatus[] = ["direct_support", "transferable_support", "expression_gap"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 只有上限的年限条件（「5 年以下」「不超过 5 年」） */
const UPPER_ONLY_RE = /(\d+|[一二两三四五六七八九十])\s*年\s*(以下|以内|之内)|(不超过|不多于|最多|至多)\s*(\d+|[一二两三四五六七八九十])\s*年/;
/** 区间写法「3—5 年」「3-5年」里的上限数字 */
const RANGE_UPPER_RE = /\d+\s*[-–—~～至到]\s*(\d+)\s*年/;

export const STALE_MISSING = "引用的履历事实已修改或删除，这条依据待重新分析";

/** 要求级状态 → 三档覆盖（撰写、旧页面沿用） */
export function coverageOf(status: MatchStatus, hardGate?: HardGateResult): Requirement["coverage"] {
  if (hardGate === "not_met") return "none";
  if (status === "direct_support") return hardGate === "unknown" ? "partial" : "full";
  if (status === "transferable_support" || status === "expression_gap") return "partial";
  return "none";
}

export type DeriveCtx = {
  experiences: Experience[];
  education: Education[];
  now: Date;
  /** JD 原文（判断证书类说法是不是 JD 本身就有） */
  jd: string;
  /** 能力推断（含确认状态） */
  abilities: AbilityEvidence[];
  /** 分析时各事实的原话快照；来源变了的证据失效 */
  factSources?: Record<string, string>;
  /** 撰写用：未确认的推断不作为依据 */
  writer?: boolean;
};

/**
 * 按当前有效证据推导一条要求的状态、门槛、覆盖与缺失点。
 * r.modelStatus / r.modelMissing 保存模型最初的判断，只作为「没有证据时属于哪类未知」和缺失点的参考。
 */
export function derive(r: Requirement, ctx: DeriveCtx): Requirement {
  const base: Requirement = {
    id: r.id,
    text: r.text,
    jdQuote: r.jdQuote,
    type: r.type,
    logic: r.logic,
    ambiguity: r.ambiguity,
    modelStatus: r.modelStatus,
    modelMissing: r.modelMissing,
    category: r.category,
    factIds: [],
  };

  // 学历、专业：程序按当前教育背景判断
  if (isEducationRequirement(r.text)) {
    const e = checkEducation(r.text, ctx.education, ctx.now);
    const status: MatchStatus = e.coverage === "full" ? "direct_support" : e.coverage === "partial" ? "needs_evidence" : e.definite ? "actual_gap" : "unknown";
    const hardGate: HardGateResult = e.coverage === "full" ? "met" : e.definite ? "not_met" : "unknown";
    return { ...base, category: r.type === "nice" ? "bonus" : "hard_gate", status, hardGate, evidence: [], coverage: coverageOf(status, hardGate), missing: e.missing, educationIds: e.educationIds };
  }

  const minYears = requiredYears(r.text);
  // 不限领域的工作年限：程序按当前任职经历计算
  if (minYears !== null && isGenericYearsRequirement(r.text)) {
    const w = checkWorkYears(minYears, ctx.experiences, ctx.now, r.text);
    const status: MatchStatus = w.coverage === "full" ? "direct_support" : w.coverage === "partial" ? "needs_evidence" : w.definite ? "actual_gap" : "unknown";
    const hardGate: HardGateResult = w.coverage === "full" ? "met" : w.definite ? "not_met" : "unknown";
    return { ...base, category: r.type === "nice" ? "bonus" : "hard_gate", status, hardGate, evidence: [], coverage: coverageOf(status, hardGate), missing: w.missing, experienceIds: w.experienceIds };
  }

  // 当前有效证据：事实仍存在且原话没变；能力推断没有被拒绝（撰写时还要求已确认）
  const factById = new Map(ctx.experiences.flatMap((e) => e.facts.map((f) => [f.id, { fact: f, exp: e }] as const)));
  const abilityById = new Map(ctx.abilities.map((a) => [a.id, a]));
  let stale = false;
  const factOk = (id: string) => {
    const hit = factById.get(id);
    const changed = !hit || (ctx.factSources?.[id] !== undefined && ctx.factSources[id] !== hit.fact.source);
    if (changed) stale = true;
    return !changed;
  };
  const abilityOk = (id: string) => {
    const a = abilityById.get(id);
    if (!a || a.confirmation === "rejected") return false;
    if (ctx.writer && a.confirmation !== "confirmed") return false;
    return a.factIds.every(factOk);
  };
  // 一条证据是联合依据：任何一个依赖（事实或推断）失效，整条证据都不再成立，不能拿剩下的部分沿用原结论
  const allEvidence = r.evidence ?? [];
  const evidence: Evidence[] = allEvidence.filter((e) => {
    const facts = e.factIds.map(factOk);
    const abs = e.abilityIds.map(abilityOk);
    return facts.every(Boolean) && abs.every(Boolean) && e.factIds.length + e.abilityIds.length > 0;
  });
  const dropped = allEvidence.length - evidence.length;
  const factsOf = (es: Evidence[]) => [...new Set([...es.flatMap((e) => e.factIds), ...es.flatMap((e) => e.abilityIds.flatMap((a) => abilityById.get(a)!.factIds))])];
  const factIds = factsOf(evidence);
  // 直接支持要沿整条依赖链判断：证据边是 direct，且引用的推断本身也是 direct
  const direct = evidence.filter((e) => e.relation === "direct" && e.abilityIds.every((id) => abilityById.get(id)!.relation === "direct"));
  // 门槛（硬性条件、年限）只能由事实或已确认的推断确定满足：证据里直接引用的事实算数，
  // 只靠未确认推断的证据不算；计入的事实 = 直接引用的事实 + 已确认推断的事实
  const firm = direct.filter((e) => e.abilityIds.every((id) => abilityById.get(id)!.confirmation === "confirmed"));
  const firmFacts = factsOf(firm);

  // 状态：有直接证据 → 直接支持（模型判「表述不足」时保留）；只有可迁移证据 → 可迁移支持；没有证据 → 需补证据 / 未知
  const ms = r.modelStatus ?? r.status ?? "unknown";
  let status: MatchStatus =
    evidence.length === 0
      ? SUPPORTIVE.includes(ms) || stale || ms === "needs_evidence"
        ? "needs_evidence"
        : "unknown"
      : direct.length > 0
        ? ms === "expression_gap"
          ? "expression_gap"
          : "direct_support"
        : "transferable_support";

  // 缺失点：对应 JD 原文里没有的证书/考试名称不能作为缺失点（按这条要求的原文逐项核对）
  const scope = norm(r.jdQuote || ctx.jd).toLowerCase();
  const certOk = (s: string) => certTokens(s).every((t) => scope.includes(t));
  const missing = (r.modelMissing ?? r.missing ?? []).filter((s) => certOk(s) && s !== STALE_MISSING && !s.startsWith("部分依据引用的推断"));
  if (stale || dropped > 0) {
    if (stale) missing.push(STALE_MISSING);
    else if (!ctx.writer) missing.push("部分依据引用的推断未被认可或待确认，这些依据暂不计入");
  }

  let category: RequirementCategory = r.category ?? "professional_ability";
  let hardGate: HardGateResult = category === "hard_gate" ? "unknown" : "not_applicable";

  // 领域年限（「3—5 年采购经验」）：只按直接证据所在经历计算，重叠时间不重复（R05）；可迁移经历不计入（R06）
  if (minYears !== null) {
    category = r.type === "nice" ? "bonus" : "hard_gate";
    // 只按「直接且已确定」的证据所在经历计算；履历库可能没录全，没有证据时只能是未知，不能推成不满足
    const exps = [...new Map(firmFacts.map((id) => [factById.get(id)!.exp.id, factById.get(id)!.exp])).values()];
    const have = exps.length ? experienceYears(exps, ctx.now) : null;
    const yMissing = missing.filter((s) => !/\d+(\.\d+)?\s*年/.test(s));
    if (exps.length === 0) {
      hardGate = "unknown";
      if (status === "direct_support") status = "needs_evidence";
      yMissing.push(evidence.length > 0 ? "只有可迁移或待确认的依据，不能确定这项年限" : `请补充与这项要求直接相关的经历（需要 ${minYears} 年以上）`);
    } else if (have === null) {
      hardGate = "unknown";
      yMissing.push(`经历起止时间不完整，无法核实 ${minYears} 年年限`);
    } else if (have < minYears) {
      // 只有当履历库里其余经历都已计入、或全部经历加起来也不够时，才能确定不满足；否则其余经历是否相关未知
      // 没被计入的经历即使有事实，也不代表领域已说明清楚（履历常常只录了一部分）：都视为「是否相关未知」
      const counted = new Set(exps.map((e) => e.id));
      const rest = ctx.experiences.filter((e) => !counted.has(e.id));
      const allHave = experienceYears(ctx.experiences, ctx.now);
      const determinable = rest.length === 0 || (allHave !== null && allHave < minYears);
      const label = `需要 ${minYears} 年以上，直接相关经历合计约 ${Math.round(have * 10) / 10} 年（重叠时间不重复计算）`;
      if (determinable) {
        hardGate = "not_met";
        status = "actual_gap";
        yMissing.push(label);
      } else {
        hardGate = "unknown";
        if (status === "direct_support") status = "needs_evidence";
        yMissing.push(`${label}；其他经历是否相关暂不清楚，可以补充这些经历的具体内容`);
      }
    } else {
      hardGate = "met";
    }
    let yCoverage = coverageOf(status, hardGate);
    if (yCoverage === "full" && yMissing.length > 0) yCoverage = "partial";
    return { ...base, category, status, hardGate, evidence, factIds, coverage: yCoverage, missing: yMissing };
  }

  // 只有上限的年限条件：不是对候选人的最低要求，不判为已满足
  if (UPPER_ONLY_RE.test(r.text)) {
    return { ...base, category, status: "unknown", hardGate: "not_applicable", evidence, factIds, coverage: "none", missing: ["这是年限上限条件，请自行确认是否符合"] };
  }

  // 硬门槛：只有直接支持才算满足；可迁移支持不能当作已满足
  if (category === "hard_gate") {
    hardGate = status === "direct_support" && firm.length > 0 ? "met" : "unknown";
    if (status === "transferable_support") missing.push("可迁移经验不能直接满足这项硬性条件");
  }
  let coverage = coverageOf(status, hardGate);
  // 有缺失点、或只靠未确认推断支持：覆盖最多算部分
  const onlyPending = evidence.length > 0 && evidence.every((e) => e.factIds.length === 0 && e.abilityIds.every((id) => abilityById.get(id)!.confirmation !== "confirmed"));
  if (coverage === "full" && (missing.length > 0 || onlyPending)) coverage = "partial";
  return { ...base, category, status, hardGate, evidence, factIds, coverage, missing };
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

/** 每段经历关联了哪些要求；没有关联的写明原因（防止静默漏失） */
function coverageByExperience(requirements: Requirement[], abilities: AbilityEvidence[], experiences: Experience[], reasons: Map<string, string>) {
  const abilityFacts = new Map(abilities.map((a) => [a.id, a.factIds]));
  return experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => {
      const own = new Set(e.facts.map((f) => f.id));
      const requirementIds = requirements
        .filter((r) => (r.evidence ?? []).some((ev) => [...ev.factIds, ...ev.abilityIds.flatMap((a) => abilityFacts.get(a) ?? [])].some((id) => own.has(id))))
        .map((r) => r.id!);
      return { experienceId: e.id, requirementIds, reason: requirementIds.length ? "" : reasons.get(e.id) || "这段经历和本 JD 的要求暂未找到对应关系" };
    });
}

/**
 * 按当前履历库、教育背景和用户的确认记录重新推导整个匹配结果：
 * 拒绝推断、修改来源、修改任职时间或教育背景后，受影响的要求随之更新，不删除任何事实。
 * writer 为 true 时得到「撰写专用」结果：未确认的推断不作为依据（R09）。
 */
export function refreshMatch(match: MatchResult, decisions: AbilityDecisions, experiences: Experience[], education: Education[], opts: { writer?: boolean; now?: Date } = {}): MatchResult {
  if (match.version !== 2) return fromLegacy(match, experiences);
  const src = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f.source] as const)));
  const abilities = (match.abilities ?? [])
    .filter((a) => a.factIds.every((id) => src.has(id) && (match.factSources?.[id] === undefined || match.factSources[id] === src.get(id))))
    .map((a): AbilityEvidence => ({ ...a, confirmation: decisions[abilityKey(a, experiences)] ?? "pending" }));
  const ctx: DeriveCtx = { experiences, education, now: opts.now ?? new Date(), jd: match.jd, abilities, factSources: match.factSources, writer: opts.writer };
  const requirements = match.requirements.map((r) => derive(r, ctx));
  const reasons = new Map((match.experienceCoverage ?? []).map((c) => [c.experienceId, c.reason]));
  return { ...match, abilities, requirements, experienceCoverage: coverageByExperience(requirements, abilities, experiences, reasons) };
}

/** 句子里出现的具体证书/考试名称（「证书」「考试」这类泛称本身也算） */
function certTokens(s: string): string[] {
  // 具体证书名（「法律职业资格证」「教师资格证」）整体核对，去掉「持有/具备」这类前缀；考试名称（六级、PMP）单独核对
  const named = (s.match(/[\u4e00-\u9fa5A-Za-z0-9]{0,10}(?:资格证书|资格证|证书|执照)/g) ?? []).map((t) =>
    t.replace(/^(?:未提供|未取得|未|缺少|缺乏|没有|无|提供|必须|需要|需|要求|持有|具备|拥有|取得|获得|相关|有|并|且|及|和|的)+/, ""),
  );
  const exams = s.match(/cet-?\d|雅思|ielts|托福|toefl|tem-?\d|四级|六级|专八|专四|pmp|cpa/gi) ?? [];
  return [...new Set([...named, ...exams].map((t) => norm(t).toLowerCase()).filter(Boolean))];
}

/** 摘录里和这条要求对应的分句：按字的重合度挑选（年限数字、学历词优先对上） */
function clauseFor(text: string, quote: string): string {
  // 顿号、括号、「但/且/并且/同时/需要」等也是分句边界（「学历不限、3年以上…」「3年以上…（有PMP证书者优先）」）
  // 汉字后的空格也是分句边界（「学历不限 3年以上采购经验」）；「大专 及以上」「学历 不限」「3年以上经验 优先」这类附着的修饰不拆开，数字后的空格（「3 年」）不拆
  const parts = quote
    .split(/[，,；;。、\n（）()]|(?<=[\u4e00-\u9fff])\s+(?![及以或含至到左右]|不限|不要求|优先|加分|更佳|为佳)|但是?|并且|而且|同时|且|需要|需/)
    .map((p) => p?.trim())
    .filter(Boolean);
  if (parts.length <= 1) return quote;
  const t = norm(text);
  const key = [...(text.match(/\d+|博士|硕士|本科|大专|专科/g) ?? [])];
  const score = (p: string) => {
    const n = norm(p);
    const keyHit = key.filter((k) => n.includes(k)).length * 10;
    let overlap = 0;
    for (const ch of new Set(t)) if (n.includes(ch)) overlap++;
    return keyHit + overlap / Math.max(1, n.length);
  };
  return parts.reduce((best, p) => (score(p) > score(best) ? p : best), parts[0]);
}

/** 年限条件的方向：下限（以上/至少）、上限（以下/不超过）、区间；没有方向时为空 */
function boundOf(t: string): string {
  if (RANGE_UPPER_RE.test(t)) return "range";
  if (UPPER_ONLY_RE.test(t)) return "upper";
  if (/以上|至少|不少于|不低于|[+＋]/.test(t)) return "lower";
  return "";
}

/** 原文摘录没对上时的兜底：年限数字、学历层次词确实出现在 JD 里，说明这条门槛不是模型自己加的 */
function gateInJd(text: string, jdNorm: string): boolean {
  const years = text.match(/\d+(?=\s*年)/g) ?? [];
  const levels = text.match(/博士|硕士|研究生|本科|学士|大专|专科/g) ?? [];
  if (years.length === 0 && levels.length === 0) return false;
  return [...years.map((n) => `${n}`), ...levels].every((t) => jdNorm.includes(t));
}

/** 校验并整理模型返回的多对多匹配结果；结构整体不可用时返回 null */
export function normalizeMatch(raw: unknown, jd: string, experiences: Experience[], education: Education[], now = new Date()): Omit<MatchResult, "jd"> | null {
  const data = obj(raw);
  if (!data || !Array.isArray(data.requirements)) return null;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  const validFacts = (ids: unknown) => [...new Set(strs(ids).filter((id) => factById.has(id) && !isInstructionFact(factById.get(id)!)))];
  const jdNorm = norm(jd);

  // 能力推断：至少引用一条有效事实，且写明理由
  const abilities: AbilityEvidence[] = [];
  const abilityIds = new Set<string>();
  (Array.isArray(data.abilities) ? data.abilities : []).forEach((a, i) => {
    const r = obj(a);
    if (!r) return;
    const factIds = validFacts(r.fact_ids);
    const ability = str(r.ability);
    const reasoning = str(r.reasoning);
    // 引用了不存在或不可用的事实 id：整条推断不成立（不能删掉坏 id 后沿用原推理）
    if (!ability || !reasoning || factIds.length === 0 || factIds.length !== strs(r.fact_ids).length) return;
    let id = str(r.id) || `A${i + 1}`;
    if (abilityIds.has(id)) id = `${id}_${i + 1}`;
    abilityIds.add(id);
    abilities.push({ id, ability, factIds, relation: r.relation === "transferable" ? "transferable" : "direct", reasoning, boundary: str(r.boundary), missingDetails: strs(r.missing_details) });
  });

  // 要求：原文能在 JD 中定位才可作为硬门槛；JD 没写的证书类要求丢弃（模型自己的要求文本不能证明条件存在）
  const seenReq = new Set<string>();
  const reqs: Requirement[] = [];
  data.requirements.forEach((x, i) => {
    const r = obj(x);
    const text = str(r?.text) || str(r?.normalized_requirement);
    if (!r || !text) return;

    let id = str(r.id) || `R${i + 1}`;
    if (seenReq.has(id)) id = `${id}_${i + 1}`;
    seenReq.add(id);
    const quote = str(r.jd_quote);
    const located = !!quote && jdNorm.includes(norm(quote));
    // 学历、年限这类门槛条件必须能在 JD 原文中定位，否则就是模型自己加的条件
    if (!located && (isEducationRequirement(text) || requiredYears(text) !== null) && !gateInJd(text, jdNorm)) return;
    // 证书/考试名称必须出现在对应原文（没有可定位原文时看整份 JD）里，否则是模型新增的条件
    const certScope = (located ? norm(quote) : jdNorm).toLowerCase();
    if (certTokens(text).some((t) => !certScope.includes(t))) return;
    // 规范化后的年限、学历及其上下限逻辑必须与原文一致；不一致时以 JD 原文为准
    // 限定词只看这条要求对应的分句：模型常把整句摘进来，同句里别的条件的「不限/优先」不能影响它
    const clause = located ? clauseFor(text, quote) : "";
    let normalized = text;
    const gateLike = requiredYears(text) !== null || UPPER_ONLY_RE.test(text) || isEducationRequirement(text);
    if (located && gateLike && (!gateInJd(text, norm(clause)) || boundOf(text) !== boundOf(clause))) normalized = clause;
    // 原文写了「不要求/不限」的不是要求；写了「优先/加分」的不能当必需条件。
    // 只有能可靠定位到本要求所在分句（年限数字/学历词都在这个分句里）时才应用，定位不了就沿用模型的判断
    const keys = normalized.match(/\d+|博士|硕士|本科|大专|专科/g) ?? [];
    const reliable = located && (keys.length === 0 ? norm(clause).length <= norm(normalized).length + 12 : keys.every((k) => norm(clause).includes(k)));
    if (reliable && /不要求|不限/.test(clause) && !/不限于/.test(clause)) return;
    const optionalInJd = reliable && /优先|加分|更佳|为佳/.test(clause);
    let category = CATEGORIES.includes(r.category as RequirementCategory) ? (r.category as RequirementCategory) : "professional_ability";
    let ambiguity = str(r.ambiguity);
    if (!located && category === "hard_gate") {
      category = "professional_ability";
      ambiguity = [ambiguity, "没能在 JD 原文中定位这条硬性条件，不作为门槛"].filter(Boolean).join("；");
    }
    if (optionalInJd && category === "hard_gate") category = "bonus";
    const type = r.priority === "nice" || category === "bonus" || optionalInJd ? "nice" : "must";
    reqs.push({ id, text: normalized, jdQuote: located ? quote : "", category, type, logic: str(r.logic), ambiguity, factIds: [] });
  });
  if (reqs.length === 0) return null;

  // 证据边：同一要求的多条记录合并（不丢后面的证据）；不认识的 id、没有理由的证据丢弃
  const merged = new Map<string, { status?: MatchStatus; evidence: Evidence[]; missing: string[] }>();
  for (const m of Array.isArray(data.matches) ? data.matches : []) {
    const r = obj(m);
    const rid = str(r?.requirement_id);
    if (!r || !seenReq.has(rid)) continue;
    const slot = merged.get(rid) ?? { evidence: [], missing: [] };
    const st = STATUSES.includes(r.status as MatchStatus) ? (r.status as MatchStatus) : undefined;
    if (st && (!slot.status || slot.status === "unknown")) slot.status = st;
    for (const ev of Array.isArray(r.evidence) ? r.evidence : []) {
      const e = obj(ev);
      if (!e) continue;
      const rawFacts = strs(e.fact_ids);
      const rawAbs = strs(e.ability_ids);
      const factIds = validFacts(rawFacts);
      const abIds = rawAbs.filter((id) => abilityIds.has(id));
      const rationale = str(e.rationale);
      // 联合证据引用了未知或不可用的 id：整条拒绝
      if ((factIds.length === 0 && abIds.length === 0) || !rationale || factIds.length !== new Set(rawFacts).size || abIds.length !== rawAbs.length) continue;
      // 证据里列出的推断都是依赖：推断待确认或被拒绝时整条证据不能作为确定依据（不从事实 id 重合推定事实能独立支持）
      slot.evidence.push({ factIds, abilityIds: abIds, relation: e.relation === "transferable" ? "transferable" : "direct", rationale });
    }
    for (const s of strs(r.missing)) if (!slot.missing.includes(s)) slot.missing.push(s);
    merged.set(rid, slot);
  }

  // 区间被拆开时，只把与某条「区间上限」数字相同的上限条件并回去；独立的上限条件保留
  // 只有上限数字相同、且条件对象一致（「工作经验」⊂「采购相关工作经验」）时才视为同一区间被拆开；
  // 「管理经验不超过 5 年」这类对象不同的独立条件保留
  const subject = (t: string) =>
    norm(t).replace(/\d+|[—\-–~～至到+＋]|年|以上|以下|以内|之内|不超过|不多于|最多|至多|至少|及|或|具备|拥有|具有|需要|要求|有/g, "");
  const ranges = reqs.flatMap((r) => {
    const n = r.text.match(RANGE_UPPER_RE)?.[1];
    return n ? [{ n, subject: subject(r.text) }] : [];
  });
  const kept = reqs.filter((r) => {
    if (requiredYears(r.text) !== null || !UPPER_ONLY_RE.test(r.text)) return true;
    const n = r.text.match(/(\d+)\s*年/)?.[1];
    const sub = subject(r.text);
    return !ranges.some((g) => g.n === n && g.subject.includes(sub));
  });

  const withModel: Requirement[] = kept.map((r) => {
    const m = merged.get(r.id!);
    return { ...r, modelStatus: m?.status ?? "unknown", modelMissing: m?.missing ?? [], evidence: m?.evidence ?? [] };
  });
  const factSources = Object.fromEntries(experiences.flatMap((e) => e.facts.map((f) => [f.id, f.source])));
  const pending = abilities.map((a): AbilityEvidence => ({ ...a, confirmation: "pending" }));
  const ctx: DeriveCtx = { experiences, education, now, jd, abilities: pending, factSources };
  const requirements = withModel.map((r) => derive(r, ctx));
  const reasons = new Map<string, string>();
  for (const c of Array.isArray(data.experience_coverage) ? data.experience_coverage : []) {
    const r = obj(c);
    if (r && str(r.experience_id)) reasons.set(str(r.experience_id), str(r.reason));
  }
  return {
    version: 2,
    requirements,
    abilities,
    experienceCoverage: coverageByExperience(requirements, abilities, experiences, reasons),
    questions: strs(data.questions).slice(0, 5),
    factSources,
  };
}

/** 旧格式匹配结果（只有 coverage/factIds）转成新状态显示；旧结论不能推出真实缺口，一律按未知/需补证据 */
export function fromLegacy(match: MatchResult, experiences: Experience[]): MatchResult {
  if (match.version === 2) return match;
  const facts = new Set(experiences.flatMap((e) => e.facts.map((f) => f.id)));
  return {
    ...match,
    requirements: match.requirements.map((r, i) => {
      const factIds = (r.factIds ?? []).filter((id) => facts.has(id));
      const coverage = r.coverage ?? (factIds.length ? "full" : "none");
      const programJudged = r.educationIds !== undefined || r.experienceIds !== undefined;
      const status: MatchStatus = coverage === "full" && (factIds.length > 0 || programJudged) ? "direct_support" : coverage === "partial" ? "needs_evidence" : "unknown";
      return {
        ...r,
        id: r.id ?? `R${i + 1}`,
        status,
        evidence: factIds.length ? [{ factIds, abilityIds: [], relation: "direct" as const, rationale: "旧版匹配结果，请重新分析以查看理由" }] : [],
        factIds,
      };
    }),
  };
}

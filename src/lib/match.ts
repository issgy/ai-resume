import type { Coverage, Experience, Requirement } from "./types";
import { TERM_RE } from "./validate";

const COVERAGES: Coverage[] = ["full", "partial", "none"];
const RANK: Record<Coverage, number> = { none: 0, partial: 1, full: 2 };

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 「3 年以上」「5年+」「三年及以上」「3-5 年经验」（取下限）等年限要求 */
const YEARS_RE =
  /(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,2})(?:\s*[-~～—至到]\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,2}))?\s*[+＋]?\s*年\s*(以上|及以上|或以上|[+＋])?/g;

function cnNumber(s: string): number {
  if (/^\d/.test(s)) return Number(s);
  if (s.length === 1) return CN_DIGITS[s] ?? NaN;
  // 十一～十九、二十 这类两位写法
  if (s[0] === "十") return 10 + (CN_DIGITS[s[1]] ?? NaN);
  if (s[1] === "十") return (CN_DIGITS[s[0]] ?? NaN) * 10;
  return NaN;
}

/** 要求里的年限下限（如「3 年以上前端开发经验」→ 3）；没有年限要求时返回 null */
export function requiredYears(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(YEARS_RE)) {
    const n = cnNumber(m[1]);
    // 只认带「以上」「+」或出现在经验/工作年限语境里的年数，避免把「2020 年」这类年份当年限
    if (!Number.isFinite(n) || n <= 0 || n > 40) continue;
    if (!m[2] && !/经验|经历|工作|年限|从业/.test(text)) continue;
    max = max === null ? n : Math.max(max, n);
  }
  return max;
}

/** 解析到月份的时间点（月序号 = 年 × 12 + 月 − 1）；只有年份、格式不明时返回 null，不做猜测 */
function parseMonth(s: string, now: Date, isEnd: boolean): number | null {
  const t = (s ?? "").trim();
  if (isEnd && /^(至今|今|现在|目前|present|now)$/i.test(t)) return now.getFullYear() * 12 + now.getMonth();
  const m = t.match(/^(\d{4})\s*(?:[-./]|年)\s*(\d{1,2})\s*月?$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + month - 1;
}

/**
 * 所引事实所在经历的合计任职年数（时间段合并去重、首尾月份都算）。
 * 任一经历的起止时间无法可靠解析时返回 null。
 */
export function experienceYears(exps: Experience[], now = new Date()): number | null {
  const ranges: [number, number][] = [];
  for (const e of exps) {
    const start = parseMonth(e.start, now, false);
    const end = parseMonth(e.end, now, true);
    if (start === null || end === null || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (cur && r[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], r[1]);
    else {
      if (cur) months += cur[1] - cur[0] + 1;
      cur = [r[0], r[1]];
    }
  }
  if (cur) months += cur[1] - cur[0] + 1;
  return months / 12;
}

function cap(c: Coverage, max: Coverage): Coverage {
  return RANK[c] > RANK[max] ? max : c;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) return null;
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}

/** 时长表达：1-2 位数字或中文数字 + 年/年半/个月（不匹配「2024 年」这类 4 位年份） */
const DURATION_RE =
  /(?<!\d)(?:\d{1,2}(?:\.\d+)?|[一二两三四五六七八九十半]{1,3})(?:[-~～至到](?:\d{1,2}|[一二两三四五六七八九十]{1,2}))?(?:年半|年|个月)/g;
/** 纯年限条目里允许出现的修饰词；剩下任何其它字符都视为另有缺口描述 */
const YEARS_FILLER_RE =
  /工作年限|经验年限|从业年限|年限|工作经验|相关经验|经验|工作|从业|以上|不足|不够|未满|未达到|未达|达不到|少于|低于|不到|仅有|只有|仅|约|还|尚|具体|合计|所引经历|实际|要求|需要|缺少|欠缺|差|的|[+＋（）()。.:：]/g;

/**
 * 是否是「纯年限」缺失点（如「1 年 4 个月」「经验年限不足」「只有 2 年经验」），服务端能算出年限时以服务端为准、可以丢弃。
 * 宁可多留不可误删：含并列连接词（，、；且和及等）或除年限外的其它内容（「缺少 2024 年后的项目经历」）一律返回 false。
 */
export function isPureYearsMissing(s: string, requirement = ""): boolean {
  const t = s.replace(/\s+/g, "").replace(/[及或]以上/g, "以上");
  if (/[，,；;、和及与且并/]/.test(t)) return false;
  let rest = t.replace(DURATION_RE, "");
  // 必须真的在说时长或年限，否则不是年限条目
  if (rest === t && !/年限/.test(t)) return false;
  // 年限要求本身的领域词（如「3 年以上前端开发经验」里的「前端开发」）不算额外缺口
  const req = requirement.replace(/\s+/g, "").replace(DURATION_RE, "");
  for (const w of req.replace(YEARS_FILLER_RE, " ").split(" ").filter((w) => w.length >= 2)) rest = rest.split(w).join("");
  return rest.replace(YEARS_FILLER_RE, "") === "";
}

export const COMPOUND_MISSING = "该条包含多项要求，未能逐项确认";

/**
 * 是否是没拆开的复合要求：分隔符与 MATCHER 提示词一致（；; 、 , ， 和 及 或 与 以及 等）。
 * 宁缺勿滥：误判为复合只会把 full 降为 partial；只排除「及以上」「或以上」「参与」这类明显不是并列的写法。
 */
export function isCompoundRequirement(text: string): boolean {
  const t = text.replace(/[及或]以上/g, "以上").replace(/参与/g, "");
  return /[；;、,，和及或与等]/.test(t);
}

/**
 * 校验匹配结果（fail-closed，宁缺勿滥）：大模型的覆盖结论只能被降级、不会被升级。
 * - 结构异常（条目不是对象、factIds/missing 不是字符串数组、coverage 取值不对）一律按缺口处理；
 *   legacy 为 true 时允许没有 coverage 字段的旧数据，按 factIds 是否为空推断后同样走下面的校验
 * - 没有有效 factIds 的一律 none
 * - 要求里的英文技术名、缩写必须出现在所引事实的 source（用户原话）中，否则降为 partial 并写入 missing
 * - 没拆开的复合要求（含「；」「、」「，」「和」「及」「或」「与」「等」等分隔符）不能整条判为 full
 * - 年限要求按所引事实所在经历的起止时间计算，不足或无法解析时不能是 full
 * raw 不是数组时返回 null，由调用方按失败处理。
 */
export function checkRequirements(
  raw: unknown,
  experiences: Experience[],
  opts: { legacy?: boolean; now?: Date } = {},
): Requirement[] | null {
  if (!Array.isArray(raw)) return null;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, { fact: f, exp: e }] as const)));

  return raw.map((item): Requirement => {
    const r = (typeof item === "object" && item !== null && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
    const textOk = typeof r.text === "string" && r.text.trim().length > 0;
    const text = textOk ? (r.text as string).trim() : "（这条要求格式异常，按缺口处理）";
    const type = r.type === "nice" ? "nice" : "must";
    const gap: Requirement = { text, type, factIds: [], coverage: "none", missing: [] };

    const rawIds = strings(r.factIds);
    const modelMissing = r.missing === undefined ? [] : strings(r.missing);
    const coverage: Coverage | null = COVERAGES.includes(r.coverage as Coverage)
      ? (r.coverage as Coverage)
      : r.coverage === undefined && opts.legacy && rawIds
        ? rawIds.length > 0
          ? "full"
          : "none"
        : null;
    if (!textOk || !rawIds || !modelMissing || !coverage) return gap;

    const factIds = [...new Set(rawIds.filter((id) => factById.has(id)))];
    if (factIds.length === 0 || coverage === "none") return { ...gap, missing: modelMissing };

    const cited = factIds.map((id) => factById.get(id)!);
    const years = requiredYears(text);
    const have = years === null ? null : experienceYears([...new Map(cited.map(({ exp }) => [exp.id, exp])).values()], opts.now);
    // 年限能由服务端按起止时间算出时，丢弃模型自己算的年限类缺失点，只保留下面服务端给出的那一条
    const missing = have === null ? modelMissing : modelMissing.filter((s) => !isPureYearsMissing(s, text));

    let result: Coverage = coverage;
    const extra: string[] = [];
    // 模型自己列出了缺失点却又标 full，结论自相矛盾
    if (missing.length > 0) result = cap(result, "partial");

    // 只认用户原话 source；text 是 AI 整理的表述，可能已含幻觉（与 /api/verify 一致）
    const evidence = cited.map(({ fact }) => fact.source).join(" ");
    const evidenceTerms = new Set((evidence.match(TERM_RE) ?? []).map((t) => t.toLowerCase()));
    const unknownTerms = [...new Set((text.match(TERM_RE) ?? []).filter((t) => !evidenceTerms.has(t.toLowerCase())))];
    if (unknownTerms.length > 0) {
      result = cap(result, "partial");
      extra.push(...unknownTerms);
    }

    if (isCompoundRequirement(text)) {
      result = cap(result, "partial");
      extra.push(COMPOUND_MISSING);
    }

    if (years !== null) {
      if (have === null) {
        result = cap(result, "partial");
        extra.push(`经历起止时间不完整，无法核实 ${years} 年年限`);
      } else if (have < years) {
        result = cap(result, "partial");
        extra.push(`${years} 年以上经验（所引经历合计约 ${Math.round(have * 10) / 10} 年）`);
      }
    }

    const allMissing = [...new Set([...missing, ...extra])].filter(
      // 模型写的缺失点已经包含这个技术词时不重复列出
      (s, _, arr) => !extra.includes(s) || !arr.some((o) => o !== s && !extra.includes(o) && o.toLowerCase().includes(s.toLowerCase())),
    );
    return { text, type, factIds, coverage: result, missing: allMissing };
  });
}

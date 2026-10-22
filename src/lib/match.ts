import type { Coverage, Experience } from "./types";

/** 年限计算（程序判断硬门槛用）：要求里的年限下限、经历的不重叠任职时长、不限领域的工作年限 */

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
    // 「3 年以下」「3 年以内」「不超过 3 年」是上限而不是下限，不按最低年限校验
    const before = text.slice(Math.max(0, m.index! - 6), m.index);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 4);
    if (/^\s*[及或]?\s*(以下|以内|之内|内)/.test(after) || /(不得超过|不能超过|不可超过|不超过|不多于|不高于|最多|至多|少于|低于|不满)\s*$/.test(before)) continue;
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

/** 年限要求里不指向具体领域的词：去掉后什么都不剩，就是不限领域的工作年限要求 */
const GENERIC_YEARS_FILLER_RE = /全职|工作经验|工作经历|工作年限|从业经验|从业|经验|工作|以上|及|或|者优先|优先|要求|的|[，,。;；\s]/g;

/** 「1 年以上工作经验」「3年及以上全职工作经验」这类不限领域的年限要求（「相关」「前端开发」等有领域的交给模型） */
export function isGenericYearsRequirement(text: string): boolean {
  if (requiredYears(text) === null) return false;
  return text.replace(YEARS_RE, "").replace(GENERIC_YEARS_FILLER_RE, "") === "";
}

/** 实习、兼职、校园任职 */
const NON_FULLTIME_RE = /实习|兼职|校园|学生会|社团|助教|助研|intern|part[\s-]?time/i;

/** 时长的中文写法：不足 1 年按月，否则保留一位小数 */
function durationLabel(years: number): string {
  const months = Math.round(years * 12);
  return months < 12 ? `${months} 个月` : `${Math.round(years * 10) / 10} 年`;
}

/**
 * 按任职经历（有岗位名的经历；没有岗位名的多是项目经历，不计入）的起止时间合计工作年限。
 * 起止时间解析不了时最多 partial；够年限为 full；不够为缺口并写明实际时长。依据记在 experienceIds。
 */
export function checkWorkYears(
  years: number,
  experiences: Experience[],
  now = new Date(),
  text = "",
): { coverage: Coverage; missing: string[]; experienceIds: string[] } {
  // 能看出是实习、兼职、校园任职的不计入工作年限
  const jobs = experiences.filter((e) => e.title.trim() && !NON_FULLTIME_RE.test(`${e.company} ${e.title}`));
  if (jobs.length === 0) return { coverage: "none", missing: ["履历库里没有正式任职经历（实习、兼职、项目经历不计入）"], experienceIds: [] };
  const have = experienceYears(jobs, now);
  const ids = jobs.map((e) => e.id);
  if (have === null) {
    return { coverage: "partial", missing: [`经历起止时间不完整，无法核实 ${years} 年工作年限`], experienceIds: ids };
  }
  if (have < years) return { coverage: "none", missing: [`需要 ${years} 年以上，任职经历合计约 ${durationLabel(have)}`], experienceIds: ids };
  // 够年限，但程序看不出每段是不是全职（岗位名里不一定写「实习」）：要求明确写「全职」时最多部分覆盖
  if (/全职/.test(text)) {
    return { coverage: "partial", missing: ["无法确认以上经历均为全职，请自行核对"], experienceIds: ids };
  }
  return { coverage: "full", missing: [], experienceIds: ids };
}

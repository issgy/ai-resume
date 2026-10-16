import type { Coverage, Education } from "./types";
import { norm } from "./validate";

/**
 * 学历、专业类要求由程序根据履历库的「教育背景」判断，不交给大模型，也不引用工作经历的事实：
 * 这类要求和工作经历无关，模型找不到依据时容易把所有事实都列上去，还判成「已覆盖」。
 */

/** 学历层次：数字越大越高 */
const LEVELS: [RegExp, number, string][] = [
  [/博士|ph\.?\s?d|doctor/i, 4, "博士"],
  [/硕士|研究生|master|mba|mpa/i, 3, "硕士"],
  [/本科|学士|bachelor|undergraduate/i, 2, "本科"],
  [/大专|专科|高职|associate/i, 1, "大专"],
];
const LEVEL_NAME = ["", "大专", "本科", "硕士", "博士"];

/** 一段文字里提到的学历层次；同时提到多个时，要求取最低（「本科及以上」「本科或硕士」），候选人取最高 */
function levelsIn(s: string): number[] {
  return LEVELS.filter(([re]) => re.test(s)).map(([, n]) => n);
}

/** 是否是学历、专业、院校类要求（这类要求由程序判断） */
const EDU_REQ_RE =
  /学历|学位|本科|硕士|博士|研究生|大专|专科|学士|毕业|(相关|以上)?专业(背景|毕业|出身)?|院校|985|211|双一流|bachelor|master|ph\.?\s?d|degree|graduate/i;
/** 年限、技能这类和学历无关的成分：出现时不当作学历要求，交回模型和其余规则判断 */
const NON_EDU_RE = /\d+\s*年(以上|及以上|\+)?\s*(工作|相关|开发|项目)?经验|经验|熟悉|精通|掌握|熟练|能力|了解/;

export function isEducationRequirement(text: string): boolean {
  return EDU_REQ_RE.test(text) && !NON_EDU_RE.test(text);
}

/** 院校层次类要求：程序无法核实，只能请用户自己确认 */
const SCHOOL_TIER_RE = /985|211|双一流|名校|重点(大学|院校)|qs|top\s?\d+|海外|留学|一本|统招/i;

/** 「计算机、软件工程等相关专业」→ ["计算机", "软件工程"]；没有具体专业名时返回 [] */
function majorKeywords(text: string): string[] {
  const m = text.match(/(.{0,30}?)(?:等)?(?:相关)?专业/);
  if (!m) return [];
  return m[1]
    .replace(/^.*?(?:学历|学位|以上|毕业)[，,、\s]*/, "")
    .replace(/(本科|硕士|博士|研究生|大专|专科|统招|全日制)(及以上|以上)?(学历|学位)?/g, "")
    .split(/[、，,/／或及和与\s]+/)
    .map((w) => w.replace(/(类|方向|领域|学科|相关|等)$/g, "").trim())
    .filter((w) => w.length >= 2 && !/^(相关|理工|理工科|以上|及以上)$/.test(w));
}

/** 结束时间在今天之后的视为在读；只能解析到年份时按该年 7 月毕业估算；解析不了时按已毕业处理 */
function inProgress(end: string, now: Date): boolean {
  if (/至今|在读|present|now/i.test(end)) return true;
  const m = end.match(/(\d{4})(?:\D{1,3}(\d{1,2}))?/);
  if (!m) return false;
  const month = m[2] ? Number(m[2]) : 7;
  return Number(m[1]) * 12 + month - 1 > now.getFullYear() * 12 + now.getMonth();
}

function eduLevel(e: Education): number {
  return Math.max(0, ...levelsIn(e.degree || e.source));
}

export type EducationCheck = { coverage: Coverage; missing: string[]; educationIds: string[] };

/**
 * 判断一条学历/专业要求（宁缺勿滥：不确定时最多 partial）：
 * - 履历库没有教育背景 → 缺口
 * - 学历层次：取要求里的最低层次，和候选人已毕业的最高层次比较；只有在读学历满足时为 partial 并写明在读
 * - 专业：要求里列出的专业名，有一个出现在某段教育背景的专业/原文里即满足；列不出具体专业名时请用户核对
 * - 985/211 等院校层次程序无法核实，最多 partial
 */
export function checkEducation(text: string, education: Education[], now = new Date()): EducationCheck {
  if (education.length === 0) {
    return { coverage: "none", missing: ["履历库没有教育背景"], educationIds: [] };
  }
  const missing: string[] = [];
  let coverage: Coverage = "full";
  let evidence = education;

  const required = levelsIn(text);
  if (required.length > 0) {
    const need = Math.min(...required);
    const meets = education.filter((e) => eduLevel(e) >= need);
    if (meets.length === 0) {
      const best = Math.max(0, ...education.map(eduLevel));
      return {
        coverage: "none",
        missing: [best > 0 ? `${LEVEL_NAME[need]}及以上学历（履历库最高为${LEVEL_NAME[best]}）` : `${LEVEL_NAME[need]}及以上学历（教育背景里没有写明学历）`],
        educationIds: [],
      };
    }
    const done = meets.filter((e) => !inProgress(e.end, now));
    if (done.length > 0) {
      evidence = done;
    } else {
      evidence = meets;
      coverage = "partial";
      missing.push(`${LEVEL_NAME[need]}及以上学历尚未毕业（${meets.map((e) => `${e.degree || LEVEL_NAME[eduLevel(e)]}${e.end ? ` 预计 ${e.end} 毕业` : "在读"}`).join("、")}）`);
    }
  }

  if (/专业/.test(text)) {
    const keys = majorKeywords(text);
    if (keys.length === 0) {
      coverage = "partial";
      missing.push("专业要求未写明具体专业，请自行核对");
    } else {
      const hit = evidence.filter((e) => keys.some((k) => norm(`${e.major} ${e.source}`).includes(norm(k))));
      if (hit.length > 0) evidence = hit;
      else {
        coverage = "partial";
        missing.push(`专业：${keys.join("、")}`);
      }
    }
  }

  // 「2026 届」「26 届毕业生」：毕业年份要对得上
  const cohort = text.match(/(\d{2}|\d{4})\s*届/);
  if (cohort) {
    const year = cohort[1].length === 2 ? `20${cohort[1]}` : cohort[1];
    const hit = evidence.filter((e) => e.end.includes(year));
    if (hit.length > 0) evidence = hit;
    else {
      coverage = "partial";
      missing.push(`${year} 届毕业`);
    }
  } else if (/应届/.test(text)) {
    coverage = "partial";
    missing.push("是否属于应届生请自行确认");
  }

  if (SCHOOL_TIER_RE.test(text)) {
    coverage = "partial";
    missing.push("院校层次要求无法自动核实，请自行确认");
  }

  return { coverage, missing, educationIds: evidence.map((e) => e.id) };
}

/** 浏览器传来的教育背景按结构清洗：缺字段的条目丢弃，不信任任意 JSON */
export function sanitizeEducation(raw: unknown): Education[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return [];
    const r = x as Record<string, unknown>;
    const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
    if (!s("id") || !s("school")) return [];
    const origin = r.origin === "imported" || r.origin === "manual" || r.origin === "edited" ? r.origin : undefined;
    return [{ id: s("id"), school: s("school"), degree: s("degree"), major: s("major"), start: s("start"), end: s("end"), source: s("source"), origin }];
  });
}

/** 教育背景一行展示：北京大学 · 硕士 · 计算机科学与技术 · 2024.09–2027.06 */
export function educationLabel(e: Education): string {
  const time = e.start || e.end ? `${e.start}–${e.end}` : "";
  return [e.school, e.degree, e.major, time].filter(Boolean).join(" · ");
}

/** 判断同一段教育背景：学校 + 学历 */
export function educationKey(e: { school: string; degree: string }): string {
  return `${norm(e.school)}|${norm(e.degree)}`;
}

import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { IMPORTER } from "@/lib/prompts";
import { norm } from "@/lib/validate";
import { BULLET_RE, IMPORT_MAX, IMPORT_MIN, experienceKey, isMetaLine, isSectionLabel, linesToSentences, literalSpan, numberLines } from "@/lib/importText";
import type { ImportResponse, ImportedExperience } from "@/lib/importText";
import type { Profile } from "@/lib/types";

export const maxDuration = 60;

type Parsed = { profile?: Partial<Record<keyof Profile, unknown>>; experiences: unknown[] };

const UNASSIGNED = "\u0000unassigned";
const PROFILE_KEYS = ["name", "phone", "email", "school", "birthday"] as const;

/** 整个请求的解析截止时间：留出余量，保证在路由 maxDuration=60s 之前返回 */
const DEADLINE_MS = 52_000;
/** 剩余时间不足这么多就不再重试 */
const RETRY_MIN_MS = 15_000;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** 模型偶尔会把提示词里的字段说明原样当成值，这些占位词一律视为空 */
const PLACEHOLDER = /^(公司名称|岗位名称|项目名称|项目所属单位|角色|姓名|电话|邮箱|学校|出生日期|无|暂无|未知|N\/?A|null)$/i;
/** 公司、岗位、时间、个人信息都会原样出现在导出的简历上：必须能在原文中找到，并保存原文的原样写法 */
const field = (v: unknown, original: string) => {
  const s = str(v);
  return s && !PLACEHOLDER.test(s) ? literalSpan(s, original) : "";
};

/**
 * 粘贴导入：模型只负责判断结构（个人信息、每段经历的公司/岗位/时间，以及描述所在的行号范围），
 * 事实由程序按行号直接取原文、按句切开逐字保存。这样不依赖排版规则切块，也不给模型改写原文的机会；
 * 带项目符号却没被归到任何经历的行放入「未归类」并提示用户核对，不会静默丢失。
 */
export async function POST(req: Request) {
  const { text: raw } = (await req.json()) as { text?: unknown };
  const text = str(raw);
  if (text.length < IMPORT_MIN) return NextResponse.json({ error: `内容太短（至少 ${IMPORT_MIN} 字）` }, { status: 400 });
  if (text.length > IMPORT_MAX) return NextResponse.json({ error: `内容太长（最多 ${IMPORT_MAX} 字）` }, { status: 400 });

  const lines = text.split(/\r?\n/);
  let parsed: Parsed;
  try {
    parsed = await parseStructure(numberLines(lines), Date.now() + DEADLINE_MS);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "解析失败，请重试" }, { status: 500 });
  }

  const profile: Partial<Profile> = {};
  for (const k of PROFILE_KEYS) {
    const v = field(parsed.profile?.[k], text);
    if (v) profile[k] = v;
  }

  // 先整理各段经历的基本信息，用于识别标题行
  const entries = parsed.experiences.flatMap((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return [];
    const r = e as Record<string, unknown>;
    const exp: ImportedExperience = {
      company: field(r.company, text),
      title: field(r.title, text),
      start: field(r.start, text),
      end: field(r.end, text),
      facts: [],
    };
    return [{ exp, range: toRange(r.factLines, lines.length) }];
  });
  const metas = entries.map(({ exp }) => [exp.company, exp.title, exp.start, exp.end]);
  /**
   * 描述行 → 事实：以句子为单位拼接（处理 PDF 折行、字间空格、小标题），
   * 每条再回到原文核对：source 保存原文里对应的原样片段，text 只比它少了多余空白和「项目简介：」这类前缀。
   * 原文中找不到的返回 null，计入 rejected。
   */
  const toFacts = (own: string[]) =>
    linesToSentences(own, (l) => isMetaLine(l, metas)).map((t) => {
      const source = literalSpan(t, text);
      return source ? { text: t, source } : null;
    });

  // 模型给的起始行号可靠，结束行号常常偏短（长简历尤其明显）。所以每段经历的描述从模型给的起始行开始，
  // 一直延续到下一段经历开始前或下一个板块标题前。空行不作为结束：PDF 复制的文字常在句子中间夹空行
  const starts = entries
    .filter((e) => e.range)
    .map((e) => e.range![0])
    .sort((a, b) => a - b);
  const extend = (range: [number, number]): [number, number] => {
    const next = starts.find((s) => s > range[0]);
    let end = range[1];
    if (next !== undefined) {
      end = next - 1;
    } else {
      end = lines.length;
    }
    // 中途遇到板块标题（技能、教育经历等）就停
    for (let i = range[0]; i <= end; i++) if (isSectionLabel(lines[i - 1])) return [range[0], Math.max(range[0], i - 1)];
    return [range[0], Math.max(range[1], end)];
  };

  let rejected = 0;
  const covered = new Set<number>();
  for (const entry of entries) {
    const { exp } = entry;
    if (entry.range === undefined) {
      rejected++;
      continue;
    }
    if (!entry.range) continue;
    const range = extend(entry.range);
    const own: string[] = [];
    for (let i = range[0]; i <= range[1]; i++) {
      // 范围重叠时，一行只归给先出现的那段经历
      if (covered.has(i)) continue;
      covered.add(i);
      own.push(lines[i - 1]);
    }
    for (const fact of toFacts(own)) {
      if (fact) exp.facts.push(fact);
      else rejected++;
    }
  }

  // 工作/实习/项目板块里带项目符号、却没被归到任何经历的行：放入「未归类」，提示用户到履历库核对。
  // 教育、技能、证书等板块下的内容不属于经历，不计入
  const loose: ImportedExperience = { company: "", title: "", start: "", end: "", facts: [] };
  let unassigned = 0;
  let inExperienceSection = true;
  lines.forEach((line, idx) => {
    if (isSectionLabel(line)) {
      inExperienceSection = EXPERIENCE_SECTION_RE.test(line);
      return;
    }
    if (!inExperienceSection || covered.has(idx + 1) || !BULLET_RE.test(line) || isMetaLine(line, metas)) return;
    const facts = toFacts([line]).filter((f) => f !== null);
    if (facts.length === 0) return;
    unassigned++;
    loose.facts.push(...facts);
  });

  // 按 company + title 合并、事实去重
  const merged: ImportedExperience[] = [];
  const byKey = new Map<string, ImportedExperience>();
  for (const exp of [...entries.map((e) => e.exp), loose]) {
    const key = experienceKey(exp) || UNASSIGNED;
    if (exp.facts.length === 0 && (key === UNASSIGNED || !exp.company)) continue;
    const same = byKey.get(key);
    if (!same) {
      exp.facts = dedupe(exp.facts);
      merged.push(exp);
      byKey.set(key, exp);
      continue;
    }
    same.start ||= exp.start;
    same.end ||= exp.end;
    same.facts = dedupe([...same.facts, ...exp.facts]);
  }

  const body: ImportResponse = { experiences: merged, profile, rejected, unassigned };
  return NextResponse.json(body);
}

/** 工作、实习、项目类板块标题 */
const EXPERIENCE_SECTION_RE = /工作|实习|实践|项目|experience|projects?/i;

/** 行号范围：[起, 止]（1 起、闭区间）；空数组表示没有描述（返回 null）；格式不对或越界返回 undefined */
function toRange(v: unknown, total: number): [number, number] | null | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.length === 0) return null;
  const nums = v.map((x) => (typeof x === "string" ? Number(x) : x));
  if (!nums.every((x) => Number.isInteger(x))) return undefined;
  const a = Math.min(...(nums as number[]));
  const b = Math.max(...(nums as number[]));
  if (a < 1 || b > total) return undefined;
  return [a, b];
}

function dedupe(facts: ImportedExperience["facts"]) {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = norm(f.source);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.reject(new Error("解析超时，请稍后重试"));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("解析超时，请稍后重试")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 返回必须是对象且 experiences 是数组；格式不对时在剩余时间充足时重试一次 */
async function parseStructure(numbered: string, deadline: number): Promise<Parsed> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && deadline - Date.now() < RETRY_MIN_MS) break;
    try {
      const p = await withDeadline(
        callLLMJson<unknown>([
          { role: "system", content: IMPORTER },
          { role: "user", content: numbered },
        ]),
        deadline,
      );
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray((p as Parsed).experiences)) return p as Parsed;
      lastError = new Error("解析结果格式不对，请重试");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("解析失败，请重试");
}

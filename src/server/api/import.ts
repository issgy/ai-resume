import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { callLLMJson } from "@/lib/llm";
import { IMPORTER } from "@/lib/prompts";
import { norm } from "@/lib/validate";
import { BULLET_RE, IMPORT_MAX, IMPORT_MIN, experienceKey, hasExperienceSection, isExperienceSection, isMetaLine, isSectionLabel, linesToSentences, literalSpan, numberLines } from "@/lib/importText";
import type { ImportResponse, ImportedEducation, ImportedExperience } from "@/lib/importText";
import type { Profile } from "@/lib/types";


type Parsed = { profile?: Partial<Record<keyof Profile, unknown>>; experiences: unknown[]; education?: unknown };

const UNASSIGNED = "\u0000unassigned";
const PROFILE_KEYS = ["name", "phone", "email", "school", "birthday"] as const;

/** 整个请求的解析截止时间：留出余量，保证在路由 maxDuration=60s 之前返回 */
const DEADLINE_MS = 52_000;
/** 剩余时间不足这么多就不再重试 */
const RETRY_MIN_MS = 15_000;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** 模型偶尔会把提示词里的字段说明原样当成值，这些占位词一律视为空 */
const PLACEHOLDER = /^(公司名称|岗位名称|项目名称|项目所属单位|角色|姓名|电话|邮箱|学校|出生日期|无|暂无|未知|N\/?A|null|下一(个|段)?(项目|经历)|新(项目|经历)|(项目|经历)\s*\d*|待(补充|填写|定|确认)|x{2,}|占位)$/i;
/** 公司、岗位、时间、个人信息都会原样出现在导出的简历上：必须能在原文中找到，并保存原文的原样写法 */
const field = (v: unknown, original: string) => {
  // 资料里的结构标记（「###下一项目」）不是公司或岗位名
  const s = str(v).replace(/^#+\s*/, "");
  return s && !PLACEHOLDER.test(s) ? literalSpan(s, original) : "";
};

/**
 * 粘贴导入：模型只负责判断结构（个人信息、每段经历的公司/岗位/时间，以及描述所在的行号范围），
 * 事实由程序按行号直接取原文、按句切开逐字保存。这样不依赖排版规则切块，也不给模型改写原文的机会；
 * 带项目符号却没被归到任何经历的行放入「未归类」并提示用户核对，不会静默丢失。
 */
export async function POST(req: Request) {
  const g = await guard<{ text?: unknown }>(req);
  if ("res" in g) return g.res;
  const { text: raw } = g.body ?? {};
  const text = str(raw);
  if (text.length < IMPORT_MIN) return NextResponse.json({ error: `内容太短（至少 ${IMPORT_MIN} 字）` }, { status: 400 });
  if (text.length > IMPORT_MAX) return NextResponse.json({ error: `内容太长（最多 ${IMPORT_MAX} 字）` }, { status: 400 });

  const lines = text.split(/\r?\n/);
  const deadline = Date.now() + DEADLINE_MS;
  let parsed: Parsed;
  try {
    parsed = await parseStructure(numberLines(lines), deadline, hasExperienceSection(lines));
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "解析失败，请重试" }, { status: 500 });
  }

  let result = assemble(parsed, text, lines);
  // 有内容没归到任何经历（多半是模型漏了一段经历）且时间够：把这些行号告诉模型，让它重新完整识别一次，取未归类更少的结果
  if (result.looseLines.length > 0 && deadline - Date.now() >= RETRY_MIN_MS) {
    const hint = `\n\n注意：上次识别漏掉了第 ${result.looseLines.join("、")} 行所在的经历。请重新完整识别，每一段工作、实习、项目经历（包括项目经历板块下的每个项目）都要单独输出一项。`;
    try {
      const again = assemble(await parseStructure(numberLines(lines) + hint, deadline, hasExperienceSection(lines)), text, lines);
      // 只有「未归类更少、事实没变少、第一次识别出的每条事实在重试结果里仍归在同名经历下」才采用重试结果
      if (again.body.unassigned < result.body.unassigned && keepsAssignments(result.body, again.body)) result = again;
    } catch {
      // 重试失败就用第一次的结果
    }
  }
  return NextResponse.json(result.body);
}

/** 第一次已归到具体经历的每条事实，在重试结果里仍在同名经历下（不丢、不改归属） */
function keepsAssignments(first: ImportResponse, again: ImportResponse): boolean {
  const owner = (body: ImportResponse) => {
    const m = new Map<string, string>();
    for (const e of body.experiences) {
      const key = experienceKey(e);
      if (!key) continue; // 未归类
      for (const f of e.facts) m.set(norm(f.source), key);
    }
    return m;
  };
  const before = owner(first);
  const after = owner(again);
  for (const [src, key] of before) if (after.get(src) !== key) return false;
  // 第一次的每条事实（包括「未归类」里的）在重试结果里都要还在，不能静默丢失
  const all = (body: ImportResponse) => new Set(body.experiences.flatMap((e) => e.facts.map((f) => norm(f.source))));
  const againAll = all(again);
  for (const src of all(first)) if (!againAll.has(src)) return false;
  return true;
}

/** 由模型给出的结构组装导入结果；looseLines 是放入「未归类」的原文行号 */
function assemble(parsed: Parsed, text: string, lines: string[]): { body: ImportResponse; looseLines: number[] } {
  const profile: Partial<Profile> = {};
  for (const k of PROFILE_KEYS) {
    const v = field(parsed.profile?.[k], text);
    if (v) profile[k] = v;
  }

  // 教育背景：学校必须能在原文中找到；原文行取模型给的行号（该行要包含学校名），否则用学校名所在的第一行
  const education: ImportedEducation[] = [];
  const eduSeen = new Set<string>();
  for (const e of Array.isArray(parsed.education) ? parsed.education : []) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    const school = field(r.school, text);
    if (!school) continue;
    const n = typeof r.line === "string" ? Number(r.line) : r.line;
    const has = (l: string | undefined) => !!l && norm(l).includes(norm(school));
    const line = Number.isInteger(n) && has(lines[(n as number) - 1]) ? lines[(n as number) - 1] : lines.find(has);
    const item: ImportedEducation = {
      school,
      degree: field(r.degree, text),
      major: field(r.major, text),
      start: field(r.start, text),
      end: field(r.end, text),
      source: (line ?? school).trim(),
    };
    const key = `${norm(item.school)}|${norm(item.degree)}|${norm(item.major)}|${norm(item.start)}`;
    if (eduSeen.has(key)) continue;
    eduSeen.add(key);
    education.push(item);
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
  // 延伸部分里出现「像经历标题」的行（非项目符号、含起止时间），说明模型可能漏识别了一段经历：
  // 在这里停下，标题之后到原本延伸终点的内容放入「未归类」，不自动归给上一段经历
  const orphans: [number, number][] = [];
  const extend = (range: [number, number]): [number, number] => {
    const next = starts.find((s) => s > range[0]);
    let end = next !== undefined ? next - 1 : lines.length;
    // 中途遇到板块标题（技能、教育经历等）就停；模型给的结束行越过板块标题时也以板块标题为准
    let capped = false;
    for (let i = range[0]; i <= Math.max(range[1], end); i++) {
      if (isSectionLabel(lines[i - 1])) {
        end = Math.max(range[0], i - 1);
        capped = true;
        break;
      }
    }
    if (!capped) end = Math.max(range[1], end);
    // 模型给的范围里也可能夹着它漏掉的经历标题，所以从第二行起整段检查
    for (let i = range[0] + 1; i <= end; i++) {
      if (looksLikeHeader(lines[i - 1])) {
        orphans.push([i + 1, end]);
        return [range[0], i - 1];
      }
    }
    return [range[0], end];
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

  const loose: ImportedExperience = { company: "", title: "", start: "", end: "", facts: [] };
  let unassigned = 0;
  const looseLines: number[] = [];
  for (const [from, to] of orphans) {
    const own: string[] = [];
    for (let i = from; i <= to; i++) {
      if (covered.has(i)) continue;
      covered.add(i);
      if (lines[i - 1].trim()) {
        own.push(lines[i - 1]);
        looseLines.push(i);
      }
    }
    const facts = toFacts(own).filter((f) => f !== null);
    if (facts.length === 0) continue;
    unassigned += own.length;
    loose.facts.push(...facts);
  }

  // 工作/实习/项目板块里带项目符号、却没被归到任何经历的行：放入「未归类」，提示用户到履历库核对。
  // 教育、技能、证书等板块下的内容不属于经历，不计入
  // 有板块标题时，第一个标题之前（联系方式、求职意向、个人总结等）不算经历；整份没有板块标题时才全部扫描
  let inExperienceSection = !lines.some(isSectionLabel);
  lines.forEach((line, idx) => {
    if (isSectionLabel(line)) {
      inExperienceSection = isExperienceSection(line);
      return;
    }
    if (!inExperienceSection || covered.has(idx + 1) || !BULLET_RE.test(line) || isMetaLine(line, metas)) return;
    const facts = toFacts([line]).filter((f) => f !== null);
    if (facts.length === 0) return;
    unassigned++;
    looseLines.push(idx + 1);
    loose.facts.push(...facts);
  });

  // 按 company + title 合并、事实去重
  const merged: ImportedExperience[] = [];
  const byKey = new Map<string, ImportedExperience>();
  for (const exp of [...entries.map((e) => e.exp), loose]) {
    // 同公司同岗位、但起止时间不同的是两段任职，不合并
    // 同一份简历里没有开始时间的同名经历无法确认是同一段，各自保留
    const key = experienceKey(exp) ? `${experienceKey(exp)}|${exp.start.trim() ? norm(exp.start) : `#${merged.length}`}` : UNASSIGNED;
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

  const body: ImportResponse = { experiences: merged, education, profile, rejected, unassigned };
  return { body, looseLines };
}

/** 起止时间：2021.07-2023.06、2026 年 6 月--至今、Jan 2022 – Present 等（年份后必须带月份，避免把「2022-2024 年规划」当成时间段） */
const DATE_RANGE_RE =
  /(?:(?:19|20)\d{2}\s*[年./-]\s*\d{1,2}\s*月?|[A-Za-z]{3,9}\.?\s+(?:19|20)\d{2})\s*(?:[-–—~～至到]+|to)\s*(?:(?:19|20)\d{2}\s*[年./-]\s*\d{1,2}\s*月?|[A-Za-z]{3,9}\.?\s+(?:19|20)\d{2}|至今|今|现在|present|now)/i;

/** 描述句常见的开头动词 */
const HEADER_VERB_RE = /^(负责|参与|主导|完成|实现|设计|开发|搭建|推动|带领|协助|优化|维护|组织|策划|撰写|制定|跟进|对接|支持|周期)/;

/**
 * 像一段经历的标题行：不是项目符号开头、不长、不以句末标点结尾，且起止时间在行首或行尾
 * （「字节跳动 | 工程师 | 2021.07-至今」「2021.07-2023.06 腾讯」）；时间写在句子中间的是描述，不算标题
 */
function looksLikeHeader(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 80 || BULLET_RE.test(t) || /[。；;！!？?，,]$/.test(t)) return false;
  const m = t.match(DATE_RANGE_RE);
  if (!m) return false;
  const before = t.slice(0, m.index).trim();
  const after = t.slice(m.index! + m[0].length).trim();
  // 时间在行首：后面必须像「公司 | 岗位」而不是一句描述
  if (before === "") return after.length <= 40 && !/[，,。；;：:]/.test(after) && !/^(期间|内|起|至今)/.test(after) && !HEADER_VERB_RE.test(after);
  // 时间在行尾：前面必须像「公司 | 岗位」而不是一句描述（不含逗号句号、不以「负责、参与」等动词开头）
  if (after !== "" && !/^[|｜/·\-–—\s]*$/.test(after)) return false;
  return before.length <= 40 && !/[，,。；;：:]/.test(before) && !HEADER_VERB_RE.test(before);
}

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
async function parseStructure(numbered: string, deadline: number, expectExperience: boolean): Promise<Parsed> {
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
      if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray((p as Parsed).experiences)) {
        // 原文明明有工作/实习/项目板块，模型却一段经历都没给：视为漏解析，重试；仍为空就报错，不当作导入成功
        if ((p as Parsed).experiences.length > 0 || !expectExperience) return p as Parsed;
        lastError = new Error("没有识别出经历，请重试；如果仍然失败，可以先删去和经历无关的内容再导入");
      } else {
        lastError = new Error("解析结果格式不对，请重试");
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("解析失败，请重试");
}

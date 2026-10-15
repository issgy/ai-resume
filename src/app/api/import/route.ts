import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { IMPORTER } from "@/lib/prompts";
import { norm, sourceInUserText } from "@/lib/validate";
import { IMPORT_MAX, IMPORT_MIN, countHeaders, experienceKey, splitResume } from "@/lib/importText";
import type { ImportResponse, ImportedExperience } from "@/lib/importText";
import type { Profile } from "@/lib/types";

export const maxDuration = 60;

type Parsed = { profile?: Partial<Record<keyof Profile, unknown>>; experiences?: unknown };

const BULLET_RE = /^\s*(?:[-–—•·*●○■□▪]|\d{1,2}[.、)）]|[（(]\d{1,2}[)）])\s*/;

const UNASSIGNED = "\u0000unassigned";

const PROFILE_KEYS = ["name", "phone", "email", "school", "birthday"] as const;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** 模型偶尔会把提示词里的字段说明原样当成值，这些占位词一律视为空 */
const PLACEHOLDER = /^(公司名称|岗位名称|项目名称|项目所属单位|角色|姓名|电话|邮箱|学校|出生日期|无|暂无|未知|N\/?A|null)$/i;
const field = (v: unknown, original: string) => {
  const s = str(v);
  // 公司、岗位必须出现在原文里，避免模型补出原文没有的单位或头衔
  return s && !PLACEHOLDER.test(s) && sourceInUserText(s, original) ? s : "";
};

export async function POST(req: Request) {
  const { text: raw } = (await req.json()) as { text?: unknown };
  const text = str(raw);
  if (text.length < IMPORT_MIN) return NextResponse.json({ error: `内容太短（至少 ${IMPORT_MIN} 字）` }, { status: 400 });
  if (text.length > IMPORT_MAX) return NextResponse.json({ error: `内容太长（最多 ${IMPORT_MAX} 字）` }, { status: 400 });

  // 较长的原文切块并行解析，任一块失败不影响其他块
  const chunks = splitResume(text);
  const settled = await Promise.allSettled(chunks.map((chunk) => parseChunk(chunk)));
  const parsed = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failedChunks = chunks.length - parsed.length;
  if (parsed.length === 0) {
    const reason = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    return NextResponse.json({ error: (reason as Error)?.message || "解析失败，请重试" }, { status: 500 });
  }

  // 个人信息：取各块中第一个非空值，且必须逐字出现在原文里
  const profile: Partial<Profile> = {};
  for (const p of parsed) {
    for (const k of PROFILE_KEYS) {
      const v = str(p.profile?.[k]);
      if (v && !PLACEHOLDER.test(v) && !profile[k] && sourceInUserText(v, text)) profile[k] = v;
    }
  }

  // 经历：按 company + title 合并、事实去重；source 不在原文中的事实丢弃并计数
  let rejected = 0;
  const merged: ImportedExperience[] = [];
  const byKey = new Map<string, ImportedExperience>();
  for (const p of parsed) {
    for (const e of Array.isArray(p.experiences) ? p.experiences : []) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const exp: ImportedExperience = { company: field(r.company, text), title: field(r.title, text), start: str(r.start), end: str(r.end), facts: [] };
      for (const f of Array.isArray(r.facts) ? r.facts : []) {
        // 去掉行首的项目符号/序号，否则同一句话带不带「- 」会被当成两条事实（去掉后仍是原文的连续片段）
        const source = str(f?.source).replace(BULLET_RE, "");
        // text 为空表示与原文相同，直接用原文，减少模型输出长度
        const fact = { text: str(f?.text).replace(BULLET_RE, "") || source, source };
        if (fact.text && sourceInUserText(fact.source, text)) exp.facts.push(fact);
        else rejected++;
      }
      // 看不出属于哪段经历的零散内容（如被切开的尾部、技能清单）合并成一段「未归类」，由用户在履历库里整理
      const key = experienceKey(exp) || UNASSIGNED;
      if (key === UNASSIGNED && exp.facts.length === 0) continue;
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
  }

  const body: ImportResponse = { experiences: merged, profile, rejected, failedChunks, totalChunks: chunks.length };
  return NextResponse.json(body);
}

/** 块与块之间的重复：同一句原文可能被拆成几条事实，所以按 source + text 去重 */
function dedupe(facts: ImportedExperience["facts"]) {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = `${norm(f.source)}|${norm(f.text)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 结果里带事实的经历段数 */
function experienceCount(p: Parsed) {
  return (Array.isArray(p.experiences) ? p.experiences : []).filter(
    (e) => e && typeof e === "object" && Array.isArray((e as { facts?: unknown }).facts) && (e as { facts: unknown[] }).facts.length > 0,
  ).length;
}

/**
 * 解析一块原文。块里有经历标题、模型却少返回了经历时重试一次；仍然不全就按失败处理，
 * 由调用方提示「部分内容解析失败」，不静默漏掉整段经历。
 */
async function parseChunk(chunk: string): Promise<Parsed> {
  const expected = countHeaders(chunk);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const p = await callLLMJson<Parsed>([
        { role: "system", content: IMPORTER },
        { role: "user", content: chunk },
      ]);
      if (!p || typeof p !== "object") throw new Error("解析结果格式不对");
      if (experienceCount(p) >= expected) return p;
      lastError = new Error("有经历没有解析出来");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

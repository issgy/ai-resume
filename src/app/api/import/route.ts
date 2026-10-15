import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { IMPORTER } from "@/lib/prompts";
import { norm, sourceInUserText } from "@/lib/validate";
import { IMPORT_MAX, IMPORT_MIN, experienceKey, splitResume } from "@/lib/importText";
import type { ImportResponse, ImportedExperience } from "@/lib/importText";
import type { Profile } from "@/lib/types";

export const maxDuration = 60;

type Parsed = { profile?: Partial<Record<keyof Profile, unknown>>; experiences?: unknown };

const PROFILE_KEYS = ["name", "phone", "email", "school", "birthday"] as const;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: Request) {
  const { text: raw } = (await req.json()) as { text?: unknown };
  const text = str(raw);
  if (text.length < IMPORT_MIN) return NextResponse.json({ error: `内容太短（至少 ${IMPORT_MIN} 字）` }, { status: 400 });
  if (text.length > IMPORT_MAX) return NextResponse.json({ error: `内容太长（最多 ${IMPORT_MAX} 字）` }, { status: 400 });

  // 较长的原文切块并行解析，任一块失败不影响其他块
  const chunks = splitResume(text);
  const settled = await Promise.allSettled(
    chunks.map((chunk) =>
      callLLMJson<Parsed>([
        { role: "system", content: IMPORTER },
        { role: "user", content: chunk },
      ]),
    ),
  );
  const parsed = settled.flatMap((r) => (r.status === "fulfilled" && r.value && typeof r.value === "object" ? [r.value] : []));
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
      if (v && !profile[k] && sourceInUserText(v, text)) profile[k] = v;
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
      const exp: ImportedExperience = { company: str(r.company), title: str(r.title), start: str(r.start), end: str(r.end), facts: [] };
      for (const f of Array.isArray(r.facts) ? r.facts : []) {
        const fact = { text: str(f?.text), source: str(f?.source) };
        if (fact.text && sourceInUserText(fact.source, text)) exp.facts.push(fact);
        else rejected++;
      }
      const key = experienceKey(exp);
      const same = key ? byKey.get(key) : undefined;
      if (!same) {
        if (!key && exp.facts.length === 0) continue;
        exp.facts = dedupe(exp.facts);
        merged.push(exp);
        if (key) byKey.set(key, exp);
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

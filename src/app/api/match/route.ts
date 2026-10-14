import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { MATCHER } from "@/lib/prompts";
import type { Experience, Requirement } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, experiences } = (await req.json()) as { jd: string; experiences: Experience[] };
  if (!jd || jd.trim().length < 50) {
    return NextResponse.json({ error: "JD 内容太短，请粘贴完整的岗位描述（职责 + 要求）" }, { status: 400 });
  }
  const allFacts = experiences.flatMap((e) =>
    e.facts.map((f) => ({ id: f.id, text: `[${e.company} ${e.title}] ${f.text}` })),
  );
  if (allFacts.length === 0) {
    return NextResponse.json({ error: "履历库还是空的，请先录入经历" }, { status: 400 });
  }
  try {
    const data = await callLLMJson<{ requirements: Requirement[] }>([
      { role: "system", content: MATCHER },
      { role: "user", content: `## JD\n${jd}\n\n## 事实清单\n${JSON.stringify(allFacts)}` },
    ]);
    const ids = new Set(allFacts.map((f) => f.id));
    const requirements = (data.requirements ?? []).map((r) => ({
      text: r.text,
      type: r.type === "nice" ? "nice" : "must",
      factIds: (r.factIds ?? []).filter((id) => ids.has(id)),
    }));
    return NextResponse.json({ requirements });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

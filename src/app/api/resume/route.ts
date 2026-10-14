import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { WRITER } from "@/lib/prompts";
import { checkHighlights } from "@/lib/validate";
import type { Experience, Highlight, Requirement } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, requirements, experiences } = (await req.json()) as {
    jd: string;
    requirements: Requirement[];
    experiences: Experience[];
  };
  const payload = experiences.map((e) => ({
    experienceId: e.id,
    company: e.company,
    title: e.title,
    facts: e.facts.map((f) => ({ id: f.id, text: f.text })),
  }));
  try {
    const data = await callLLMJson<{ highlights: Highlight[] }>([
      { role: "system", content: WRITER },
      {
        role: "user",
        content: `## JD\n${jd}\n\n## 匹配表\n${JSON.stringify(requirements)}\n\n## 经历\n${JSON.stringify(payload)}`,
      },
    ]);
    const { kept, dropped } = checkHighlights(data.highlights ?? [], experiences);
    return NextResponse.json({ highlights: kept, dropped });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

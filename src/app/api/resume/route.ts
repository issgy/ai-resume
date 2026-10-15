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
    facts: e.facts.map((f) => ({ id: f.id, text: f.text, source: f.source })),
  }));
  try {
    // 每段经历单独并行生成：单次输出更短，总耗时约等于最慢的一段，避免整份简历一次生成超时
    const results = await Promise.allSettled(
      payload
        .filter((p) => p.facts.length > 0)
        .map((p) =>
          callLLMJson<{ highlights: Highlight[] }>([
            { role: "system", content: WRITER },
            {
              role: "user",
              content: `## JD\n${jd}\n\n## 匹配表\n${JSON.stringify(requirements)}\n\n## 经历\n${JSON.stringify([p])}`,
            },
          ]),
        ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value.highlights ?? []);
    if (ok.length === 0) {
      const first = results.find((r) => r.status === "rejected");
      throw first?.reason ?? new Error("没有可生成的经历");
    }
    const { kept, dropped } = checkHighlights(ok.flat(), experiences);
    return NextResponse.json({ highlights: kept, dropped });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

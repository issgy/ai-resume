import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { VERIFIER } from "@/lib/prompts";
import { applyVerification, failVerification } from "@/lib/validate";
import type { DroppedHighlight, Experience, Highlight } from "@/lib/types";

export const maxDuration = 60;

/**
 * 亮点内容核验：用强模型逐条检查亮点里的技能、职责、效果能否在所引事实的原话中找到依据。
 * 与撰写分开成独立接口，避免撰写 + 核验串行超出单个接口的时长上限。
 * 每段经历并行核验；某段出错或超时，该段亮点全部剔除（不放行未核验内容）。
 */
export async function POST(req: Request) {
  const { highlights, experiences } = (await req.json()) as { highlights: Highlight[]; experiences: Experience[] };

  const groups = experiences
    .map((exp) => ({ exp, items: highlights.filter((h) => h.experienceId === exp.id) }))
    .filter((g) => g.items.length > 0);
  const orphans = highlights.filter((h) => !experiences.some((e) => e.id === h.experienceId));

  const results = await Promise.all(
    groups.map(async ({ exp, items }) => {
      const cited = new Set(items.flatMap((h) => h.factIds));
      const payload = {
        facts: exp.facts.filter((f) => cited.has(f.id)).map((f) => ({ id: f.id, source: f.source, text: f.text })),
        highlights: items.map((h, index) => ({ index, text: h.text, factIds: h.factIds })),
      };
      try {
        const data = await callLLMJson<unknown>([
          { role: "system", content: VERIFIER },
          { role: "user", content: JSON.stringify(payload) },
        ]);
        // 响应结构未经保证，原样交给 applyVerification 严格校验
        const results = typeof data === "object" && data !== null ? (data as { results?: unknown }).results : undefined;
        return applyVerification(items, results);
      } catch {
        return { kept: [] as Highlight[], dropped: failVerification(items) };
      }
    }),
  );

  const dropped: DroppedHighlight[] = [
    ...results.flatMap((r) => r.dropped),
    ...orphans.map((h) => ({ text: h.text, reason: "未关联到任何经历", factIds: h.factIds })),
  ];
  return NextResponse.json({ highlights: results.flatMap((r) => r.kept), dropped });
}

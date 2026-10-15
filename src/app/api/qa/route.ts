import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { QA_WRITER } from "@/lib/prompts";
import { applyQA, failQA } from "@/lib/validate";
import type { DroppedHighlight, Experience, Highlight } from "@/lib/types";

export const maxDuration = 60;

/**
 * 面试追问与参考回答：只对已通过 /api/verify 核验的亮点生成。
 * 每条亮点单独一次调用、全部并行：单次输出只有 2-3 组问答，总耗时约等于最慢的一条。
 * 某条出错、超时或没返回有效问答，该亮点剔除（fail-closed）；回答不可信的亮点按 GAPS#1 规则剔除。
 */
export async function POST(req: Request) {
  const { jd, highlights, experiences } = (await req.json()) as { jd: string; highlights: Highlight[]; experiences: Experience[] };

  const results = await Promise.all(
    highlights.map(async (h) => {
      const exp = experiences.find((e) => e.id === h.experienceId);
      if (!exp) return applyQA(h, undefined, experiences);
      const payload = {
        highlight: { text: h.text, factIds: h.factIds },
        facts: exp.facts.map((f) => ({ id: f.id, text: f.text, source: f.source })),
      };
      try {
        const data = await callLLMJson<unknown>([
          { role: "system", content: QA_WRITER },
          { role: "user", content: `## JD\n${jd}\n\n## 亮点与事实\n${JSON.stringify(payload)}` },
        ]);
        // 响应结构未经保证，原样交给 applyQA 严格校验
        const questions = typeof data === "object" && data !== null ? (data as { questions?: unknown }).questions : undefined;
        return applyQA(h, questions, experiences);
      } catch {
        return { dropped: failQA([h])[0] };
      }
    }),
  );

  const kept = results.flatMap((r) => (r.kept ? [r.kept] : []));
  const dropped: DroppedHighlight[] = results.flatMap((r) => (r.dropped ? [r.dropped] : []));
  return NextResponse.json({ highlights: kept, dropped });
}

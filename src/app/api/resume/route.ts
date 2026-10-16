import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { WRITER } from "@/lib/prompts";
import { sanitizeEducation } from "@/lib/education";
import { checkRequirements } from "@/lib/match";
import { checkHighlights } from "@/lib/validate";
import type { Experience, Highlight } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, requirements, experiences, education } = (await req.json()) as {
    jd: string;
    requirements: unknown;
    experiences: Experience[];
    education?: unknown;
  };
  // 匹配表来自浏览器存储，可能是旧数据或被改过，按同一规则重新核对；只把核对后的覆盖程度和缺失点交给模型，
  // 缺口和缺失点明确标出，避免模型为了贴合 JD 编造
  const matchTable = checkRequirements(requirements, experiences, { legacy: true, education: sanitizeEducation(education) }) ?? [];
  const payload = experiences.map((e) => ({
    experienceId: e.id,
    company: e.company,
    title: e.title,
    facts: e.facts.map((f) => ({ id: f.id, text: f.text, source: f.source })),
  }));
  try {
    // 每段经历单独并行生成，且只输出亮点（不含面试问答）：单次输出更短，总耗时约等于最慢的一段，避免超时
    const targets = payload.filter((p) => p.facts.length > 0);
    const results = await Promise.allSettled(
      targets.map((p) =>
        callLLMJson<{ highlights: Highlight[] }>([
          { role: "system", content: WRITER },
          {
            role: "user",
            content: `## JD\n${jd}\n\n## 匹配表\n${JSON.stringify(matchTable)}\n\n## 经历\n${JSON.stringify([p])}`,
          },
        ]),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (Array.isArray(r.value.highlights) ? r.value.highlights : []));
    if (ok.length === 0) {
      const first = results.find((r) => r.status === "rejected");
      throw first?.reason ?? new Error("没有可生成的经历");
    }
    // 请求失败或没返回任何亮点的经历要告诉用户，不能静默缺段
    const failedExperienceIds = targets
      .filter((_, i) => {
        const r = results[i];
        return r.status === "rejected" || !Array.isArray(r.value.highlights) || r.value.highlights.length === 0;
      })
      .map((p) => p.experienceId);
    // 这里只写亮点；问答在核验通过后由 /api/qa 生成，模型多给的 questions 一律丢弃
    const raw = ok.flat().map((h) => ({ experienceId: h.experienceId, text: h.text, factIds: h.factIds, questions: [] }));
    const { kept, dropped } = checkHighlights(raw, experiences);
    return NextResponse.json({ highlights: kept, dropped, failedExperienceIds });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

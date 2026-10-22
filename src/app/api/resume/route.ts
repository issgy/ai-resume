import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { WRITER } from "@/lib/prompts";
import { checkHighlights, isInstructionFact } from "@/lib/validate";
import type { AbilityEvidence, Experience, Highlight, Requirement } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, requirements, abilities, experiences } = (await req.json()) as {
    jd: string;
    requirements: unknown;
    abilities?: unknown;
    experiences: Experience[];
  };
  // 匹配表来自浏览器存储：只取撰写需要的字段，事实 id 必须仍在履历库；状态只影响侧重，不放宽核验
  const facts = new Set(experiences.flatMap((e) => e.facts.map((f) => f.id)));
  const matchTable = (Array.isArray(requirements) ? (requirements as Requirement[]) : [])
    .filter((r) => r && typeof r.text === "string")
    .map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      status: r.status ?? r.coverage,
      factIds: (Array.isArray(r.factIds) ? r.factIds : []).filter((id) => facts.has(id)),
      missing: Array.isArray(r.missing) ? r.missing : [],
    }));
  // 只把用户已确认的能力推断交给撰写（R09）；未确认的推断不进入简历
  const confirmed = (Array.isArray(abilities) ? (abilities as AbilityEvidence[]) : [])
    .filter((a) => a?.confirmation === "confirmed" && Array.isArray(a.factIds) && a.factIds.every((id) => facts.has(id)))
    .map((a) => ({ ability: a.ability, factIds: a.factIds }));
  const payload = experiences.map((e) => ({
    experienceId: e.id,
    company: e.company,
    title: e.title,
    // 资料里的指令或备注标出来，撰写时不当作经历使用（R14）
    facts: e.facts.map((f) => ({ id: f.id, text: f.text, source: f.source, ...(isInstructionFact(f) ? { isInstruction: true } : {}) })),
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
            content: `## JD\n${jd}\n\n## 匹配表\n${JSON.stringify(matchTable)}\n\n## 用户已确认的能力（只能写对应的具体行为）\n${JSON.stringify(confirmed)}\n\n## 经历\n${JSON.stringify([p])}`,
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

import { NextResponse } from "next/server";
import { checkExperiences, checkJd, checkList, guard, InputError, inputErrorResponse, LIMITS } from "@/lib/guard";
import { callLLMJson } from "@/lib/llm";
import { WRITER } from "@/lib/prompts";
import { checkHighlights, isInstructionFact, tidyBullet } from "@/lib/validate";
import type { AbilityEvidence, Disposition, Experience, Highlight, Requirement, Selection, UnusedFact } from "@/lib/types";

const SELECTIONS: Selection[] = ["expanded", "condensed", "optional"];
const LEVELS: Disposition["level"][] = ["expanded", "condensed", "optional"];


export async function POST(req: Request) {
  const g = await guard<{ jd: string; requirements: unknown; abilities?: unknown; experiences: Experience[] }>(req);
  if ("res" in g) return g.res;
  const { jd, requirements, abilities, experiences } = g.body;
  try {
    checkJd(jd);
    checkExperiences(experiences);
    checkList(requirements, LIMITS.requirements, "JD 要求");
    checkList(abilities, LIMITS.abilities, "能力推断");
    if (!Array.isArray(experiences)) throw new InputError("经历数据格式不正确");
  } catch (e) {
    return inputErrorResponse(e)!;
  }
  // 匹配表来自浏览器存储：只取撰写需要的字段，事实 id 必须仍在履历库；状态只影响侧重，不放宽核验
  const facts = new Set(experiences.flatMap((e) => e.facts.map((f) => f.id)));
  // 只把用户已确认的能力推断交给撰写（R09）；未确认的推断不进入简历
  const confirmedList = (Array.isArray(abilities) ? (abilities as AbilityEvidence[]) : []).filter(
    (a) => a?.confirmation === "confirmed" && Array.isArray(a.factIds) && a.factIds.every((id) => facts.has(id)),
  );
  const confirmedIds = new Set(confirmedList.map((a) => a.id));
  const confirmed = confirmedList.map((a) => ({ ability: a.ability, factIds: a.factIds }));
  const SUPPORTIVE = ["direct_support", "transferable_support", "expression_gap"];
  const matchTable = (Array.isArray(requirements) ? (requirements as Requirement[]) : [])
    .filter((r) => r && typeof r.text === "string")
    .map((r) => {
      // 兜底：即使客户端传来的证据引用了未确认推断，也去掉；只靠它支持的要求按「需补证据」交给撰写
      // 联合证据：任何一个依赖不可用（事实已删除、推断未确认），整条证据都不计入
      const evidence = (Array.isArray(r.evidence) ? r.evidence : []).filter(
        (e) =>
          (e.factIds ?? []).length + (e.abilityIds ?? []).length > 0 &&
          (e.factIds ?? []).every((id) => facts.has(id)) &&
          (e.abilityIds ?? []).every((id) => confirmedIds.has(id)),
      );
      const status = r.status ?? r.coverage;
      return {
        id: r.id,
        text: r.text,
        category: r.category,
        status: r.evidence && SUPPORTIVE.includes(String(status)) && evidence.length === 0 ? "needs_evidence" : status,
        factIds: r.evidence ? [...new Set(evidence.flatMap((e) => e.factIds))] : (Array.isArray(r.factIds) ? r.factIds : []).filter((id) => facts.has(id)),
        missing: Array.isArray(r.missing) ? r.missing : [],
      };
    });
  const payload = experiences.map((e) => ({
    experienceId: e.id,
    company: e.company,
    title: e.title,
    // 资料里的指令或备注标出来，撰写时不当作经历使用（R14）
    facts: e.facts.map((f) => ({ id: f.id, text: f.text, source: f.source, ...(isInstructionFact(f) ? { isInstruction: true } : {}) })),
  }));
  try {
    // 每段经历单独并行生成，且只输出亮点（不含面试问答）：单次输出更短，总耗时约等于最慢的一段，避免超时
    // 没有公司和岗位的记录（未归类内容）不进入成稿（T10）：先在履历库补上公司或岗位
    const targets = payload.filter((p) => p.facts.length > 0 && (p.company.trim() || p.title.trim()));
    const results = await Promise.allSettled(
      targets.map((p) =>
        callLLMJson<unknown>([
          { role: "system", content: WRITER },
          {
            role: "user",
            content: `## JD\n${jd}\n\n## 匹配表\n${JSON.stringify(matchTable)}\n\n## 用户已确认的能力（只能写对应的具体行为）\n${JSON.stringify(confirmed)}\n\n## 经历\n${JSON.stringify(p)}`,
          },
        ]),
      ),
    );
    const reqIds = new Set(matchTable.map((r) => r.id).filter(Boolean));
    const raw: Highlight[] = [];
    const dispositions: Disposition[] = [];
    const unused: UnusedFact[] = [];
    const failedExperienceIds: string[] = [];
    targets.forEach((p, i) => {
      const r = results[i];
      const data = r.status === "fulfilled" && r.value && typeof r.value === "object" ? (r.value as Record<string, unknown>) : null;
      const items = Array.isArray(data?.highlights) ? (data!.highlights as Record<string, unknown>[]) : [];
      // 请求失败或没返回任何句子的经历要告诉用户，不能静默缺段
      if (!data || items.length === 0) {
        failedExperienceIds.push(p.experienceId);
        return;
      }
      for (const h of items) {
        if (!h || typeof h.text !== "string") continue;
        raw.push({
          // 每次只写一段经历，归属以请求的经历为准（模型写错 id 时由所引事实再核对）
          experienceId: p.experienceId,
          text: tidyBullet(h.text),
          factIds: Array.isArray(h.factIds) ? (h.factIds as unknown[]).filter((x): x is string => typeof x === "string") : [],
          requirementIds: Array.isArray(h.requirementIds) ? (h.requirementIds as unknown[]).filter((x): x is string => typeof x === "string" && reqIds.has(x)) : [],
          selection: SELECTIONS.includes(h.selection as Selection) ? (h.selection as Selection) : "expanded",
          questions: [],
        });
      }
      const d = data.disposition as Record<string, unknown> | undefined;
      const level = d && LEVELS.includes(d.level as Disposition["level"]) ? (d.level as Disposition["level"]) : undefined;
      if (level) dispositions.push({ experienceId: p.experienceId, level, reason: typeof d!.reason === "string" ? d!.reason : "" });
      // 没写进句子的事实：模型给的原因；模型漏写的由程序补上（R10：资产不静默消失）
      const cited = new Set(items.flatMap((h) => (Array.isArray(h.factIds) ? (h.factIds as string[]) : [])));
      const reasons = new Map(
        (Array.isArray(data.unused) ? (data.unused as Record<string, unknown>[]) : [])
          .filter((u) => u && typeof u.factId === "string")
          .map((u) => [u.factId as string, typeof u.reason === "string" ? u.reason : ""]),
      );
      for (const f of p.facts) if (!cited.has(f.id)) unused.push({ experienceId: p.experienceId, factId: f.id, reason: reasons.get(f.id) || "本次撰写没有用到" });
    });
    if (raw.length === 0 && failedExperienceIds.length === targets.length) {
      const first = results.find((r) => r.status === "rejected");
      throw (first as PromiseRejectedResult | undefined)?.reason ?? new Error("没有可生成的经历");
    }
    // 一致性：直接或可迁移支持了必需要求的句子至少算「次相关」，不能只作为可选内容（S5：相关且有支持的内容优先）
    // 只看「直接支持」必需的职责/专业能力/硬性条件；可迁移的软能力支持不强制放进简历
    const coreSupported = new Map(
      matchTable
        .filter((r) => r.id && r.status === "direct_support" && ["core_responsibility", "professional_ability", "hard_gate"].includes(String(r.category)))
        .map((r) => [r.id!, r.text]),
    );
    for (const h of raw) {
      if (h.selection === "optional" && (h.requirementIds ?? []).some((id) => coreSupported.has(id))) h.selection = "condensed";
    }
    for (const d of dispositions) {
      const lifted = raw.filter((h) => h.experienceId === d.experienceId && h.selection !== "optional");
      if (d.level === "optional" && lifted.length > 0) {
        const req = lifted.flatMap((h) => h.requirementIds ?? []).map((id) => coreSupported.get(id)).find(Boolean);
        d.level = "condensed";
        d.reason = `直接支持岗位必需要求${req ? `「${req}」` : ""}，至少保留一条`;
      }
    }
    // 这里只写简历句；问答在核验通过后由 /api/qa 生成
    const { kept, dropped } = checkHighlights(raw, experiences);
    return NextResponse.json({ highlights: kept, dropped, failedExperienceIds, dispositions, unused });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

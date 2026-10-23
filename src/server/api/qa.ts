import { NextResponse } from "next/server";
import { checkExperiences, checkHighlights, checkJd, guard, InputError, inputErrorResponse } from "@/lib/guard";
import { callLLMJson } from "@/lib/llm";
import { QA_WRITER } from "@/lib/prompts";
import { callVerifier } from "@/lib/verifier";
import { checkAnswer, failQA, isInsufficient, needsDetails, parseQuestions, pickQuestions, verdictPasses } from "@/lib/validate";
import type { Experience, Highlight, QA } from "@/lib/types";


/**
 * 面试准备（交接包 03-M6、02 InterviewItem）：只为可导出（ready）的简历句生成，每句单独一次调用、全部并行。
 * - 参考回答只用来源事实；数字/英文名词按规则检查，中文断言再用同一个核验模型检查（R13，与简历句同一事实边界）
 * - 来源不足或回答含无依据内容 → 该题 needs_details：隐藏草稿、列出待补细节
 * - 面试准备的任何结果（包括调用失败）都不改变简历句的导出状态，也不删除事实（R07）
 */
export async function POST(req: Request) {
  const g = await guard<{ jd: string; highlights: Highlight[]; experiences: Experience[] }>(req);
  if ("res" in g) return g.res;
  const { jd, highlights, experiences } = g.body;
  try {
    checkJd(jd);
    checkHighlights(highlights);
    checkExperiences(experiences);
    if (!Array.isArray(highlights) || !Array.isArray(experiences)) throw new InputError("请求格式不正确");
  } catch (e) {
    return inputErrorResponse(e)!;
  }

  const results = await Promise.all(
    highlights.map(async (h): Promise<Highlight> => {
      const exp = experiences.find((e) => e.id === h.experienceId);
      if (!exp || (h.exportStatus ?? "ready") !== "ready") return h;
      const facts = exp.facts.filter((f) => h.factIds.includes(f.id));
      const payload = {
        highlight: { text: h.text, factIds: h.factIds },
        facts: exp.facts.map((f) => ({ id: f.id, text: f.text, source: f.source })),
      };
      let parsed: QA[] | null;
      try {
        const data = await callLLMJson<unknown>([
          { role: "system", content: QA_WRITER },
          { role: "user", content: `## JD\n${jd}\n\n## 简历句与事实\n${JSON.stringify(payload)}` },
        ]);
        parsed = parseQuestions(typeof data === "object" && data !== null ? (data as { questions?: unknown }).questions : undefined);
      } catch {
        parsed = null;
      }
      if (!parsed) return { ...failQA([h])[0] };

      // 规则检查后，把还有草稿的回答交给核验模型逐句检查中文断言
      const questions = parsed.map((qa) => checkAnswer(qa, exp.facts, facts));
      const drafts = questions.map((qa, i) => ({ qa, i })).filter(({ qa }) => !isInsufficient(qa));
      if (drafts.length > 0) {
        const cited = exp.facts.filter((f) => drafts.some(({ qa }) => (qa.factIds ?? []).includes(f.id)));
        const verdicts = await callVerifier(cited, drafts.map(({ qa }) => ({ text: qa.a, factIds: qa.factIds ?? [] })));
        drafts.forEach(({ qa, i }, k) => {
          const v = verdicts?.get(k);
          if (!v) {
            questions[i] = { ...needsDetails(qa, ["参考回答核验请求失败，暂不展示；点「重新生成追问」重试"]), retryable: true };
          } else if (!verdictPasses(v)) {
            const bad = v.checks.filter((c) => !c.supported || c.conflict).map((c) => c.claim);
            questions[i] = needsDetails(qa, bad.length ? [`你的原话里没有：${bad.slice(0, 3).map((c) => `「${c}」`).join("")}`] : []);
          }
        });
      }
      // 每个回答保存所依据事实的原话快照，事实之后被修改时可单独失效
      const withSources = questions.map((qa) =>
        isInsufficient(qa) ? qa : { ...qa, sources: Object.fromEntries(exp.facts.filter((f) => (qa.factIds ?? []).includes(f.id)).map((f) => [f.id, f.source])) },
      );
      return { ...h, questions: pickQuestions(withSources), qaFailed: false, qaError: undefined };
    }),
  );

  return NextResponse.json({ highlights: results, dropped: [] });
}

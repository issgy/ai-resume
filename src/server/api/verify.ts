import { NextResponse } from "next/server";
import { checkExperiences, checkHighlights, guard, InputError, inputErrorResponse } from "@/lib/guard";
import { callVerifier } from "@/lib/verifier";
import { verifyExperience } from "@/lib/verifyFlow";
import type { DroppedHighlight, Experience, Highlight } from "@/lib/types";


/**
 * 逐句事实核验（交接包 03-M5、02 S6）：
 * 1. 把句子拆成行动、数字、范围、角色、结果等断言逐个判断；全部有依据 → ready
 * 2. 部分无依据 → 采用模型给出的「忠实缩小」句，再核验一次；通过 → ready（记录删去了什么）
 * 3. 缩小后仍不通过、或给不出缩小句 → 退回所引事实的原话（原话本身就是来源）→ ready
 * 4. 与原话明确矛盾 → blocked（不导出，写明冲突）
 * 5. 模型调用失败或结论结构不可信 → pending + technical_error（不导出、可重试），不判为「找不到依据」
 * 任何情况都不删除履历事实；一句有问题不影响同一经历的其他句子。
 */
export async function POST(req: Request) {
  const g = await guard<{ highlights: Highlight[]; experiences: Experience[] }>(req);
  if ("res" in g) return g.res;
  const { highlights, experiences } = g.body;
  try {
    checkHighlights(highlights);
    checkExperiences(experiences);
    if (!Array.isArray(highlights) || !Array.isArray(experiences)) throw new InputError("请求格式不正确");
  } catch (e) {
    return inputErrorResponse(e)!;
  }

  const groups = experiences
    .map((exp) => ({ exp, items: highlights.filter((h) => h.experienceId === exp.id) }))
    .filter((g) => g.items.length > 0);
  const orphans = highlights.filter((h) => !experiences.some((e) => e.id === h.experienceId));

  const results = await Promise.all(groups.map(({ exp, items }) => verifyExperience(exp, items, callVerifier)));

  const dropped: DroppedHighlight[] = orphans.map((h) => ({ text: h.text, reason: "模型给出的句子没有对应任何经历（不影响履历库里的事实）", factIds: h.factIds }));
  return NextResponse.json({ highlights: results.flat(), dropped });
}


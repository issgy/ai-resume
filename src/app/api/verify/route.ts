import { NextResponse } from "next/server";
import { callVerifier } from "@/lib/verifier";
import { failVerification, fallbackText, ruleIssues, verdictPasses } from "@/lib/validate";
import type { VerifyVerdict } from "@/lib/validate";
import type { DroppedHighlight, Experience, Highlight } from "@/lib/types";

export const maxDuration = 60;

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
  const { highlights, experiences } = (await req.json()) as { highlights: Highlight[]; experiences: Experience[] };

  const groups = experiences
    .map((exp) => ({ exp, items: highlights.filter((h) => h.experienceId === exp.id) }))
    .filter((g) => g.items.length > 0);
  const orphans = highlights.filter((h) => !experiences.some((e) => e.id === h.experienceId));

  const results = await Promise.all(groups.map(({ exp, items }) => verifyExperience(exp, items)));

  const dropped: DroppedHighlight[] = orphans.map((h) => ({ text: h.text, reason: "模型给出的句子没有对应任何经历（不影响履历库里的事实）", factIds: h.factIds }));
  return NextResponse.json({ highlights: results.flat(), dropped });
}

const quote = (claims: string[]) => claims.map((c) => `「${c}」`).join("");

async function verifyExperience(exp: Experience, items: Highlight[]): Promise<Highlight[]> {
  const out = new Map<number, Highlight>();
  items.forEach((h, i) => {
    if (h.exportStatus === "blocked") out.set(i, h);
  });
  const todo = items.map((h, i) => ({ h, i })).filter(({ h }) => h.exportStatus !== "blocked");
  const result = () => items.map((h, i) => out.get(i) ?? h);
  if (todo.length === 0) return result();

  const factsOf = (h: Highlight) => exp.facts.filter((f) => h.factIds.includes(f.id));
  // 只把所引事实交给核验模型：结论只针对这句引用的来源，跨阶段沿用同一组事实 id
  const cited = exp.facts.filter((f) => todo.some(({ h }) => h.factIds.includes(f.id)));

  const round1 = await callVerifier(cited, todo.map(({ h }) => h));
  if (!round1) {
    failVerification(todo.map(({ h }) => h)).forEach((h, k) => out.set(todo[k].i, h));
    return result();
  }

  const fallback = (h: Highlight, claims: string[], why: string): Highlight => {
    const text = fallbackText(factsOf(h));
    if (!text) {
      return { ...h, exportStatus: "blocked", issueType: "unsupported_assertion", note: `${quote(claims)}在你的原话中找不到依据，且没有可退回的原话，不会导出` };
    }
    return {
      ...h,
      text,
      originalText: h.text,
      exportStatus: "ready",
      issueType: null,
      note: `${why}，已退回你的原话${claims.length ? `（删去了${quote(claims)}）` : ""}`,
    };
  };

  const recheck: { i: number; h: Highlight; revised: string; claims: string[]; checks: VerifyVerdict["checks"] }[] = [];
  todo.forEach(({ h, i }, k) => {
    const v = round1.get(k);
    if (!v) {
      out.set(i, { ...h, exportStatus: "pending", issueType: "technical_error", note: "核验没有返回这句的结论，暂未核验，不会导出；可以点「重试」" });
      return;
    }
    const facts = factsOf(h);
    const conflicts = v.checks.filter((c) => c.conflict);
    if (v.issue === "source_conflict" || conflicts.length > 0) {
      out.set(i, {
        ...h,
        exportStatus: "blocked",
        issueType: "source_conflict",
        assertionChecks: v.checks,
        note: `与你的原话存在矛盾${conflicts.length ? `：${quote(conflicts.map((c) => c.claim))}` : ""}${conflicts[0]?.reason ? `（${conflicts[0].reason}）` : ""}，请到履历库核对来源`,
      });
      return;
    }
    const modelClaims = v.checks.filter((c) => !c.supported).map((c) => c.claim);
    // 规则发现的数字/英文名词已包含在模型指出的说法里时不重复列出
    const claims = [...new Set([...modelClaims, ...ruleIssues(h.text, facts).filter((t) => !modelClaims.some((c) => c.includes(t)))])];
    if (verdictPasses(v) && claims.length === 0) {
      out.set(i, { ...h, exportStatus: "ready", issueType: null, assertionChecks: v.checks });
      return;
    }
    // 部分无依据：先缩小句子，再重验（02 ResumeBullet.assertion_checks）
    const revised = v.revised && v.revised !== h.text && ruleIssues(v.revised, facts).length === 0 ? v.revised : "";
    if (revised) recheck.push({ i, h, revised, claims, checks: v.checks });
    else out.set(i, fallback(h, claims, "这句有说法在原话中找不到依据"));
  });

  if (recheck.length > 0) {
    const round2 = await callVerifier(cited, recheck.map((r) => ({ text: r.revised, factIds: r.h.factIds })));
    recheck.forEach((r, j) => {
      const v = round2?.get(j);
      if (v && verdictPasses(v) && ruleIssues(r.revised, factsOf(r.h)).length === 0) {
        out.set(r.i, {
          ...r.h,
          text: r.revised,
          originalText: r.h.text,
          exportStatus: "ready",
          issueType: null,
          assertionChecks: r.checks,
          note: `已删去原话中找不到依据的说法：${quote(r.claims)}`,
        });
      } else {
        // 第二轮失败（无论是核验不通过还是调用出错）都退回原话：原话就是来源，不需要再调用模型
        out.set(r.i, fallback(r.h, r.claims, "缩小后的句子仍未通过核验"));
      }
    });
  }
  return result();
}

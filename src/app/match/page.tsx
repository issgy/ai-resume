"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorText, PageHeader } from "@/components/ui";
import { KEYS, useStored } from "@/lib/storage";
import type { AbilityEvidence, Education, Experience, MatchResult, MatchStatus, Requirement, RequirementCategory } from "@/lib/types";
import { educationLabel } from "@/lib/education";
import { abilityKey, refreshMatch } from "@/lib/matching";
import type { AbilityDecisions } from "@/lib/matching";
import { attachResumeRedirect, experienceLabel, runMatch, runResume, useJobs } from "@/lib/jobs";

/** 02 Match.status 的展示：用户一眼区分「有依据」「需补证据」「材料没提到」「明确不满足」 */
const STATUS: Record<MatchStatus, { label: string; badge: string; row: string }> = {
  direct_support: { label: "直接支持", badge: "bg-emerald-100 text-emerald-700", row: "border-emerald-200 bg-emerald-50/40" },
  transferable_support: { label: "可迁移支持", badge: "bg-sky-100 text-sky-800", row: "border-sky-200 bg-sky-50/40" },
  expression_gap: { label: "有相关经历·表述不足", badge: "bg-sky-100 text-sky-800", row: "border-sky-200 bg-sky-50/40" },
  needs_evidence: { label: "需补证据", badge: "bg-amber-100 text-amber-800", row: "border-amber-200 bg-amber-50/40" },
  unknown: { label: "材料未提到", badge: "bg-slate-100 text-slate-600", row: "border-line bg-paper/60" },
  actual_gap: { label: "明确不满足", badge: "bg-rose-100 text-rose-700", row: "border-rose-200 bg-rose-50/40" },
};
const CATEGORY: Record<RequirementCategory, string> = {
  hard_gate: "硬性条件",
  core_responsibility: "核心职责",
  professional_ability: "专业能力",
  soft_ability: "软能力",
  bonus: "加分项",
};
const GATE = { met: "门槛已满足", not_met: "门槛未满足", unknown: "门槛待确认", not_applicable: "" } as const;

export default function MatchPage() {
  const router = useRouter();
  const [experiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [stored] = useStored<MatchResult | null>(KEYS.match, null);
  const [jdDraft] = useStored<string>(KEYS.jdDraft, "");
  const [education] = useStored<Education[]>(KEYS.education, []);
  const [decisions, setDecisions] = useStored<AbilityDecisions>(KEYS.abilityDecisions, {});
  const eduById = new Map(education.map((e) => [e.id, e]));
  const [jd, setJd] = useState("");
  // 任务在 jobs 模块里后台运行，离开本页不会中断；回到本页时仍能看到进行中的阶段
  const jobs = useJobs();
  const loading = jobs.resume ?? jobs.match ?? "";

  const currentJd = jd || stored?.jd || jdDraft;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, { ...f, exp: e }] as const)));
  // 存下的结果按当前履历库和用户的推断确认记录重新整理（事实被删的证据去掉，被拒绝的推断不再支持要求）
  const match = stored ? refreshMatch(stored, decisions, experiences, education) : null;
  const requirements: Requirement[] = match?.requirements ?? [];
  const abilities = match?.abilities ?? [];
  const abilityById = new Map(abilities.map((a) => [a.id, a]));
  const reqById = new Map(requirements.map((r) => [r.id, r]));

  // 生成完成时用户仍在本页才跳转到简历页；已离开则由顶部导航提示，不强行拽走
  useEffect(() => attachResumeRedirect(() => router.push("/resume")), [router]);

  const decide = (a: AbilityEvidence, d: "confirmed" | "rejected" | null) =>
    setDecisions((prev) => {
      const next = { ...prev };
      const k = abilityKey(a, experiences);
      if (d) next[k] = d;
      else delete next[k];
      return next;
    });

  const counts = requirements.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status ?? "unknown"]: (m[r.status ?? "unknown"] ?? 0) + 1 }), {});
  const pendingAbilities = abilities.filter((a) => a.confirmation === "pending").length;

  const factLine = (id: string) => {
    const f = factById.get(id);
    return f ? (
      <li key={id} className="flex gap-2">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span>
          {f.text} <span className="text-xs text-muted">· {experienceLabel(f.exp)}</span>
        </span>
      </li>
    ) : null;
  };

  return (
    <div className="space-y-6">
      <PageHeader step="03" title="JD 匹配" desc="粘贴目标岗位的完整 JD。一段经历可以支持多项要求，一项要求可以由多段经历共同支持；没有依据的要求会标出来，绝不虚构。" />

      <Card className="space-y-4">
        <textarea
          className="field resize-y !p-4 leading-relaxed"
          rows={8}
          placeholder="粘贴目标岗位的完整 JD（岗位职责 + 任职要求）"
          value={currentJd}
          onChange={(e) => setJd(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">{currentJd.trim().length} 字</span>
          <Button variant="accent" onClick={() => runMatch(currentJd, experiences)} disabled={!!loading || !currentJd.trim()}>
            {loading === "match" ? "分析中…" : "分析匹配"}
          </Button>
        </div>
      </Card>
      <ErrorText>{jobs.error}</ErrorText>

      {match && (
        <Card className="animate-rise space-y-5">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">匹配表</h2>
            {stored?.version !== 2 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">这是旧版匹配结果，没有逐条理由和能力推断，建议点「分析匹配」重新分析。</p>
            )}
            {/* 不输出匹配率：按状态计数（02 Match：不把引用数、关键词命中转成匹配率） */}
            <div className="flex flex-wrap gap-1.5 text-xs">
              {(Object.keys(STATUS) as MatchStatus[])
                .filter((s) => counts[s])
                .map((s) => (
                  <span key={s} className={`rounded-full px-2 py-0.5 ${STATUS[s].badge}`}>
                    {STATUS[s].label} {counts[s]}
                  </span>
                ))}
            </div>
          </div>

          <ul className="space-y-3">
            {requirements.map((r, i) => {
              const status = STATUS[r.status ?? "unknown"];
              return (
                <li key={r.id ?? i} className={`grid gap-3 rounded-2xl border p-4 sm:grid-cols-[2fr_3fr] ${status.row}`}>
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.type === "must" ? "bg-ink text-white" : "bg-accent-soft text-accent"}`}>
                        {r.category ? CATEGORY[r.category] : r.type === "must" ? "必须" : "加分"}
                      </span>
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${status.badge}`}>{status.label}</span>
                      {r.hardGate && GATE[r.hardGate] && (
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${r.hardGate === "met" ? "bg-emerald-50 text-emerald-700" : r.hardGate === "not_met" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
                          {GATE[r.hardGate]}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-medium">{r.text}</div>
                    {r.jdQuote && r.jdQuote !== r.text && <div className="text-xs text-muted">JD 原文：「{r.jdQuote}」</div>}
                    {r.ambiguity && <div className="text-xs text-muted">待确认：{r.ambiguity}</div>}
                  </div>
                  <div className="space-y-2 text-sm">
                    {r.experienceIds ? (
                      <ul className="space-y-1.5">
                        {r.experienceIds.map((id) => {
                          const e = experiences.find((x) => x.id === id);
                          return e ? (
                            <li key={id} className="flex gap-2">
                              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${r.coverage === "full" ? "bg-emerald-500" : "bg-amber-500"}`} />
                              <span>
                                {[experienceLabel(e), e.start || e.end ? `${e.start}–${e.end}` : ""].filter(Boolean).join(" · ")} <span className="text-xs text-muted">· 任职经历</span>
                              </span>
                            </li>
                          ) : null;
                        })}
                      </ul>
                    ) : r.educationIds ? (
                      r.educationIds.length === 0 && r.missing?.[0] === "履历库没有教育背景" ? (
                        <span className="text-amber-800">
                          履历库还没有教育背景，<Link href="/vault" className="underline underline-offset-4">去履历库补充</Link>
                        </span>
                      ) : (
                        <ul className="space-y-1.5">
                          {r.educationIds.map((id) => {
                            const e = eduById.get(id);
                            return e ? (
                              <li key={id} className="flex gap-2">
                                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                                <span>
                                  {educationLabel(e)} <span className="text-xs text-muted">· 教育背景</span>
                                </span>
                              </li>
                            ) : null;
                          })}
                        </ul>
                      )
                    ) : (r.evidence ?? []).length === 0 ? (
                      <span className="text-muted">履历库里没有找到对应的经历（材料没写不等于不具备），不会在简历中虚构</span>
                    ) : (
                      (r.evidence ?? []).map((ev, j) => (
                        <div key={j} className="space-y-1 rounded-xl bg-white/60 p-2">
                          <div className="text-xs">
                            <span className={`mr-1 rounded-full px-1.5 py-0.5 ${ev.relation === "direct" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-800"}`}>
                              {ev.relation === "direct" ? "直接" : "可迁移"}
                            </span>
                            <span className="text-slate-600">{ev.rationale}</span>
                          </div>
                          <ul className="space-y-1">{ev.factIds.map(factLine)}</ul>
                          {ev.abilityIds.map((id) => {
                            const a = abilityById.get(id);
                            return a ? (
                              <div key={id} className="text-xs text-slate-600">
                                能力推断「{a.ability}」{a.confirmation === "confirmed" ? "（你已认可）" : "（待你确认，见下方）"}
                              </div>
                            ) : null;
                          })}
                        </div>
                      ))
                    )}
                    {!!r.missing?.length && <p className="text-amber-800">缺少：{r.missing.join("；")}，不会在简历中虚构</p>}
                  </div>
                </li>
              );
            })}
          </ul>

          {abilities.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="font-semibold">从你的行为推断出的能力</h3>
                <p className="text-xs text-muted">
                  这些是推断，不是你的原话。认可后才会用来组织简历（简历里只写具体行为，不写「抗压能力强」这类形容词）；不认可不会删除任何经历。
                  {pendingAbilities > 0 && ` 还有 ${pendingAbilities} 项待确认。`}
                </p>
              </div>
              <ul className="space-y-2">
                {abilities.map((a) => (
                  <li key={a.id} className="space-y-1.5 rounded-2xl border border-line bg-paper/60 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {a.ability}
                        <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                          {a.relation === "direct" ? "行为直接体现" : "方法可迁移"}
                        </span>
                        {a.confirmation !== "pending" && (
                          <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[11px] ${a.confirmation === "confirmed" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                            {a.confirmation === "confirmed" ? "已认可" : "已否认"}
                          </span>
                        )}
                      </span>
                      <span className="flex gap-1.5">
                        {a.confirmation === "pending" ? (
                          <>
                            <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => decide(a, "confirmed")}>认可</Button>
                            <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => decide(a, "rejected")}>不认可</Button>
                          </>
                        ) : (
                          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => decide(a, null)}>撤销</Button>
                        )}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">理由：{a.reasoning}</div>
                    {a.boundary && <div className="text-xs text-slate-500">边界：{a.boundary}</div>}
                    <ul className="space-y-1 text-xs">{a.factIds.map(factLine)}</ul>
                    {a.missingDetails.length > 0 && <div className="text-xs text-amber-800">还可补充：{a.missingDetails.join("；")}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!!match.experienceCoverage?.length && (
            <section className="space-y-2">
              <h3 className="font-semibold">每段经历的去向</h3>
              <ul className="space-y-1.5 text-sm">
                {match.experienceCoverage.map((c) => {
                  const e = experiences.find((x) => x.id === c.experienceId);
                  if (!e) return null;
                  return (
                    <li key={c.experienceId}>
                      <span className="font-medium">{experienceLabel(e)}</span>
                      <span className="text-muted">
                        {" → "}
                        {c.requirementIds.length
                          ? c.requirementIds.map((id) => reqById.get(id)?.text).filter(Boolean).join("、")
                          : c.reason}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {!!match.questions?.length && (
            <section className="space-y-2">
              <h3 className="font-semibold">补充这些信息，匹配会更准确</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                {match.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
              <p className="text-xs text-muted">
                可以到<Link href="/collect" className="underline underline-offset-2">录入经历</Link>或<Link href="/vault" className="underline underline-offset-2">履历库</Link>补充，然后重新分析。
              </p>
            </section>
          )}

          <div className="flex justify-end">
            <Button variant="accent" className="!px-6 !py-3" onClick={() => stored && runResume(stored, experiences)} disabled={!!loading}>
              {loading === "resume"
                ? "生成简历句中…"
                : loading === "verify"
                  ? "核验中：逐句检查是否都出自你的原话…"
                  : loading === "qa"
                    ? "准备面试追问中…"
                    : "生成定向简历 →"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

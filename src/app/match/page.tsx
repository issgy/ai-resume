"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorText, PageHeader } from "@/components/ui";
import { KEYS, useStored } from "@/lib/storage";
import type { Experience, MatchResult, Requirement } from "@/lib/types";
import { checkRequirements } from "@/lib/match";
import { attachResumeRedirect, runMatch, runResume, useJobs } from "@/lib/jobs";

const STATUS = {
  full: { label: "✓ 已覆盖", badge: "bg-emerald-100 text-emerald-700", row: "border-emerald-200 bg-emerald-50/40" },
  partial: { label: "部分覆盖", badge: "bg-sky-100 text-sky-800", row: "border-sky-200 bg-sky-50/40" },
  none: { label: "缺口", badge: "bg-amber-100 text-amber-800", row: "border-amber-200 bg-amber-50/40" },
} as const;

export default function MatchPage() {
  const router = useRouter();
  const [experiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [match] = useStored<MatchResult | null>(KEYS.match, null);
  const [jdDraft] = useStored<string>(KEYS.jdDraft, "");
  const [jd, setJd] = useState("");
  // 任务在 jobs 模块里后台运行，离开本页不会中断；回到本页时仍能看到进行中的阶段
  const jobs = useJobs();
  const loading = jobs.resume ?? jobs.match ?? "";

  const currentJd = jd || match?.jd || jdDraft;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, { ...f, exp: e }] as const)));
  // 存下的匹配结果（含没有 coverage 的旧数据）按当前履历库重新核对，结论只会被降级
  const requirements: Requirement[] = match ? (checkRequirements(match.requirements, experiences, { legacy: true }) ?? []) : [];

  // 生成完成时用户仍在本页才跳转到简历页；已离开则由顶部导航提示，不强行拽走
  useEffect(() => attachResumeRedirect(() => router.push("/resume")), [router]);

  // 只有完整覆盖的要求计入覆盖数
  const covered = requirements.filter((r) => r.coverage === "full").length;
  const total = requirements.length;
  const pct = total ? Math.round((covered / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader step="03" title="JD 匹配" desc="粘贴目标岗位的完整 JD，逐条对照你的履历库。没有对应经历的要求会标为缺口，绝不虚构。" />

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
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">匹配表</h2>
              <p className="text-sm text-muted">已覆盖 {covered} / {total} 条要求</p>
            </div>
            <div className="flex items-center gap-3">
              <div
                className="grid h-14 w-14 place-items-center rounded-full"
                style={{ background: `conic-gradient(var(--color-accent) ${pct * 3.6}deg, var(--color-line) 0)` }}
              >
                <span className="grid h-11 w-11 place-items-center rounded-full bg-card text-sm font-bold">{pct}%</span>
              </div>
            </div>
          </div>

          <ul className="space-y-3">
            {requirements.map((r, i) => {
              const status = STATUS[r.coverage ?? "none"];
              return (
                <li key={i} className={`grid gap-3 rounded-2xl border p-4 sm:grid-cols-[2fr_3fr] ${status.row}`}>
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.type === "must" ? "bg-ink text-white" : "bg-accent-soft text-accent"}`}>
                        {r.type === "must" ? "必须" : "加分"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.badge}`}>{status.label}</span>
                    </div>
                    <div className="text-sm font-medium">{r.text}</div>
                  </div>
                  <div className="space-y-2 text-sm">
                    {r.coverage === "none" ? (
                      <span className="text-amber-800">履历库里没有对应经历，不会在简历中虚构</span>
                    ) : (
                      <ul className="space-y-1.5">
                        {r.factIds.map((id) => {
                          const f = factById.get(id);
                          return f ? (
                            <li key={id} className="flex gap-2">
                              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                              <span>
                                {f.text} <span className="text-xs text-muted">· {f.exp.company}</span>
                              </span>
                            </li>
                          ) : null;
                        })}
                      </ul>
                    )}
                    {r.coverage === "partial" && (
                      <p className="text-amber-800">
                        缺少：{r.missing?.length ? r.missing.join("、") : "未能确认完整覆盖"}，不会在简历中虚构
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button variant="accent" className="!px-6 !py-3" onClick={() => runResume(match.jd, requirements, experiences)} disabled={!!loading}>
              {loading === "resume" ? "生成中，约需 20-40 秒…" : loading === "verify" ? "正在核验亮点是否都出自你的原话…" : "生成定向简历 →"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

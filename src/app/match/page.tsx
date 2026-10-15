"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorText, PageHeader, postJson } from "@/components/ui";
import { KEYS, useStored } from "@/lib/storage";
import type { Experience, MatchResult, Requirement, ResumeResult } from "@/lib/types";
import { failVerification } from "@/lib/validate";

export default function MatchPage() {
  const router = useRouter();
  const [experiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [match, setMatch] = useStored<MatchResult | null>(KEYS.match, null);
  const [, setResume] = useStored<ResumeResult | null>(KEYS.resume, null);
  const [jdDraft] = useStored<string>(KEYS.jdDraft, "");
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState<"" | "match" | "resume" | "verify">("");
  const [error, setError] = useState("");

  const currentJd = jd || match?.jd || jdDraft;
  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, { ...f, exp: e }] as const)));

  async function runMatch() {
    setError("");
    setLoading("match");
    try {
      const { requirements } = await postJson<{ requirements: Requirement[] }>("/api/match", { jd: currentJd, experiences });
      setMatch({ jd: currentJd, requirements });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading("");
    }
  }

  async function runResume() {
    if (!match) return;
    setError("");
    setLoading("resume");
    try {
      const data = await postJson<Pick<ResumeResult, "highlights" | "dropped" | "failedExperienceIds">>("/api/resume", { ...match, experiences });
      // 规则校验通过的亮点再做一次大模型内容核验；核验请求整体失败时这批亮点全部剔除，不放行未核验内容
      let verified: Pick<ResumeResult, "highlights" | "dropped"> = { highlights: [], dropped: [] };
      if (data.highlights.length > 0) {
        setLoading("verify");
        try {
          verified = await postJson<Pick<ResumeResult, "highlights" | "dropped">>("/api/verify", { highlights: data.highlights, experiences });
        } catch {
          verified = { highlights: [], dropped: failVerification(data.highlights) };
        }
      }
      setResume({
        jd: match.jd,
        highlights: verified.highlights,
        dropped: [...data.dropped, ...verified.dropped],
        failedExperienceIds: data.failedExperienceIds ?? [],
        // 只有上面核验通过的 highlights 会被导出；简历页不会把未核验的履历事实写进正文
        provenanceChecked: true,
      });
      router.push("/resume");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading("");
    }
  }

  const covered = match?.requirements.filter((r) => r.factIds.length > 0).length ?? 0;

  const total = match?.requirements.length ?? 0;
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
          <Button variant="accent" onClick={runMatch} disabled={!!loading || !currentJd.trim()}>
            {loading === "match" ? "分析中…" : "分析匹配"}
          </Button>
        </div>
      </Card>
      <ErrorText>{error}</ErrorText>

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
            {match.requirements.map((r, i) => {
              const hit = r.factIds.length > 0;
              return (
                <li
                  key={i}
                  className={`grid gap-3 rounded-2xl border p-4 sm:grid-cols-[2fr_3fr] ${
                    hit ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/40"
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.type === "must" ? "bg-ink text-white" : "bg-accent-soft text-accent"}`}>
                        {r.type === "must" ? "必须" : "加分"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${hit ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                        {hit ? "✓ 已覆盖" : "缺口"}
                      </span>
                    </div>
                    <div className="text-sm font-medium">{r.text}</div>
                  </div>
                  <div className="text-sm">
                    {!hit ? (
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
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button variant="accent" className="!px-6 !py-3" onClick={runResume} disabled={!!loading}>
              {loading === "resume" ? "生成中，约需 20-40 秒…" : loading === "verify" ? "正在核验亮点是否都出自你的原话…" : "生成定向简历 →"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorText, postJson } from "@/components/ui";
import { KEYS, useStored } from "@/lib/storage";
import type { Experience, MatchResult, Requirement, ResumeResult } from "@/lib/types";

export default function MatchPage() {
  const router = useRouter();
  const [experiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [match, setMatch] = useStored<MatchResult | null>(KEYS.match, null);
  const [, setResume] = useStored<ResumeResult | null>(KEYS.resume, null);
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState<"" | "match" | "resume">("");
  const [error, setError] = useState("");

  const currentJd = jd || match?.jd || "";
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
      const data = await postJson<Omit<ResumeResult, "jd">>("/api/resume", { ...match, experiences });
      setResume({ jd: match.jd, ...data });
      router.push("/resume");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading("");
    }
  }

  const covered = match?.requirements.filter((r) => r.factIds.length > 0).length ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">JD 匹配</h1>
      <textarea
        className="w-full rounded border p-3 text-sm"
        rows={8}
        placeholder="粘贴目标岗位的完整 JD（岗位职责 + 任职要求）"
        value={currentJd}
        onChange={(e) => setJd(e.target.value)}
      />
      <Button onClick={runMatch} disabled={!!loading || !currentJd.trim()}>
        {loading === "match" ? "分析中…" : "分析匹配"}
      </Button>
      <ErrorText>{error}</ErrorText>

      {match && (
        <div className="space-y-3 rounded border bg-white p-4">
          <h2 className="font-semibold">
            匹配表 <span className="text-sm font-normal text-slate-500">已覆盖 {covered} / {match.requirements.length} 条要求</span>
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="w-2/5 py-2">JD 要求</th>
                <th className="py-2">你的对应经历</th>
              </tr>
            </thead>
            <tbody>
              {match.requirements.map((r, i) => (
                <tr key={i} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <span className={`mr-1 rounded px-1 text-xs ${r.type === "must" ? "bg-slate-900 text-white" : "bg-slate-200"}`}>
                      {r.type === "must" ? "必须" : "加分"}
                    </span>
                    {r.text}
                  </td>
                  <td className="py-2">
                    {r.factIds.length === 0 ? (
                      <span className="text-amber-700">缺口：履历库里没有对应经历，不会在简历中虚构</span>
                    ) : (
                      <ul className="space-y-1">
                        {r.factIds.map((id) => {
                          const f = factById.get(id);
                          return f ? (
                            <li key={id}>
                              {f.text} <span className="text-xs text-slate-400">· {f.exp.company}</span>
                            </li>
                          ) : null;
                        })}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button onClick={runResume} disabled={!!loading}>
            {loading === "resume" ? "生成中，约需 20-40 秒…" : "生成定向简历 →"}
          </Button>
        </div>
      )}
    </div>
  );
}

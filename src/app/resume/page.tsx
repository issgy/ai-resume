"use client";

import Link from "next/link";
import { Button, Card, PageHeader } from "@/components/ui";
import { KEYS, useStored } from "@/lib/storage";
import type { Experience, Profile, ResumeResult } from "@/lib/types";

const EMPTY_PROFILE: Profile = { name: "", phone: "", email: "", school: "", birthday: "" };
const FIELDS: [keyof Profile, string][] = [
  ["name", "姓名"],
  ["phone", "电话"],
  ["email", "邮箱"],
  ["school", "毕业院校"],
  ["birthday", "出生年月"],
];

export default function ResumePage() {
  const [experiences, , loaded] = useStored<Experience[]>(KEYS.experiences, []);
  const [profile, setProfile] = useStored<Profile>(KEYS.profile, EMPTY_PROFILE);
  const [resume] = useStored<ResumeResult | null>(KEYS.resume, null);

  if (!loaded) return null;
  if (!resume) {
    return (
      <Card className="py-14 text-center text-muted">
        还没有生成简历，<Link href="/match" className="font-medium text-accent underline underline-offset-4">先去做 JD 匹配</Link>
      </Card>
    );
  }

  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  // 履历库里的每段经历都要出现在简历中；没有定向亮点的经历直接列出原始事实
  const sections = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => ({ exp: e, items: resume.highlights.filter((h) => h.experienceId === e.id) }));

  return (
    <div className="space-y-6">
      <PageHeader step="04" title="简历导出" desc="点开每条亮点可查看来源和面试追问。打印时只保留简历正文。" />

      <Card className="no-print space-y-4">
        <h2 className="text-sm font-semibold">基本信息</h2>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {FIELDS.map(([k, label]) => (
            <input
              key={k}
              className="field"
              placeholder={label}
              value={profile[k]}
              onChange={(e) => setProfile({ ...profile, [k]: e.target.value })}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="accent" onClick={() => window.print()}>导出 PDF（打印 → 另存为 PDF）</Button>
          <Link href="/match"><Button variant="ghost">换一个 JD</Button></Link>
        </div>
      </Card>

      {/* 简历正文：屏幕和打印共用 */}
      <article className="mx-auto max-w-[210mm] rounded-2xl border border-line bg-white p-10 shadow-[0_30px_80px_-40px_rgb(20_40_35/0.35)] print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="mb-5 border-b border-slate-300 pb-4">
          <h1 className="text-3xl font-bold tracking-tight">{profile.name || "你的姓名"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {[profile.phone, profile.email, profile.school, profile.birthday].filter(Boolean).join(" ｜ ") || "电话 ｜ 邮箱 ｜ 院校"}
          </p>
        </header>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">工作经历</h2>
        {sections.map(({ exp, items }) => (
          <section key={exp.id} className="mb-4 break-inside-avoid">
            <div className="flex justify-between text-sm font-semibold">
              <span>{exp.company} · {exp.title}</span>
              <span className="font-normal text-slate-500">{[exp.start, exp.end].filter(Boolean).join(" – ")}</span>
            </div>
            {items.length === 0 && (
              <>
                <p className="no-print mt-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  这段经历没有生成定向亮点（可能是生成简历后才录入的），下面直接列出履历库中的事实。
                  <Link href="/match" className="underline">重新生成</Link>可获得针对 JD 的亮点。
                </p>
                <ul className="mt-1 space-y-1">
                  {exp.facts.map((f) => (
                    <li key={f.id} className="text-sm before:mr-1 before:content-['•']">{f.text}</li>
                  ))}
                </ul>
              </>
            )}
            <ul className="mt-1 space-y-1">
              {items.map((h, i) => (
                <li key={i} className="text-sm">
                  <details className="group">
                    <summary className="cursor-pointer list-none before:mr-1 before:content-['•'] print:cursor-auto">
                      {h.text}
                      <span className="no-print ml-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent group-open:hidden">来源与追问</span>
                    </summary>
                    <div className="no-print my-2 space-y-3 rounded-xl border border-line bg-paper p-4 text-xs">
                      <div>
                        <div className="font-semibold text-slate-600">来源</div>
                        {h.factIds.map((id) => (
                          <div key={id} className="text-slate-500">你说过：「{factById.get(id)?.source}」</div>
                        ))}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-600">面试可能追问</div>
                        {h.questions.map((q, j) => (
                          <div key={j} className="mt-1">
                            <div>Q：{q.q}</div>
                            <div className="text-slate-500">A：{q.a}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </article>

      {resume.dropped.length > 0 && (
        <div className="no-print rounded-3xl border border-amber-200 bg-amber-50/70 p-5 text-sm">
          <h2 className="mb-3 font-semibold text-amber-900">以下亮点未写入简历</h2>
          <ul className="space-y-2">
            {resume.dropped.map((d, i) => (
              <li key={i}>
                <span className="text-slate-700">{d.text}</span>
                <span className="ml-2 text-amber-700">原因：{d.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

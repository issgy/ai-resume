"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
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
      <p className="rounded border bg-white p-6 text-center text-slate-500">
        还没有生成简历，<Link href="/match" className="underline">先去做 JD 匹配</Link>
      </p>
    );
  }

  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  // 履历库里的每段经历都要出现在简历中；没有定向亮点的经历直接列出原始事实
  const sections = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => ({ exp: e, items: resume.highlights.filter((h) => h.experienceId === e.id) }));

  return (
    <div className="space-y-6">
      <div className="no-print space-y-3 rounded border bg-white p-4">
        <h2 className="font-semibold">基本信息</h2>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {FIELDS.map(([k, label]) => (
            <input
              key={k}
              className="rounded border px-2 py-1"
              placeholder={label}
              value={profile[k]}
              onChange={(e) => setProfile({ ...profile, [k]: e.target.value })}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>导出 PDF（打印 → 另存为 PDF）</Button>
          <Link href="/match"><Button variant="ghost">换一个 JD</Button></Link>
        </div>
      </div>

      {/* 简历正文：屏幕和打印共用 */}
      <article className="rounded border bg-white p-8 print:border-0 print:p-0">
        <header className="mb-4 border-b pb-3">
          <h1 className="text-2xl font-bold">{profile.name || "你的姓名"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {[profile.phone, profile.email, profile.school, profile.birthday].filter(Boolean).join(" ｜ ") || "电话 ｜ 邮箱 ｜ 院校"}
          </p>
        </header>
        <h2 className="mb-2 text-base font-semibold">工作经历</h2>
        {sections.map(({ exp, items }) => (
          <section key={exp.id} className="mb-4 break-inside-avoid">
            <div className="flex justify-between text-sm font-semibold">
              <span>{exp.company} · {exp.title}</span>
              <span className="font-normal text-slate-500">{[exp.start, exp.end].filter(Boolean).join(" – ")}</span>
            </div>
            {items.length === 0 && (
              <>
                <p className="no-print mt-1 text-xs text-amber-700">
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
                      <span className="no-print ml-1 text-xs text-blue-600 group-open:hidden">来源与追问</span>
                    </summary>
                    <div className="no-print my-2 space-y-2 rounded bg-slate-50 p-3 text-xs">
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
        <div className="no-print rounded border border-amber-200 bg-amber-50 p-4 text-sm">
          <h2 className="mb-2 font-semibold text-amber-800">以下亮点未写入简历</h2>
          <ul className="space-y-1">
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

"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, ErrorText, PageHeader } from "@/components/ui";
import { isInAppBrowser, renderResume, saveFile, toPdf } from "@/lib/exportPdf";
import { KEYS, useStored } from "@/lib/storage";
import type { Experience, Profile, ResumeResult } from "@/lib/types";
import { VERIFY_FAILED, VERIFY_MISSING, dropIndefensible, dropStale } from "@/lib/validate";

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
  const [stored] = useStored<ResumeResult | null>(KEYS.resume, null);
  const resume = stored && dropStale(dropIndefensible(stored), experiences);
  // 内容核验上线前生成的简历没有经过核验，只能查看，不能导出
  const exportable = !!resume?.provenanceChecked;
  const articleRef = useRef<HTMLElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [longImage, setLongImage] = useState("");

  async function exportPdf() {
    if (!articleRef.current || !exportable) return;
    setExportError("");
    setExporting(true);
    try {
      const rendered = await renderResume(articleRef.current);
      if (isInAppBrowser()) {
        // 内置浏览器拦截下载：给一张长图，长按即可保存到相册
        setLongImage(rendered.canvas.toDataURL("image/jpeg", 0.92));
        return;
      }
      const file = await toPdf(rendered, `${profile.name.trim() || "我的"}-简历.pdf`);
      await saveFile(file);
    } catch (e) {
      setExportError(`导出失败：${(e as Error).message || "未知错误"}，请重试`);
    } finally {
      setExporting(false);
    }
  }

  if (!loaded) return null;
  if (!resume) {
    return (
      <Card className="py-14 text-center text-muted">
        还没有生成简历，<Link href="/match" className="font-medium text-accent underline underline-offset-4">先去做 JD 匹配</Link>
      </Card>
    );
  }

  const factById = new Map(experiences.flatMap((e) => e.facts.map((f) => [f.id, f] as const)));
  const verifyFailed = resume.dropped.some((d) => d.reason === VERIFY_FAILED || d.reason === VERIFY_MISSING);
  const sourceLabel = (id: string) => {
    const origin = factById.get(id)?.origin;
    return origin === "edited" ? "你在履历库手动修改为" : origin === "manual" ? "你手动补充" : "你说过";
  };
  // 履历库里的每段经历都要出现在简历中；没有定向亮点的经历直接列出原始事实，
  // 但被剔除亮点引用过的事实不列出，避免答不上来的内容换个形式回到简历里
  const sections = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => {
      const dropped = resume.dropped.filter((d) => d.experienceId === e.id);
      const droppedFactIds = new Set(dropped.flatMap((d) => d.factIds ?? []));
      return {
        exp: e,
        items: resume.highlights.filter((h) => h.experienceId === e.id),
        hasDropped: dropped.length > 0,
        fallbackFacts: e.facts.filter((f) => !droppedFactIds.has(f.id)),
      };
    });

  return (
    <div className="space-y-6">
      <PageHeader step="04" title="简历导出" desc="点开每条亮点可查看来源和面试追问。导出的 PDF 只保留简历正文。" />

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
          <Button variant="accent" onClick={exportPdf} disabled={exporting || !exportable}>
            {exporting ? "正在生成 PDF…" : "下载 PDF"}
          </Button>
          {/* 打印只在桌面端提供；用外层控制显隐，避免和按钮自身的 inline-flex 冲突 */}
          <span className="hidden sm:inline">
            <Button variant="ghost" onClick={() => window.print()} disabled={!exportable}>打印</Button>
          </span>
          <Link href="/match"><Button variant="ghost">{exportable ? "换一个 JD" : "重新生成"}</Button></Link>
        </div>
        {!exportable && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            这份简历生成于「亮点内容核验」上线之前，亮点没有逐条核对是否出自你的原话，只能查看、不能导出。
            请<Link href="/match" className="underline">重新生成</Link>后再下载 PDF。
          </p>
        )}
        {exportable && verifyFailed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            内容核验服务出错或超时，未能确认的亮点已剔除（见页面底部）。请稍后<Link href="/match" className="underline">重新生成</Link>。
          </p>
        )}
        <ErrorText>{exportError}</ErrorText>
      </Card>

      {longImage && (
        <div className="no-print fixed inset-0 z-50 flex flex-col bg-ink/80 p-4 backdrop-blur-sm" onClick={() => setLongImage("")}>
          <div className="mx-auto mb-3 w-full max-w-md rounded-2xl bg-card p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <p className="font-semibold">长按下方图片，保存到相册</p>
            <p className="mt-1 text-xs text-muted">当前是微信 / 支付宝等内置浏览器，无法直接下载文件。需要 PDF 的话，点右上角「···」选择「在浏览器中打开」，再点「下载 PDF」。</p>
            <Button variant="ghost" className="mt-3 w-full" onClick={() => setLongImage("")}>关闭</Button>
          </div>
          <div className="mx-auto w-full max-w-md flex-1 overflow-y-auto rounded-lg" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL 长图，需要原生 img 才能长按保存 */}
            <img src={longImage} alt="简历长图" className="w-full bg-white" />
          </div>
        </div>
      )}

      {/* 简历正文：屏幕和打印共用 */}
      <article ref={articleRef} className={`${exportable ? "" : "print:hidden"} mx-auto max-w-[210mm] rounded-2xl border border-line bg-white p-10 shadow-[0_30px_80px_-40px_rgb(20_40_35/0.35)] print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none`}>
        <header className="mb-5 border-b border-slate-300 pb-4">
          <h1 className="text-3xl font-bold tracking-tight">{profile.name || "你的姓名"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {[profile.phone, profile.email, profile.school, profile.birthday].filter(Boolean).join(" ｜ ") || "电话 ｜ 邮箱 ｜ 院校"}
          </p>
        </header>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">工作经历</h2>
        {sections.map(({ exp, items, hasDropped, fallbackFacts }) => (
          <section key={exp.id} className="mb-4 break-inside-avoid">
            <div className="flex justify-between text-sm font-semibold">
              <span>{exp.company} · {exp.title}</span>
              <span className="font-normal text-slate-500">{[exp.start, exp.end].filter(Boolean).join(" – ")}</span>
            </div>
            {items.length === 0 && (
              <>
                <p className="no-print mt-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  {hasDropped
                    ? `这段经历的亮点都未通过校验（原因见页面底部）${fallbackFacts.length ? "，下面列出未被剔除亮点引用的履历事实" : "，暂无可写入的内容"}。`
                    : "这段经历没有生成定向亮点（可能是生成简历后才录入的），下面直接列出履历库中的事实。"}
                  <Link href="/match" className="underline">重新生成</Link>可获得针对 JD 的亮点。
                </p>
                <ul className="mt-1 space-y-1">
                  {fallbackFacts.map((f) => (
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
                          <div key={id} className="text-slate-500">{sourceLabel(id)}：「{h.sources?.[id] ?? factById.get(id)?.source}」</div>
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

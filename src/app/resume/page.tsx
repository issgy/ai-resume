"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Button, Card, ErrorText, PageHeader } from "@/components/ui";
import { isInAppBrowser, renderResume, saveFile, slicePages, toPdf } from "@/lib/exportPdf";
import { KEYS, useStored } from "@/lib/storage";
import type { Education, Experience, Highlight, Profile, ResumeResult } from "@/lib/types";
import { isExportable, isIncluded, isInsufficient, markStale, needsInput } from "@/lib/validate";
import {
  addFactAsBullet,
  BULLET_MAX,
  byTimeDesc,
  defaultEducationFirst,
  editBullet,
  experienceLabel,
  orderExperiences,
  retryExperience,
  setEducationFirst,
  setOrder,
  setSelection,
  useJobs,
} from "@/lib/jobs";

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
  const [educationRaw] = useStored<Education[]>(KEYS.education, []);
  const resume = stored && markStale(stored, experiences);
  const jobs = useJobs();
  // 内容核验上线前生成的简历没有经过核验，只能查看，不能导出
  const exportable = !!resume?.provenanceChecked;
  const articleRef = useRef<HTMLElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [longImage, setLongImage] = useState("");
  // 正在改措辞的句子（resume.highlights 下标）和草稿
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // 分页预览：与导出的 PDF 用同一套分页结果
  // 分页结果连同算出它时的版面键一起存；正文一变（句子、选材、顺序、基本信息、来源失效），旧页数和预览就不再显示
  const [pageInfo, setPageInfo] = useState<{ count: number; key: string; pages?: string[] } | null>(null);

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
      setPageInfo({ count: rendered.breaks.length + 1, key: layoutKey() });
      await saveFile(file);
    } catch (e) {
      setExportError(`导出失败：${(e as Error).message || "未知错误"}，请重试`);
    } finally {
      setExporting(false);
    }
  }

  async function previewPages() {
    if (!articleRef.current) return;
    setExportError("");
    setExporting(true);
    try {
      const rendered = await renderResume(articleRef.current);
      const key = layoutKey();
      setPageInfo({ count: rendered.breaks.length + 1, key, pages: slicePages(rendered).map((c) => c.toDataURL("image/jpeg", 0.8)) });
    } catch (e) {
      setExportError(`分页预览失败：${(e as Error).message || "未知错误"}，请重试`);
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
  const sourceLabel = (id: string) => {
    const origin = factById.get(id)?.origin;
    return origin === "edited" ? "你在履历库手动修改为" : origin === "manual" ? "你手动补充" : origin === "imported" ? "简历原文" : "你说过";
  };
  const failedIds = new Set(resume.failedExperienceIds ?? []);
  const indexed = resume.highlights.map((h, i) => ({ h, i }));
  const dispositionOf = new Map((resume.dispositions ?? []).map((d) => [d.experienceId, d]));
  // 本段已生成句子、但有事实既没被引用也不在 unused 里（旧版简历没有 unused，或生成后新增的事实）：同样列为可加入，不让事实没有入口
  const unusedOf = (e: Experience, own: Highlight[]) => {
    if (own.length === 0) return [];
    const listed = (resume.unused ?? []).filter((u) => u.experienceId === e.id && e.facts.some((f) => f.id === u.factId));
    const cited = new Set([...own.flatMap((h) => h.factIds), ...listed.map((u) => u.factId)]);
    const rest = e.facts.filter((f) => !cited.has(f.id)).map((f) => ({ experienceId: e.id, factId: f.id, reason: resume.unused ? "生成简历后新增，或本次没有写入" : "旧版简历没有使用这条" }));
    return [...listed, ...rest];
  };
  // 经历顺序只属于这份简历（resume.order）；没调整过时按履历库顺序
  const ordered = orderExperiences(experiences, resume.order);
  const sections = ordered
    .filter((e) => e.facts.length > 0)
    .map((e) => {
      const all = indexed.filter(({ h }) => h.experienceId === e.id);
      const ready = all.filter(({ h }) => isExportable(h, resume));
      return {
        exp: e,
        items: ready.filter(({ h }) => isIncluded(h)),
        optional: ready.filter(({ h }) => !isIncluded(h)),
        waiting: all.filter(({ h }) => !isExportable(h, resume)),
        unused: unusedOf(e, all.map(({ h }) => h)),
        disposition: dispositionOf.get(e.id),
        failed: failedIds.has(e.id),
        generated: all.length > 0,
      };
    });
  // 简历正文（屏幕、打印、PDF、长图）只放 ready 且选入简历的句子；可选内容、待处理、本次未生成的经历在正文之外列出，
  // 每段都有去向和原因、可以恢复，履历事实都不删除（02 R10、S5）
  const verifiedSections = sections.filter((s) => s.items.length > 0);
  // 版面键：按实际导出的正文计算（来源失效的句子已被 markStale 移出）
  // 教育背景：履历库里填写的学校/专业/学历/时间，按时间倒序；放在工作经历前面还是后面
  const education = byTimeDesc(educationRaw.filter((e) => e.school.trim() || e.major.trim() || e.degree.trim()));
  const educationFirst = resume.educationFirst ?? defaultEducationFirst(education);
  const squash = (x: string) => x.replace(/\s/g, "").toLowerCase();
  const schoolInEducation = !!profile.school.trim() && education.some((e) => squash(e.school).includes(squash(profile.school)));
  function layoutKey() {
    return JSON.stringify([profile, education, educationFirst, verifiedSections.map(({ exp, items }) => [exp.company, exp.title, exp.start, exp.end, items.map(({ h }) => h.text)])]);
  }
  const educationBlock = education.length > 0 && (
    <section className={`break-inside-avoid ${educationFirst ? "mb-5" : "mt-5"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">教育背景</h2>
        <button className="no-print rounded-full px-2 py-0.5 text-[11px] text-muted hover:bg-paper" onClick={() => setEducationFirst(!educationFirst)}>
          {educationFirst ? "移到工作经历后面" : "移到工作经历前面"}
        </button>
      </div>
      {education.map((e) => (
        <div key={e.id} className="mb-1 flex flex-col gap-0.5 text-sm sm:flex-row sm:justify-between">
          <span className="font-semibold">{[e.school, e.major, e.degree].filter((x) => x.trim()).join(" · ")}</span>
          <span className="text-slate-500">{[e.start, e.end].filter((x) => x.trim()).join(" – ")}</span>
        </div>
      ))}
    </section>
  );
  const fresh = pageInfo?.key === layoutKey();
  const pageCount = fresh ? pageInfo!.count : 0;
  const pages = fresh ? (pageInfo!.pages ?? null) : null;
  const setPages = (v: null) => setPageInfo(pageInfo && { ...pageInfo, pages: v ?? undefined });
  // 调整顺序：只在正文里的经历之间移动，其余经历的相对位置不变
  const RANK = { expanded: 0, condensed: 1, optional: 2 } as const;
  const applyVisibleOrder = (visibleIds: string[]) => {
    const visible = new Set(visibleIds);
    let k = 0;
    setOrder(ordered.map((e) => (visible.has(e.id) ? visibleIds[k++] : e.id)));
  };
  const move = (id: string, delta: -1 | 1) => {
    const ids = verifiedSections.map((x) => x.exp.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    applyVisibleOrder(ids);
  };
  const sortByTime = () => setOrder(byTimeDesc(ordered).map((e) => e.id));
  const sortByRelevance = () => {
    const timeRank = new Map(byTimeDesc(ordered).map((e, i) => [e.id, i]));
    const rank = (id: string) => RANK[dispositionOf.get(id)?.level ?? "optional"] ?? 3;
    setOrder([...ordered].sort((a, b) => rank(a.id) - rank(b.id) || timeRank.get(a.id)! - timeRank.get(b.id)!).map((e) => e.id));
  };
  const optionalSections = sections.filter((s) => s.optional.length > 0 || s.unused.length > 0);
  const waiting = sections.filter((s) => s.waiting.length > 0 || s.failed);
  const notGenerated = sections.filter((s) => !s.generated && !s.failed);
  const LEVEL = { expanded: "高相关·展开", condensed: "次相关·压缩", optional: "低相关·可选" } as const;
  const retryButton = (expId: string, label = "重试这段") => (
    <Button variant="ghost" className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs" onClick={() => retryExperience(expId)} disabled={!!jobs.retrying || !!jobs.resume}>
      {jobs.retrying === expId ? "重试中…" : label}
    </Button>
  );
  const statusText = (h: Highlight) =>
    h.issueType === "technical_error"
      ? "模型请求出错（不是你的经历有问题）"
      : h.issueType === "stale"
        ? "来源已修改，待重新核验"
        : h.issueType === "source_conflict"
          ? "与原话矛盾"
          : "无法导出";

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
          <Button variant="accent" onClick={exportPdf} disabled={exporting || !exportable || verifiedSections.length === 0}>
            {exporting ? "正在生成…" : "下载 PDF"}
          </Button>
          <Button variant="ghost" onClick={previewPages} disabled={exporting || verifiedSections.length === 0}>
            分页预览
          </Button>
          {/* 打印只在桌面端提供；用外层控制显隐，避免和按钮自身的 inline-flex 冲突 */}
          <span className="hidden sm:inline">
            <Button variant="ghost" onClick={() => window.print()} disabled={!exportable || verifiedSections.length === 0}>打印</Button>
          </span>
          <Link href="/match"><Button variant="ghost">{exportable ? "换一个 JD" : "重新生成"}</Button></Link>
        </div>
        {!exportable && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            这份简历生成于「亮点内容核验」上线之前，亮点没有逐条核对是否出自你的原话，只能查看、不能导出。
            请<Link href="/match" className="underline">重新生成</Link>后再下载 PDF。
          </p>
        )}
        {waiting.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            有 {waiting.length} 段经历存在待处理内容（模型出错、来源已修改或与原话矛盾），不会导出，详见页面下方，可以逐段重试。
          </p>
        )}
        {pageCount > 0 && (
          <p className="text-xs text-muted">
            按当前内容导出共 {pageCount} 页（A4）。{pageCount > 1 && "想压缩到 1 页，可以把相关度低的句子移出，或在「改措辞」里写得更简短。"}
          </p>
        )}
        <ErrorText>{jobs.retryError}</ErrorText>
        <ErrorText>{exportError}</ErrorText>
      </Card>

      {pages &&
        createPortal(
        <div className="no-print fixed inset-0 z-50 flex flex-col bg-ink/80 p-4 backdrop-blur-sm" onClick={() => setPages(null)}>
          <div className="mx-auto mb-3 flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl bg-card p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-semibold">分页预览：共 {pages.length} 页</p>
              <p className="mt-1 text-xs text-muted">和下载的 PDF 完全一致；分页只落在行与行之间，经历标题不会单独留在页底。</p>
            </div>
            <Button variant="ghost" onClick={() => setPages(null)}>关闭</Button>
          </div>
          <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {pages.map((src, i) => (
              <figure key={i} className="space-y-1">
                <figcaption className="text-xs text-white/80">第 {i + 1} 页</figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL 预览图 */}
                <img src={src} alt={`第 ${i + 1} 页`} className="w-full rounded bg-white shadow" />
              </figure>
            ))}
          </div>
        </div>,
          document.body,
        )}

      {longImage &&
        createPortal(
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
        </div>,
          document.body,
        )}

      {/* 简历正文：屏幕和打印共用 */}
      <article ref={articleRef} className={`${exportable ? "" : "print:hidden"} mx-auto max-w-[210mm] rounded-2xl border border-line bg-white p-5 sm:p-10 shadow-[0_30px_80px_-40px_rgb(20_40_35/0.35)] print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none`}>
        <header className="mb-5 border-b border-slate-300 pb-4">
          <h1 className="text-3xl font-bold tracking-tight">{profile.name || "你的姓名"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {/* 教育背景栏里已经写了这所学校时，抬头不再重复；否则保留（不丢学校信息） */}
            {[profile.phone, profile.email, schoolInEducation ? "" : profile.school, profile.birthday].filter(Boolean).join(" ｜ ") || "电话 ｜ 邮箱 ｜ 院校"}
          </p>
        </header>
        {educationFirst && educationBlock}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">工作经历</h2>
          {verifiedSections.length > 1 && (
            <div className="no-print flex flex-wrap items-center gap-1 text-[11px] text-muted">
              排序：
              <button className="rounded-full px-2 py-0.5 hover:bg-paper" onClick={sortByTime}>按时间倒序</button>
              <button className="rounded-full px-2 py-0.5 hover:bg-paper" onClick={sortByRelevance}>按相关度</button>
              {resume.order && (
                <button className="rounded-full px-2 py-0.5 hover:bg-paper" onClick={() => setOrder(undefined)}>恢复履历库顺序</button>
              )}
            </div>
          )}
        </div>
        {verifiedSections.length === 0 && (
          <p className="no-print rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            暂无可导出的简历句，请查看下方待处理内容，或<Link href="/match" className="underline">重新生成</Link>。
          </p>
        )}
        {verifiedSections.map(({ exp, items, disposition }, k) => (
          <section key={exp.id} className="mb-4 break-inside-avoid">
            <div className="flex flex-col gap-0.5 text-sm font-semibold sm:flex-row sm:items-center sm:justify-between">
              <span>{experienceLabel(exp)}</span>
              {/* 手机上：日期在左、↑↓ 在右；桌面：↑↓ 在日期左边。↑↓ 不进入导出 */}
              <span className="flex items-center justify-between gap-2 font-normal text-slate-500 sm:justify-end">
                <span className="sm:order-2">{[exp.start, exp.end].filter(Boolean).join(" – ")}</span>
                {verifiedSections.length > 1 && (
                  <span className="no-print inline-flex gap-0.5 text-[11px] text-muted sm:order-1">
                    <button className="rounded px-1 hover:bg-paper disabled:opacity-30" title="上移" aria-label="上移这段经历" disabled={k === 0} onClick={() => move(exp.id, -1)}>↑</button>
                    <button className="rounded px-1 hover:bg-paper disabled:opacity-30" title="下移" aria-label="下移这段经历" disabled={k === verifiedSections.length - 1} onClick={() => move(exp.id, 1)}>↓</button>
                  </span>
                )}
              </span>
            </div>
            {disposition && (
              <div className="no-print mt-0.5 text-[11px] text-muted">
                <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-slate-100 px-1.5 py-0.5">{LEVEL[disposition.level]}</span>
                {disposition.reason}
              </div>
            )}
            <ul className="mt-1 space-y-1">
              {items.map(({ h, i }) => (
                <li key={i} className="text-sm">
                  <details className="group">
                    <summary className="cursor-pointer list-none before:mr-1 before:content-['•'] print:cursor-auto">
                      {h.text}
                      <span className="no-print ml-1.5 inline-block whitespace-nowrap rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent group-open:hidden">来源与追问</span>
                      {needsInput(h) > 0 && (
                        <span className="inline-block whitespace-nowrap no-print ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 group-open:hidden">
                          {needsInput(h)} 个追问需补充
                        </span>
                      )}
                      <button
                        className="no-print ml-1 rounded-full px-2 py-0.5 text-[11px] text-muted hover:bg-paper group-open:hidden"
                        title="从本份简历移出（可以在下方「未放进简历的内容」恢复）"
                        onClick={(e) => {
                          e.preventDefault();
                          setSelection(i, "hidden_by_user");
                        }}
                      >
                        移出
                      </button>
                    </summary>
                    <div className="no-print my-2 space-y-3 rounded-xl border border-line bg-paper p-4 text-xs">
                      <div>
                        <div className="font-semibold text-slate-600">来源</div>
                        {h.factIds.map((id) => (
                          <div key={id} className="text-slate-500">{sourceLabel(id)}：「{h.sources?.[id] ?? factById.get(id)?.source}」</div>
                        ))}
                        {h.note && <div className="mt-1 text-amber-800">核验：{h.note}</div>}
                        {h.originalText && <div className="text-slate-400">{h.edited ? "你改的版本" : "AI 初稿"}：{h.originalText}</div>}
                        {h.edited && h.generatedText && <div className="text-slate-400">生成时的版本：{h.generatedText}</div>}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-600">改措辞</div>
                        {editing === i ? (
                          <div className="mt-1 space-y-2">
                            <textarea
                              className="w-full rounded-lg border border-line bg-white p-2 text-sm"
                              rows={3}
                              maxLength={BULLET_MAX}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                            />
                            <p className="text-slate-500">只能依据上面列出的来源改写；改完会重新核验这一句，来源里没有的说法会被删去并说明原因。要写新内容，请先到履历库补充事实。</p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="accent"
                                className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs"
                                disabled={!!jobs.retrying || !!jobs.resume || !draft.trim() || draft.trim() === h.text}
                                onClick={async () => {
                                  await editBullet(i, draft);
                                  setEditing(null);
                                }}
                              >
                                {jobs.retrying === h.experienceId ? "核验中…" : "保存并核验"}
                              </Button>
                              <Button variant="ghost" className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs" onClick={() => setEditing(null)} disabled={jobs.retrying === h.experienceId}>
                                取消
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-1 flex flex-wrap gap-2">
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs"
                              disabled={!!jobs.retrying || !!jobs.resume}
                              onClick={() => {
                                setEditing(i);
                                setDraft(h.text);
                              }}
                            >
                              改这句的措辞
                            </Button>
                            {h.edited && h.generatedText && (
                              <Button variant="ghost" className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs" disabled={!!jobs.retrying || !!jobs.resume} onClick={() => editBullet(i, h.generatedText!, true)}>
                                恢复生成的版本
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-600">面试准备</div>
                        {(h.qaFailed || h.questions.some((q) => q.retryable)) && (
                          <div className="mt-1 flex items-center gap-2 text-amber-800">
                            {h.qaFailed ? "面试追问生成出错（不影响这句简历）。" : "部分参考回答需要更新（不影响这句简历）。"}
                            {retryButton(h.experienceId, "重新生成追问")}
                          </div>
                        )}
                        {h.questions.map((q, j) => (
                          <div key={j} className="mt-1">
                            <div>Q：{q.q}</div>
                            {q.retryable ? (
                              <div className="text-slate-500">
                                <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-slate-100 px-1.5 py-0.5">待更新</span>
                                参考回答暂不展示：{q.missingDetails?.[q.missingDetails.length - 1] ?? "模型出错或来源已修改"}
                              </div>
                            ) : isInsufficient(q) ? (
                              <div className="text-amber-800">
                                <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-amber-100 px-1.5 py-0.5">需要你补充</span>
                                {q.missingDetails?.length ? `待补：${q.missingDetails.join("；")}。` : "你的原始描述里没有这道题的答案。"}
                                AI 不代答；可以
                                <Link href="/vault" className="underline underline-offset-2">到履历库补充细节</Link>，下次生成会用上。
                              </div>
                            ) : (
                              <>
                                <div className="text-slate-500">A：{q.a}</div>
                                {!!q.missingDetails?.length && <div className="text-amber-700">还可补充：{q.missingDetails.join("；")}</div>}
                              </>
                            )}
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
        {!educationFirst && educationBlock}
      </article>

      {/* 正文之外：本份简历没放进去的内容（低相关可选、用户移出、没写进句子的事实），都可以恢复 */}
      {optionalSections.length > 0 && (
        <div className="no-print space-y-4 rounded-3xl border border-line bg-card p-5 text-sm">
          <div>
            <h2 className="font-semibold">未放进本份简历的内容</h2>
            <p className="text-xs text-muted">这些都是你的真实经历，只是和这个岗位相关度较低或篇幅有限；不是没通过核验，可以随时放进简历。</p>
          </div>
          {optionalSections.map(({ exp, optional, unused, disposition }) => (
            <section key={exp.id} className="space-y-1.5">
              <div className="font-medium">
                {experienceLabel(exp)}
                {disposition && <span className="ml-2 text-xs font-normal text-muted">{LEVEL[disposition.level]}：{disposition.reason}</span>}
              </div>
              <ul className="space-y-1">
                {optional.map(({ h, i }) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <span className="text-slate-700">
                      {h.text}
                      <span className="ml-1 text-xs text-muted">{h.selection === "hidden_by_user" ? "（你移出的）" : "（低相关，可选）"}</span>
                    </span>
                    <Button variant="ghost" className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs" onClick={() => setSelection(i, "expanded")}>放进简历</Button>
                  </li>
                ))}
                {unused.map((u) => {
                  const f = exp.facts.find((x) => x.id === u.factId)!;
                  return (
                    <li key={u.factId} className="flex items-start justify-between gap-2">
                      <span className="text-slate-600">
                        {f.text}
                        <span className="ml-1 text-xs text-muted">（未写进句子：{u.reason}）</span>
                      </span>
                      <Button variant="ghost" className="shrink-0 whitespace-nowrap !px-3 !py-1 text-xs" onClick={() => addFactAsBullet(exp.id, u.factId)} disabled={!!jobs.retrying}>
                        {jobs.retrying === exp.id ? "加入中…" : "加入简历"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* 正文之外：待处理（不导出、可重试） */}
      {waiting.length > 0 && (
        <div className="no-print space-y-4 rounded-3xl border border-amber-200 bg-amber-50/70 p-5 text-sm">
          <h2 className="font-semibold text-amber-900">待处理（不会导出）</h2>
          {waiting.map(({ exp, waiting: items, failed }) => (
            <section key={exp.id} className="space-y-2">
              <div className="flex items-center justify-between gap-2 font-medium text-amber-900">
                <span>{experienceLabel(exp)}</span>
                {retryButton(exp.id)}
              </div>
              {failed && <p className="text-xs text-amber-800">这段经历的简历句生成失败：模型请求出错或超时（不是你的经历有问题）。</p>}
              <ul className="space-y-1.5">
                {items.map(({ h, i }) => (
                  <li key={i} className="text-slate-700">
                    <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">{statusText(h)}</span>
                    {h.text}
                    {h.note && <div className="text-xs text-amber-700">{h.note}</div>}
                    {h.issueType === "source_conflict" && (
                      <Link href="/vault" className="text-xs underline">去履历库核对来源</Link>
                    )}
                    {h.edited && h.generatedText && (
                      <button className="ml-2 text-xs underline" disabled={!!jobs.retrying || !!jobs.resume} onClick={() => editBullet(i, h.generatedText!, true)}>
                        恢复生成的版本
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* 本次没有生成简历句的经历：事实仍在履历库，可单独生成 */}
      {notGenerated.length > 0 && (
        <div className="no-print space-y-3 rounded-3xl border border-line bg-card p-5 text-sm">
          <h2 className="font-semibold">本次没有写入简历的经历</h2>
          <p className="text-xs text-muted">这些经历的事实都还在履历库里，不是没通过核验；可能是生成简历之后才录入的，或者还没有公司/岗位。</p>
          {notGenerated.map(({ exp }) => (
            <section key={exp.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 font-medium">
                <span>{experienceLabel(exp)}</span>
                {exp.company.trim() || exp.title.trim() ? (
                  retryButton(exp.id, "为这段生成")
                ) : (
                  <Link href="/vault" className="text-xs underline">先到履历库补上公司或岗位</Link>
                )}
              </div>
              <ul className="space-y-1">
                {exp.facts.map((f) => (
                  <li key={f.id} className="text-slate-600 before:mr-1 before:content-['•']">{f.text}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {resume.dropped.length > 0 && (
        <div className="no-print rounded-3xl border border-line bg-card p-5 text-sm">
          <h2 className="mb-2 font-semibold">{resume.highlights.some((h) => h.exportStatus) ? "模型输出中无效的句子（不影响履历事实）" : "以下亮点未写入简历"}</h2>
          <ul className="space-y-2">
            {resume.dropped.map((d, i) => (
              <li key={i}>
                <span className="text-slate-700">{d.text}</span>
                <span className="ml-2 text-muted">原因：{d.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

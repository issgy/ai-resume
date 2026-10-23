"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { dismissNotice, useJobs } from "@/lib/jobs";

const nav = [
  { href: "/collect", label: "录入经历", short: "录入" },
  { href: "/vault", label: "履历库", short: "履历库" },
  { href: "/match", label: "JD 匹配", short: "匹配" },
  { href: "/resume", label: "简历导出", short: "简历" },
];

export function Nav() {
  const pathname = usePathname();
  const jobs = useJobs();
  const notice = jobs.notice;
  const running = jobs.resume
    ? { text: "定向简历生成中，可以先去做别的，完成后会在这里提示", href: "/match" }
    : jobs.match
      ? { text: "匹配分析中，完成后会在这里提示", href: "/match" }
      : jobs.import
        ? { text: "简历导入解析中，可以先去做别的，完成后会在这里提示", href: "/collect" }
        : null;

  // 用户已经到了提示指向的页面，就不再需要这条提示
  useEffect(() => {
    if (notice && pathname === notice.href) dismissNotice();
  }, [notice, pathname]);

  return (
    // 手机上导航随页面滚走，不吸顶遮挡正文；桌面端吸顶（04「浮动导航不遮正文」）
    <header className="no-print relative top-0 z-20 px-3 pt-3 sm:sticky sm:px-4 sm:pt-4">
      <nav className="mx-auto flex max-w-5xl items-center justify-between gap-0.5 overflow-x-auto [scrollbar-width:none] rounded-full border border-line bg-card/75 p-1.5 text-sm shadow-[0_8px_30px_rgb(0_0_0/0.05)] backdrop-blur-xl sm:justify-start sm:gap-1">
        <Link href="/" aria-label="有据简历首页" className="flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-1.5 pr-1.5 font-bold tracking-tight sm:mr-2 sm:pl-2 sm:pr-3">
          <Logo />
          <span className="hidden sm:inline">有据简历</span>
        </Link>
        {nav.map((n, i) => {
          const active = pathname === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 transition sm:gap-1.5 sm:px-3 ${
                active ? "bg-brand text-white shadow-[0_6px_20px_-8px_rgb(15_118_110/0.7)]" : "text-ink-soft hover:bg-paper"
              }`}
            >
              <span className={`font-mono text-[11px] ${active ? "text-white/60" : "text-muted"}`}>0{i + 1}</span>
              <span className="sm:hidden">{n.short}</span>
              <span className="hidden sm:inline">{n.label}</span>
            </Link>
          );
        })}
      </nav>
      {notice && pathname !== notice.href ? (
        <div
          role="status"
          className={`mx-auto mt-2 flex max-w-5xl items-center justify-between gap-3 rounded-full border px-4 py-2 text-sm shadow-[0_8px_30px_rgb(0_0_0/0.05)] backdrop-blur-xl ${
            notice.tone === "success" ? "border-emerald-200 bg-emerald-50/90 text-emerald-800" : "border-red-200 bg-red-50/90 text-red-700"
          }`}
        >
          <Link href={notice.href} onClick={dismissNotice} className="font-medium underline-offset-4 hover:underline">
            {notice.text} →
          </Link>
          <button onClick={dismissNotice} aria-label="关闭提示" className="shrink-0 px-1 opacity-60 hover:opacity-100">
            ✕
          </button>
        </div>
      ) : running && pathname !== running.href ? (
        <div role="status" className="mx-auto mt-2 max-w-5xl rounded-full border border-line bg-card/90 px-4 py-2 text-sm text-ink-soft backdrop-blur-xl">
          <Link href={running.href} className="underline-offset-4 hover:underline">{running.text}</Link>
        </div>
      ) : null}
    </header>
  );
}

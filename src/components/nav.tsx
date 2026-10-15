"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { dismissNotice, useJobs } from "@/lib/jobs";

const nav = [
  { href: "/collect", label: "录入经历" },
  { href: "/vault", label: "履历库" },
  { href: "/match", label: "JD 匹配" },
  { href: "/resume", label: "简历导出" },
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
    <header className="no-print sticky top-0 z-20 px-4 pt-4">
      <nav className="mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto [scrollbar-width:none] rounded-full border border-line bg-card/75 p-1.5 text-sm shadow-[0_8px_30px_rgb(0_0_0/0.05)] backdrop-blur-xl">
        <Link href="/" className="mr-2 flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-2 pr-3 font-bold tracking-tight">
          <Logo />
          有据简历
        </Link>
        {nav.map((n, i) => {
          const active = pathname === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 transition ${
                active ? "bg-brand text-white shadow-[0_6px_20px_-8px_rgb(15_118_110/0.7)]" : "text-ink-soft hover:bg-paper"
              }`}
            >
              <span className={`font-mono text-[11px] ${active ? "text-white/60" : "text-muted"}`}>0{i + 1}</span>
              {n.label}
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

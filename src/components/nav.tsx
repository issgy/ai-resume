"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";

const nav = [
  { href: "/collect", label: "录入经历" },
  { href: "/vault", label: "履历库" },
  { href: "/match", label: "JD 匹配" },
  { href: "/resume", label: "简历导出" },
];

export function Nav() {
  const pathname = usePathname();
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
    </header>
  );
}

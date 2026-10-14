import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 简历 · 可辩护的 JD 匹配器",
  description: "一次录入真实经历，粘贴 JD 定向生成简历，每条亮点都能应对面试追问",
};

const nav = [
  { href: "/collect", label: "1. 录入经历" },
  { href: "/vault", label: "2. 履历库" },
  { href: "/match", label: "3. JD 匹配" },
  { href: "/resume", label: "4. 简历导出" },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <header className="no-print border-b bg-white">
          <nav className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">AI 简历</Link>
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="text-slate-600 hover:text-slate-900">
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

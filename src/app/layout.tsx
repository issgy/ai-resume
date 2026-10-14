import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "有据简历 · 粘贴 JD，生成每句都有出处的简历",
  description: "有据简历：一次录入真实经历，粘贴 JD 定向生成简历，每句都能追溯到你的原话，并附面试追问",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="bg-grain min-h-screen antialiased">
        <Nav />
        <main className="mx-auto max-w-5xl px-4 pb-20 pt-10 print:p-0">{children}</main>
      </body>
    </html>
  );
}

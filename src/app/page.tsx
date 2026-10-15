import Link from "next/link";
import { DemoButton } from "@/components/demo-button";

const steps = [
  { n: "01", title: "对话录入", desc: "像聊天一样讲经历，AI 追问细节和数字" },
  { n: "02", title: "履历库", desc: "检查、修改每条事实，原话随时可查" },
  { n: "03", title: "JD 匹配", desc: "逐条对照岗位要求，缺口一目了然" },
  { n: "04", title: "定向简历", desc: "生成针对岗位的亮点，一键导出 PDF" },
];

export default function Home() {
  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="animate-rise grid items-center gap-10 pt-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-7">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-soft">
            <span className="bg-brand h-1.5 w-1.5 rounded-full" />
            有据简历 · 粘贴 JD，生成每句都有出处的简历
          </span>
          <h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            每条亮点
            <br />
            <span className="text-brand">都有出处。</span>
          </h1>
          <p className="max-w-md text-base leading-relaxed text-ink-soft">
            一次录入真实经历，粘贴 JD 自动定向重写。简历上的每一句话都能追溯到你说过的原话，并附带面试追问与参考回答。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/collect"
              className="bg-brand inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-medium text-white shadow-[0_12px_30px_-10px_rgb(15_118_110/0.7)] transition hover:brightness-110"
            >
              开始录入 <span aria-hidden>→</span>
            </Link>
            <DemoButton />
          </div>
          <p className="text-xs text-muted">数据只保存在你当前浏览器里，可在履历库页导出备份。</p>
        </div>

        {/* 示意卡片：亮点 ↔ 原话 */}
        <div className="relative">
          <div className="bg-brand absolute -inset-4 -z-10 rounded-[2.5rem] opacity-20 blur-3xl" />
          <div className="space-y-3 rounded-[2rem] border border-line bg-card/90 p-5 shadow-[0_30px_80px_-30px_rgb(20_40_35/0.35)] backdrop-blur">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>简历亮点</span>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">已校验</span>
            </div>
            <p className="text-[15px] font-medium leading-relaxed">
              主导商品管理页 React 重构，首屏耗时由 <mark className="rounded bg-accent-soft px-1 text-accent">3 秒</mark> 降至{" "}
              <mark className="rounded bg-accent-soft px-1 text-accent">1.2 秒</mark>
            </p>
            <div className="rounded-2xl bg-paper p-4 text-sm">
              <div className="mb-1 text-xs font-medium text-muted">来源 · 你说过</div>
              <p className="text-ink-soft">「首屏时间从 3 秒降到 1.2 秒」</p>
            </div>
            <div className="rounded-2xl border border-dashed border-line p-4 text-sm">
              <div className="mb-1 text-xs font-medium text-muted">面试可能追问</div>
              <p className="text-ink-soft">Q：具体用了哪些优化手段？</p>
            </div>
          </div>
        </div>
      </section>

      {/* Bento 步骤 */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <div
            key={s.n}
            className={`animate-rise group rounded-3xl border border-line p-6 transition hover:-translate-y-1 ${
              i === 0 ? "bg-ink text-white" : "bg-card"
            }`}
            style={{ animationDelay: `${120 + i * 80}ms` }}
          >
            <div className={`font-mono text-sm ${i === 0 ? "text-white/50" : "text-muted"}`}>{s.n}</div>
            <div className="mt-10 text-lg font-semibold">{s.title}</div>
            <p className={`mt-1 text-sm ${i === 0 ? "text-white/70" : "text-muted"}`}>{s.desc}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

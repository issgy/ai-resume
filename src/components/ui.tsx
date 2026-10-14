import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "accent" | "ghost" | "danger";

export function Button({ className = "", variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles = {
    primary: "bg-ink text-white hover:bg-ink-soft",
    accent: "bg-brand text-white shadow-[0_8px_24px_-8px_rgb(15_118_110/0.6)] hover:brightness-110",
    ghost: "border border-line bg-card text-ink hover:border-ink",
    danger: "border border-red-200 bg-card text-red-600 hover:bg-red-50",
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-3xl border border-line bg-card p-5 shadow-[0_10px_40px_-20px_rgb(20_40_35/0.25)] sm:p-6 ${className}`}>{children}</div>;
}

/** 页面标题区：步骤号 + 大标题 + 说明 + 右侧操作 */
export function PageHeader({ step, title, desc, actions }: { step?: string; title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="no-print flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-2">
        {step && (
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-soft">
            <span className="bg-brand h-1.5 w-1.5 rounded-full" />
            STEP {step}
          </span>
        )}
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        {desc && <p className="max-w-xl text-sm text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{children}</p>;
}

/** 把平台层的错误码（如 Vercel 超时返回的 504 页面）翻译成用户能看懂的提示 */
export function httpError(status: number) {
  if (status === 504 || status === 524) return "模型响应超时，请重试（你的输入已保留）";
  if (status === 429) return "请求太频繁，请稍等几秒再试";
  return `请求失败 ${status}，请重试`;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: httpError(res.status) }));
  if (!res.ok || data.error) throw new Error(data.error ?? `请求失败 ${res.status}`);
  return data as T;
}

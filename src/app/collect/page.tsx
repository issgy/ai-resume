"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorText, PageHeader, httpError, postJson } from "@/components/ui";
import { Logo } from "@/components/logo";
import { KEYS, uid, useStored } from "@/lib/storage";
import type { ChatMessage, Experience } from "@/lib/types";

const GREETING: ChatMessage = {
  role: "assistant",
  content: "你好！我们来录入一段经历。先说说：这段经历是在哪家公司、什么岗位，大概什么时间？",
};

type Extracted = Omit<Experience, "id" | "facts"> & { facts: { text: string; source: string }[]; rejected: number };

export default function CollectPage() {
  const router = useRouter();
  const [messages, setMessages] = useStored<ChatMessage[]>(KEYS.chat, [GREETING]);
  const [, setExperiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [draft, setDraft] = useState<Extracted | null>(null);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError("");
    setInput("");
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) {
        // 我们自己的路由返回纯文本错误；平台层（如 504）返回 HTML，统一换成可读提示
        const text = res.headers.get("content-type")?.startsWith("text/plain") ? await res.text() : "";
        throw new Error(text || httpError(res.status));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        setMessages([...next, { role: "assistant", content: reply }]);
      }
    } catch (e) {
      // 流式输出中途断开时浏览器只给出 TypeError，换成可读提示
      setError(e instanceof TypeError ? "连接中断或模型响应超时，请重试" : (e as Error).message || "对话失败");
      // 撤回这条发言并放回输入框，用户可以直接重发
      setMessages(messages);
      setInput(text);
    } finally {
      setStreaming(false);
    }
  }

  async function extract() {
    setError("");
    setExtracting(true);
    try {
      setDraft(await postJson<Extracted>("/api/extract", { messages }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }

  function save() {
    if (!draft) return;
    const facts = draft.facts.map((f) => ({ id: uid(), text: f.text, source: f.source, origin: "chat" as const }));
    setExperiences((prev) => {
      const same = prev.find((e) => e.company && e.company === draft.company && e.title === draft.title);
      if (same && confirm(`履历库里已有「${same.company} · ${same.title}」，是否合并到这段经历？（取消则新建）`)) {
        return prev.map((e) => (e.id === same.id ? { ...e, facts: [...e.facts, ...facts] } : e));
      }
      return [...prev, { id: uid(), company: draft.company, title: draft.title, start: draft.start, end: draft.end, facts }];
    });
    setMessages([GREETING]);
    setDraft(null);
    router.push("/vault");
  }

  const userTurns = messages.filter((m) => m.role === "user").length;

  return (
    <div className="space-y-6">
      <PageHeader
        step="01"
        title="录入经历"
        desc="像聊天一样讲一段经历，AI 会追问细节和数字。回答两轮以上就可以整理入库。"
        actions={
          <Button variant="ghost" onClick={() => { setMessages([GREETING]); setDraft(null); }} disabled={streaming}>
            重新开始这段
          </Button>
        }
      />

      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft"><Logo size={22} /></span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">简历顾问</div>
            <div className="text-xs text-muted">{streaming ? "正在输入…" : "在线"}</div>
          </div>
        </div>

        <div className="h-[52vh] space-y-4 overflow-y-auto bg-paper/50 px-5 py-6">
          {messages.map((m, i) => (
            <div key={i} className={`flex items-end gap-2 ${m.role === "user" ? "justify-end" : ""}`}>
              {m.role === "assistant" && (
                <span className="mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft"><Logo size={18} /></span>
              )}
              <span
                className={`inline-block max-w-[78%] whitespace-pre-wrap px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-brand rounded-2xl rounded-br-md text-white shadow-[0_8px_20px_-10px_rgb(15_118_110/0.7)]"
                    : "rounded-2xl rounded-bl-md border border-line bg-card text-ink"
                }`}
              >
                {m.content || <span className="inline-flex gap-1 py-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:240ms]" /></span>}
              </span>
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="flex items-end gap-2 border-t border-line p-3">
          <textarea
            className="field flex-1 resize-none !rounded-2xl !border-transparent !bg-paper"
            rows={2}
            placeholder="如实描述就好，Enter 发送，Shift+Enter 换行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="flex flex-col gap-2">
            <Button variant="accent" onClick={send} disabled={streaming || !input.trim()}>发送 ↑</Button>
            <Button variant="ghost" onClick={extract} disabled={streaming || extracting || userTurns < 2}>
              {extracting ? "整理中…" : "整理入库"}
            </Button>
          </div>
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>

      {draft && (
        <Card className="animate-rise space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">确认入库内容</h2>
            <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">{draft.facts.length} 条事实</span>
          </div>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            {(["company", "title", "start", "end"] as const).map((k) => (
              <label key={k} className="space-y-1">
                <span className="text-xs font-medium text-muted">{{ company: "公司", title: "岗位", start: "开始", end: "结束" }[k]}</span>
                <input
                  className="field"
                  value={draft[k]}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <ul className="space-y-2 text-sm">
            {draft.facts.map((f, i) => (
              <li key={i} className="rounded-2xl border border-line bg-paper/60 p-4">
                <div className="font-medium">{f.text}</div>
                <div className="mt-1.5 text-xs text-muted">原话：「{f.source}」</div>
              </li>
            ))}
          </ul>
          {draft.rejected > 0 && (
            <p className="text-xs text-warn">有 {draft.rejected} 条整理结果在你的原话里找不到依据，已自动丢弃。</p>
          )}
          {draft.facts.length === 0 && <p className="text-sm text-warn">没有整理出可用的事实，请继续补充具体做了什么。</p>}
          <Button variant="accent" onClick={save} disabled={draft.facts.length === 0}>保存到履历库 →</Button>
        </Card>
      )}
    </div>
  );
}

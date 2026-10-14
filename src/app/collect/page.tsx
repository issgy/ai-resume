"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorText, postJson } from "@/components/ui";
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

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

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
      if (!res.ok || !res.body) throw new Error(await res.text());
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
      setError((e as Error).message || "对话失败");
      setMessages(next);
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
    const facts = draft.facts.map((f) => ({ id: uid(), text: f.text, source: f.source }));
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">录入经历</h1>
        <Button variant="ghost" onClick={() => { setMessages([GREETING]); setDraft(null); }} disabled={streaming}>
          重新开始这段
        </Button>
      </div>

      <div className="h-[55vh] space-y-3 overflow-y-auto rounded border bg-white p-4">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <span
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-sm ${
                m.role === "user" ? "bg-slate-900 text-white" : "bg-slate-100"
              }`}
            >
              {m.content || "…"}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <ErrorText>{error}</ErrorText>

      <div className="flex gap-2">
        <textarea
          className="flex-1 rounded border p-2 text-sm"
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
          <Button onClick={send} disabled={streaming || !input.trim()}>发送</Button>
          <Button variant="ghost" onClick={extract} disabled={streaming || extracting || userTurns < 2}>
            {extracting ? "整理中…" : "整理入库"}
          </Button>
        </div>
      </div>

      {draft && (
        <div className="space-y-3 rounded border bg-white p-4">
          <h2 className="font-semibold">确认入库内容</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {(["company", "title", "start", "end"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <span className="w-12 text-slate-500">{{ company: "公司", title: "岗位", start: "开始", end: "结束" }[k]}</span>
                <input
                  className="flex-1 rounded border px-2 py-1"
                  value={draft[k]}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <ul className="space-y-2 text-sm">
            {draft.facts.map((f, i) => (
              <li key={i} className="rounded bg-slate-50 p-2">
                <div>{f.text}</div>
                <div className="mt-1 text-xs text-slate-500">原话：「{f.source}」</div>
              </li>
            ))}
          </ul>
          {draft.rejected > 0 && (
            <p className="text-xs text-amber-700">有 {draft.rejected} 条整理结果在你的原话里找不到依据，已自动丢弃。</p>
          )}
          {draft.facts.length === 0 && <p className="text-sm text-amber-700">没有整理出可用的事实，请继续补充具体做了什么。</p>}
          <Button onClick={save} disabled={draft.facts.length === 0}>保存到履历库</Button>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorText, PageHeader, httpError, postJson } from "@/components/ui";
import { Logo } from "@/components/logo";
import { IMPORT_MAX, IMPORT_MIN } from "@/lib/importText";
import { cancelImport, confirmImport, runImport, useJobs } from "@/lib/jobs";
import type { ImportReview } from "@/lib/jobs";
import { KEYS, uid, useStored } from "@/lib/storage";
import type { ChatMessage, Experience } from "@/lib/types";

const GREETING: ChatMessage = {
  role: "assistant",
  content: "你好！我们来录入一段经历。先说说：这段经历是在哪家公司、什么岗位，大概什么时间？",
};

type Extracted = Omit<Experience, "id" | "facts"> & { facts: { text: string; source: string }[]; rejected: number };

type Tab = "paste" | "chat";

export default function CollectPage() {
  const [tab, setTab] = useState<Tab>("paste");
  return (
    <div className="space-y-6">
      <PageHeader
        step="01"
        title="录入经历"
        desc={
          tab === "paste"
            ? "把现有简历的文字粘贴进来，AI 按原文拆分成经历和事实，直接存入履历库。"
            : "像聊天一样讲一段经历，AI 会追问细节和数字。回答两轮以上就可以整理入库。适合还没有简历的同学。"
        }
      />
      <div role="tablist" className="inline-flex rounded-full border border-line bg-card p-1 text-sm">
        {([
          ["paste", "粘贴简历"],
          ["chat", "对话录入"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-1.5 transition ${tab === key ? "bg-brand text-white" : "text-ink-soft hover:bg-paper"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "paste" ? <PasteImport /> : <ChatCollect />}
    </div>
  );
}

/** 离开页面再回来时保留粘贴框里的内容（不写 localStorage，不进备份） */
let pasteDraft = "";

function PasteImport() {
  const jobs = useJobs();
  const [text, setText] = useState(pasteDraft);
  const count = text.trim().length;
  const tooShort = count > 0 && count < IMPORT_MIN;
  const tooLong = count > IMPORT_MAX;
  const running = jobs.import !== null;
  const s = jobs.importSummary;

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <textarea
          className="field min-h-[40vh] resize-y"
          placeholder="把简历里的工作经历、实习经历、项目经历和个人信息粘贴到这里（纯文本即可，格式乱一点也没关系）"
          value={text}
          disabled={running}
          onChange={(e) => {
            pasteDraft = e.target.value;
            setText(e.target.value);
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={`text-xs ${tooShort || tooLong ? "text-warn" : "text-muted"}`}>
            {count} / {IMPORT_MAX} 字
            {tooShort && `，内容太短（至少 ${IMPORT_MIN} 字）`}
            {tooLong && "，超出上限，请删减后再导入"}
          </span>
          <Button variant="accent" onClick={() => runImport(text.trim())} disabled={running || !!jobs.importReview || count < IMPORT_MIN || tooLong}>
            {running ? "解析中，可以先去做别的…" : "解析并存入履历库"}
          </Button>
        </div>
        <p className="text-xs text-muted">文本会发送给大模型服务商用于解析，本站不在服务器保存</p>
      </Card>

      <ErrorText>{jobs.importError}</ErrorText>

      {jobs.importReview && <ImportReviewPanel review={jobs.importReview} />}

      {s && (
        <Card className="animate-rise space-y-4">
          <h2 className="text-lg font-semibold">导入完成</h2>
          <ul className="space-y-1.5 text-sm">
            <li>新增 {s.added} 段经历，合并到已有经历 {s.merged} 段，共写入 {s.facts} 条事实</li>
            {s.duplicates > 0 && <li className="text-muted">{s.duplicates} 条与履历库中已有事实出自同一原文，已跳过</li>}
            {s.rejected > 0 && <li className="text-warn">{s.rejected} 条因在原文中找不到依据被丢弃</li>}
            {!!s.notes && <li className="text-muted">{s.notes} 条资料备注没有存成经历事实</li>}
            {!!s.education && <li>新增 {s.education} 段教育背景，可在履历库查看和修改</li>}
            <li>{s.profileFields.length > 0 ? `个人信息填充了：${s.profileFields.join("、")}` : "个人信息没有需要填充的字段（已填写的不会被覆盖）"}</li>
            {s.unassigned > 0 && (
              <li className="text-warn">
                有 {s.unassigned} 行内容没能归到具体经历，已放入履历库的「未归类」，请到履历库核对并移到对应经历下
              </li>
            )}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Link href="/vault"><Button variant="accent">去履历库查看</Button></Link>
            <Link href="/match"><Button variant="ghost">去 JD 匹配</Button></Link>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * 导入前的集中确认（02 S1、T09、T10）：只在有疑似重复、资料备注、无名记录时出现一次，不逐条确认事实。
 * 疑似重复默认「保留为两段」（不自动合并可能不同的任职），资料备注默认不存成事实。
 */
function ImportReviewPanel({ review }: { review: ImportReview }) {
  const [merge, setMerge] = useState<Record<number, boolean>>({});
  const [keepNotes, setKeepNotes] = useState<Record<string, boolean>>({});
  const [dates, setDates] = useState<Record<number, "existing" | "imported">>({});
  const exp = (i: number) => review.data.experiences[i];
  const span = (d: { start: string; end: string }) => [d.start, d.end].filter(Boolean).join(" – ") || "未写时间";
  // 要合并且起止时间不一致的，必须先选用哪边的时间
  const missingDate = review.duplicates.some((d) => d.dates && (d.sure || merge[d.index]) && !dates[d.index]);
  return (
    <Card className="animate-rise space-y-4 border-amber-200">
      <div>
        <h2 className="text-lg font-semibold">存入前请确认这几处</h2>
        <p className="text-xs text-muted">其余内容没有问题，确认后一起存入履历库。</p>
      </div>
      {review.duplicates.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">疑似重复的经历</h3>
          <p className="text-xs text-muted">合并后事实归到同一段，年限不会重复计算；如果确实是两段不同的任职，请选「保留两段」。</p>
          {review.duplicates.map((d) => (
            <div key={d.index} className="space-y-1 rounded-2xl border border-line bg-paper/60 p-3 text-sm">
              <div className="font-medium">{d.label || "未命名经历"}</div>
              <div className="text-xs text-muted">{d.reason}</div>
              {!d.sure && (
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={!!merge[d.index]} onChange={() => setMerge({ ...merge, [d.index]: true })} /> 是同一段，合并
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={!merge[d.index]} onChange={() => setMerge({ ...merge, [d.index]: false })} /> 保留两段
                  </label>
                </div>
              )}
              {d.dates && (d.sure || merge[d.index]) && (
                <div className="space-y-1 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                  <div>两边的起止时间不一致，合并后用哪一个？（会影响工作年限的计算）</div>
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={dates[d.index] === "existing"} onChange={() => setDates({ ...dates, [d.index]: "existing" })} />
                    {d.existingId ? "履历库里的" : "这次导入的另一段"}：{span(d.dates.existing)}
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={dates[d.index] === "imported"} onChange={() => setDates({ ...dates, [d.index]: "imported" })} />
                    这次导入的：{span(d.dates.imported)}
                  </label>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {review.notes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">看起来是资料备注或写给 AI 的要求</h3>
          <p className="text-xs text-muted">这些默认不存成你的经历事实；如果其实是你做过的事，勾选保留。</p>
          {review.notes.map((n) => {
            const k = `${n.index}-${n.factIndex}`;
            return (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={!!keepNotes[k]} onChange={(e) => setKeepNotes({ ...keepNotes, [k]: e.target.checked })} />
                <span>
                  {n.text}
                  <span className="ml-1 text-xs text-muted">· {[exp(n.index).company, exp(n.index).title].filter(Boolean).join(" · ") || "未归类"}</span>
                </span>
              </label>
            );
          })}
        </section>
      )}
      {review.unnamed.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          有 {review.unnamed.reduce((n, i) => n + exp(i).facts.length, 0)} 条内容没有对应的公司或岗位，会放进履历库的「未归类」；补上公司或岗位之前不会写进简历。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="accent" onClick={() => confirmImport({ merge, keepNotes, dates })} disabled={missingDate}>
          {missingDate ? "请先选择起止时间" : "确认存入履历库"}
        </Button>
        <Button variant="ghost" onClick={cancelImport}>放弃这次导入</Button>
      </div>
    </Card>
  );
}

function ChatCollect() {
  const router = useRouter();
  const [messages, setMessages] = useStored<ChatMessage[]>(KEYS.chat, [GREETING]);
  const [, setExperiences] = useStored<Experience[]>(KEYS.experiences, []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [draft, setDraft] = useState<Extracted | null>(null);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  /** 进行中的流式回复；离开页面时中止，避免旧回复在后台继续写入、覆盖回来后的新对话 */
  const stream = useRef<AbortController | null>(null);
  useEffect(() => () => stream.current?.abort(), []);

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
    const ctrl = new AbortController();
    stream.current = ctrl;
    let reply = "";
    try {
      const res = await fetch("/api/chat", {
        signal: ctrl.signal,
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
      for (;;) {
        const { done, value } = await reader.read();
        if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        setMessages([...next, { role: "assistant", content: reply }]);
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        // 离开页面导致中止：保留用户这条发言和已收到的部分回复并注明中断，不再回滚（回滚会覆盖之后的新对话）
        setMessages([...next, { role: "assistant", content: `${reply}${reply ? "\n\n" : ""}（回复因离开页面而中断，可以继续补充或重新提问）` }]);
        return;
      }
      // 流式输出中途断开时浏览器只给出 TypeError，换成可读提示
      setError(e instanceof TypeError ? "连接中断或模型响应超时，请重试" : (e as Error).message || "对话失败");
      // 撤回这条发言并放回输入框，用户可以直接重发
      setMessages(messages);
      setInput(text);
    } finally {
      if (stream.current === ctrl) stream.current = null;
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
      <Card className="!p-0 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft"><Logo size={22} /></span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">简历顾问</div>
            <div className="text-xs text-muted">{streaming ? "正在输入…" : "在线"}</div>
          </div>
          <Button variant="ghost" className="ml-auto" onClick={() => { setMessages([GREETING]); setDraft(null); }} disabled={streaming}>
            重新开始这段
          </Button>
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
            <span className="inline-block whitespace-nowrap rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">{draft.facts.length} 条事实</span>
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

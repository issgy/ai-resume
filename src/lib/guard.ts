/**
 * 公开接口的成本保护（交接包 F12「公开接口输入与调用限制」）：
 * 1. 输入上限：请求体大小、经历 / 事实 / 句子条数、单条文字长度，超出直接拒绝，不调用模型；
 * 2. 频率限制：按访问者 IP，每 10 分钟最多 60 次调用模型的接口请求。
 *
 * 频率计数存在服务器内存里：Vercel 可能同时运行多个实例，各实例分别计数，所以这是挡住大部分滥用的
 * 尽力而为的限制，不是严格的全局上限；费用的硬上限请在模型平台设置余额 / 消费上限。
 */
import { NextResponse } from "next/server";

export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** 请求体上限：完整的履历库 + 简历一般在几十 KB */
export const BODY_MAX_BYTES = 400 * 1024;

export const LIMITS = {
  jd: 10_000,
  experiences: 30,
  factsPerExperience: 60,
  facts: 400,
  factChars: 2_000,
  highlights: 120,
  /** 核验退回原话时可能是几条事实原话拼起来的，比单条事实上限宽 */
  highlightChars: 6_000,
  requirements: 80,
  abilities: 80,
  messages: 400,
  messageChars: 4_000,
  /** 一段对话的总字数 */
  transcriptChars: 80_000,
} as const;

const hits = new Map<string, number[]>();
let lastSweep = 0;
/** 计数表容量：超过后先清过期记录，仍超过才淘汰最早的访问者 */
const MAX_KEYS = 20_000;

/** 访问者标识：Vercel 会覆盖写入这几个请求头，客户端伪造的值不会被采用 */
export function clientKey(req: Request): string {
  const h = req.headers;
  return h.get("x-vercel-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** 记一次请求；超过上限时返回需要等待的毫秒数，否则返回 0 */
export function takeToken(key: string, now = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(key, recent);
    return RATE_WINDOW_MS - (now - recent[0]);
  }
  recent.push(now);
  hits.set(key, recent);
  // 防止内存无限增长：每分钟最多清理一次过期记录；仍超过容量时淘汰最早写入的访问者
  if (hits.size > 5_000 && now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, ts] of hits) if (!ts.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  if (hits.size > MAX_KEYS) {
    for (const k of hits.keys()) {
      if (hits.size <= MAX_KEYS) break;
      if (k !== key) hits.delete(k);
    }
  }
  return 0;
}

/** 仅测试用：清空计数 */
export function resetRateLimit() {
  hits.clear();
  lastSweep = 0;
}

export class InputError extends Error {}

const fail = (msg: string, status: number, headers?: Record<string, string>) => NextResponse.json({ error: msg }, { status, headers });

/**
 * 接口入口：先限频，再读取并检查请求体大小。返回解析后的 JSON，或者一个应直接返回的错误响应。
 * 被拒绝的请求不会调用模型。
 */
export async function guard<T>(req: Request): Promise<{ body: T } | { res: NextResponse }> {
  const wait = takeToken(clientKey(req));
  if (wait > 0) {
    const minutes = Math.max(1, Math.ceil(wait / 60_000));
    return { res: fail(`操作太频繁（每 10 分钟最多 ${RATE_LIMIT} 次 AI 请求），请 ${minutes} 分钟后再试`, 429, { "Retry-After": String(Math.ceil(wait / 1000)) }) };
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > BODY_MAX_BYTES) return { res: fail("提交的内容太多，请精简后再试", 413) };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > BODY_MAX_BYTES) return { res: fail("提交的内容太多，请精简后再试", 413) };
  try {
    return { body: JSON.parse(text) as T };
  } catch {
    return { res: fail("请求格式不正确", 400) };
  }
}

type ExpLike = { facts?: { text?: unknown; source?: unknown }[] };
type HighlightLike = { text?: unknown };

const strLen = (x: unknown) => (typeof x === "string" ? x.length : 0);

/** 检查经历：段数、每段事实数、总事实数、单条事实长度 */
export function checkExperiences(exps: unknown): void {
  if (exps === undefined) return;
  if (!Array.isArray(exps)) throw new InputError("经历数据格式不正确");
  if (exps.length > LIMITS.experiences) throw new InputError(`经历最多 ${LIMITS.experiences} 段，请在履历库合并或删除一些`);
  let total = 0;
  for (const e of exps as ExpLike[]) {
    const facts = Array.isArray(e?.facts) ? e.facts : [];
    if (facts.length > LIMITS.factsPerExperience) throw new InputError(`每段经历最多 ${LIMITS.factsPerExperience} 条事实，请在履历库精简`);
    total += facts.length;
    if (facts.some((f) => strLen(f?.text) > LIMITS.factChars || strLen(f?.source) > LIMITS.factChars)) throw new InputError(`单条事实最多 ${LIMITS.factChars} 字，请在履历库拆分`);
  }
  if (total > LIMITS.facts) throw new InputError(`履历库事实合计最多 ${LIMITS.facts} 条，请精简后再试`);
}

export function checkJd(jd: unknown): void {
  if (jd !== undefined && strLen(jd) > LIMITS.jd) throw new InputError(`JD 最多 ${LIMITS.jd} 字，请删去公司介绍、福利等与要求无关的部分`);
}

export function checkHighlights(hs: unknown): void {
  if (hs === undefined) return;
  if (!Array.isArray(hs)) throw new InputError("简历句数据格式不正确");
  if (hs.length > LIMITS.highlights) throw new InputError(`一次最多处理 ${LIMITS.highlights} 句，请移出一些后再试`);
  if ((hs as HighlightLike[]).some((h) => strLen(h?.text) > LIMITS.highlightChars)) throw new InputError(`单句最多 ${LIMITS.highlightChars} 字`);
}

export function checkList(x: unknown, max: number, label: string): void {
  if (x === undefined) return;
  if (!Array.isArray(x)) throw new InputError(`${label}格式不正确`);
  if (x.length > max) throw new InputError(`${label}最多 ${max} 条`);
}

export function checkMessages(ms: unknown): void {
  if (!Array.isArray(ms)) throw new InputError("对话记录格式不正确");
  if (ms.length > LIMITS.messages || ms.reduce((n, m) => n + strLen(m?.content), 0) > LIMITS.transcriptChars)
    throw new InputError("这段对话太长，没法一次整理；可以把要点复制到「粘贴简历」里导入，或开始新的一段对话");
  if (ms.some((m) => !m || typeof m.content !== "string" || (m.role !== "user" && m.role !== "assistant"))) throw new InputError("对话记录格式不正确");
  if (ms.some((m) => m.content.length > LIMITS.messageChars)) throw new InputError(`单条消息最多 ${LIMITS.messageChars} 字`);
}

/** 把输入检查的错误转成 400 响应 */
export function inputErrorResponse(e: unknown): NextResponse | null {
  return e instanceof InputError ? fail(e.message, 400) : null;
}

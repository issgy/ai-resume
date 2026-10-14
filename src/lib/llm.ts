/**
 * 统一的大模型调用，走 OpenAI 兼容接口。
 * 换模型只需改环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 * 默认智谱 GLM-4-Flash。
 */
const BASE_URL = process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const MODEL = process.env.LLM_MODEL || "glm-4-flash";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

function headers() {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error("未配置 LLM_API_KEY：请复制 .env.example 为 .env.local 并在 .env.local 中填写 Key（.env.example 不会被读取），然后重启 npm run dev");
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

/** 模型调用超时：要小于路由的 maxDuration(60s)，超时后返回清晰错误，而不是被平台以 504 掐断 */
const TIMEOUT_MS = 50_000;
const TIMEOUT_MSG = "模型响应超时，请稍后重试";

async function post(body: Record<string, unknown>, signal: AbortSignal) {
  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: MODEL, ...body }),
      signal,
    });
    if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  } catch (e) {
    if (signal.aborted) throw new Error(TIMEOUT_MSG);
    throw e;
  }
}

export async function callLLM(messages: LLMMessage[], temperature = 0.3): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await post({ messages, temperature }, controller.signal);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (controller.signal.aborted) throw new Error(TIMEOUT_MSG);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 调用模型并把回复解析为 JSON（容忍 ```json 包裹和前后多余文字） */
export async function callLLMJson<T>(messages: LLMMessage[]): Promise<T> {
  const text = await callLLM(messages, 0.2);
  return parseJson<T>(text);
}

export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("模型没有返回 JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** 流式调用，返回纯文本流（把上游 SSE 解析成增量文本） */
export async function streamLLM(messages: LLMMessage[], temperature = 0.5): Promise<ReadableStream<Uint8Array>> {
  // 整个流（含首字节前的等待）共用一个超时，超时后中止上游请求并结束输出
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await post({ messages, temperature, stream: true }, controller.signal);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(out) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        clearTimeout(timer);
        out.error(controller.signal.aborted ? new Error(TIMEOUT_MSG) : e);
        return;
      }
      const { done, value } = chunk;
      if (done) {
        clearTimeout(timer);
        out.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) out.enqueue(encoder.encode(delta));
        } catch {
          // 忽略不完整的行
        }
      }
    },
    cancel() {
      clearTimeout(timer);
      reader.cancel();
    },
  });
}

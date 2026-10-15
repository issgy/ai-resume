/**
 * 统一的大模型调用，走 OpenAI 兼容接口。
 * 两档模型，换模型只需改环境变量：
 * - 默认档 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL：录入对话，要求快，默认智谱 GLM-4-Flash
 * - 强模型档 LLM_STRONG_BASE_URL / LLM_STRONG_API_KEY / LLM_STRONG_MODEL：整理、匹配、撰写，要求准；
 *   未配置 LLM_STRONG_API_KEY 时回退到默认档
 */
export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };
export type Tier = "default" | "strong";

type Config = { baseUrl: string; apiKey: string; model: string; keyVar: string };

function config(tier: Tier): Config {
  const base: Config = {
    baseUrl: process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "glm-4-flash",
    keyVar: "LLM_API_KEY",
  };
  if (tier === "strong" && process.env.LLM_STRONG_API_KEY) {
    return {
      baseUrl: process.env.LLM_STRONG_BASE_URL || base.baseUrl,
      apiKey: process.env.LLM_STRONG_API_KEY,
      model: process.env.LLM_STRONG_MODEL || base.model,
      keyVar: "LLM_STRONG_API_KEY",
    };
  }
  return base;
}

function headers(cfg: Config) {
  if (!cfg.apiKey) throw new Error(`未配置 ${cfg.keyVar}：请复制 .env.example 为 .env.local 并在 .env.local 中填写 Key（.env.example 不会被读取），然后重启 npm run dev`);
  return { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
}

/** 模型调用超时：要小于路由的 maxDuration(60s)，超时后返回清晰错误，而不是被平台以 504 掐断 */
const TIMEOUT_MS = 50_000;
const TIMEOUT_MSG = "模型响应超时，请稍后重试";

async function post(tier: Tier, body: Record<string, unknown>, signal: AbortSignal) {
  const cfg = config(tier);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ model: cfg.model, ...body }),
      signal,
    });
    if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  } catch (e) {
    if (signal.aborted) throw new Error(TIMEOUT_MSG);
    throw e;
  }
}

export async function callLLM(messages: LLMMessage[], temperature = 0.3, tier: Tier = "default"): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await post(tier, { messages, temperature }, controller.signal);
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
/** 结构化任务（整理、匹配、撰写）默认走强模型档 */
export async function callLLMJson<T>(messages: LLMMessage[], tier: Tier = "strong"): Promise<T> {
  const text = await callLLM(messages, 0.2, tier);
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
    res = await post("default", { messages, temperature, stream: true }, controller.signal);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sent = false;

  /** 结束输出并主动断开上游：有的服务商发完 [DONE] 后不关闭连接，不主动断开会一直挂到平台超时 */
  function finish(out: ReadableStreamDefaultController<Uint8Array>) {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    out.close();
  }

  return new ReadableStream({
    async pull(out) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        clearTimeout(timer);
        // 已经输出过内容就正常收尾，保留已生成的部分；否则报错让前端提示重试
        if (sent) out.close();
        else out.error(controller.signal.aborted ? new Error(TIMEOUT_MSG) : e);
        return;
      }
      const { done, value } = chunk;
      if (done) {
        finish(out);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          finish(out);
          return;
        }
        try {
          const choice = JSON.parse(payload).choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            out.enqueue(encoder.encode(delta));
            sent = true;
          }
          if (choice?.finish_reason) {
            finish(out);
            return;
          }
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

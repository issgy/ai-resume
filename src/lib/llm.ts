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

async function post(body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function callLLM(messages: LLMMessage[], temperature = 0.3): Promise<string> {
  const res = await post({ messages, temperature });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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
  const res = await post({ messages, temperature, stream: true });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
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
          if (delta) controller.enqueue(encoder.encode(delta));
        } catch {
          // 忽略不完整的行
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

import { streamLLM } from "@/lib/llm";
import { checkMessages, guard, inputErrorResponse } from "@/lib/guard";
import { INTERVIEWER } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/types";


export async function POST(req: Request) {
  const g = await guard<{ messages: ChatMessage[] }>(req);
  if ("res" in g) return g.res;
  // 服务器只用最近 30 条，检查也只看这 30 条，不因为对话长而拒绝
  const messages = Array.isArray(g.body.messages) ? g.body.messages.slice(-30) : g.body.messages;
  try {
    checkMessages(messages);
  } catch (e) {
    return inputErrorResponse(e) ?? new Response("请求格式不正确", { status: 400 });
  }
  try {
    const stream = await streamLLM([{ role: "system", content: INTERVIEWER }, ...messages]);
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
}

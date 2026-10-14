import { streamLLM } from "@/lib/llm";
import { INTERVIEWER } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: ChatMessage[] };
  try {
    const stream = await streamLLM([{ role: "system", content: INTERVIEWER }, ...messages.slice(-30)]);
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
}

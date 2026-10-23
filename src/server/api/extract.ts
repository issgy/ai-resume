import { NextResponse } from "next/server";
import { checkMessages, guard, inputErrorResponse } from "@/lib/guard";
import { callLLMJson } from "@/lib/llm";
import { EXTRACTOR } from "@/lib/prompts";
import { sourceInUserText } from "@/lib/validate";
import type { ChatMessage } from "@/lib/types";


type Extracted = {
  company: string;
  title: string;
  start: string;
  end: string;
  facts: { text: string; source: string }[];
};

export async function POST(req: Request) {
  const g = await guard<{ messages: ChatMessage[] }>(req);
  if ("res" in g) return g.res;
  const { messages } = g.body;
  try {
    checkMessages(messages);
  } catch (e) {
    return inputErrorResponse(e)!;
  }
  const transcript = messages.map((m) => `${m.role === "user" ? "用户" : "顾问"}：${m.content}`).join("\n");
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

  try {
    const data = await callLLMJson<Extracted>([
      { role: "system", content: EXTRACTOR },
      { role: "user", content: transcript },
    ]);
    const facts = (data.facts ?? []).filter((f) => f.text && sourceInUserText(f.source ?? "", userText));
    const rejected = (data.facts?.length ?? 0) - facts.length;
    return NextResponse.json({ ...data, facts, rejected });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { checkRequirements } from "@/lib/match";
import { MATCHER } from "@/lib/prompts";
import type { Experience } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, experiences } = (await req.json()) as { jd: string; experiences: Experience[] };
  if (!jd || jd.trim().length < 50) {
    return NextResponse.json({ error: "JD 内容太短，请粘贴完整的岗位描述（职责 + 要求）" }, { status: 400 });
  }
  // 起止时间一并给模型，年限类要求才能结合经历时长判断
  const payload = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => ({
      company: e.company,
      title: e.title,
      start: e.start,
      end: e.end,
      facts: e.facts.map((f) => ({ id: f.id, text: f.text, source: f.source })),
    }));
  if (payload.length === 0) {
    return NextResponse.json({ error: "履历库还是空的，请先录入经历" }, { status: 400 });
  }
  const today = new Date().toISOString().slice(0, 7);
  try {
    const data = await callLLMJson<{ requirements?: unknown }>([
      { role: "system", content: MATCHER },
      { role: "user", content: `## 今天\n${today}\n\n## JD\n${jd}\n\n## 经历\n${JSON.stringify(payload)}` },
    ]);
    // 模型的覆盖结论只能被代码降级：技术词、复合要求、年限逐条核对，结构异常按缺口处理
    const requirements = checkRequirements(data?.requirements, experiences);
    if (!requirements) {
      return NextResponse.json({ error: "匹配结果格式异常，请重新分析" }, { status: 502 });
    }
    return NextResponse.json({ requirements });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

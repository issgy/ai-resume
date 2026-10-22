import { NextResponse } from "next/server";
import { callLLMJson } from "@/lib/llm";
import { sanitizeEducation } from "@/lib/education";
import { normalizeMatch } from "@/lib/matching";
import { isInstructionFact } from "@/lib/validate";
import { MATCHER } from "@/lib/prompts";
import type { Experience } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { jd, experiences, education: rawEducation } = (await req.json()) as { jd: string; experiences: Experience[]; education?: unknown };
  const education = sanitizeEducation(rawEducation);
  if (!jd || jd.trim().length < 50) {
    return NextResponse.json({ error: "JD 内容太短，请粘贴完整的岗位描述（职责 + 要求）" }, { status: 400 });
  }
  // 起止时间一并给模型，年限类要求才能结合经历时长判断
  const payload = experiences
    .filter((e) => e.facts.length > 0)
    .map((e) => ({
      id: e.id,
      company: e.company,
      title: e.title,
      start: e.start,
      end: e.end,
      // 资料里的指令或备注不作为候选人行为（R14）
      facts: e.facts.filter((f) => !isInstructionFact(f)).map((f) => ({ id: f.id, text: f.text, source: f.source })),
    }));
  if (payload.length === 0) {
    return NextResponse.json({ error: "履历库还是空的，请先录入经历" }, { status: 400 });
  }
  const today = new Date().toISOString().slice(0, 7);
  try {
    const data = await callLLMJson<unknown>([
      { role: "system", content: MATCHER },
      { role: "user", content: `## 今天\n${today}\n\n## JD\n${jd}\n\n## 经历\n${JSON.stringify(payload)}` },
    ]);
    // 服务端校验 id、枚举和证据理由；学历、年限由程序判断（见 normalizeMatch）
    const match = normalizeMatch(data, jd, experiences, education);
    if (!match) {
      return NextResponse.json({ error: "匹配结果格式异常（模型输出不完整），请重新分析" }, { status: 502 });
    }
    return NextResponse.json(match);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

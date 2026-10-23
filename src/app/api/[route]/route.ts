import { NextResponse } from "next/server";
import { POST as chat } from "@/server/api/chat";
import { POST as extract } from "@/server/api/extract";
import { POST as importResume } from "@/server/api/import";
import { POST as match } from "@/server/api/match";
import { POST as qa } from "@/server/api/qa";
import { POST as resume } from "@/server/api/resume";
import { POST as verify } from "@/server/api/verify";

export const maxDuration = 60;

/**
 * 所有调用模型的接口共用这一个入口（网址不变：/api/chat、/api/match……）。
 * 部署时它们是同一个服务器函数，频率计数（lib/guard）在各接口之间共享，
 * 「每 10 分钟最多 60 次」才是合计的次数，而不是每个接口各 60 次。
 */
const HANDLERS: Record<string, (req: Request) => Promise<Response>> = {
  chat,
  extract,
  import: importResume,
  match,
  qa,
  resume,
  verify,
};

export async function POST(req: Request, { params }: { params: Promise<{ route: string }> }) {
  const handler = HANDLERS[(await params).route];
  if (!handler) return NextResponse.json({ error: "接口不存在" }, { status: 404 });
  return handler(req);
}

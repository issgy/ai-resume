"use client";

import { useRouter } from "next/navigation";
import { hasUserData, loadDemo } from "@/lib/demo";

export function DemoButton() {
  const router = useRouter();
  function start() {
    if (hasUserData() && !confirm("示例数据会替换你当前的履历库和匹配结果，确定继续吗？\n（可以先到履历库页「导出备份」）")) return;
    loadDemo();
    router.push("/match");
  }
  return (
    <button
      onClick={start}
      className="rounded-full border border-accent/30 bg-accent-soft px-6 py-3 text-sm font-medium text-accent transition hover:border-accent"
    >
      一键体验示例
    </button>
  );
}

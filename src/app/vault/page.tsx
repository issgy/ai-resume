"use client";

import { useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { KEYS, exportAll, importAll, uid, useStored } from "@/lib/storage";
import type { Experience } from "@/lib/types";

export default function VaultPage() {
  const [experiences, setExperiences, loaded] = useStored<Experience[]>(KEYS.experiences, []);
  const fileInput = useRef<HTMLInputElement>(null);

  function update(id: string, patch: Partial<Experience>) {
    setExperiences((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function download() {
    const blob = new Blob([exportAll()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-resume-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function upload(file: File) {
    try {
      importAll(await file.text());
      location.reload();
    } catch {
      alert("文件格式不正确");
    }
  }

  if (!loaded) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">履历库</h1>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={download}>导出备份</Button>
          <Button variant="ghost" onClick={() => fileInput.current?.click()}>导入备份</Button>
          <input ref={fileInput} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Link href="/collect"><Button>+ 录入新经历</Button></Link>
        </div>
      </div>

      {experiences.length === 0 && (
        <p className="rounded border bg-white p-6 text-center text-slate-500">
          还没有经历，<Link href="/collect" className="underline">去录入第一段</Link>
        </p>
      )}

      {experiences.map((exp) => (
        <section key={exp.id} className="space-y-3 rounded border bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <input className="rounded border px-2 py-1 font-semibold" value={exp.company} placeholder="公司" onChange={(e) => update(exp.id, { company: e.target.value })} />
            <input className="rounded border px-2 py-1" value={exp.title} placeholder="岗位" onChange={(e) => update(exp.id, { title: e.target.value })} />
            <input className="w-24 rounded border px-2 py-1 text-sm" value={exp.start} placeholder="开始" onChange={(e) => update(exp.id, { start: e.target.value })} />
            <span>–</span>
            <input className="w-24 rounded border px-2 py-1 text-sm" value={exp.end} placeholder="结束" onChange={(e) => update(exp.id, { end: e.target.value })} />
            <Button
              variant="danger"
              className="ml-auto"
              onClick={() => confirm("删除这段经历？") && setExperiences((p) => p.filter((e) => e.id !== exp.id))}
            >
              删除
            </Button>
          </div>

          <ul className="space-y-2">
            {exp.facts.map((f) => (
              <li key={f.id} className="flex gap-2">
                <div className="flex-1">
                  <textarea
                    className="w-full rounded border p-2 text-sm"
                    rows={2}
                    value={f.text}
                    onChange={(e) =>
                      update(exp.id, { facts: exp.facts.map((x) => (x.id === f.id ? { ...x, text: e.target.value } : x)) })
                    }
                  />
                  <div className="text-xs text-slate-500">原话：「{f.source}」</div>
                </div>
                <Button variant="danger" onClick={() => update(exp.id, { facts: exp.facts.filter((x) => x.id !== f.id) })}>×</Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            onClick={() => {
              const text = prompt("补充一条事实（请如实填写）");
              if (text?.trim()) update(exp.id, { facts: [...exp.facts, { id: uid(), text: text.trim(), source: text.trim() }] });
            }}
          >
            + 手动补充一条
          </Button>
        </section>
      ))}

      {experiences.length > 0 && (
        <Link href="/match"><Button>下一步：粘贴 JD 匹配 →</Button></Link>
      )}
    </div>
  );
}

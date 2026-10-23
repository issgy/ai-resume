"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, ErrorText, PageHeader } from "@/components/ui";
import { KEYS, exportAll, importAll, read, uid, useStored } from "@/lib/storage";
import { parseBackup } from "@/lib/backup";
import type { Education, Experience, Fact } from "@/lib/types";

export default function VaultPage() {
  const [experiences, setExperiences, loaded] = useStored<Experience[]>(KEYS.experiences, []);
  const [education, setEducation] = useStored<Education[]>(KEYS.education, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [backupError, setBackupError] = useState("");

  /** 修改教育背景：导入的条目改过之后标为「手动修改」，原文仍保留 */
  function updateEdu(id: string, patch: Partial<Education>) {
    setEducation((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch, origin: e.origin === "imported" ? "edited" : e.origin } : e)));
  }

  function update(id: string, patch: Partial<Experience>) {
    setExperiences((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  /** 手动修改的内容就是用户自己写的：改后的文字记为新来源，第一次修改时保留修改前的原话 */
  function editFact(exp: Experience, f: Fact, text: string) {
    const edited: Fact = {
      ...f,
      text,
      source: text,
      origin: "edited",
      originalSource: f.origin === "edited" ? f.originalSource : f.source,
    };
    update(exp.id, { facts: exp.facts.map((x) => (x.id === f.id ? edited : x)) });
  }

  function download() {
    const blob = new Blob([exportAll()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-resume-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 导入备份：先校验结构，列出要覆盖的内容和被跳过的条目，用户确认后才写入 */
  async function upload(file: File) {
    setBackupError("");
    try {
      const { data, summary, warnings } = parseBackup(await file.text());
      const cur = read<Experience[]>(KEYS.experiences, []);
      const lines = [
        `当前履历库：${cur.length} 段经历、${cur.reduce((n, e) => n + e.facts.length, 0)} 条事实`,
        `备份内容：${summary.experiences} 段经历、${summary.facts} 条事实、${summary.education} 条教育背景${summary.hasResume ? "、1 份简历" : ""}${summary.hasMatch ? "、1 份 JD 匹配" : ""}`,
        ...(warnings.length ? ["", "以下内容不完整，不会导入：", ...warnings.map((w) => `· ${w}`)] : []),
        "",
        "导入会用备份覆盖当前对应的内容，且无法撤销。建议先「导出备份」保存当前资料。确定导入吗？",
      ];
      if (!confirm(lines.join("\n"))) return;
      importAll(data);
      location.reload();
    } catch (e) {
      setBackupError(`导入失败：${(e as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!loaded) return null;

  const factCount = experiences.reduce((n, e) => n + e.facts.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        step="02"
        title="履历库"
        desc={`共 ${experiences.length} 段经历、${factCount} 条事实。每条事实都保留了你的原话，可随时修改。`}
        actions={
          <>
            <Button variant="ghost" onClick={download}>导出备份</Button>
            <Button variant="ghost" onClick={() => fileInput.current?.click()}>导入备份</Button>
            <input ref={fileInput} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Link href="/collect"><Button variant="accent">+ 录入新经历</Button></Link>
          </>
        }
      />
      <ErrorText>{backupError}</ErrorText>

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">教育背景</h2>
            <p className="text-xs text-muted">用于判断 JD 里的学历、专业要求</p>
          </div>
          <Button
            variant="ghost"
            onClick={() => setEducation((p) => [...p, { id: uid(), school: "", degree: "", major: "", start: "", end: "", source: "", origin: "manual" }])}
          >
            + 添加
          </Button>
        </div>
        {education.length === 0 && <p className="text-sm text-muted">还没有教育背景。粘贴简历导入时会自动识别，也可以手动添加。</p>}
        {education.map((e) => (
          <div key={e.id} className="space-y-1.5 rounded-2xl border border-line bg-paper/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input className="field !w-auto flex-1 font-semibold sm:max-w-48" value={e.school} placeholder="学校" onChange={(ev) => updateEdu(e.id, { school: ev.target.value })} />
              <input className="field !w-28" value={e.degree} placeholder="学历" onChange={(ev) => updateEdu(e.id, { degree: ev.target.value })} />
              <input className="field !w-auto flex-1 sm:max-w-48" value={e.major} placeholder="专业" onChange={(ev) => updateEdu(e.id, { major: ev.target.value })} />
              <div className="flex items-center gap-1.5">
                <input className="field !w-24" value={e.start} placeholder="入学" onChange={(ev) => updateEdu(e.id, { start: ev.target.value })} />
                <span className="text-muted">–</span>
                <input className="field !w-24" value={e.end} placeholder="毕业" onChange={(ev) => updateEdu(e.id, { end: ev.target.value })} />
              </div>
              <button
                className="ml-auto h-8 w-8 shrink-0 rounded-full text-muted transition hover:bg-red-50 hover:text-red-600"
                title="删除这段教育背景"
                onClick={() => setEducation((p) => p.filter((x) => x.id !== e.id))}
              >
                ×
              </button>
            </div>
            {e.source && (
              <div className="px-1 text-xs text-muted">
                {e.origin === "edited" ? (
                  <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-800">手动修改</span>
                ) : (
                  <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-sky-800">简历导入</span>
                )}
                原文：「{e.source}」
              </div>
            )}
          </div>
        ))}
      </Card>

      {experiences.length === 0 && (
        <Card className="py-14 text-center">
          <div className="bg-brand mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl text-xl text-white">+</div>
          <p className="text-muted">
            还没有经历，<Link href="/collect" className="font-medium text-accent underline underline-offset-4">去录入第一段</Link>
          </p>
        </Card>
      )}

      {experiences.map((exp, idx) => (
        <Card key={exp.id} className="animate-rise space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">0{idx + 1}</span>
            <input className="field !w-auto flex-1 !text-base font-semibold sm:max-w-56" value={exp.company} placeholder="公司" onChange={(e) => update(exp.id, { company: e.target.value })} />
            <input className="field !w-auto flex-1 sm:max-w-48" value={exp.title} placeholder="岗位" onChange={(e) => update(exp.id, { title: e.target.value })} />
            <div className="flex items-center gap-1.5">
              <input className="field !w-28" value={exp.start} placeholder="开始" onChange={(e) => update(exp.id, { start: e.target.value })} />
              <span className="text-muted">–</span>
              <input className="field !w-28" value={exp.end} placeholder="结束" onChange={(e) => update(exp.id, { end: e.target.value })} />
            </div>
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
              <li key={f.id} className="group flex gap-2 rounded-2xl border border-line bg-paper/60 p-3">
                <div className="flex-1 space-y-1.5">
                  <textarea
                    className="field resize-none"
                    rows={2}
                    value={f.text}
                    onChange={(e) => editFact(exp, f, e.target.value)}
                  />
                  <div className="px-1 text-xs text-muted">
                    {f.origin === "edited" ? (
                      <>
                        <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-amber-800">手动修改</span>
                        以上文字即为来源{f.originalSource ? `；修改前原话：「${f.originalSource}」` : ""}
                      </>
                    ) : f.origin === "manual" ? (
                      <>
                        <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-accent">手动补充</span>
                        以上文字即为来源
                      </>
                    ) : f.origin === "imported" ? (
                      <>
                        <span className="inline-block whitespace-nowrap mr-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-sky-800">简历导入</span>
                        原文：「{f.source}」
                      </>
                    ) : (
                      <>原话：「{f.source}」</>
                    )}
                  </div>
                </div>
                <button
                  className="h-8 w-8 shrink-0 rounded-full text-muted transition hover:bg-red-50 hover:text-red-600"
                  title="删除这条事实"
                  onClick={() => update(exp.id, { facts: exp.facts.filter((x) => x.id !== f.id) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            onClick={() => {
              const text = prompt("补充一条事实（请如实填写）");
              if (text?.trim()) update(exp.id, { facts: [...exp.facts, { id: uid(), text: text.trim(), source: text.trim(), origin: "manual" }] });
            }}
          >
            + 手动补充一条
          </Button>
        </Card>
      ))}

      {experiences.length > 0 && (
        <div className="flex justify-end">
          <Link href="/match"><Button variant="accent" className="!px-6 !py-3">下一步：粘贴 JD 匹配 →</Button></Link>
        </div>
      )}
    </div>
  );
}

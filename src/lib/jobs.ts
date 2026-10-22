"use client";

import { useSyncExternalStore } from "react";
import { postJson } from "@/components/ui";
import { KEYS, read, uid, writeStored } from "@/lib/storage";
import { BULLET_RE, findSameExperience } from "@/lib/importText";
import type { ImportResponse } from "@/lib/importText";
import type { Education, Experience, Highlight, Profile, Requirement, ResumeResult } from "@/lib/types";
import { educationKey } from "@/lib/education";
import { failQA, failVerification, norm } from "@/lib/validate";

/**
 * 「粘贴简历导入」「分析匹配」「生成定向简历」的后台任务。
 * 状态是模块级单例，与页面组件的生命周期无关：用户中途切到其他步骤，请求继续跑，结果照常写入 localStorage。
 * 整页刷新/关闭会中断请求，所以进行中的任务记在 sessionStorage，刷新后据此提示「被中断」而不是静默。
 */

export type JobKind = "import" | "match" | "resume";

export type Notice = { tone: "success" | "error"; text: string; href: string };

/** 一次导入写入履历库后的汇总，显示在录入页 */
export type ImportSummary = {
  added: number;
  merged: number;
  /** 实际写入的事实条数 */
  facts: number;
  /** 与履历库已有事实同一原文、跳过的条数 */
  duplicates: number;
  /** 在原文中找不到依据而丢弃的条数 */
  rejected: number;
  /** 填充了的个人信息字段（中文名） */
  profileFields: string[];
  /** 没能归到具体经历、已放入「未归类」的行数 */
  unassigned: number;
  /** 新增的教育背景条数（与已有学校 + 学历相同的跳过）；旧版本没有该字段 */
  education?: number;
};

export type JobsState = {
  /** 进行中的阶段，null 表示空闲；同类任务同一时间只有一个 */
  import: "import" | null;
  match: "match" | null;
  resume: "resume" | "verify" | "qa" | null;
  /** 最近一次匹配/生成失败原因，显示在匹配页；开始新任务时清空 */
  error: string;
  /** 最近一次导入失败原因，显示在录入页 */
  importError: string;
  /** 最近一次导入的汇总 */
  importSummary: ImportSummary | null;
  /** 用户不在任务所属页面时的完成/失败提示，显示在顶部导航 */
  notice: Notice | null;
  /** 正在局部重试的经历 id */
  retrying: string | null;
  /** 最近一次局部重试的失败原因 */
  retryError: string;
};

const PENDING_KEY = (kind: JobKind) => `air:job:${kind}`;
const INTERRUPTED: Record<JobKind, string> = {
  import: "上次简历导入被中断，请重新导入",
  match: "上次匹配分析被中断，请重新分析",
  resume: "上次生成被中断，请重新生成",
};
const HREF: Record<JobKind, string> = { import: "/collect", match: "/match", resume: "/match" };

const SERVER_STATE: JobsState = { import: null, match: null, resume: null, error: "", importError: "", importSummary: null, notice: null, retrying: null, retryError: "" };
let state: JobsState = SERVER_STATE;
let initialized = false;
const listeners = new Set<() => void>();
/** 匹配页挂载时注册：生成完成且用户仍在匹配页时由它跳转到简历页 */
let onResumeDone: (() => void) | null = null;

function update(patch: Partial<JobsState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/**
 * 整页刷新/关闭时浏览器会中止进行中的请求，旧页面的 catch/finally 可能在卸载前执行。
 * 卸载期间不能清除进行中标记，否则新页面发现不了「被中断」。
 */
let unloading = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    unloading = true;
  });
  window.addEventListener("beforeunload", () => {
    unloading = true;
  });
  // 从 bfcache 恢复时页面并没有卸载
  window.addEventListener("pageshow", () => {
    unloading = false;
  });
}

function markPending(kind: JobKind, pending: boolean) {
  if (!pending && unloading) return;
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY(kind), String(Date.now()));
    else sessionStorage.removeItem(PENDING_KEY(kind));
  } catch {
    // sessionStorage 不可用时只是失去「被中断」提示
  }
}

/** 首次订阅时检查上次页面留下的未完成任务：能走到这里说明本页没有在跑它，即已被刷新/关闭中断 */
function init() {
  if (initialized) return;
  initialized = true;
  // 两类都被中断时以生成简历的提示为准（后写覆盖先写）
  for (const kind of ["import", "match", "resume"] as const) {
    let pending = false;
    try {
      pending = sessionStorage.getItem(PENDING_KEY(kind)) !== null;
    } catch {}
    if (!pending || state[kind]) continue;
    markPending(kind, false);
    const notice: Notice = { tone: "error", text: INTERRUPTED[kind], href: HREF[kind] };
    update(kind === "import" ? { importError: INTERRUPTED[kind], notice } : { error: INTERRUPTED[kind], notice });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  init();
  return () => listeners.delete(listener);
}

export function useJobs(): JobsState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export function dismissNotice() {
  if (state.notice) update({ notice: null });
}

/** 匹配页挂载期间注册跳转回调，返回注销函数 */
export function attachResumeRedirect(fn: () => void) {
  onResumeDone = fn;
  return () => {
    if (onResumeDone === fn) onResumeDone = null;
  };
}

const STORAGE_FAILED = "浏览器存储空间不足或被禁用，导入内容没有保存。请清理浏览器数据或关闭无痕模式后重试";

const PROFILE_LABELS: Record<keyof Profile, string> = { name: "姓名", phone: "电话", email: "邮箱", school: "学校", birthday: "出生日期" };
const EMPTY_PROFILE: Profile = { name: "", phone: "", email: "", school: "", birthday: "" };

/**
 * 把导入结果写入履历库（产品决策：不逐条确认）：同 company + title 的经历合并到已有经历，按 source 跳过已有事实；
 * 其余作为新经历追加。个人信息只填充当前为空的字段。以 localStorage 中的最新值为准。
 */
function applyImport(data: ImportResponse): ImportSummary {
  const experiences = read<Experience[]>(KEYS.experiences, []);
  let added = 0;
  let merged = 0;
  let facts = 0;
  let duplicates = 0;
  for (const imp of data.experiences) {
    // 没有公司和岗位的「未归类」内容也合并到已有的未归类经历，重复导入时不再多出一段
    const idx = findSameExperience(experiences, imp);
    const existing = idx >= 0 ? experiences[idx] : null;
    // 原文或整理后的文字任一相同都算重复（忽略行首项目符号），避免重复导入同一份简历时多出事实
    const strip = (s: string) => norm(s.replace(BULLET_RE, ""));
    const seen = new Set((existing?.facts ?? []).flatMap((f) => [strip(f.source), strip(f.text)]));
    const fresh = imp.facts
      .filter((f) => {
        const dup = seen.has(strip(f.source)) || seen.has(strip(f.text));
        if (!dup) {
          seen.add(strip(f.source));
          seen.add(strip(f.text));
        }
        if (dup) duplicates++;
        return !dup;
      })
      .map((f) => ({ id: uid(), text: f.text, source: f.source, origin: "imported" as const }));
    facts += fresh.length;
    if (existing) {
      merged++;
      experiences[idx] = { ...existing, start: existing.start || imp.start, end: existing.end || imp.end, facts: [...existing.facts, ...fresh] };
    } else {
      added++;
      experiences.push({ id: uid(), company: imp.company, title: imp.title, start: imp.start, end: imp.end, facts: fresh });
    }
  }
  // 写不进浏览器存储（空间不足或被禁用）时不能提示导入成功
  if (!writeStored(KEYS.experiences, experiences)) throw new Error(STORAGE_FAILED);

  const profile = { ...EMPTY_PROFILE, ...read<Partial<Profile>>(KEYS.profile, {}) };
  const profileFields: string[] = [];
  for (const k of Object.keys(PROFILE_LABELS) as (keyof Profile)[]) {
    const v = data.profile[k]?.trim();
    if (v && !profile[k]?.trim()) {
      profile[k] = v;
      profileFields.push(PROFILE_LABELS[k]);
    }
  }
  if (profileFields.length > 0 && !writeStored(KEYS.profile, profile)) throw new Error(STORAGE_FAILED);

  // 教育背景：学校 + 学历相同的视为同一段，跳过
  const education = read<Education[]>(KEYS.education, []);
  const eduKeys = new Set(education.map(educationKey));
  let eduAdded = 0;
  for (const e of data.education ?? []) {
    if (eduKeys.has(educationKey(e))) continue;
    eduKeys.add(educationKey(e));
    education.push({ id: uid(), ...e, origin: "imported" });
    eduAdded++;
  }
  if (eduAdded > 0 && !writeStored(KEYS.education, education)) throw new Error(STORAGE_FAILED);

  return { added, merged, facts, duplicates, rejected: data.rejected, profileFields, unassigned: data.unassigned, education: eduAdded };
}

export async function runImport(text: string) {
  if (state.import) return;
  update({ import: "import", importError: "", importSummary: null, notice: null });
  markPending("import", true);
  try {
    const data = await postJson<ImportResponse>("/api/import", { text });
    const summary = applyImport(data);
    const partial = summary.unassigned > 0 ? "，有部分内容没能归到具体经历" : "";
    update({
      import: null,
      importSummary: summary,
      notice: { tone: "success", text: `简历导入完成：新增 ${summary.added} 段、合并 ${summary.merged} 段经历${partial}，点击查看`, href: "/collect" },
    });
  } catch (e) {
    const message = (e as Error).message;
    update({ import: null, importError: message, notice: { tone: "error", text: `简历导入失败：${message}`, href: "/collect" } });
  } finally {
    markPending("import", false);
  }
}

export async function runMatch(jd: string, experiences: Experience[]) {
  if (state.match) return;
  update({ match: "match", error: "", notice: null });
  markPending("match", true);
  try {
    const education = read<Education[]>(KEYS.education, []);
    const { requirements } = await postJson<{ requirements: Requirement[] }>("/api/match", { jd, experiences, education });
    writeStored(KEYS.match, { jd, requirements });
    update({ match: null, notice: { tone: "success", text: "匹配分析已完成，点击查看", href: "/match" } });
  } catch (e) {
    const message = (e as Error).message;
    update({ match: null, error: message, notice: { tone: "error", text: `匹配分析失败：${message}`, href: "/match" } });
  } finally {
    markPending("match", false);
  }
}

type Generated = Pick<ResumeResult, "highlights" | "dropped" | "failedExperienceIds">;

/**
 * 撰写 → 逐句核验 → 面试准备。各阶段失败都按技术错误处理（02 S6、T14）：
 * - 撰写整体失败：抛错（没有任何结果可保留）；单段失败记入 failedExperienceIds，可单独重试
 * - 核验失败：句子保留为 pending + technical_error，不导出、可重试，不判成「找不到依据」
 * - 面试准备失败：只标记 qaFailed，不影响句子导出
 */
async function generate(jd: string, requirements: Requirement[], experiences: Experience[], onStage: (s: "verify" | "qa") => void): Promise<Generated> {
  const data = await postJson<Generated>("/api/resume", { jd, requirements, experiences, education: read<Education[]>(KEYS.education, []) });
  let verified: Pick<ResumeResult, "highlights" | "dropped"> = { highlights: [], dropped: [] };
  if (data.highlights.length > 0) {
    onStage("verify");
    try {
      verified = await postJson<Pick<ResumeResult, "highlights" | "dropped">>("/api/verify", { highlights: data.highlights, experiences });
    } catch {
      verified = { highlights: failVerification(data.highlights), dropped: [] };
    }
  }
  let answered = verified.highlights;
  const ready = verified.highlights.filter((h) => (h.exportStatus ?? "ready") === "ready");
  if (ready.length > 0) {
    onStage("qa");
    let withQA: Highlight[];
    try {
      withQA = (await postJson<{ highlights: Highlight[] }>("/api/qa", { jd, highlights: ready, experiences })).highlights;
    } catch {
      withQA = failQA(ready);
    }
    // 按顺序把面试准备结果放回原位置，非 ready 的句子原样保留
    let k = 0;
    answered = verified.highlights.map((h) => ((h.exportStatus ?? "ready") === "ready" ? (withQA[k++] ?? h) : h));
  }
  return { highlights: answered, dropped: [...data.dropped, ...verified.dropped], failedExperienceIds: data.failedExperienceIds ?? [] };
}

export async function runResume(jd: string, requirements: Requirement[], experiences: Experience[]) {
  if (state.resume) return;
  update({ resume: "resume", error: "", notice: null });
  markPending("resume", true);
  try {
    const data = await generate(jd, requirements, experiences, (stage) => update({ resume: stage }));
    const resume: ResumeResult = {
      jd,
      highlights: data.highlights,
      dropped: data.dropped,
      failedExperienceIds: data.failedExperienceIds ?? [],
      // 只有 exportStatus 为 ready 的句子会被导出
      provenanceChecked: true,
      requirements,
    };
    writeStored(KEYS.resume, resume);
    if (onResumeDone) {
      update({ resume: null });
      onResumeDone();
    } else {
      update({ resume: null, notice: { tone: "success", text: "定向简历已生成，点击查看", href: "/resume" } });
    }
  } catch (e) {
    const message = (e as Error).message;
    update({ resume: null, error: message, notice: { tone: "error", text: `定向简历生成失败：${message}`, href: "/match" } });
  } finally {
    markPending("resume", false);
  }
}

/**
 * 局部重试（T14）：只重新生成一段经历，其他经历已完成的结果原样保留；替换这段经历原有的句子，不重复插入。
 * 用于撰写失败、核验失败、来源已修改待重验、面试准备失败。
 */
export async function retryExperience(experienceId: string) {
  if (state.resume || state.retrying) return;
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  const exp = read<Experience[]>(KEYS.experiences, []).find((e) => e.id === experienceId);
  if (!resume || !exp) return;
  const requirements = resume.requirements ?? read<{ requirements: Requirement[] } | null>(KEYS.match, null)?.requirements ?? [];
  update({ retrying: experienceId, retryError: "" });
  try {
    const data = await generate(resume.jd, requirements, [exp], () => {});
    const latest = read<ResumeResult | null>(KEYS.resume, null) ?? resume;
    const next: ResumeResult = {
      ...latest,
      highlights: [...latest.highlights.filter((h) => h.experienceId !== experienceId), ...data.highlights],
      dropped: [...latest.dropped.filter((d) => d.experienceId !== experienceId), ...data.dropped],
      failedExperienceIds: [...(latest.failedExperienceIds ?? []).filter((id) => id !== experienceId), ...(data.failedExperienceIds ?? [])],
    };
    writeStored(KEYS.resume, next);
    update({ retrying: null });
  } catch (e) {
    update({ retrying: null, retryError: `「${experienceLabel(exp)}」重试失败：${(e as Error).message}` });
  }
}

/** 经历在提示里的名字：公司 · 岗位；都为空时不显示孤零零的「·」 */
export function experienceLabel(e: Pick<Experience, "company" | "title">): string {
  return [e.company.trim(), e.title.trim()].filter(Boolean).join(" · ") || "未命名经历（未归类内容）";
}

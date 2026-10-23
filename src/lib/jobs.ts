"use client";

import { useSyncExternalStore } from "react";
import { postJson } from "@/components/ui";
import { KEYS, read, uid, writeStored } from "@/lib/storage";
import { BULLET_RE, experienceKey, findSameExperience } from "@/lib/importText";
import type { ImportResponse } from "@/lib/importText";
import type { AbilityEvidence, Education, Experience, Highlight, MatchResult, Profile, Requirement, ResumeResult, Selection } from "@/lib/types";
import { educationKey } from "@/lib/education";
import { refreshMatch } from "@/lib/matching";
import type { AbilityDecisions } from "@/lib/matching";
import { checkHighlights, failQA, failVerification, isInstructionFact, markStale, norm, tidyBullet } from "@/lib/validate";

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
  /** 作为资料备注没有存成事实的条数 */
  notes?: number;
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
  /** 导入解析完成、等待用户集中确认的内容（疑似重复、资料备注、无名记录）；没有需要确认的内容时直接入库 */
  importReview: ImportReview | null;
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

const SERVER_STATE: JobsState = { import: null, match: null, resume: null, error: "", importError: "", importSummary: null, importReview: null, notice: null, retrying: null, retryError: "" };
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

/** 导入前需要用户集中确认的内容（02 S1：疑似重复确认、资料备注与事实分离、无名记录不进入成稿） */
export type ImportReview = {
  data: ImportResponse;
  /** 疑似重复：导入的第 index 段与履历库已有经历 existingId（或同一次导入的第 otherIndex 段） */
  duplicates: {
    index: number;
    existingId?: string;
    otherIndex?: number;
    label: string;
    reason: string;
    /** 已能确认是同一段（同开始时间或事实重合），只需确认时间 */
    sure?: boolean;
    /** 两边起止时间不一致：合并时由用户选用哪一边，不默认取旧值，也不自动取最大区间 */
    dates?: { existing: { start: string; end: string }; imported: { start: string; end: string } };
  }[];
  /** 看起来是资料备注或写给 AI 的指令，默认不作为经历事实 */
  notes: { index: number; factIndex: number; text: string }[];
  /** 没有公司和岗位的记录：会进履历库「未归类」，但不会写进简历 */
  unnamed: number[];
};
export type ImportChoices = { merge: Record<number, boolean>; keepNotes: Record<string, boolean>; dates?: Record<number, "existing" | "imported"> };

/** 资料备注：「证据待收集」「###下一项目」「TODO」这类整理资料时留下的说明，不是候选人的行为 */
// 只认整条就是备注的写法；「建立待确认需求清单」「备注：独立完成供应商评估…」这类含真实行为的不算（拿不准时保留为事实，
// 写给 AI 的要求仍由 isInstructionFact 识别）
const NOTE_RE =
  /^\s*(#{2,}.*|(todo|tbd)\b.*|((证据|材料|数据|内容|细节|成果|结果|量化)\s*)?(待收集|待补充|待完善|待确认|待核实|待整理)[。.!！]?|此处填写.*|(示例文字|占位(符|内容)?)[。.]?|下一(个|段)?(项目|经历)[:：]?)\s*$/i;

/** 时间归一到「年-月」，只用于疑似重复判断（「2025-06」「2025.06」「2025年6月」视为同一月），不改原文 */
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function monthKey(s: string): number | null {
  const m = s.match(/((?:19|20)\d{2})\s*(?:[-./年]\s*(\d{1,2}))?/);
  if (!m) return /至今|现在|present|now|current/i.test(s) ? Infinity : null;
  // 英文月份（「Sep 2025」「2025 Sep」「September 2025」）
  const en = !m[2] && s.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/);
  const month = m[2] ? Number(m[2]) - 1 : en ? EN_MONTHS.indexOf(en[1]) : 0;
  return Number(m[1]) * 12 + month;
}
function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  const as = monthKey(a.start), bs = monthKey(b.start);
  if (as === null || bs === null) return false;
  const ae = monthKey(a.end) ?? as, be = monthKey(b.end) ?? bs;
  return as <= be && bs <= ae;
}

/** 起止时间是否矛盾（只比双方都写了的部分；写法不同但同一月不算） */
function datesDiffer(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  const diff = (x: string, y: string) => {
    if (!x.trim() || !y.trim()) return false;
    const kx = monthKey(x), ky = monthKey(y);
    return kx !== null && ky !== null ? kx !== ky : norm(x) !== norm(y);
  };
  return diff(a.start, b.start) || diff(a.end, b.end);
}

function buildReview(data: ImportResponse, vault: Experience[]): ImportReview {
  const duplicates: ImportReview["duplicates"] = [];
  data.experiences.forEach((imp, i) => {
    const key = experienceKey(imp);
    if (!key) return;
    const range = (e: { start: string; end: string }) => ({ start: e.start, end: e.end });
    // 能确认是同一段（同公司同岗位同开始时间，或事实重合）的自动合并；只有起止时间不一致时才请用户选时间
    const same = findSameExperience(vault, imp);
    if (same >= 0) {
      const v = vault[same];
      if (datesDiffer(v, imp)) {
        const label = [imp.company, imp.title].filter(Boolean).join(" · ");
        duplicates.push({ index: i, existingId: v.id, sure: true, label, reason: "履历库已有这段经历，但起止时间与这次导入的不一致", dates: { existing: range(v), imported: range(imp) } });
      }
      return;
    }
    const label = [imp.company, imp.title, [imp.start, imp.end].filter(Boolean).join("–")].filter(Boolean).join(" · ");
    const v = vault.find((e) => experienceKey(e) === key && (!e.start.trim() || !imp.start.trim() || monthKey(e.start) === monthKey(imp.start) || overlaps(e, imp)));
    if (v) {
      duplicates.push({ index: i, existingId: v.id, label, dates: datesDiffer(v, imp) ? { existing: range(v), imported: range(imp) } : undefined, reason: `履历库已有「${[v.company, v.title, [v.start, v.end].filter(Boolean).join("–")].filter(Boolean).join(" · ")}」，公司和岗位相同、${monthKey(v.start) === monthKey(imp.start) ? (datesDiffer(v, imp) ? "开始时间相同、结束时间不一致" : "时间相同（写法不同）") : "时间重叠或缺失"}` });
      return;
    }
    const j = data.experiences.findIndex((o, k) => k < i && experienceKey(o) === key && (monthKey(o.start) === monthKey(imp.start) || overlaps(o, imp)));
    const o = data.experiences[j];
    if (j >= 0) duplicates.push({ index: i, otherIndex: j, label, dates: datesDiffer(o, imp) ? { existing: range(o), imported: range(imp) } : undefined, reason: "这次导入里有另一段公司、岗位相同且时间相同或重叠的记录" });
  });
  const notes: ImportReview["notes"] = [];
  data.experiences.forEach((imp, i) =>
    imp.facts.forEach((f, k) => {
      if (NOTE_RE.test(f.source) || isInstructionFact(f)) notes.push({ index: i, factIndex: k, text: f.source });
    }),
  );
  const unnamed = data.experiences.map((e, i) => (!e.company.trim() && !e.title.trim() && e.facts.length > 0 ? i : -1)).filter((i) => i >= 0);
  return { data, duplicates, notes, unnamed };
}

/**
 * 把导入结果写入履历库：同 company + title 的经历合并到已有经历，按 source 跳过已有事实；同 company + title 的经历合并到已有经历，按 source 跳过已有事实；
 * 其余作为新经历追加。个人信息只填充当前为空的字段。以 localStorage 中的最新值为准。
 */
function applyImport(review: ImportReview, choices: ImportChoices = { merge: {}, keepNotes: {} }): ImportSummary {
  const data = review.data;
  const experiences = read<Experience[]>(KEYS.experiences, []);
  let added = 0;
  let merged = 0;
  let facts = 0;
  let duplicates = 0;
  // 资料备注默认不作为事实；用户勾选保留的除外
  const isNote = new Set(review.notes.filter((n) => !choices.keepNotes[`${n.index}-${n.factIndex}`]).map((n) => `${n.index}-${n.factIndex}`));
  const dupOf = new Map(review.duplicates.map((d) => [d.index, d]));
  const placed = new Map<number, number>(); // 导入序号 → 写入后的履历库位置
  data.experiences.forEach((rawImp, i) => {
    const imp = { ...rawImp, facts: rawImp.facts.filter((_, k) => !isNote.has(`${i}-${k}`)) };
    if (imp.facts.length === 0 && !imp.company.trim() && !imp.title.trim()) return;
    // 疑似重复：用户选择合并时并入对应经历，否则保留为独立的一段（02 S1：不自动合并可能不同的任职）
    const d = dupOf.get(i);
    let idx = -1;
    if (d && (d.sure || choices.merge[i])) idx = d.existingId ? experiences.findIndex((e) => e.id === d.existingId) : (placed.get(d.otherIndex!) ?? -1);
    else if (!d) idx = findSameExperience(experiences, imp);
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
      // 时间矛盾时按用户的选择；没矛盾时只补空缺
      const useImported = !!d?.dates && choices.dates?.[i] === "imported";
      const start = useImported ? imp.start || existing.start : existing.start || imp.start;
      const end = useImported ? imp.end || existing.end : existing.end || imp.end;
      experiences[idx] = { ...existing, start, end, facts: [...existing.facts, ...fresh] };
      placed.set(i, idx);
    } else {
      added++;
      experiences.push({ id: uid(), company: imp.company, title: imp.title, start: imp.start, end: imp.end, facts: fresh });
      placed.set(i, experiences.length - 1);
    }
  });
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

  return { added, merged, facts, duplicates, rejected: data.rejected, profileFields, unassigned: data.unassigned, education: eduAdded, notes: isNote.size };
}

function finishImport(review: ImportReview, choices?: ImportChoices) {
  const summary = applyImport(review, choices);
  const partial = summary.unassigned > 0 ? "，有部分内容没能归到具体经历" : "";
  update({
    import: null,
    importReview: null,
    importSummary: summary,
    notice: { tone: "success", text: `简历导入完成：新增 ${summary.added} 段、合并 ${summary.merged} 段经历${partial}，点击查看`, href: "/collect" },
  });
}

/** 用户在集中确认面板里确认导入 */
export function confirmImport(choices: ImportChoices) {
  if (!state.importReview) return;
  try {
    finishImport(state.importReview, choices);
  } catch (e) {
    update({ importError: (e as Error).message });
  }
}

/** 放弃这次导入（不写入任何内容） */
export function cancelImport() {
  update({ importReview: null, import: null });
}

export async function runImport(text: string) {
  // 上一批还在等确认时不开始新的解析，免得上一批的选择套到新结果上
  if (state.import || state.importReview) return;
  update({ import: "import", importError: "", importSummary: null, notice: null });
  markPending("import", true);
  try {
    const data = await postJson<ImportResponse>("/api/import", { text });
    const review = buildReview(data, read<Experience[]>(KEYS.experiences, []));
    // 没有需要确认的内容就直接入库；有疑似重复、资料备注、无名记录时集中确认一次（不逐条确认事实）
    if (review.duplicates.length === 0 && review.notes.length === 0 && review.unnamed.length === 0) finishImport(review);
    else update({ import: null, importReview: review, notice: { tone: "success", text: "简历解析完成，有几处需要你确认后再存入", href: "/collect" } });
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
    const match = await postJson<Omit<MatchResult, "jd">>("/api/match", { jd, experiences, education });
    writeStored(KEYS.match, { ...match, jd });
    update({ match: null, notice: { tone: "success", text: "匹配分析已完成，点击查看", href: "/match" } });
  } catch (e) {
    const message = (e as Error).message;
    update({ match: null, error: message, notice: { tone: "error", text: `匹配分析失败：${message}`, href: "/match" } });
  } finally {
    markPending("match", false);
  }
}

type Generated = Pick<ResumeResult, "highlights" | "dropped" | "failedExperienceIds" | "dispositions" | "unused">;

/**
 * 撰写 → 逐句核验 → 面试准备。各阶段失败都按技术错误处理（02 S6、T14）：
 * - 撰写整体失败：抛错（没有任何结果可保留）；单段失败记入 failedExperienceIds，可单独重试
 * - 核验失败：句子保留为 pending + technical_error，不导出、可重试，不判成「找不到依据」
 * - 面试准备失败：只标记 qaFailed，不影响句子导出
 */
async function generate(
  jd: string,
  requirements: Requirement[],
  experiences: Experience[],
  onStage: (s: "verify" | "qa") => void,
  abilities: AbilityEvidence[] = [],
): Promise<Generated> {
  const data = await postJson<Generated>("/api/resume", { jd, requirements, abilities, experiences });
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
  return {
    highlights: answered,
    dropped: [...data.dropped, ...verified.dropped],
    failedExperienceIds: data.failedExperienceIds ?? [],
    dispositions: data.dispositions ?? [],
    unused: data.unused ?? [],
  };
}

/** 撰写专用匹配表：按当前履历、教育背景和推断确认记录重新推导；未确认的推断不作为依据（R09） */
function writerInput(match: MatchResult | undefined, fallback: Requirement[], experiences: Experience[]) {
  if (!match) return { requirements: fallback, abilities: [] as AbilityEvidence[] };
  const w = refreshMatch(match, read<AbilityDecisions>(KEYS.abilityDecisions, {}), experiences, read<Education[]>(KEYS.education, []), { writer: true });
  return { requirements: w.requirements, abilities: (w.abilities ?? []).filter((a) => a.confirmation === "confirmed") };
}

export async function runResume(match: MatchResult, experiences: Experience[]) {
  if (state.resume) return;
  // 简历里有句子正在改写/重试时不重新生成，免得旧请求的结果写进新简历
  if (state.retrying) return update({ error: "简历里有句子正在修改或重试，完成后再重新生成" });
  update({ resume: "resume", error: "", notice: null });
  markPending("resume", true);
  try {
    const jd = match.jd;
    const { requirements, abilities } = writerInput(match, match.requirements, experiences);
    const data = await generate(jd, requirements, experiences, (stage) => update({ resume: stage }), abilities);
    const resume: ResumeResult = {
      jd,
      highlights: data.highlights,
      dropped: data.dropped,
      failedExperienceIds: data.failedExperienceIds ?? [],
      dispositions: data.dispositions,
      unused: data.unused,
      // 只有 exportStatus 为 ready 且选入简历的句子会被导出
      provenanceChecked: true,
      requirements,
      abilities,
      match,
      // 重新生成时沿用用户调整过的经历顺序和教育背景位置
      order: read<ResumeResult | null>(KEYS.resume, null)?.order,
      educationFirst: read<ResumeResult | null>(KEYS.resume, null)?.educationFirst,
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
 * 局部重试（T14）：只处理一段经历，只重跑出问题的阶段，其他经历和这段里已通过的句子原样保留（按位置原地替换，不重复插入）。
 * - 这段撰写失败或还没有句子 → 重新撰写整段；新结果为空时保留原状并提示
 * - 待处理的句子（模型出错、来源已修改、旧版本剔除）→ 用当前履历事实重新核验这些句子
 * - 面试准备失败、参考回答来源已修改、本次刚通过核验的句子 → 只重新生成面试准备
 */
export async function retryExperience(experienceId: string) {
  if (state.resume || state.retrying) return;
  const stored = read<ResumeResult | null>(KEYS.resume, null);
  const experiences = read<Experience[]>(KEYS.experiences, []);
  const exp = experiences.find((e) => e.id === experienceId);
  if (!stored || !exp) return;
  update({ retrying: experienceId, retryError: "" });
  const label = experienceLabel(exp);
  try {
    // 先按当前履历库标出过期句子、迁移旧版本剔除项，再在此基础上处理
    const latest = markStale(stored, experiences);
    const own = latest.highlights.map((h, i) => ({ h, i })).filter(({ h }) => h.experienceId === experienceId);
    const writerFailed = (latest.failedExperienceIds ?? []).includes(experienceId) || own.length === 0;

    if (writerFailed) {
      // 按当前确认记录和履历重新推导：撤销或已失效的推断不会再被用上
      const { requirements, abilities } = writerInput(latest.match, latest.requirements ?? [], experiences);
      const data = await generate(latest.jd, requirements, [exp], () => {}, abilities);
      if (data.highlights.length === 0) {
        update({ retrying: null, retryError: `「${label}」仍未生成成功（模型请求出错或没有返回内容），已保留原状，可以稍后再试` });
        return;
      }
      const cur = read<ResumeResult | null>(KEYS.resume, null);
      const base = cur ? markStale(cur, read<Experience[]>(KEYS.experiences, experiences)) : latest;
      writeStored(KEYS.resume, {
        ...base,
        highlights: [...base.highlights.filter((h) => h.experienceId !== experienceId), ...data.highlights],
        dropped: [...base.dropped.filter((d) => d.experienceId !== experienceId), ...data.dropped],
        failedExperienceIds: (base.failedExperienceIds ?? []).filter((id) => id !== experienceId),
        dispositions: [...(base.dispositions ?? []).filter((d) => d.experienceId !== experienceId), ...(data.dispositions ?? [])],
        unused: [...(base.unused ?? []).filter((u) => u.experienceId !== experienceId), ...(data.unused ?? [])],
      });
      update({ retrying: null });
      return;
    }

    const next = [...latest.highlights];
    // 1) 重新核验待处理的句子（用当前事实刷新来源快照；所引事实都已删除的标为 blocked）
    const toVerify = own.filter(({ h }) => h.exportStatus === "pending");
    if (toVerify.length > 0) {
      const refreshed = toVerify.map(({ h }) => {
        const { kept } = checkHighlights([{ experienceId, text: h.text, factIds: h.factIds.filter((id) => exp.facts.some((f) => f.id === id)), questions: [] }], [exp]);
        return kept[0] ? keepLayout(kept[0], h) : null;
      });
      const verifiable = refreshed.filter((h): h is Highlight => !!h);
      let verified: Highlight[] = [];
      try {
        verified = (await postJson<{ highlights: Highlight[] }>("/api/verify", { highlights: verifiable, experiences: [exp] })).highlights;
      } catch {
        verified = failVerification(verifiable);
      }
      let k = 0;
      toVerify.forEach(({ h, i }, j) => {
        next[i] = refreshed[j]
          ? keepLayout(verified[k++] ?? refreshed[j]!, h)
          : { ...h, exportStatus: "blocked", issueType: "unsupported_assertion", note: "引用的履历事实都已删除，这句不再有来源" };
      });
    }
    // 2) 只为需要的句子重新生成面试准备
    const needQA = own
      .map(({ i }) => i)
      .filter((i) => {
        const h = next[i];
        if ((h.exportStatus ?? "ready") !== "ready") return false;
        return h.qaFailed || h.questions.length === 0 || h.questions.some((q) => q.retryable);
      });
    if (needQA.length > 0) {
      let withQA: Highlight[];
      try {
        withQA = (await postJson<{ highlights: Highlight[] }>("/api/qa", { jd: latest.jd, highlights: needQA.map((i) => next[i]), experiences: [exp] })).highlights;
      } catch {
        withQA = failQA(needQA.map((i) => next[i]));
      }
      needQA.forEach((i, j) => {
        next[i] = keepLayout(withQA[j] ?? next[i], next[i]);
      });
    }
    // 结果落盘时以最新存储为准：只替换本段经历的核验/问答结果，保留请求期间用户做的移出/放回
    const now = read<ResumeResult | null>(KEYS.resume, null);
    const base = now && now.highlights.length === latest.highlights.length ? markStale(now, read<Experience[]>(KEYS.experiences, experiences)) : latest;
    const ownIdx = new Set(own.map(({ i }) => i));
    writeStored(KEYS.resume, {
      ...base,
      highlights: base.highlights.map((h, i) => (ownIdx.has(i) && h.text === latest.highlights[i].text ? { ...next[i], selection: h.selection } : h)),
    });
    update({ retrying: null });
  } catch (e) {
    update({ retrying: null, retryError: `「${label}」重试失败：${(e as Error).message}，已保留原状` });
  }
}

/** 重新核验 / 生成面试准备后保留编排字段（选入状态、对应要求），否则低相关或已移出的句子会重新进入导出 */
function keepLayout(h: Highlight, prev: Highlight): Highlight {
  return { ...h, selection: prev.selection, requirementIds: prev.requirementIds ?? h.requirementIds, edited: prev.edited, generatedText: prev.generatedText };
}

export const BULLET_MAX = 200;

/**
 * 改一句的措辞（02 S7、04「编辑后仅核验受影响内容」）：只重新核验这一句、重新生成这一句的面试追问，其他句子不动。
 * 改写仍只能依据这句所引的履历事实；加了来源里没有的说法会照常被缩小或退回原话并写明原因（不提供强制保留）。
 * restore=true 时恢复成生成时的句子（同样重新核验）。
 */
export async function editBullet(index: number, text: string, restore = false) {
  if (state.resume || state.retrying) return;
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  const prev = resume?.highlights[index];
  const exp = prev && read<Experience[]>(KEYS.experiences, []).find((e) => e.id === prev.experienceId);
  if (!resume || !prev || !exp) return;
  const next = tidyBullet(text).trim();
  if (!next) return update({ retryError: "句子不能为空；不想要这句可以点「移出」" });
  if (!restore && next.length > BULLET_MAX) return update({ retryError: `句子太长（最多 ${BULLET_MAX} 字）` });
  update({ retrying: prev.experienceId, retryError: "" });
  try {
    const factIds = prev.factIds.filter((id) => exp.facts.some((f) => f.id === id));
    const { kept } = checkHighlights([{ experienceId: exp.id, text: next, factIds, questions: [] }], [exp]);
    if (kept.length === 0) throw new Error("这句引用的履历事实都已删除，没法再核验；可以把它移出简历");
    let verified: Highlight[];
    try {
      verified = (await postJson<{ highlights: Highlight[] }>("/api/verify", { highlights: kept, experiences: [exp] })).highlights;
    } catch {
      verified = failVerification(kept);
    }
    let out = verified;
    if (verified[0] && (verified[0].exportStatus ?? "ready") === "ready") {
      try {
        out = (await postJson<{ highlights: Highlight[] }>("/api/qa", { jd: resume.jd, highlights: verified, experiences: [exp] })).highlights;
      } catch {
        out = failQA(verified);
      }
    }
    const h = out[0];
    if (!h) throw new Error("核验没有返回结果，已保留原句");
    // 生成版本始终保留；只有恢复成功（核验通过且就是生成的原句）才去掉「改过」标记，恢复失败仍可再试
    const generatedText = prev.generatedText ?? prev.text;
    const restored = restore && (h.exportStatus ?? "ready") === "ready" && h.text === generatedText;
    const edited: Highlight = { ...h, selection: prev.selection, requirementIds: prev.requirementIds, edited: !restored, generatedText };
    if (edited.note && edited.text !== next) edited.note = `${edited.note}。要写进来源里没有的内容，请先到履历库补充这段经历的事实`;
    // 以最新存储为准，只替换这一句（期间用户可能移出/放回了别的句子）
    const latest = read<ResumeResult | null>(KEYS.resume, null) ?? resume;
    if (latest.highlights[index]?.text !== prev.text) throw new Error("简历在改写期间发生了变化，已保留原样，请重新修改");
    writeStored(KEYS.resume, { ...latest, highlights: latest.highlights.map((x, i) => (i === index ? { ...edited, selection: x.selection } : x)) });
    update({ retrying: null });
  } catch (e) {
    update({ retrying: null, retryError: `修改没有保存：${(e as Error).message}` });
  }
}

/** 保存这份简历的经历顺序（只影响本份简历和导出，不改履历库）；传 undefined 恢复为履历库顺序 */
export function setOrder(order: string[] | undefined) {
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  if (!resume) return;
  writeStored(KEYS.resume, { ...resume, order });
}

/** 教育背景放在工作经历前面还是后面（只影响本份简历） */
export function setEducationFirst(educationFirst: boolean) {
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  if (!resume) return;
  writeStored(KEYS.resume, { ...resume, educationFirst });
}

/** 在读或毕业不到一年（应届 / 实习求职）时教育背景放在前面，这是中文简历的常见写法 */
export function defaultEducationFirst(education: { start: string; end: string }[], now = new Date()): boolean {
  const cur = now.getFullYear() * 12 + now.getMonth();
  return education.some((e) => {
    const end = monthKey(e.end);
    if (end === null) return !e.end.trim() && (monthKey(e.start) ?? -Infinity) > cur - 48;
    return end >= cur - 12;
  });
}

/** 按这份简历的顺序排列经历：order 里有的在前，其余（新增的经历）按履历库顺序接在后面 */
export function orderExperiences<T extends { id: string }>(experiences: T[], order: string[] | undefined): T[] {
  if (!order?.length) return experiences;
  const pos = new Map(order.map((id, i) => [id, i]));
  return experiences
    .map((e, i) => ({ e, k: pos.get(e.id) ?? order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map(({ e }) => e);
}

/** 时间倒序：结束时间（至今最新）→ 开始时间，都没有时间的放最后，同时间保持原顺序 */
export function byTimeDesc<T extends { start: string; end: string }>(experiences: T[]): T[] {
  const key = (e: T) => {
    const end = monthKey(e.end) ?? (e.end.trim() ? null : monthKey(e.start));
    return [end ?? -Infinity, monthKey(e.start) ?? -Infinity];
  };
  return experiences
    .map((e, i) => ({ e, i, k: key(e) }))
    .sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || a.i - b.i)
    .map(({ e }) => e);
}

/** 把一句放进简历或移出简历（选材可恢复，不删除内容；02 R10、T15） */
export function setSelection(index: number, selection: Selection) {
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  if (!resume || !resume.highlights[index]) return;
  const highlights = resume.highlights.map((h, i) => (i === index ? { ...h, selection } : h));
  writeStored(KEYS.resume, { ...resume, highlights });
}

/**
 * 把一条本次没写进句子的事实加入简历：以原话作为句子（只做格式整理），同样经过逐句核验和面试准备，
 * 核验确认它是候选人的经历描述后才可导出。
 */
export async function addFactAsBullet(experienceId: string, factId: string) {
  if (state.resume || state.retrying) return;
  const resume = read<ResumeResult | null>(KEYS.resume, null);
  const exp = read<Experience[]>(KEYS.experiences, []).find((e) => e.id === experienceId);
  const fact = exp?.facts.find((f) => f.id === factId);
  if (!resume || !exp || !fact) return;
  update({ retrying: experienceId, retryError: "" });
  try {
    const { kept } = checkHighlights([{ experienceId, text: tidyBullet(fact.source), factIds: [factId], questions: [], selection: "expanded" }], [exp]);
    if (kept.length === 0) throw new Error("这条事实无法作为简历句");
    let verified: Highlight[];
    try {
      verified = (await postJson<{ highlights: Highlight[] }>("/api/verify", { highlights: kept, experiences: [exp] })).highlights;
    } catch {
      verified = failVerification(kept);
    }
    let added = verified;
    if (verified[0] && (verified[0].exportStatus ?? "ready") === "ready") {
      try {
        added = (await postJson<{ highlights: Highlight[] }>("/api/qa", { jd: resume.jd, highlights: verified, experiences: [exp] })).highlights;
      } catch {
        added = failQA(verified);
      }
    }
    const latest = read<ResumeResult | null>(KEYS.resume, null) ?? resume;
    writeStored(KEYS.resume, {
      ...latest,
      highlights: [...latest.highlights, ...added],
      unused: (latest.unused ?? []).filter((u) => !(u.experienceId === experienceId && u.factId === factId)),
    });
    update({ retrying: null });
  } catch (e) {
    update({ retrying: null, retryError: `加入失败：${(e as Error).message}` });
  }
}

/** 经历在提示里的名字：公司 · 岗位；都为空时不显示孤零零的「·」 */
export function experienceLabel(e: Pick<Experience, "company" | "title">): string {
  return [e.company.trim(), e.title.trim()].filter(Boolean).join(" · ") || "未命名经历（未归类内容）";
}

"use client";

import { useSyncExternalStore } from "react";
import { postJson } from "@/components/ui";
import { KEYS, writeStored } from "@/lib/storage";
import type { Experience, Requirement, ResumeResult } from "@/lib/types";
import { failVerification } from "@/lib/validate";

/**
 * 「分析匹配」「生成定向简历」的后台任务。
 * 状态是模块级单例，与页面组件的生命周期无关：用户中途切到其他步骤，请求继续跑，结果照常写入 localStorage。
 * 整页刷新/关闭会中断请求，所以进行中的任务记在 sessionStorage，刷新后据此提示「被中断」而不是静默。
 */

export type JobKind = "match" | "resume";

export type Notice = { tone: "success" | "error"; text: string; href: string };

export type JobsState = {
  /** 进行中的阶段，null 表示空闲；同类任务同一时间只有一个 */
  match: "match" | null;
  resume: "resume" | "verify" | null;
  /** 最近一次失败原因，显示在匹配页；开始新任务时清空 */
  error: string;
  /** 用户不在匹配页时的完成/失败提示，显示在顶部导航 */
  notice: Notice | null;
};

const PENDING_KEY = (kind: JobKind) => `air:job:${kind}`;
const INTERRUPTED: Record<JobKind, string> = {
  match: "上次匹配分析被中断，请重新分析",
  resume: "上次生成被中断，请重新生成",
};

const SERVER_STATE: JobsState = { match: null, resume: null, error: "", notice: null };
let state: JobsState = SERVER_STATE;
let initialized = false;
const listeners = new Set<() => void>();
/** 匹配页挂载时注册：生成完成且用户仍在匹配页时由它跳转到简历页 */
let onResumeDone: (() => void) | null = null;

function update(patch: Partial<JobsState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function markPending(kind: JobKind, pending: boolean) {
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
  for (const kind of ["match", "resume"] as const) {
    let pending = false;
    try {
      pending = sessionStorage.getItem(PENDING_KEY(kind)) !== null;
    } catch {}
    if (!pending || state[kind]) continue;
    markPending(kind, false);
    update({ error: INTERRUPTED[kind], notice: { tone: "error", text: INTERRUPTED[kind], href: "/match" } });
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

export async function runMatch(jd: string, experiences: Experience[]) {
  if (state.match) return;
  update({ match: "match", error: "", notice: null });
  markPending("match", true);
  try {
    const { requirements } = await postJson<{ requirements: Requirement[] }>("/api/match", { jd, experiences });
    writeStored(KEYS.match, { jd, requirements });
    update({ match: null, notice: { tone: "success", text: "匹配分析已完成，点击查看", href: "/match" } });
  } catch (e) {
    const message = (e as Error).message;
    update({ match: null, error: message, notice: { tone: "error", text: `匹配分析失败：${message}`, href: "/match" } });
  } finally {
    markPending("match", false);
  }
}

export async function runResume(jd: string, requirements: Requirement[], experiences: Experience[]) {
  if (state.resume) return;
  update({ resume: "resume", error: "", notice: null });
  markPending("resume", true);
  try {
    const data = await postJson<Pick<ResumeResult, "highlights" | "dropped" | "failedExperienceIds">>("/api/resume", { jd, requirements, experiences });
    // 规则校验通过的亮点再做一次大模型内容核验；核验请求整体失败时这批亮点全部剔除，不放行未核验内容
    let verified: Pick<ResumeResult, "highlights" | "dropped"> = { highlights: [], dropped: [] };
    if (data.highlights.length > 0) {
      update({ resume: "verify" });
      try {
        verified = await postJson<Pick<ResumeResult, "highlights" | "dropped">>("/api/verify", { highlights: data.highlights, experiences });
      } catch {
        verified = { highlights: [], dropped: failVerification(data.highlights) };
      }
    }
    const resume: ResumeResult = {
      jd,
      highlights: verified.highlights,
      dropped: [...data.dropped, ...verified.dropped],
      failedExperienceIds: data.failedExperienceIds ?? [],
      // 只有上面核验通过的 highlights 会被导出；简历页不会把未核验的履历事实写进正文
      provenanceChecked: true,
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

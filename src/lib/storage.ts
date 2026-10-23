"use client";

import { useCallback, useEffect, useState } from "react";

export const KEYS = {
  experiences: "air:experiences",
  profile: "air:profile",
  /** 教育背景 */
  education: "air:education",
  /** 用户对能力推断的确认/拒绝（按能力 + 事实 + 原话快照记录，事实变了自动失效） */
  abilityDecisions: "air:abilityDecisions",
  chat: "air:chat",
  match: "air:match",
  resume: "air:resume",
  /** 预填到匹配页的 JD 草稿（示例数据用） */
  jdDraft: "air:jdDraft",
} as const;

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 同一页面内写入 localStorage 后派发的事件，让同 key 的其他 useStored 实例同步 */
const STORED_EVENT = "air:stored";
type StoredDetail = { key: string; value: unknown };

/** 写入 localStorage 并通知已挂载的 useStored；不依赖组件是否挂载，后台任务也可直接调用 */
export function writeStored<T>(key: string, value: T): boolean {
  let ok = true;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储满或被禁用：返回 false，由需要确认持久化的调用方（如导入）报错
    ok = false;
  }
  window.dispatchEvent(new CustomEvent<StoredDetail>(STORED_EVENT, { detail: { key, value } }));
  return ok;
}

/** localStorage 持久化的 state；首帧返回 fallback，挂载后再读取，避免 SSR 水合不一致 */
export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setValue(read(key, fallback));
    setLoaded(true);
    const onLocal = (e: Event) => {
      const { detail } = e as CustomEvent<StoredDetail>;
      if (detail.key === key) setValue(detail.value as T);
    };
    // 其他标签页的写入；key 为 null 表示整体清空
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea === localStorage && (e.key === key || e.key === null)) setValue(read(key, fallback));
    };
    window.addEventListener(STORED_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STORED_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      // 写入不能放在 setState 的 updater 里：组件卸载后 updater 不会执行，结果就丢了。
      // 函数式更新以 localStorage 中的最新值为准，同 key 的多个实例之间不会互相覆盖
      const v = typeof next === "function" ? (next as (p: T) => T)(read(key, fallback)) : next;
      setValue(v);
      writeStored(key, v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, set, loaded] as const;
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function exportAll(): string {
  // app / version 用于导入时识别本站备份；旧备份没有这两个字段也能导入
  const data: Record<string, unknown> = { app: "ai-resume", version: 1, exportedAt: new Date().toISOString() };
  for (const k of Object.values(KEYS)) data[k] = read(k, null);
  return JSON.stringify(data, null, 2);
}

/**
 * 写入已校验的备份（只写备份里有的项）。任何一项写入失败（如存储空间不足）就把已写的项恢复原样，
 * 不留下一半新一半旧的数据。
 */
export function importAll(data: Partial<Record<string, unknown>>) {
  const keys = Object.values(KEYS).filter((k) => data[k] !== undefined);
  const before = new Map<string, string | null>(keys.map((k) => [k, localStorage.getItem(k)]));
  const written: string[] = [];
  try {
    for (const k of keys) {
      written.push(k);
      localStorage.setItem(k, JSON.stringify(data[k]));
    }
  } catch {
    // 先把已写入的新值全部移除腾出空间，再逆序恢复原值；逐项确认恢复成功
    for (const k of written) localStorage.removeItem(k);
    const failed: string[] = [];
    for (const k of [...written].reverse()) {
      const v = before.get(k) ?? null;
      if (v === null) continue;
      try {
        localStorage.setItem(k, v);
      } catch {
        failed.push(k);
      }
      if (localStorage.getItem(k) !== v) failed.push(k);
    }
    if (failed.length === 0) throw new Error("浏览器存储空间不足，备份没有导入，原有资料保持不变");
    throw new Error("浏览器存储空间不足，备份没有导入，且部分原有资料没能恢复；请先用之前导出的备份恢复");
  }
}

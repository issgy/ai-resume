"use client";

import { useCallback, useEffect, useState } from "react";

export const KEYS = {
  experiences: "air:experiences",
  profile: "air:profile",
  chat: "air:chat",
  match: "air:match",
  resume: "air:resume",
  /** 预填到匹配页的 JD 草稿（示例数据用） */
  jdDraft: "air:jdDraft",
} as const;

function read<T>(key: string, fallback: T): T {
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
export function writeStored<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储满或被禁用时忽略
  }
  window.dispatchEvent(new CustomEvent<StoredDetail>(STORED_EVENT, { detail: { key, value } }));
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
  const data: Record<string, unknown> = {};
  for (const k of Object.values(KEYS)) data[k] = read(k, null);
  return JSON.stringify(data, null, 2);
}

export function importAll(json: string) {
  const data = JSON.parse(json) as Record<string, unknown>;
  for (const k of Object.values(KEYS)) {
    if (data[k] != null) localStorage.setItem(k, JSON.stringify(data[k]));
  }
}

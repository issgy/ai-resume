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

/** localStorage 持久化的 state；首帧返回 fallback，挂载后再读取，避免 SSR 水合不一致 */
export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setValue(read(key, fallback));
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          // 存储满或被禁用时忽略
        }
        return v;
      });
    },
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

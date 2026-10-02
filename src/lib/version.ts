import type { TaskVersion } from "../types";

const SITE_KEY = "dfwlfront-3:site-id";

interface KVLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getSiteId(kv: KVLike): string {
  const cached = kv.getItem(SITE_KEY);
  if (cached) return cached;
  const id = `site-${Math.random().toString(36).slice(2, 8)}`;
  kv.setItem(SITE_KEY, id);
  return id;
}

// 版本比较：先比 Lamport，再比站点 ID，保证多端排序确定
export function compareVersion(a: TaskVersion, b: TaskVersion): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.siteId === b.siteId) return 0;
  return a.siteId < b.siteId ? -1 : 1;
}

export function versionText(v: TaskVersion): string {
  return `v${v.lamport}@${v.siteId}`;
}

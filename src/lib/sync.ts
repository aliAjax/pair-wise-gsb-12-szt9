import type { Conflict, ConflictKind, DispatchTask, RemoteLedger } from "../types";
import { KEYS, normalizeTask } from "./migrate";
import type { KV } from "./kv";
import { compareVersion } from "./version";

// 半开区间重叠判断：[start, end)，首尾相接不算重叠
export function intervalsOverlap(a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }): boolean {
  return Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);
}

// 合并远端任务：按 id upsert，版本新者胜；缺版本/时段的先补齐再参与
export function mergeTasks(local: DispatchTask[], incoming: DispatchTask[]): { tasks: DispatchTask[]; changed: number } {
  const byId = new Map(local.map((t) => [t.id, t] as const));
  let changed = 0;
  for (const raw of incoming) {
    const task = normalizeTask(raw, "remote");
    const existing = byId.get(task.id);
    if (!existing || compareVersion(task.version, existing.version) > 0) {
      byId.set(task.id, task);
      changed += 1;
    }
  }
  return { tasks: [...byId.values()], changed };
}

// 同一 key（车辆/司机）下，把传递重叠的任务聚成一簇
function groupOverlapping(active: DispatchTask[], keyOf: (t: DispatchTask) => string): DispatchTask[][] {
  const byKey = new Map<string, DispatchTask[]>();
  for (const t of active) {
    const list = byKey.get(keyOf(t));
    if (list) list.push(t);
    else byKey.set(keyOf(t), [t]);
  }
  const groups: DispatchTask[][] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    let cluster: DispatchTask[] = [];
    let clusterEnd = -Infinity;
    for (const t of sorted) {
      const start = Date.parse(t.startAt);
      const end = Date.parse(t.endAt);
      if (cluster.length > 0 && start >= clusterEnd) {
        if (cluster.length > 1) groups.push(cluster);
        cluster = [];
        clusterEnd = -Infinity;
      }
      cluster.push(t);
      clusterEnd = Math.max(clusterEnd, end);
    }
    if (cluster.length > 1) groups.push(cluster);
  }
  return groups;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && b.every((x) => a.includes(x));
}

let conflictSeq = 0;

// 冲突检测：同一车辆/同一司机的重叠时段只保留先确认的一版，其余进冲突区
export function detectConflicts(
  tasks: DispatchTask[],
  existing: Conflict[],
  now: string
): { tasks: DispatchTask[]; conflicts: Conflict[]; added: Conflict[] } {
  const next = tasks.map((t) => ({ ...t }));
  const active = next.filter((t) => t.status === "active");
  const conflicts = [...existing];
  const added: Conflict[] = [];
  const loserIds = new Set<string>();

  const dimensions: { kind: ConflictKind; keyOf: (t: DispatchTask) => string }[] = [
    { kind: "vehicle-overlap", keyOf: (t) => t.vehicleId },
    { kind: "driver-overlap", keyOf: (t) => t.driverId },
  ];

  for (const { kind, keyOf } of dimensions) {
    for (const group of groupOverlapping(active, keyOf)) {
      const ordered = [...group].sort((a, b) => compareVersion(a.version, b.version));
      const winner = ordered[0];
      for (const loser of ordered.slice(1)) loserIds.add(loser.id);
      const taskIds = ordered.map((t) => t.id).sort();
      const dup = conflicts.some((c) => !c.resolvedAt && c.kind === kind && sameSet([...c.taskIds].sort(), taskIds));
      if (!dup) {
        conflictSeq += 1;
        added.push({
          id: `cfl-${Date.now().toString(36)}-${conflictSeq}`,
          kind,
          vehicleId: kind === "vehicle-overlap" ? winner.vehicleId : null,
          driverId: kind === "driver-overlap" ? winner.driverId : null,
          taskIds,
          winnerId: winner.id,
          detectedAt: now,
          resolvedAt: null,
          keepTaskId: null,
        });
      }
    }
  }

  for (const t of next) {
    if (loserIds.has(t.id)) t.status = "conflicted";
  }
  return { tasks: next, conflicts: [...conflicts, ...added], added };
}

export function loadRemote(kv: KV): RemoteLedger {
  const raw = kv.getItem(KEYS.remote);
  if (!raw) return { tasks: [], updatedAt: null };
  try {
    const parsed = JSON.parse(raw) as RemoteLedger;
    return { tasks: parsed.tasks ?? [], updatedAt: parsed.updatedAt ?? null };
  } catch {
    return { tasks: [], updatedAt: null };
  }
}

export function saveRemote(kv: KV, ledger: RemoteLedger): void {
  kv.setItem(KEYS.remote, JSON.stringify(ledger));
}

// 模拟服务端台账：按 id upsert，保留版本新的一版
export function upsertRemote(kv: KV, tasks: DispatchTask[]): void {
  const ledger = loadRemote(kv);
  const byId = new Map(ledger.tasks.map((t) => [t.id, t] as const));
  for (const task of tasks) {
    const existing = byId.get(task.id);
    if (!existing || compareVersion(task.version, existing.version) >= 0) byId.set(task.id, task);
  }
  saveRemote(kv, { tasks: [...byId.values()], updatedAt: new Date().toISOString() });
}

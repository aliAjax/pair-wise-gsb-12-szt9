import type { Conflict, Dispatch, LocalDB, OutboxOp, Vehicle } from "../types";
import {
  detectConflicts,
  earlierConfirmed,
  isActive,
  makeConflict,
  openOccupancyFor,
  overlaps,
  uid
} from "./core";
import { saveDb } from "./storage";

// ---------- 远端模拟（本地 localStorage 充当服务端 + 另一名调度员） ----------

const REMOTE_KEY = "dfwlfront-3-remote";

export interface RemoteState {
  dispatches: Dispatch[];
  vehicles: Pick<Vehicle, "id" | "version">[];
  lastPushAt?: string;
}

function loadRemote(): RemoteState {
  const raw = localStorage.getItem(REMOTE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as RemoteState;
    } catch {
      /* fallthrough */
    }
  }
  return { dispatches: [], vehicles: [] };
}

function saveRemote(state: RemoteState): void {
  localStorage.setItem(REMOTE_KEY, JSON.stringify(state));
}

/** 把一名“另一名调度员”在远端的派车写入服务端，等待本机恢复网络后拉取合并 */
export function simulateRemoteDispatch(input: {
  vehicleId: string;
  driver: string;
  zone: string;
  task: string;
  startAt: string;
  endAt: string;
  confirmedAt?: number;
}): Dispatch {
  const remote = loadRemote();
  const confirmedAt = input.confirmedAt ?? Date.now();
  const dispatch: Dispatch = {
    id: uid("dp-remote"),
    version: 1,
    vehicleId: input.vehicleId,
    driver: input.driver,
    zone: input.zone,
    task: input.task,
    status: "confirmed",
    startAt: input.startAt,
    endAt: input.endAt,
    confirmedAt,
    seq: confirmedAt,
    origin: "remote",
    createdAt: new Date().toISOString(),
    synced: true
  };
  remote.dispatches.push(dispatch);
  const v = remote.vehicles.find((x) => x.id === input.vehicleId);
  if (v) v.version += 1;
  else remote.vehicles.push({ id: input.vehicleId, version: 2 });
  saveRemote(remote);
  return dispatch;
}

// ---------- 网络恢复后的合并 ----------

export interface MergeResult {
  pulled: number;
  pushed: number;
  newConflicts: number;
}

function dbVehicleVersion(db: LocalDB, vehicleId: string): number {
  return db.vehicles.find((v) => v.id === vehicleId)?.version ?? 1;
}

/**
 * 本地优先合并：
 * - 本地断网期间登记的任务先入发件箱，联网后推送到远端
 * - 拉取远端任务并与本地有效任务逐条做车辆/司机时段重叠判定
 * - 先确认的一版保留为有效任务并占用资源，后确认的一版进入冲突区
 * - 冲突车辆版本号同步 +1（版本失配作为冲突原因之一记录）
 */
export function syncNow(db: LocalDB): MergeResult {
  const nowIso = new Date().toISOString();
  const remote = loadRemote();

  // 1) 推送本地发件箱中的派车
  let pushed = 0;
  const pending: OutboxOp[] = [];
  for (const op of db.outbox) {
    if (op.type === "dispatch") {
      const d = db.dispatches.find((x) => x.id === (op.payload as Dispatch).id);
      if (d) {
        if (!remote.dispatches.some((x) => x.id === d.id)) {
          remote.dispatches.push(structuredClone(d));
        }
        const rv = remote.vehicles.find((x) => x.id === d.vehicleId);
        const vNow = dbVehicleVersion(db, d.vehicleId);
        if (rv) rv.version = Math.max(rv.version, vNow);
        else remote.vehicles.push({ id: d.vehicleId, version: vNow });
        d.synced = true;
        pushed += 1;
        continue;
      }
    }
    pending.push(op);
  }
  db.outbox = pending;

  // 2) 拉取远端任务并合并（incoming 入库前先找本地败方，避免重复计因）
  let newConflicts = 0;
  let pulled = 0;
  const localIds = new Set(db.dispatches.map((d) => d.id));

  for (const incomingRaw of remote.dispatches) {
    if (localIds.has(incomingRaw.id)) continue;
    const incoming: Dispatch = { ...structuredClone(incomingRaw), origin: "remote" };
    pulled += 1;

    const vehicle = db.vehicles.find((v) => v.id === incoming.vehicleId);
    const preFindings = detectConflicts(db, incoming);

    const clashLocals = db.dispatches.filter(
      (d) =>
        isActive(d) &&
        overlaps(d, incoming) &&
        (d.vehicleId === incoming.vehicleId ||
          (d.driver.trim() !== "" && d.driver === incoming.driver))
    );

    const incomingWins = clashLocals.every((d) => earlierConfirmed(incoming, d) === incoming);

    if (clashLocals.length > 0 && !incomingWins) {
      // 本地先确认 → 远端版本进冲突区，不入库、不占用
      db.conflicts.push(makeConflict(incoming, preFindings));
      newConflicts += 1;
      continue;
    }

    // 远端先确认（或无冲突）：入库并建立占用；被覆盖的本地任务逐条进冲突区
    if (vehicle) {
      vehicle.version += 1;
      vehicle.updatedAt = nowIso;
    }
    db.dispatches.push(incoming);
    db.occupancy.push(openOccupancyFor(incoming, nowIso));
    localIds.add(incoming.id);

    for (const local of clashLocals) {
      const overlapVehicle = local.vehicleId === incoming.vehicleId;
      const overlapDriver = local.driver.trim() !== "" && local.driver === incoming.driver;
      const reasons: Conflict["reasons"] = [];
      if (overlapVehicle) {
        reasons.push({
          kind: "vehicle-overlap",
          message: `车辆 ${vehicle?.plate ?? local.vehicleId} 在重叠时段被远端任务「${incoming.task}」先确认`
        });
      }
      if (overlapDriver) {
        reasons.push({
          kind: "driver-overlap",
          message: `司机 ${local.driver} 在重叠时段已被远端任务「${incoming.task}」分配`
        });
      }
      reasons.push({
        kind: "stale-version",
        message: `合并时车辆版本已更新为 v${vehicle?.version ?? "?"}，本机任务基于旧版本`
      });
      db.conflicts.push({
        id: uid("cf"),
        candidate: structuredClone(local),
        state: "pending",
        reasons,
        winnerDispatchId: incoming.id,
        detectedAt: Date.now()
      });
      newConflicts += 1;

      local.status = "cancelled";
      local.note = [local.note, "合并时被先确认任务覆盖，转入冲突区"]
        .filter(Boolean)
        .join("；");
      const occ = db.occupancy.find((o) => o.dispatchId === local.id && o.state === "open");
      if (occ) {
        occ.state = "closed";
        occ.closedAt = nowIso;
      }
      db.outbox = db.outbox.filter((op) => (op.payload as Dispatch)?.id !== local.id);
    }
  }

  remote.lastPushAt = nowIso;
  saveRemote(remote);
  saveDb(db);
  return { pulled, pushed, newConflicts };
}

/** 清空模拟远端（演练用） */
export function resetRemote(): void {
  localStorage.removeItem(REMOTE_KEY);
}

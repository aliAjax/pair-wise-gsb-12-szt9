import type {
  Conflict,
  ConflictReason,
  Dispatch,
  LocalDB,
  OccupancyEntry,
  TimeWindow,
  Vehicle
} from "../types";
import { SCHEMA_VERSION } from "../types";

export function uid(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 占用中的任务状态：confirmed / executing 均为有效任务 */
export const ACTIVE_STATUSES: ReadonlySet<Dispatch["status"]> = new Set([
  "confirmed",
  "executing"
]);

export function isActive(d: Pick<Dispatch, "status">): boolean {
  return ACTIVE_STATUSES.has(d.status);
}

export function toTime(value: string | number | Date): number {
  return new Date(value).getTime();
}

/** 半开区间重叠判定：相邻时段 [a,b)[b,c) 不算冲突 */
export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  const as = toTime(a.startAt);
  const ae = toTime(a.endAt);
  const bs = toTime(b.startAt);
  const be = toTime(b.endAt);
  if ([as, ae, bs, be].some((n) => Number.isNaN(n))) return false;
  return as < be && bs < ae;
}

export function validWindow(w: TimeWindow): boolean {
  const s = toTime(w.startAt);
  const e = toTime(w.endAt);
  return !Number.isNaN(s) && !Number.isNaN(e) && e > s;
}

/** 裁决先后：confirmedAt 小者为先确认；相同则 seq 小者胜；再相同 id 字典序 */
export function earlierConfirmed(a: Dispatch, b: Dispatch): Dispatch {
  if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt < b.confirmedAt ? a : b;
  if (a.seq !== b.seq) return a.seq < b.seq ? a : b;
  return a.id < b.id ? a : b;
}

export interface ConflictFindings {
  vehicleWinner?: Dispatch;
  driverWinner?: Dispatch;
  reasons: ConflictReason[];
}

/**
 * 判断候选任务是否与库内有效任务冲突：
 * 1) 同一车辆占用时段重叠（一辆车同时段只能有一个有效任务）
 * 2) 同一司机占用时段重叠（司机不能重复分配）
 * 3) 候选基于过期车辆版本（并发派车的版本失配）
 */
export function detectConflicts(
  db: Pick<LocalDB, "dispatches">,
  candidate: Dispatch,
  baseVehicleVersion?: number,
  currentVehicleVersion?: number
): ConflictFindings {
  const reasons: ConflictReason[] = [];
  let vehicleWinner: Dispatch | undefined;
  let driverWinner: Dispatch | undefined;

  for (const d of db.dispatches) {
    if (d.id === candidate.id || !isActive(d) || !overlaps(d, candidate)) continue;

    if (d.vehicleId === candidate.vehicleId) {
      const winner = earlierConfirmed(d, candidate) === d ? d : undefined;
      if (winner) {
        vehicleWinner = winner;
        reasons.push({
          kind: "vehicle-overlap",
          message: `车辆 ${candidate.vehicleId} 在 ${fmtRange(candidate)} 已被任务「${winner.task}」占用（先确认）`
        });
      }
    }
    if (d.driver.trim() && d.driver === candidate.driver) {
      const winner = earlierConfirmed(d, candidate) === d ? d : undefined;
      if (winner) {
        driverWinner = winner;
        reasons.push({
          kind: "driver-overlap",
          message: `司机 ${candidate.driver} 在 ${fmtRange(candidate)} 已有任务「${winner.task}」，不能重复分配`
        });
      }
    }
  }

  const stale =
    typeof baseVehicleVersion === "number" &&
    typeof currentVehicleVersion === "number" &&
    baseVehicleVersion < currentVehicleVersion;
  if (stale && reasons.length > 0) {
    reasons.push({
      kind: "stale-version",
      message: `表单基于车辆版本 v${baseVehicleVersion}，当前已为 v${currentVehicleVersion}，存在并发派车`
    });
  }

  return { vehicleWinner, driverWinner, reasons };
}

export function makeConflict(candidate: Dispatch, findings: ConflictFindings): Conflict {
  const winner = findings.vehicleWinner ?? findings.driverWinner;
  return {
    id: uid("cf"),
    candidate: structuredClone(candidate),
    state: "pending",
    reasons: findings.reasons,
    winnerDispatchId: winner?.id ?? "",
    detectedAt: Date.now()
  };
}

export function fmtRange(w: TimeWindow): string {
  const fmt = (s: string) => {
    const d = new Date(s);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${fmt(w.startAt)} ~ ${fmt(w.endAt)}`;
}

/** ISO 串 → <input type="datetime-local"> 需要的本地时间串（yyyy-MM-ddTHH:mm） */
export function toDatetimeLocal(value: string | number | Date): string {
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function openOccupancyFor(d: Dispatch, nowIso: string): OccupancyEntry {
  return {
    id: uid("oc"),
    dispatchId: d.id,
    vehicleId: d.vehicleId,
    driver: d.driver,
    task: d.task,
    startAt: d.startAt,
    endAt: d.endAt,
    state: "open",
    version: 1,
    openedAt: nowIso
  };
}

// ---------- 旧数据迁移：先补齐任务版本与占用时段，再参与判断 ----------

interface LegacyRecord {
  id?: string;
  vehicle?: string;
  driver?: string;
  zone?: string;
  task?: string;
  status?: string;
  notes?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** 缺占用时段时的补齐窗口：创建时刻起 4 小时 */
function fallbackWindow(createdAtIso: string): TimeWindow {
  const start = Number.isNaN(toTime(createdAtIso)) ? Date.now() : toTime(createdAtIso);
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 4 * 3600_000).toISOString()
  };
}

function slugPlate(plate: string, index: number): string {
  const slug = plate.replace(/[^\w一-龥-]/g, "") || `veh-${index + 1}`;
  return `veh-${slug}`;
}

/**
 * 把旧版记录数组迁移为本地库。
 * 旧记录无任务版本、无占用时段：一律先补齐（version=1，窗口取 createdAt + 4h），
 * 补齐完成后才允许进入冲突判断流程。
 */
export function migrateLegacy(recordsRaw: unknown): LocalDB {
  const records = Array.isArray(recordsRaw) ? (recordsRaw as LegacyRecord[]) : [];
  const nowIso = new Date().toISOString();
  const vehicles: Vehicle[] = [];
  const dispatches: Dispatch[] = [];
  const occupancy: OccupancyEntry[] = [];
  let seq = 0;

  records.forEach((r, index) => {
    const plate = String(r.vehicle ?? `未命名车辆-${index + 1}`).trim();
    const driver = String(r.driver ?? "").trim();
    const zone = String(r.zone ?? "").trim();
    const id = slugPlate(plate, index);
    if (!vehicles.some((v) => v.id === id)) {
      vehicles.push({
        id,
        plate,
        driver,
        zone,
        note: r.status === "空闲" ? String(r.notes ?? "") : "",
        version: 1,
        updatedAt: typeof r.createdAt === "string" ? r.createdAt : nowIso
      });
    }

    // 补齐：任务版本缺失 → 1；占用时段缺失 → createdAt 起 4 小时
    const win: TimeWindow =
      typeof r.startAt === "string" && typeof r.endAt === "string"
        ? { startAt: r.startAt, endAt: r.endAt }
        : fallbackWindow(typeof r.createdAt === "string" ? r.createdAt : nowIso);

    if (r.status === "执行中" || r.status === "已完成") {
      seq += 1;
      const active = r.status === "执行中";
      const createdAtIso = typeof r.createdAt === "string" ? r.createdAt : nowIso;
      const dispatch: Dispatch = {
        id: typeof r.id === "string" && r.id ? `dp-${r.id}` : uid("dp"),
        version: 1, // 旧数据无版本，先补齐
        vehicleId: id,
        driver,
        zone,
        task: String(r.task ?? "未命名任务"),
        note: [r.notes, active ? "" : "（旧数据补齐时段）"].filter(Boolean).join(" "),
        status: active ? "executing" : "finished",
        confirmedAt: toTime(createdAtIso),
        seq,
        origin: "local",
        createdAt: createdAtIso,
        ...win
      };
      dispatches.push(dispatch);
      if (active) {
        occupancy.push(openOccupancyFor(dispatch, nowIso));
      } else {
        occupancy.push({
          ...openOccupancyFor(dispatch, createdAtIso),
          state: "closed",
          closedAt: createdAtIso
        });
      }
    }
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    vehicles,
    dispatches,
    occupancy,
    conflicts: [],
    outbox: [],
    seq,
    lastMigration: {
      fromVersion: 0,
      toVersion: SCHEMA_VERSION,
      status: "done",
      migratedAt: nowIso
    }
  };
}

/** 已是本地库结构但字段缺失（低版本/半截数据）：原地补齐，幂等 */
export function backfillDb(db: LocalDB): LocalDB {
  const nowIso = new Date().toISOString();
  let touched = false;

  for (const d of db.dispatches) {
    if (typeof d.version !== "number") {
      d.version = 1;
      touched = true;
    }
    if (!d.startAt || !d.endAt) {
      const w = fallbackWindow(d.createdAt ?? nowIso);
      d.startAt = w.startAt;
      d.endAt = w.endAt;
      touched = true;
    }
  }
  for (const o of db.occupancy) {
    if (typeof o.version !== "number") {
      o.version = 1;
      touched = true;
    }
    if (!o.startAt || !o.endAt) {
      const d = db.dispatches.find((x) => x.id === o.dispatchId);
      const w = d ? { startAt: d.startAt, endAt: d.endAt } : fallbackWindow(o.openedAt ?? nowIso);
      o.startAt = w.startAt;
      o.endAt = w.endAt;
      touched = true;
    }
  }
  for (const v of db.vehicles) {
    if (typeof v.version !== "number") {
      v.version = 1;
      touched = true;
    }
  }
  db.schemaVersion = SCHEMA_VERSION;
  if (touched && db.lastMigration) {
    db.lastMigration.status = "done";
  }
  return db;
}

export function seedDb(): LocalDB {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const vehicles: Vehicle[] = [
    { id: "veh-hu-a-82l6", plate: "沪A-82L6", driver: "董飞", zone: "城北", version: 1, updatedAt: iso },
    { id: "veh-hu-b-73k9", plate: "沪B-73K9", driver: "周航", zone: "城东", version: 2, updatedAt: iso },
    { id: "veh-hu-c-15t2", plate: "沪C-15T2", driver: "李娜", zone: "城南", version: 1, updatedAt: iso }
  ];

  const active: Dispatch = {
    id: "dp-seed-1",
    version: 2,
    vehicleId: "veh-hu-b-73k9",
    driver: "周航",
    zone: "城东",
    task: "医药配送",
    note: "预计17:30返回",
    status: "executing",
    startAt: new Date(now - 60 * 60_000).toISOString(),
    endAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    confirmedAt: now - 90 * 60_000,
    seq: 1,
    origin: "local",
    createdAt: iso,
    synced: true
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    vehicles,
    dispatches: [active],
    occupancy: [openOccupancyFor(active, iso)],
    conflicts: [],
    outbox: [],
    seq: 1
  };
}

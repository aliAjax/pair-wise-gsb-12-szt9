import type { DispatchTask, Driver, PersistedState, Vehicle } from "../types";
import { DEFAULT_TASK_HOURS, SCHEMA_VERSION } from "../types";
import type { KV } from "./kv";

export const KEYS = {
  legacy: "dfwlfront-3-dispatch", // v1 旧数据
  state: "dfwlfront-3:v2:state", // v2 主状态
  remote: "dfwlfront-3:v2:remote", // 模拟服务端台账
  snapshot: "dfwlfront-3:v2:snapshot", // 迁移快照
  migrationFlag: "dfwlfront-3:v2:migrating", // 迁移进行标记
} as const;

interface LegacyRecord {
  id?: string;
  vehicle?: string;
  driver?: string;
  zone?: string;
  task?: string;
  status?: string;
  notes?: string;
  createdAt?: string;
}

export interface EnsureResult {
  state: PersistedState;
  notices: string[];
}

function validTime(value: string | undefined): value is string {
  return !!value && !Number.isNaN(Date.parse(value));
}

// 旧数据缺少任务版本或占用时段时，先确定性补齐再参与冲突判断
export function normalizeTask(raw: Partial<DispatchTask> & { id: string }, fallbackSite = "backfill"): DispatchTask {
  const createdAt = validTime(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const startAt = validTime(raw.startAt) ? raw.startAt : createdAt;
  let endAt = validTime(raw.endAt) ? raw.endAt : "";
  if (!endAt || Date.parse(endAt) <= Date.parse(startAt)) {
    endAt = new Date(Date.parse(startAt) + DEFAULT_TASK_HOURS * 3600_000).toISOString();
  }
  const version =
    raw.version && typeof raw.version.lamport === "number" && raw.version.siteId
      ? raw.version
      : { lamport: Date.parse(createdAt), siteId: fallbackSite };
  return {
    id: raw.id,
    vehicleId: raw.vehicleId ?? "",
    driverId: raw.driverId ?? "",
    zone: raw.zone ?? "",
    cargo: raw.cargo ?? "",
    startAt,
    endAt,
    version,
    status: raw.status ?? "active",
    notes: raw.notes ?? "",
    origin: raw.origin ?? "remote",
    createdAt,
    updatedAt: validTime(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

export function normalizeState(parsed: Partial<PersistedState>): PersistedState {
  const tasks = (parsed.tasks ?? []).map((t) => normalizeTask(t, "backfill"));
  const clock = Math.max(parsed.clock ?? 0, 0, ...tasks.map((t) => t.version.lamport));
  return {
    schemaVersion: SCHEMA_VERSION,
    vehicles: parsed.vehicles ?? [],
    drivers: parsed.drivers ?? [],
    tasks,
    conflicts: parsed.conflicts ?? [],
    outbox: parsed.outbox ?? [],
    clock,
  };
}

// 启动入口：恢复中断的迁移 → 加载/迁移/种子
export function ensureSchema(kv: KV): EnsureResult {
  const notices: string[] = [];

  // 1) 上次迁移中断：保留原记录，从快照恢复
  if (kv.getItem(KEYS.migrationFlag)) {
    const snapshotRaw = kv.getItem(KEYS.snapshot);
    if (snapshotRaw) {
      try {
        const snapshot = JSON.parse(snapshotRaw) as { state: string | null };
        if (snapshot.state === null) kv.removeItem(KEYS.state);
        else kv.setItem(KEYS.state, snapshot.state);
        notices.push("检测到上次迁移中断：已保留原记录，并从快照恢复");
      } catch {
        kv.removeItem(KEYS.state);
        notices.push("迁移快照损坏，已回滚到迁移前状态");
      }
    }
    kv.removeItem(KEYS.migrationFlag);
  }

  // 2) 已是当前版本：补齐缺版本/时段的旧任务后直接返回
  const stateRaw = kv.getItem(KEYS.state);
  if (stateRaw) {
    try {
      const parsed = JSON.parse(stateRaw) as Partial<PersistedState>;
      if (parsed.schemaVersion === SCHEMA_VERSION) return { state: normalizeState(parsed), notices };
      notices.push("本地数据版本未知，已按旧数据重新迁移");
    } catch {
      notices.push("本地数据损坏，已尝试从旧记录重建");
    }
  }

  // 3) 旧数据迁移（v1 → v2）
  const legacyRaw = kv.getItem(KEYS.legacy);
  if (legacyRaw) {
    const migrated = migrateWithSnapshot(kv, legacyRaw, stateRaw, notices);
    if (migrated) return { state: migrated, notices };
  }

  // 4) 全新安装：写入演示数据
  return { state: seedState(), notices };
}

function migrateWithSnapshot(kv: KV, legacyRaw: string, stateRaw: string | null, notices: string[]): PersistedState | null {
  let legacy: LegacyRecord[];
  try {
    const parsed = JSON.parse(legacyRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("legacy is not an array");
    legacy = parsed as LegacyRecord[];
  } catch {
    notices.push("旧记录无法解析，已保留原记录并跳过迁移");
    return null;
  }

  // 先快照再置标记：任何一步中断，下次启动都会回滚
  kv.setItem(KEYS.snapshot, JSON.stringify({ state: stateRaw, takenAt: new Date().toISOString() }));
  kv.setItem(KEYS.migrationFlag, new Date().toISOString());
  try {
    const state = buildStateFromLegacy(legacy);
    kv.setItem(KEYS.state, JSON.stringify(state));
    kv.removeItem(KEYS.migrationFlag);
    notices.push(`已迁移 ${legacy.length} 条旧记录：补齐任务版本与占用时段，原记录保留在 ${KEYS.legacy}`);
    return state;
  } catch {
    // 迁移失败：保留原记录，从快照恢复
    const snapshotRaw = kv.getItem(KEYS.snapshot);
    const snapshot = snapshotRaw ? (JSON.parse(snapshotRaw) as { state: string | null }) : { state: null };
    if (snapshot.state === null) kv.removeItem(KEYS.state);
    else kv.setItem(KEYS.state, snapshot.state);
    kv.removeItem(KEYS.migrationFlag);
    notices.push("迁移中断：已保留原记录，并从快照恢复");
    return snapshot.state ? normalizeState(JSON.parse(snapshot.state) as Partial<PersistedState>) : null;
  }
}

function buildStateFromLegacy(records: LegacyRecord[]): PersistedState {
  const vehicles = new Map<string, Vehicle>();
  const drivers = new Map<string, Driver>();
  const tasks: DispatchTask[] = [];

  records.forEach((rec, index) => {
    const plate = (rec.vehicle ?? "").trim() || `未命名车辆-${index + 1}`;
    const driverName = (rec.driver ?? "").trim() || "未指定司机";
    const createdAt = validTime(rec.createdAt) ? rec.createdAt : new Date().toISOString();

    let vehicle = vehicles.get(plate);
    if (!vehicle) {
      vehicle = { id: `veh-${vehicles.size + 1}`, plate, zone: (rec.zone ?? "").trim(), notes: "", createdAt };
      vehicles.set(plate, vehicle);
    }
    let driver = drivers.get(driverName);
    if (!driver) {
      driver = { id: `drv-${drivers.size + 1}`, name: driverName, createdAt };
      drivers.set(driverName, driver);
    }

    // 旧状态映射：执行中→有效任务，已完成→历史任务，空闲→仅登记车辆
    const status = rec.status === "执行中" ? "active" : rec.status === "已完成" ? "completed" : null;
    if (!status) return;
    tasks.push(
      normalizeTask(
        {
          id: rec.id ?? `mig-${index + 1}`,
          vehicleId: vehicle.id,
          driverId: driver.id,
          zone: (rec.zone ?? "").trim(),
          cargo: (rec.task ?? "").trim(),
          status,
          notes: (rec.notes ?? "").trim(),
          origin: "migration",
          createdAt,
        },
        "migration"
      )
    );
  });

  return normalizeState({
    vehicles: [...vehicles.values()],
    drivers: [...drivers.values()],
    tasks,
    conflicts: [],
    outbox: [],
    clock: 0,
  });
}

export function seedState(now = new Date()): PersistedState {
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  const vehicles: Vehicle[] = [
    { id: "veh-1", plate: "沪A-82L6", zone: "城北", notes: "冷链车", createdAt: hoursAgo(72) },
    { id: "veh-2", plate: "沪B-73K9", zone: "城东", notes: "", createdAt: hoursAgo(72) },
    { id: "veh-3", plate: "沪C-55D2", zone: "城南", notes: "", createdAt: hoursAgo(72) },
  ];
  const drivers: Driver[] = [
    { id: "drv-1", name: "董飞", createdAt: hoursAgo(72) },
    { id: "drv-2", name: "周航", createdAt: hoursAgo(72) },
    { id: "drv-3", name: "林岚", createdAt: hoursAgo(72) },
  ];
  const tasks: DispatchTask[] = [
    normalizeTask(
      {
        id: "seed-1",
        vehicleId: "veh-2",
        driverId: "drv-2",
        zone: "城东",
        cargo: "医药配送",
        status: "active",
        notes: "预计 17:30 返回",
        origin: "migration",
        createdAt: hoursAgo(1),
      },
      "seed"
    ),
    normalizeTask(
      {
        id: "seed-2",
        vehicleId: "veh-1",
        driverId: "drv-1",
        zone: "城北",
        cargo: "商超补货",
        status: "completed",
        notes: "",
        origin: "migration",
        createdAt: hoursAgo(30),
      },
      "seed"
    ),
  ];
  return normalizeState({ vehicles, drivers, tasks, conflicts: [], outbox: [], clock: 0 });
}

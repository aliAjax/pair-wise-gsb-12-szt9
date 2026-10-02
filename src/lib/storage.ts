import type { LocalDB } from "../types";
import { backfillDb, migrateLegacy, seedDb } from "./core";

/** 本地库单 key 原子持久化；旧版数据 key 与迁移快照独立保留 */
export const DB_KEY = "dfwlfront-3-dispatch-db";
export const LEGACY_KEY = "dfwlfront-3-dispatch";
export const SNAPSHOT_KEY = "dfwlfront-3-dispatch-migration-snapshot";
export const MIGRATION_LOCK_KEY = "dfwlfront-3-dispatch-migration-lock";
const TMP_KEY = `${DB_KEY}.tmp`;

export function saveDb(db: LocalDB): void {
  const raw = JSON.stringify(db);
  // 先写临时键再覆盖正式键，避免写入中途失败导致半截数据
  localStorage.setItem(TMP_KEY, raw);
  localStorage.setItem(DB_KEY, raw);
  localStorage.removeItem(TMP_KEY);
}

interface Snapshot {
  legacyRaw: string;
  at: string;
}

/**
 * 载入本地库，启动流程：
 * 1. 本地库存在 → 直接用，缺字段走幂等补齐
 * 2. 只有旧数据 → 迁移前先存快照与迁移锁，迁移成功后解锁（旧记录原样保留）
 * 3. 检测到迁移锁残留（上次迁移中断）→ 用快照重做迁移并标记“已恢复”
 * 4. 全新用户 → 种子数据
 */
export function loadDb(): LocalDB {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      return backfillDb(JSON.parse(raw) as LocalDB);
    } catch {
      // 正式键损坏：落入快照/种子恢复路径，不覆盖任何旧记录
      console.warn("本地库解析失败，尝试从迁移快照恢复");
    }
  }

  const lock = localStorage.getItem(MIGRATION_LOCK_KEY);
  const snapRaw = localStorage.getItem(SNAPSHOT_KEY);
  const legacyRaw = localStorage.getItem(LEGACY_KEY);

  if (lock && snapRaw) {
    // 迁移中断：原记录保留在快照中，从快照重做迁移
    const snap = JSON.parse(snapRaw) as Snapshot;
    const db = migrateLegacy(JSON.parse(snap.legacyRaw));
    if (db.lastMigration) {
      db.lastMigration.status = "interrupted-recovered";
      db.lastMigration.restoredFromSnapshot = true;
    }
    saveDb(db);
    localStorage.removeItem(MIGRATION_LOCK_KEY);
    return db;
  }

  if (legacyRaw != null) {
    // 迁移前留快照 + 加锁；任何一步失败，下次启动都能从快照恢复
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ legacyRaw, at: new Date().toISOString() } satisfies Snapshot)
    );
    localStorage.setItem(MIGRATION_LOCK_KEY, "1");
    let records: unknown;
    try {
      records = JSON.parse(legacyRaw);
    } catch {
      records = [];
    }
    const db = migrateLegacy(records);
    saveDb(db);
    localStorage.removeItem(MIGRATION_LOCK_KEY);
    return db;
  }

  const seeded = seedDb();
  saveDb(seeded);
  return seeded;
}

/** 演示：写入一份缺任务版本、缺占用时段的旧数据后重载，触发首次迁移 */
export function stageLegacyData(): void {
  const legacy = [
    {
      vehicle: "沪A-82L6",
      driver: "董飞",
      zone: "城北",
      task: "商超补货",
      status: "空闲",
      notes: "可立即派车",
      createdAt: new Date(Date.now() - 2 * 86400000).toISOString()
    },
    {
      id: "seed-2",
      vehicle: "沪B-73K9",
      driver: "周航",
      zone: "城东",
      task: "医药配送",
      status: "执行中",
      notes: "预计17:30返回（旧数据，无版本/无时段）",
      createdAt: new Date(Date.now() - 3600_000).toISOString()
    },
    {
      id: "seed-3",
      vehicle: "沪D-90Q8",
      driver: "王磊",
      zone: "城南",
      task: "家电入户",
      status: "已完成",
      notes: "",
      createdAt: new Date(Date.now() - 86400000).toISOString()
    }
  ];
  localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
  localStorage.removeItem(DB_KEY);
}

/** 演示：迁移进行到一半中断（锁未释放、本地库未生成），原记录保留在快照中 */
export function stageInterruptedMigration(): void {
  const legacy = [
    {
      vehicle: "沪A-82L6",
      driver: "董飞",
      zone: "城北",
      task: "商超补货",
      status: "空闲",
      notes: "可立即派车",
      createdAt: new Date(Date.now() - 86400000).toISOString()
    },
    {
      vehicle: "沪E-27M5",
      driver: "陈晨",
      zone: "城东",
      task: "生鲜冷链",
      status: "执行中",
      notes: "迁移中断演练",
      createdAt: new Date(Date.now() - 1800_000).toISOString()
    }
  ];
  const legacyRaw = JSON.stringify(legacy);
  localStorage.setItem(LEGACY_KEY, legacyRaw);
  localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({ legacyRaw, at: new Date().toISOString() } satisfies Snapshot)
  );
  localStorage.setItem(MIGRATION_LOCK_KEY, "1");
  localStorage.removeItem(DB_KEY);
}

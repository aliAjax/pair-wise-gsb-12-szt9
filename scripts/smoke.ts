// 本地优先调度核心规则冒烟测试（Node 环境，localStorage 用内存模拟）
import assert from "node:assert";

// ---- localStorage shim ----
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  }
} as Storage;

const { overlaps, detectConflicts, migrateLegacy, backfillDb, earlierConfirmed } = await import(
  "../src/lib/core.ts"
);
const storage = await import("../src/lib/storage.ts");
const sync = await import("../src/lib/sync.ts");

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

// 1) 时段重叠：相邻时段不冲突，交叉时段冲突
assert.ok(overlaps({ startAt: "2026-10-02T08:00:00Z", endAt: "2026-10-02T10:00:00Z" }, { startAt: "2026-10-02T09:00:00Z", endAt: "2026-10-02T11:00:00Z" }));
assert.ok(!overlaps({ startAt: "2026-10-02T08:00:00Z", endAt: "2026-10-02T10:00:00Z" }, { startAt: "2026-10-02T10:00:00Z", endAt: "2026-10-02T11:00:00Z" }));
passed += 2;
console.log("✓ 时段重叠判定（交叉重叠 / 首尾相接不冲突）");

// 2) 先确认裁决
const d1 = { confirmedAt: 100, seq: 1 } as never;
const d2 = { confirmedAt: 100, seq: 2 } as never;
ok("同时刻确认：seq 小者胜", earlierConfirmed(d1 as never, d2 as never) === d1);

// 3) 旧数据迁移：缺版本/缺时段一律补齐，且“执行中”产生开放占用
mem.clear();
const migrated = migrateLegacy([
  { vehicle: "沪A-1", driver: "甲", zone: "城北", task: "T1", status: "执行中", createdAt: "2026-10-01T01:00:00Z" },
  { vehicle: "沪A-2", driver: "乙", zone: "城东", task: "T2", status: "已完成", createdAt: "2026-10-01T02:00:00Z" },
  { vehicle: "沪A-3", driver: "丙", zone: "城南", task: "T3", status: "空闲", notes: "空闲车" }
]);
ok("旧数据车辆全部入库", migrated.vehicles.length === 3);
ok("旧任务版本补齐为 1", migrated.dispatches.every((d) => d.version === 1));
ok("旧任务占用时段补齐", migrated.dispatches.every((d) => !!d.startAt && !!d.endAt && d.endAt > d.startAt));
ok("执行中任务对应 open 占用", migrated.occupancy.filter((o) => o.state === "open").length === 1);
ok("已完成任务对应 closed 占用", migrated.occupancy.filter((o) => o.state === "closed").length === 1);

// 4) 冲突检测：同车重叠、同司机重叠
const candidate = {
  id: "c1", version: 1, vehicleId: migrated.vehicles[0].id, driver: "甲", zone: "城北",
  task: "新任务", status: "confirmed", startAt: "2026-10-01T02:00:00Z", endAt: "2026-10-01T03:00:00Z",
  confirmedAt: Date.now(), seq: 99, origin: "local", createdAt: new Date().toISOString()
} as never;
// 迁移出的“执行中”窗口为 createdAt+4h = 01:00~05:00，与候选 02:00~03:00 重叠
const f = detectConflicts(migrated, candidate as never);
ok("同车重叠被检出", f.reasons.some((r) => r.kind === "vehicle-overlap"));
ok("同司机重叠被检出（司机不能重复分配）", f.reasons.some((r) => r.kind === "driver-overlap"));

// 5) loadDb 首次迁移 + 迁移锁释放 + 旧记录保留
mem.clear();
localStorage.setItem(storage.LEGACY_KEY, JSON.stringify([
  { vehicle: "沪B-1", driver: "丁", task: "X", status: "执行中", createdAt: "2026-10-01T00:00:00Z" }
]));
const db1 = storage.loadDb();
ok("首次启动完成旧数据迁移", db1.schemaVersion === 2 && db1.vehicles.length === 1);
ok("迁移后锁已释放、旧记录原样保留", localStorage.getItem(storage.MIGRATION_LOCK_KEY) === null && localStorage.getItem(storage.LEGACY_KEY) !== null);
ok("迁移快照留存", localStorage.getItem(storage.SNAPSHOT_KEY) !== null);

// 6) 迁移中断：锁残留 + 无 DB → 从快照恢复并标记
mem.delete(storage.DB_KEY);
localStorage.setItem(storage.MIGRATION_LOCK_KEY, "1");
const db2 = storage.loadDb();
ok("迁移中断后从快照恢复", db2.lastMigration?.status === "interrupted-recovered");
ok("恢复数据完整（车辆与占用不丢）", db2.vehicles.length === 1 && db2.occupancy.length === 1);

// 7) backfillDb 幂等：半截库缺字段补齐不报错
mem.clear();
const partial = {
  schemaVersion: 1,
  vehicles: [{ id: "v1", plate: "沪Z-9", driver: "戊", zone: "城北", updatedAt: "2026-10-01T00:00:00Z" }],
  dispatches: [{ id: "dp1", vehicleId: "v1", driver: "戊", zone: "城北", task: "缺版本缺时段", status: "confirmed", confirmedAt: 1, seq: 1, origin: "local", createdAt: "2026-10-01T00:00:00Z" }],
  occupancy: [], conflicts: [], outbox: [], seq: 1
};
const bf = backfillDb(structuredClone(partial) as never);
ok("半截数据补齐版本与时段", (bf.dispatches[0] as { version: number; startAt: string }).version === 1 && !!(bf.dispatches[0] as { endAt: string }).endAt);
ok("backfill 幂等（schemaVersion=2）", bf.schemaVersion === 2);

// 8) 断网登记 → 恢复合并：本地先确认，远端同车后进 → 远端版进冲突区
mem.clear();
const db = storage.loadDb(); // 种子数据
const veh = db.vehicles[0];
const w = { startAt: new Date(Date.now() + 3600_000).toISOString(), endAt: new Date(Date.now() + 2 * 3600_000).toISOString() };
// 离线：本地登记（直接构造 outbox 效果：设置 synced=false + 派发）
db.dispatches.push({
  id: "local-offline-1", version: 1, vehicleId: veh.id, driver: "离线司机", zone: "城北",
  task: "离线登记任务", status: "confirmed", ...w, confirmedAt: Date.now() - 2000, seq: 10,
  origin: "local", createdAt: new Date().toISOString(), synced: false
});
db.outbox.push({ id: "op1", type: "dispatch", payload: db.dispatches.at(-1), createdAt: Date.now() });
storage.saveDb(db);
// 另一调度员晚 2 秒确认同车同时段
sync.simulateRemoteDispatch({ vehicleId: veh.id, driver: "远端司机", zone: "城南", task: "远端晚确认任务", ...w, confirmedAt: Date.now() - 1000 });
const r1 = sync.syncNow(storage.loadDb());
ok("恢复后推送 1 笔本地任务", r1.pushed === 1);
ok("晚确认的远端版本进入冲突区", r1.newConflicts === 1);
const after = JSON.parse(localStorage.getItem(storage.DB_KEY)!);
ok("本地任务仍有效并保持占用", after.dispatches.find((d: { id: string }) => d.id === "local-offline-1").status === "confirmed");
ok("冲突区版本不产生占用记录", !after.occupancy.some((o: { task: string }) => o.task === "远端晚确认任务"));

// 9) 远端先确认 → 本地败方失效释放占用、远端入库占用
mem.clear();
const dbA = storage.loadDb();
const vehA = dbA.vehicles[1]; // 沪B（种子已有执行中任务，换一辆空闲车 v2 用 vehicles[2]）
const target = dbA.vehicles[2];
const w2 = { startAt: new Date(Date.now() + 7200_000).toISOString(), endAt: new Date(Date.now() + 3 * 3600_000).toISOString() };
dbA.dispatches.push({
  id: "local-late", version: 1, vehicleId: target.id, driver: "本地司机", zone: "城北",
  task: "本地晚确认", status: "confirmed", ...w2, confirmedAt: Date.now() - 1000, seq: 5,
  origin: "local", createdAt: new Date().toISOString(), synced: false
});
dbA.occupancy.push({
  id: "oc-late", dispatchId: "local-late", vehicleId: target.id, driver: "本地司机", task: "本地晚确认",
  ...w2, state: "open", version: 1, openedAt: new Date().toISOString()
});
dbA.outbox.push({ id: "op2", type: "dispatch", payload: dbA.dispatches.at(-1), createdAt: Date.now() });
storage.saveDb(dbA);
sync.simulateRemoteDispatch({ vehicleId: target.id, driver: "远端司机", zone: "城东", task: "远端先确认", ...w2, confirmedAt: Date.now() - 5000 });
const r2 = sync.syncNow(storage.loadDb());
ok("远端先确认：本地败方进冲突区", r2.newConflicts === 1);
const after2 = JSON.parse(localStorage.getItem(storage.DB_KEY)!);
const localLate = after2.dispatches.find((d: { id: string }) => d.id === "local-late");
ok("本地败方任务被取消", localLate.status === "cancelled");
ok("本地败方占用已释放", after2.occupancy.find((o: { dispatchId: string }) => o.dispatchId === "local-late").state === "closed");
ok("远端先确认任务已入库并开放占用", after2.dispatches.some((d: { task: string }) => d.task === "远端先确认") && after2.occupancy.some((o: { task: string; state: string }) => o.task === "远端先确认" && o.state === "open"));
ok("同车同时段仅一条 open 占用", after2.occupancy.filter((o: { vehicleId: string; state: string }) => o.vehicleId === target.id && o.state === "open").length === 1);

console.log(`\n全部 ${passed} 项断言通过`);
void vehA;

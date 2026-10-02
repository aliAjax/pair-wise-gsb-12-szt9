// 逻辑自测：迁移补齐/回滚、合并冲突、司机重复分配、离线合并
// 运行：npm run selftest
import { memoryKV } from "../src/lib/kv";
import { ensureSchema, KEYS, normalizeTask, seedState } from "../src/lib/migrate";
import { detectConflicts, intervalsOverlap, loadRemote, mergeTasks, upsertRemote } from "../src/lib/sync";
import type { DispatchTask } from "../src/types";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

function task(partial: Partial<DispatchTask> & { id: string }): DispatchTask {
  return normalizeTask({
    vehicleId: "v1",
    driverId: "d1",
    zone: "城北",
    cargo: "测试任务",
    status: "active",
    notes: "",
    origin: "local",
    createdAt: "2026-10-02T08:00:00.000Z",
    startAt: "2026-10-02T09:00:00.000Z",
    endAt: "2026-10-02T12:00:00.000Z",
    ...partial,
  });
}

console.log("1) 旧数据迁移：补齐任务版本与占用时段");
const kv1 = memoryKV();
kv1.setItem(
  KEYS.legacy,
  JSON.stringify([
    { vehicle: "沪A-82L6", driver: "董飞", zone: "城北", task: "商超补货", status: "空闲", notes: "可立即派车", createdAt: "2026-09-30T08:00:00.000Z" },
    { vehicle: "沪B-73K9", driver: "周航", zone: "城东", task: "医药配送", status: "执行中", notes: "", createdAt: "2026-10-01T09:00:00.000Z" },
  ])
);
const r1 = ensureSchema(kv1);
check("生成车辆与司机", r1.state.vehicles.length === 2 && r1.state.drivers.length === 2);
check("空闲记录只登记车辆不生成任务", r1.state.tasks.length === 1);
const migrated = r1.state.tasks[0];
check("补齐任务版本", migrated.version.lamport > 0 && migrated.version.siteId === "migration");
check("补齐占用时段", Date.parse(migrated.endAt) > Date.parse(migrated.startAt));
check("迁移后原记录保留", kv1.getItem(KEYS.legacy) !== null);
check("迁移前生成快照", kv1.getItem(KEYS.snapshot) !== null);

console.log("2) 迁移中断：保留原记录并从快照恢复");
const kv2 = memoryKV();
kv2.setItem(KEYS.state, JSON.stringify(seedState(new Date("2026-10-02T00:00:00.000Z"))));
const before = kv2.getItem(KEYS.state);
kv2.setItem(KEYS.snapshot, JSON.stringify({ state: before, takenAt: "2026-10-02T01:00:00.000Z" }));
kv2.setItem(KEYS.migrationFlag, "2026-10-02T01:00:01.000Z");
kv2.setItem(KEYS.state, '{"schemaVersion":2,"vehicles":['); // 模拟写了一半
const r2 = ensureSchema(kv2);
check("状态从快照恢复", kv2.getItem(KEYS.state) === before && r2.state.vehicles.length === 3);
check("给出恢复提示", r2.notices.some((n) => n.includes("快照")));

const kv3 = memoryKV();
kv3.setItem(
  KEYS.legacy,
  JSON.stringify([{ vehicle: "沪X-0001", driver: "测试", zone: "城北", task: "临时", status: "执行中", createdAt: "2026-10-01T00:00:00.000Z" }])
);
kv3.setItem(KEYS.snapshot, JSON.stringify({ state: null, takenAt: "2026-10-02T01:00:00.000Z" }));
kv3.setItem(KEYS.migrationFlag, "2026-10-02T01:00:01.000Z");
kv3.setItem(KEYS.state, '{"schemaVersion":2'); // 半截写入
const r3 = ensureSchema(kv3);
check("半截写入回滚后重新迁移", r3.state.tasks.length === 1 && r3.state.vehicles[0]?.plate === "沪X-0001");
check("旧记录仍然保留", kv3.getItem(KEYS.legacy) !== null);

console.log("3) 同时提交：保留先确认的一版，另一版进冲突区");
const t1 = task({ id: "t1", version: { lamport: 10, siteId: "site-a" } });
const t2 = task({ id: "t2", driverId: "d2", version: { lamport: 5, siteId: "site-b" }, startAt: "2026-10-02T10:00:00.000Z", endAt: "2026-10-02T13:00:00.000Z" });
const det = detectConflicts([t1, t2], [], "2026-10-02T12:30:00.000Z");
check("先确认版本保持有效", det.tasks.find((t) => t.id === "t2")?.status === "active");
check("后确认版本进冲突区", det.tasks.find((t) => t.id === "t1")?.status === "conflicted");
check("生成车辆重叠冲突", det.added.length === 1 && det.added[0].kind === "vehicle-overlap" && det.added[0].winnerId === "t2");
const detAgain = detectConflicts(det.tasks, det.conflicts, "2026-10-02T12:31:00.000Z");
check("重复检测不重复建冲突", detAgain.added.length === 0);

console.log("4) 司机不能重复分配");
const t3 = task({ id: "t3", vehicleId: "v2", driverId: "d9", version: { lamport: 1, siteId: "a" } });
const t4 = task({ id: "t4", vehicleId: "v3", driverId: "d9", version: { lamport: 2, siteId: "a" }, startAt: "2026-10-02T11:00:00.000Z", endAt: "2026-10-02T14:00:00.000Z" });
const detDriver = detectConflicts([t3, t4], [], "2026-10-02T12:00:00.000Z");
check("识别司机重复分配", detDriver.added.some((c) => c.kind === "driver-overlap"));
check(
  "先确认的司机任务保留",
  detDriver.tasks.find((t) => t.id === "t3")?.status === "active" && detDriver.tasks.find((t) => t.id === "t4")?.status === "conflicted"
);

console.log("5) 时段边界与合并");
check(
  "首尾相接不算重叠",
  !intervalsOverlap(
    { startAt: "2026-10-02T09:00:00.000Z", endAt: "2026-10-02T10:00:00.000Z" },
    { startAt: "2026-10-02T10:00:00.000Z", endAt: "2026-10-02T11:00:00.000Z" }
  )
);
const newer = task({ id: "t1", version: { lamport: 20, siteId: "a" }, cargo: "更新后" });
const merged = mergeTasks([t1], [newer]);
check("LWW 保留新版本", merged.tasks.find((t) => t.id === "t1")?.cargo === "更新后");
const older = task({ id: "t1", version: { lamport: 1, siteId: "a" }, cargo: "旧版本" });
const merged2 = mergeTasks([newer], [older]);
check("旧版本不覆盖", merged2.tasks.find((t) => t.id === "t1")?.cargo === "更新后");

console.log("6) 断网登记 → 恢复后合并");
const kv6 = memoryKV();
upsertRemote(kv6, [t3]); // 服务端已有对端任务
const local = [task({ id: "local-1", vehicleId: "v9", driverId: "d1", version: { lamport: 3, siteId: "site-c" } })];
upsertRemote(kv6, local); // 离线队列恢复后推送
const remote = loadRemote(kv6);
const mergedLocal = mergeTasks(local, remote.tasks);
check("远端任务合并到本地", mergedLocal.tasks.some((t) => t.id === "t3"));
const det6 = detectConflicts(mergedLocal.tasks, [], "2026-10-02T12:00:00.000Z");
check("合并后无冲突（不同车辆）", det6.added.length === 0);

console.log("7) 缺版本/时段的旧任务先补齐再判断");
const raw = normalizeTask({ id: "old-1", vehicleId: "v1", driverId: "d1", createdAt: "2026-10-02T08:00:00.000Z", status: "active" });
check("缺版本按创建时间补齐", raw.version.lamport === Date.parse("2026-10-02T08:00:00.000Z"));
check("缺时段按默认时长补齐", Date.parse(raw.endAt) - Date.parse(raw.startAt) === 4 * 3600 * 1000);

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);

import { defineStore } from "pinia";
import type { Conflict, DispatchTask, Driver, OutboxEntry, PersistedState, Vehicle } from "../types";
import { SCHEMA_VERSION } from "../types";
import { defaultKV, type KV } from "../lib/kv";
import { ensureSchema, KEYS } from "../lib/migrate";
import { detectConflicts, intervalsOverlap, loadRemote, mergeTasks, saveRemote, upsertRemote } from "../lib/sync";
import { getSiteId, versionText } from "../lib/version";

const kv: KV = defaultKV();
const PEER_SITE_ID = "dispatch-b";
let listenersBound = false;

export interface RegisterInput {
  vehicleId: string;
  driverId: string;
  zone: string;
  cargo: string;
  startAt: string;
  endAt: string;
  notes: string;
}

export interface VehicleCard {
  vehicle: Vehicle;
  current: DispatchTask | null;
  upcoming: DispatchTask | null;
  conflictCount: number;
  paused: boolean;
  status: "空闲" | "执行中" | "暂停派车";
}

// 有未解决冲突的车辆暂停派车（车辆冲突与司机冲突都计入）
function pausedVehicles(tasks: DispatchTask[], conflicts: Conflict[]): Set<string> {
  const ids = new Set<string>();
  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  for (const c of conflicts) {
    if (c.resolvedAt) continue;
    for (const taskId of c.taskIds) {
      const t = taskById.get(taskId);
      if (t) ids.add(t.vehicleId);
    }
  }
  return ids;
}

export const useDispatchStore = defineStore("dispatch", {
  state: () => ({
    vehicles: [] as Vehicle[],
    drivers: [] as Driver[],
    tasks: [] as DispatchTask[],
    conflicts: [] as Conflict[],
    outbox: [] as OutboxEntry[],
    clock: 0,
    siteId: "",
    online: true,
    lastSyncAt: null as string | null,
    notices: [] as string[],
    ready: false,
  }),
  getters: {
    vehicleById(state): Map<string, Vehicle> {
      return new Map(state.vehicles.map((v) => [v.id, v] as const));
    },
    driverById(state): Map<string, Driver> {
      return new Map(state.drivers.map((d) => [d.id, d] as const));
    },
    unresolvedConflicts(state): Conflict[] {
      return state.conflicts.filter((c) => !c.resolvedAt);
    },
    resolvedConflicts(state): Conflict[] {
      return state.conflicts
        .filter((c) => !!c.resolvedAt)
        .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));
    },
    pausedVehicleIds(state): Set<string> {
      return pausedVehicles(state.tasks, state.conflicts);
    },
    // 占用台账：任务的投影，按占用开始时间倒序
    ledger(state): DispatchTask[] {
      return [...state.tasks].sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
    },
    vehicleCards(state): VehicleCard[] {
      const now = Date.now();
      const paused = pausedVehicles(state.tasks, state.conflicts);
      return state.vehicles.map((vehicle) => {
        const active = state.tasks.filter((t) => t.vehicleId === vehicle.id && t.status === "active");
        const current = active.find((t) => Date.parse(t.startAt) <= now && now < Date.parse(t.endAt)) ?? null;
        const upcoming =
          active
            .filter((t) => Date.parse(t.startAt) > now)
            .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0] ?? null;
        const conflictCount = state.conflicts.filter(
          (c) =>
            !c.resolvedAt &&
            c.taskIds.some((id) => state.tasks.find((x) => x.id === id)?.vehicleId === vehicle.id)
        ).length;
        const isPaused = paused.has(vehicle.id);
        return {
          vehicle,
          current,
          upcoming,
          conflictCount,
          paused: isPaused,
          status: isPaused ? "暂停派车" : current ? "执行中" : "空闲",
        };
      });
    },
  },
  actions: {
    init() {
      if (this.ready) return;
      this.siteId = getSiteId(kv);
      const { state, notices } = ensureSchema(kv);
      this.applyState(state);
      notices.forEach((n) => this.pushNotice(n));
      this.online = typeof navigator === "undefined" ? true : navigator.onLine;
      if (typeof window !== "undefined" && !listenersBound) {
        listenersBound = true;
        window.addEventListener("online", () => {
          this.online = true;
          this.pushNotice("网络已恢复，开始合并离线期间的登记");
          this.syncNow();
        });
        window.addEventListener("offline", () => {
          this.online = false;
        });
      }
      this.ready = true;
      if (this.online) this.syncNow();
      else this.persist();
    },
    applyState(state: PersistedState) {
      this.vehicles = state.vehicles;
      this.drivers = state.drivers;
      this.tasks = state.tasks;
      this.conflicts = state.conflicts;
      this.outbox = state.outbox;
      this.clock = state.clock;
    },
    persist() {
      const state: PersistedState = {
        schemaVersion: SCHEMA_VERSION,
        vehicles: this.vehicles,
        drivers: this.drivers,
        tasks: this.tasks,
        conflicts: this.conflicts,
        outbox: this.outbox,
        clock: this.clock,
      };
      kv.setItem(KEYS.state, JSON.stringify(state));
    },
    pushNotice(msg: string) {
      this.notices.unshift(msg);
      if (this.notices.length > 5) this.notices.pop();
    },
    dismissNotice(index: number) {
      this.notices.splice(index, 1);
    },
    // Lamport 时钟：不小于当前墙钟，保证“先确认”贴近真实先后
    tick(): number {
      this.clock = Math.max(this.clock + 1, Date.now());
      return this.clock;
    },
    // 派车登记：本地先校验，在线即同步，离线进待同步队列
    register(input: RegisterInput): string | null {
      const vehicle = this.vehicleById.get(input.vehicleId);
      if (!vehicle) return "请选择车辆";
      if (this.pausedVehicleIds.has(vehicle.id)) return `车辆 ${vehicle.plate} 存在未解决冲突，已暂停派车`;
      const driver = this.driverById.get(input.driverId);
      if (!driver) return "请选择司机";
      if (!input.cargo.trim()) return "请填写配送任务";
      const start = Date.parse(input.startAt);
      const end = Date.parse(input.endAt);
      if (Number.isNaN(start) || Number.isNaN(end)) return "请选择完整的占用时段";
      if (end <= start) return "结束时间必须晚于开始时间";
      const draft = { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
      const vehicleClash = this.tasks.find(
        (t) => t.vehicleId === vehicle.id && t.status === "active" && intervalsOverlap(t, draft)
      );
      if (vehicleClash)
        return `车辆 ${vehicle.plate} 在该时段已有有效任务（版本 ${versionText(vehicleClash.version)}），同一车辆重叠时段只能保留一个任务`;
      const driverClash = this.tasks.find(
        (t) => t.driverId === driver.id && t.status === "active" && intervalsOverlap(t, draft)
      );
      if (driverClash) return `司机 ${driver.name} 在相同时段已有任务，司机不能重复分配`;

      const now = new Date().toISOString();
      const task: DispatchTask = {
        id: crypto.randomUUID(),
        vehicleId: vehicle.id,
        driverId: driver.id,
        zone: input.zone.trim() || vehicle.zone,
        cargo: input.cargo.trim(),
        startAt: draft.startAt,
        endAt: draft.endAt,
        version: { lamport: this.tick(), siteId: this.siteId },
        status: "active",
        notes: input.notes.trim(),
        origin: "local",
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.unshift(task);
      this.afterLocalChange([task]);
      return null;
    },
    setTaskStatus(id: string, status: "completed" | "cancelled") {
      const task = this.tasks.find((t) => t.id === id);
      if (!task || task.status !== "active") return;
      task.status = status;
      task.updatedAt = new Date().toISOString();
      task.version = { lamport: this.tick(), siteId: this.siteId };
      this.afterLocalChange([task]);
    },
    completeTask(id: string) {
      this.setTaskStatus(id, "completed");
    },
    cancelTask(id: string) {
      this.setTaskStatus(id, "cancelled");
    },
    afterLocalChange(changed: DispatchTask[]) {
      if (this.online) {
        upsertRemote(kv, changed);
        this.syncNow();
      } else {
        const now = new Date().toISOString();
        for (const task of changed) this.outbox.push({ task: { ...task }, enqueuedAt: now });
        this.persist();
      }
    },
    // 同步：推送离线队列 → 拉取远端合并（LWW）→ 冲突检测 → 回写远端收敛
    syncNow() {
      if (!this.online) return;
      if (this.outbox.length > 0) {
        upsertRemote(
          kv,
          this.outbox.map((e) => e.task)
        );
        this.outbox = [];
      }
      const remote = loadRemote(kv);
      const merged = mergeTasks(this.tasks, remote.tasks);
      this.tasks = merged.tasks;
      this.clock = Math.max(this.clock, 0, ...this.tasks.map((t) => t.version.lamport));
      const detected = detectConflicts(this.tasks, this.conflicts, new Date().toISOString());
      this.tasks = detected.tasks;
      this.conflicts = detected.conflicts;
      if (detected.added.length > 0) {
        this.pushNotice(`合并时发现 ${detected.added.length} 条新冲突：已保留先确认的一版，其余进入冲突区`);
      }
      upsertRemote(kv, this.tasks);
      this.lastSyncAt = new Date().toISOString();
      this.persist();
    },
    // 冲突解决：保留所选版本，其余取消；车辆在无未解决冲突后自动恢复派车
    resolveConflict(conflictId: string, keepTaskId: string) {
      const conflict = this.conflicts.find((c) => c.id === conflictId && !c.resolvedAt);
      if (!conflict) return;
      const now = new Date().toISOString();
      const changed: DispatchTask[] = [];
      for (const taskId of conflict.taskIds) {
        const task = this.tasks.find((t) => t.id === taskId);
        if (!task) continue;
        task.status = taskId === keepTaskId ? "active" : "cancelled";
        task.updatedAt = now;
        task.version = { lamport: this.tick(), siteId: this.siteId };
        changed.push(task);
      }
      conflict.resolvedAt = now;
      conflict.keepTaskId = keepTaskId;
      const detected = detectConflicts(this.tasks, this.conflicts, now);
      this.tasks = detected.tasks;
      this.conflicts = detected.conflicts;
      this.afterLocalChange(changed);
      this.pushNotice("冲突已解决：保留所选版本，其余版本已取消");
    },
    // 演练用：模拟另一调度员把任务直接提交到服务端台账
    peerDispatch(input: RegisterInput) {
      const vehicle = this.vehicleById.get(input.vehicleId);
      const driver = this.driverById.get(input.driverId);
      if (!vehicle || !driver) return;
      const now = new Date().toISOString();
      const task: DispatchTask = {
        id: crypto.randomUUID(),
        vehicleId: vehicle.id,
        driverId: driver.id,
        zone: input.zone.trim() || vehicle.zone,
        cargo: input.cargo.trim() || "对端临时任务",
        startAt: input.startAt,
        endAt: input.endAt,
        version: { lamport: Date.now(), siteId: PEER_SITE_ID },
        status: "active",
        notes: "另一调度员提交",
        origin: "remote",
        createdAt: now,
        updatedAt: now,
      };
      const remote = loadRemote(kv);
      saveRemote(kv, { tasks: [...remote.tasks, task], updatedAt: now });
      if (this.online) this.syncNow();
    },
    toggleOnline() {
      this.online = !this.online;
      if (this.online) {
        this.pushNotice("网络已恢复，开始合并离线期间的登记");
        this.syncNow();
      } else {
        this.pushNotice("已切换到离线：派车登记照常进行，恢复后自动合并");
      }
    },
    resetAll() {
      kv.removeItem(KEYS.state);
      kv.removeItem(KEYS.remote);
      kv.removeItem(KEYS.snapshot);
      kv.removeItem(KEYS.migrationFlag);
      kv.removeItem(KEYS.legacy);
      this.ready = false;
      this.notices = [];
      this.lastSyncAt = null;
      this.init();
      this.pushNotice("已重置为演示数据");
    },
  },
});

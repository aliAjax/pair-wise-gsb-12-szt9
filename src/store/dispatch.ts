import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  Conflict,
  Dispatch,
  LocalDB,
  Vehicle
} from "../types";
import {
  detectConflicts,
  fmtRange,
  isActive,
  makeConflict,
  openOccupancyFor,
  overlaps,
  toDatetimeLocal,
  uid,
  validWindow
} from "../lib/core";
import { loadDb, saveDb } from "../lib/storage";
import { resetRemote, simulateRemoteDispatch, syncNow } from "../lib/sync";

export interface DispatchInput {
  vehicleId: string;
  driver: string;
  zone: string;
  task: string;
  startAt: string;
  endAt: string;
  note?: string;
}

export interface SubmitOutcome {
  ok: boolean;
  conflict?: Conflict;
  error?: string;
  dispatch?: Dispatch;
}

function toInputLocal(isoLike: string): string {
  // <input type="datetime-local"> 使用本地时区，无尾缀 Z
  return toDatetimeLocal(isoLike);
}

export const useDispatchStore = defineStore("dispatch", () => {
  const db = ref<LocalDB>(loadDb());
  const online = ref(true);
  const banner = ref<string>("");
  const lastMerge = ref<{ pulled: number; pushed: number; newConflicts: number; at: number } | null>(
    null
  );

  function persist() {
    saveDb(db.value);
  }

  function flash(message: string) {
    banner.value = message;
    window.setTimeout(() => {
      if (banner.value === message) banner.value = "";
    }, 5000);
  }

  // ---------- 派车核心：先到先得的本地判定 ----------

  function buildDispatch(input: DispatchInput, confirmedAt: number, seq: number): Dispatch {
    return {
      id: uid("dp"),
      version: 1,
      vehicleId: input.vehicleId,
      driver: input.driver.trim(),
      zone: input.zone,
      task: input.task.trim(),
      note: input.note?.trim() || undefined,
      status: "confirmed",
      startAt: new Date(input.startAt).toISOString(),
      endAt: new Date(input.endAt).toISOString(),
      confirmedAt,
      seq,
      origin: "local",
      createdAt: new Date().toISOString(),
      synced: online.value
    };
  }

  /**
   * 派车登记。同一车辆/司机重叠时段：
   * - 本笔后确认 → 直接拒绝并进入冲突区，车辆与司机均不被占用
   * - 本笔先确认 → 登记成功（同时提交的另一笔会在其自身提交时落败）
   * 车辆存在未解决冲突时暂停派车。
   */
  function submitDispatch(input: DispatchInput, confirmedAt = Date.now()): SubmitOutcome {
    if (pausedVehicleIds.value.has(input.vehicleId)) {
      return {
        ok: false,
        error: "该车辆存在未解决冲突，已暂停派车，请先在冲突区处理"
      };
    }
    if (!input.vehicleId || !input.driver.trim() || !input.task.trim()) {
      return { ok: false, error: "请完整填写车辆、司机与任务" };
    }
    if (!validWindow({ startAt: input.startAt, endAt: input.endAt })) {
      return { ok: false, error: "占用时段不合法，结束时间必须晚于开始时间" };
    }

    db.value.seq += 1;
    const candidate = buildDispatch(input, confirmedAt, db.value.seq);
    const findings = detectConflicts(db.value, candidate);

    if (findings.vehicleWinner || findings.driverWinner) {
      const conflict = makeConflict(candidate, findings);
      db.value.conflicts.push(conflict);
      persist();
      flash("登记失败：车辆或司机在重叠时段已有先确认任务，本版已转入冲突区");
      return { ok: false, conflict, dispatch: candidate };
    }

    db.value.dispatches.push(candidate);
    db.value.occupancy.push(openOccupancyFor(candidate, new Date().toISOString()));
    const vehicle = db.value.vehicles.find((v) => v.id === input.vehicleId);
    if (vehicle) {
      vehicle.version += 1;
      vehicle.updatedAt = new Date().toISOString();
    }

    // 断网期间照常登记：任务本地有效，推送操作进入发件箱，恢复后合并
    if (!online.value || !candidate.synced) {
      candidate.synced = false;
      db.value.outbox.push({
        id: uid("op"),
        type: "dispatch",
        payload: structuredClone(candidate),
        createdAt: confirmedAt
      });
      flash("当前离线：已本地登记并占用，任务进入发件箱，网络恢复后自动合并");
    }

    persist();
    return { ok: true, dispatch: candidate };
  }

  /**
   * 模拟“两名调度员同时点确认”：两笔同车重叠任务以相同确认时刻提交，
   * seq 小的一版保留为有效任务，另一版进冲突区。
   */
  function submitSimultaneous(first: DispatchInput, second: DispatchInput): void {
    const at = Date.now();
    const a = submitDispatch(first, at);
    const b = submitDispatch(second, at);
    if (a.ok && !b.ok) {
      flash("同时提交：先确认版本已占用车辆，另一版进入冲突区");
    }
  }

  function finishDispatch(id: string) {
    const d = db.value.dispatches.find((x) => x.id === id);
    if (!d || !isActive(d)) return;
    d.status = "finished";
    d.version += 1;
    closeOccupancy(id);
    if (!online.value) {
      db.value.outbox.push({ id: uid("op"), type: "finish", payload: { id }, createdAt: Date.now() });
    }
    persist();
  }

  function cancelDispatch(id: string) {
    const d = db.value.dispatches.find((x) => x.id === id);
    if (!d) return;
    d.status = "cancelled";
    closeOccupancy(id);
    db.value.outbox = db.value.outbox.filter(
      (op) => !op.payload || (op.payload as Dispatch).id !== id
    );
    if (!online.value) {
      db.value.outbox.push({ id: uid("op"), type: "cancel", payload: { id }, createdAt: Date.now() });
    }
    persist();
  }

  function closeOccupancy(dispatchId: string) {
    for (const o of db.value.occupancy) {
      if (o.dispatchId === dispatchId && o.state === "open") {
        o.state = "closed";
        o.closedAt = new Date().toISOString();
      }
    }
  }

  // ---------- 冲突区 ----------

  /** 放弃候选版本，保持先确认版本有效；冲突解决后车辆恢复派车 */
  function resolveDiscard(conflictId: string) {
    const c = db.value.conflicts.find((x) => x.id === conflictId);
    if (!c || c.state === "resolved") return;
    c.state = "resolved";
    c.resolution = "cancelled";
    c.resolvedAt = Date.now();
    persist();
  }

  /**
   * 采用冲突区候选版本：取消当前有效任务（释放车辆/司机占用），
   * 候选转为有效任务并建立占用。
   */
  function resolvePromote(conflictId: string) {
    const c = db.value.conflicts.find((x) => x.id === conflictId);
    if (!c || c.state === "resolved") return;
    const candidate = structuredClone(c.candidate);
    const nowIso = new Date().toISOString();

    const existing = db.value.dispatches.find((x) => x.id === candidate.id);
    if (existing) {
      // 本地败方恢复有效
      existing.status = candidate.status === "cancelled" ? "confirmed" : candidate.status;
      existing.note = [existing.note, "冲突裁决后人工采用本版"].filter(Boolean).join("；");
      if (!db.value.occupancy.some((o) => o.dispatchId === existing.id && o.state === "open")) {
        db.value.occupancy.push(openOccupancyFor(existing, nowIso));
      }
    } else {
      candidate.origin = "local";
      candidate.synced = online.value;
      db.value.dispatches.push(candidate);
      db.value.occupancy.push(openOccupancyFor(candidate, nowIso));
      if (!online.value) {
        db.value.outbox.push({
          id: uid("op"),
          type: "dispatch",
          payload: structuredClone(candidate),
          createdAt: Date.now()
        });
      }
    }

    // 释放与候选同车或同司机、时段重叠的有效任务
    for (const d of db.value.dispatches) {
      if (d.id === candidate.id || !isActive(d)) continue;
      const sameVehicle = d.vehicleId === candidate.vehicleId;
      const sameDriver = d.driver.trim() !== "" && d.driver === candidate.driver;
      if (
        (sameVehicle || sameDriver) &&
        overlaps(d, candidate)
      ) {
        d.status = "cancelled";
        d.note = [d.note, "冲突裁决：人工采用了另一版，本版取消"].filter(Boolean).join("；");
        closeOccupancy(d.id);
      }
    }

    const vehicle = db.value.vehicles.find((v) => v.id === candidate.vehicleId);
    if (vehicle) vehicle.version += 1;

    c.state = "resolved";
    c.resolution = "promoted";
    c.resolvedAt = Date.now();
    persist();
  }

  // ---------- 断网 / 恢复 ----------

  function setOnline(value: boolean) {
    online.value = value;
    if (value) {
      merge();
    }
  }

  function merge() {
    const result = syncNow(db.value);
    lastMerge.value = { ...result, at: Date.now() };
    if (result.pulled || result.pushed) {
      flash(
        `合并完成：推送 ${result.pushed} 笔、拉取 ${result.pulled} 笔` +
          (result.newConflicts ? `，新增 ${result.newConflicts} 个冲突待处理` : "")
      );
    } else if (result.newConflicts) {
      flash(`合并完成：发现 ${result.newConflicts} 个冲突，相关车辆已暂停派车`);
    }
    persist();
  }

  /** 演练：另一名调度员在远端派了同一辆车（若本机离线，恢复后才合并） */
  function remoteDispatch(input: Parameters<typeof simulateRemoteDispatch>[0]) {
    simulateRemoteDispatch(input);
    if (online.value) {
      merge();
    } else {
      flash("远端已有派车变更，当前离线，恢复网络后将拉取合并");
    }
  }

  // ---------- 车辆 ----------

  function addVehicle(input: { plate: string; driver: string; zone: string; note?: string }) {
    if (!input.plate.trim()) return { ok: false, error: "车牌号必填" };
    if (db.value.vehicles.some((v) => v.plate === input.plate.trim())) {
      return { ok: false, error: "车牌号已存在" };
    }
    db.value.vehicles.push({
      id: uid("veh"),
      plate: input.plate.trim(),
      driver: input.driver.trim(),
      zone: input.zone,
      note: input.note?.trim(),
      version: 1,
      updatedAt: new Date().toISOString()
    });
    persist();
    return { ok: true };
  }

  function reloadAfterMigration() {
    db.value = loadDb();
  }

  function resetDemo() {
    localStorage.removeItem("dfwlfront-3-dispatch-db");
    localStorage.removeItem("dfwlfront-3-dispatch-db.tmp");
    resetRemote();
    db.value = loadDb();
    online.value = true;
  }

  // ---------- 派生视图 ----------

  const pendingConflicts = computed(() =>
    db.value.conflicts.filter((c) => c.state === "pending")
  );

  /** 有未解决冲突的车辆集合 → 车辆卡片标记 + 暂停派车 */
  const pausedVehicleIds = computed(() => {
    const ids = new Set<string>();
    for (const c of pendingConflicts.value) {
      ids.add(c.candidate.vehicleId);
      const winner = db.value.dispatches.find((d) => d.id === c.winnerDispatchId);
      if (winner) ids.add(winner.vehicleId);
    }
    return ids;
  });

  function vehicleCard(vehicleId: string) {
    const activeDispatches = db.value.dispatches.filter(
      (d) => d.vehicleId === vehicleId && isActive(d)
    );
    const openEntries = db.value.occupancy.filter(
      (o) => o.vehicleId === vehicleId && o.state === "open"
    );
    const hasConflict = pausedVehicleIds.value.has(vehicleId);
    return {
      activeDispatches,
      openEntries,
      hasConflict,
      occupied: openEntries.length > 0,
      pendingOutbox: db.value.outbox.filter(
        (op) => (op.payload as Dispatch)?.vehicleId === vehicleId
      ).length
    };
  }

  // ---------- 派生视图 ----------

  const metrics = computed(() => ({
    total: db.value.vehicles.length,
    occupied: db.value.vehicles.filter((v) => vehicleCard(v.id).occupied).length,
    idle: db.value.vehicles.filter((v) => !vehicleCard(v.id).occupied).length,
    conflicts: pendingConflicts.value.length,
    outbox: db.value.outbox.length
  }));

  const defaultWindow = computed(() => {
    const start = Date.now();
    return {
      start: toInputLocal(new Date(start).toISOString()),
      end: toInputLocal(new Date(start + 2 * 3600_000).toISOString())
    };
  });

  return {
    db,
    online,
    banner,
    lastMerge,
    // actions
    submitDispatch,
    submitSimultaneous,
    finishDispatch,
    cancelDispatch,
    resolveDiscard,
    resolvePromote,
    setOnline,
    merge,
    remoteDispatch,
    addVehicle,
    reloadAfterMigration,
    resetDemo,
    vehicleCard,
    // views
    pendingConflicts,
    pausedVehicleIds,
    metrics,
    defaultWindow,
    fmtRange
  };
});

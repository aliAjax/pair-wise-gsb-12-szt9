<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { useDispatchStore, type DispatchInput } from "./store/dispatch";
import { isActive, overlaps, toDatetimeLocal, validWindow } from "./lib/core";
import { stageInterruptedMigration, stageLegacyData } from "./lib/storage";

const store = useDispatchStore();
const { db } = storeToRefs(store);

type TabKey = "vehicles" | "dispatches" | "occupancy" | "conflicts";
const tab = ref<TabKey>("vehicles");

const ZONES = ["城北", "城东", "城南"];
const tabs: { key: TabKey; label: string }[] = [
  { key: "vehicles", label: "车辆清单" },
  { key: "dispatches", label: "派车登记" },
  { key: "occupancy", label: "占用台账" },
  { key: "conflicts", label: "冲突区" }
];

// ---------- 派车表单 ----------

const form = reactive({
  vehicleId: "",
  driver: "",
  zone: ZONES[0],
  task: "",
  startAt: store.defaultWindow.start,
  endAt: store.defaultWindow.end,
  note: ""
});
const formError = ref("");

const selectedVehicle = computed(() =>
  db.value.vehicles.find((v) => v.id === form.vehicleId)
);

/** 表单实时预检：用于在提交前提示重叠，但裁决仍以提交时 confirmedAt 为准 */
const preflight = computed(() => {
  const vehicleConflicts = db.value.dispatches.filter(
    (d) =>
      isActive(d) &&
      form.vehicleId &&
      d.vehicleId === form.vehicleId &&
      overlaps(
        { startAt: iso(form.startAt), endAt: iso(form.endAt) },
        { startAt: d.startAt, endAt: d.endAt }
      )
  );
  const driverConflicts = db.value.dispatches.filter(
    (d) =>
      isActive(d) &&
      form.driver.trim() &&
      d.driver === form.driver.trim() &&
      overlaps(
        { startAt: iso(form.startAt), endAt: iso(form.endAt) },
        { startAt: d.startAt, endAt: d.endAt }
      )
  );
  return { vehicleConflicts, driverConflicts };
});

const selectedPaused = computed(
  () => !!form.vehicleId && store.pausedVehicleIds.has(form.vehicleId)
);

function iso(local: string): string {
  return new Date(local).toISOString();
}

function syncDriver() {
  if (selectedVehicle.value) form.driver = selectedVehicle.value.driver;
}

function buildInput(): DispatchInput {
  return {
    vehicleId: form.vehicleId,
    driver: form.driver,
    zone: form.zone,
    task: form.task,
    startAt: form.startAt,
    endAt: form.endAt,
    note: form.note
  };
}

function resetForm() {
  form.vehicleId = "";
  form.driver = "";
  form.zone = ZONES[0];
  form.task = "";
  form.note = "";
  form.startAt = store.defaultWindow.start;
  form.endAt = store.defaultWindow.end;
  formError.value = "";
}

function submit() {
  formError.value = "";
  if (!validWindow({ startAt: iso(form.startAt), endAt: iso(form.endAt) })) {
    formError.value = "占用时段不合法：结束时间必须晚于开始时间";
    return;
  }
  const outcome = store.submitDispatch(buildInput());
  if (!outcome.ok) {
    formError.value = outcome.error ?? "该时段已被先确认任务占用，本版已进入冲突区";
    if (outcome.conflict) tab.value = "conflicts";
    return;
  }
  resetForm();
}

// ---------- 同时派车 / 远端派车 演练 ----------

function demoSimultaneous() {
  const v = db.value.vehicles[0];
  if (!v) return;
  const start = toDatetimeLocal(new Date());
  const base: DispatchInput = {
    vehicleId: v.id,
    driver: v.driver || "调度员A的司机",
    zone: v.zone || ZONES[0],
    task: "",
    startAt: start,
    endAt: toDatetimeLocal(Date.now() + 90 * 60_000)
  };
  const other = db.value.vehicles.find((x) => x.id !== v.id) ?? v;
  store.submitSimultaneous(
    { ...base, task: "调度员A：商超补货", driver: "董飞" },
    {
      ...base,
      task: "调度员B：同车加急件",
      driver: other.driver || "周航",
      zone: ZONES[1]
    }
  );
  tab.value = "conflicts";
}

function demoRemoteSameVehicle() {
  const v = db.value.vehicles[0];
  if (!v) return;
  store.remoteDispatch({
    vehicleId: v.id,
    driver: form.driver.trim() || "远端司机·赵强",
    zone: ZONES[2],
    task: store.online ? "另一调度员同车派单（实时合并）" : "另一调度员同车派单（离线等待合并）",
    startAt: new Date().toISOString(),
    endAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    confirmedAt: Date.now() - 1000
  });
}

// ---------- 新增车辆 ----------

const showAddVehicle = ref(false);
const newVehicle = reactive({ plate: "", driver: "", zone: ZONES[0], note: "" });
const addVehicleError = ref("");

function addVehicle() {
  addVehicleError.value = "";
  const r = store.addVehicle({ ...newVehicle });
  if (!r.ok) {
    addVehicleError.value = r.error ?? "新增失败";
    return;
  }
  newVehicle.plate = "";
  newVehicle.driver = "";
  newVehicle.note = "";
  showAddVehicle.value = false;
}

// ---------- 迁移演练 ----------

function runMigrationStage(stage: "legacy" | "interrupted") {
  if (stage === "legacy") stageLegacyData();
  else stageInterruptedMigration();
  store.reloadAfterMigration();
  tab.value = "vehicles";
}

// ---------- 展示辅助 ----------

const dispatchesSorted = computed(() =>
  [...db.value.dispatches].sort((a, b) => b.confirmedAt - a.confirmedAt)
);

const occupancySorted = computed(() =>
  [...db.value.occupancy].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))
);

function vehicleOf(id: string) {
  return db.value.vehicles.find((v) => v.id === id);
}
function plateOf(id: string) {
  return vehicleOf(id)?.plate ?? id;
}
function statusLabel(s: string) {
  return { confirmed: "待派出", executing: "执行中", finished: "已完成", cancelled: "已取消" }[
    s as "confirmed"
  ] ?? s;
}
function fmt(t: string) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function conflictWinner(id: string) {
  return db.value.dispatches.find((d) => d.id === id);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">物流 · 本地优先调度闭环</p>
          <h1>车辆调度小工具</h1>
          <p class="subtitle">
            车辆清单 / 派车登记 / 占用台账 本地优先：同一车辆重叠时段仅一个有效任务，
            先确认者保留，后确认者进冲突区；断网照常登记，恢复后合并。
          </p>
        </div>
        <div class="conn" :class="store.online ? 'online' : 'offline'">
          <span class="dot" />
          {{ store.online ? "在线" : "断网（本地登记中）" }}
          <label class="switch">
            <input type="checkbox" :checked="store.online" @change="store.setOnline(!store.online)" />
            切网
          </label>
        </div>
      </header>

      <p v-if="store.banner" class="banner">{{ store.banner }}</p>

      <section class="metrics">
        <article class="metric"><span>车辆总数</span><strong>{{ store.metrics.total }}</strong></article>
        <article class="metric"><span>占用中</span><strong>{{ store.metrics.occupied }}</strong></article>
        <article class="metric"><span>空闲车辆</span><strong>{{ store.metrics.idle }}</strong></article>
        <article class="metric" :class="{ alert: store.metrics.conflicts > 0 }">
          <span>待处理冲突（暂停派车）</span><strong>{{ store.metrics.conflicts }}</strong>
        </article>
        <article class="metric" :class="{ alert: store.metrics.outbox > 0 }">
          <span>发件箱待合并</span><strong>{{ store.metrics.outbox }}</strong>
        </article>
      </section>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <em v-if="t.key === 'conflicts' && store.pendingConflicts.length" class="badge">
            {{ store.pendingConflicts.length }}
          </em>
        </button>
      </nav>

      <!-- 车辆清单 + 派车表单 -->
      <section v-if="tab === 'vehicles'" class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>派车登记</h2>
          <div class="form-grid">
            <label>
              车牌号
              <select v-model="form.vehicleId" required @change="syncDriver">
                <option value="">请选择车辆</option>
                <option v-for="v in db.vehicles" :key="v.id" :value="v.id">
                  {{ v.plate }}（{{ v.zone }}）· v{{ v.version }}
                </option>
              </select>
            </label>
            <p v-if="selectedPaused" class="field-warn">
              该车辆存在未解决冲突，已暂停派车
            </p>
            <label>
              司机
              <input v-model="form.driver" placeholder="司机姓名" required />
            </label>
            <p v-if="preflight.driverConflicts.length" class="field-warn">
              该司机在所选时段已有 {{ preflight.driverConflicts.length }} 个有效任务，不能重复分配
            </p>
            <label>
              配送区域
              <select v-model="form.zone">
                <option v-for="z in ZONES" :key="z" :value="z">{{ z }}</option>
              </select>
            </label>
            <label>
              配送任务
              <input v-model="form.task" placeholder="如：商超补货" required />
            </label>
            <div class="two-col">
              <label>
                占用开始
                <input v-model="form.startAt" type="datetime-local" required />
              </label>
              <label>
                占用结束
                <input v-model="form.endAt" type="datetime-local" required />
              </label>
            </div>
            <p v-if="preflight.vehicleConflicts.length" class="field-warn">
              车辆在该时段已被 {{ preflight.vehicleConflicts.length }}
              个先确认任务占用，提交后本版将进入冲突区
            </p>
            <label>
              备注
              <textarea v-model="form.note" placeholder="现场说明（可选）" />
            </label>
            <p v-if="formError" class="field-warn strong">{{ formError }}</p>
            <button type="submit" :disabled="selectedPaused">确认派车</button>
            <p class="hint">
              裁决规则：同时提交时 confirmedAt（确认时刻）更小者保留，相同则按序号；
              败方不占用车辆/司机，直接进入冲突区。
            </p>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>车辆清单</h2>
            <div class="toolbar-actions">
              <button type="button" class="secondary" @click="demoSimultaneous">
                演练：两人同时派车
              </button>
              <button type="button" class="secondary" @click="demoRemoteSameVehicle">
                演练：另一调度员派同车
              </button>
              <button type="button" class="secondary" @click="showAddVehicle = !showAddVehicle">
                新增车辆
              </button>
            </div>
          </div>

          <form v-if="showAddVehicle" class="inline-form" @submit.prevent="addVehicle">
            <input v-model="newVehicle.plate" placeholder="车牌号" required />
            <input v-model="newVehicle.driver" placeholder="默认司机" />
            <select v-model="newVehicle.zone">
              <option v-for="z in ZONES" :key="z" :value="z">{{ z }}</option>
            </select>
            <input v-model="newVehicle.note" placeholder="备注（可选）" />
            <button type="submit">保存车辆</button>
            <p v-if="addVehicleError" class="field-warn">{{ addVehicleError }}</p>
          </form>

          <div class="record-grid">
            <article
              v-for="v in db.vehicles"
              :key="v.id"
              class="record vehicle-card"
              :class="{ conflicted: store.vehicleCard(v.id).hasConflict }"
            >
              <div class="record-head">
                <p class="record-title">{{ v.plate }}</p>
                <span
                  class="status"
                  :class="store.vehicleCard(v.id).occupied ? 'busy' : 'free'"
                >
                  {{ store.vehicleCard(v.id).occupied ? "占用中" : "空闲" }}
                </span>
              </div>
              <div class="details">
                <span>默认司机：{{ v.driver || "—" }}</span>
                <span>区域：{{ v.zone }}</span>
                <span>数据版本：v{{ v.version }}</span>
                <span v-if="store.vehicleCard(v.id).pendingOutbox">
                  离线待合并：{{ store.vehicleCard(v.id).pendingOutbox }}
                </span>
              </div>
              <div
                v-if="store.vehicleCard(v.id).openEntries.length"
                class="occ-line"
              >
                <span v-for="o in store.vehicleCard(v.id).openEntries" :key="o.id">
                  {{ o.task }} · {{ o.driver }} · {{ store.fmtRange(o) }}
                </span>
              </div>
              <div v-if="store.vehicleCard(v.id).hasConflict" class="conflict-flag">
                ⚠ 存在未解决冲突 · 已暂停派车
                <button type="button" class="link" @click="tab = 'conflicts'">前往处理</button>
              </div>
              <p v-if="v.note" class="note">{{ v.note }}</p>
            </article>
          </div>

          <section v-if="db.lastMigration" class="migration-note">
            <strong>数据迁移：</strong>
            旧数据缺少任务版本/占用时段，已先补齐再参与判断
            （v{{ db.lastMigration.fromVersion }} → v{{ db.lastMigration.toVersion }}，
            {{ db.lastMigration.status === "interrupted-recovered" ? "迁移中断后已从快照恢复" : "迁移完成" }}，
            时间：{{ fmt(db.lastMigration.migratedAt) }}）
            <button type="button" class="link" @click="runMigrationStage('legacy')">
              演练：载入旧版数据触发补齐迁移
            </button>
            <button type="button" class="link" @click="runMigrationStage('interrupted')">
              演练：迁移中断 → 快照恢复
            </button>
            <button type="button" class="link danger-link" @click="store.resetDemo()">
              重置演示数据
            </button>
          </section>
        </section>
      </section>

      <!-- 派车登记列表 -->
      <section v-else-if="tab === 'dispatches'" class="list-panel standalone">
        <h2>派车登记</h2>
        <div class="table-wrap">
          <table class="grid-table">
            <thead>
              <tr>
                <th>任务 / 版本</th><th>车辆</th><th>司机</th><th>区域</th>
                <th>占用时段</th><th>确认时刻</th><th>来源 / 同步</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in dispatchesSorted" :key="d.id">
                <td>{{ d.task }} <em class="ver">v{{ d.version }}</em></td>
                <td>{{ plateOf(d.vehicleId) }}</td>
                <td>{{ d.driver }}</td>
                <td>{{ d.zone }}</td>
                <td>{{ store.fmtRange(d) }}</td>
                <td>{{ fmt(new Date(d.confirmedAt).toISOString()) }} #{{ d.seq }}</td>
                <td>
                  {{ d.origin === "local" ? "本地" : "远端合并" }} ·
                  {{ d.synced ? "已同步" : "待合并" }}
                </td>
                <td><span class="status" :class="d.status">{{ statusLabel(d.status) }}</span></td>
                <td>
                  <button
                    v-if="d.status === 'confirmed'"
                    type="button"
                    class="mini"
                    @click="store.finishDispatch(d.id)"
                  >开始执行</button>
                  <button
                    v-if="d.status === 'executing'"
                    type="button"
                    class="mini"
                    @click="store.finishDispatch(d.id)"
                  >完成</button>
                  <button
                    v-if="isActive(d)"
                    type="button"
                    class="mini danger"
                    @click="store.cancelDispatch(d.id)"
                  >取消</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 占用台账 -->
      <section v-else-if="tab === 'occupancy'" class="list-panel standalone">
        <h2>占用台账</h2>
        <p class="hint">每条有效派车任务对应一条占用；任务完成/取消即关闭，释放车辆与司机。</p>
        <div class="table-wrap">
          <table class="grid-table">
            <thead>
              <tr><th>状态</th><th>车辆</th><th>司机</th><th>任务</th><th>占用时段</th><th>开启 / 关闭</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in occupancySorted" :key="o.id" :class="{ closed: o.state === 'closed' }">
                <td>
                  <span class="status" :class="o.state === 'open' ? 'busy' : 'free'">
                    {{ o.state === "open" ? "占用中" : "已释放" }}
                  </span>
                </td>
                <td>{{ plateOf(o.vehicleId) }}</td>
                <td>{{ o.driver }}</td>
                <td>{{ o.task }}</td>
                <td>{{ store.fmtRange(o) }}</td>
                <td>
                  {{ fmt(o.openedAt) }}
                  <template v-if="o.closedAt"> → {{ fmt(o.closedAt) }}</template>
                </td>
              </tr>
              <tr v-if="!occupancySorted.length"><td colspan="6" class="empty-cell">暂无占用记录</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 冲突区 -->
      <section v-else class="list-panel standalone">
        <h2>冲突区</h2>
        <p class="hint">
          败方任务保留在此不参与占用。可放弃候选（维持先确认版本），
          或人工采用候选（自动释放对方占用）。相关车辆在冲突解决前暂停派车。
        </p>
        <div v-if="!store.pendingConflicts.length && !db.conflicts.length" class="empty">
          当前没有冲突
        </div>
        <div class="conflict-list">
          <article
            v-for="c in [...db.conflicts].reverse()"
            :key="c.id"
            class="record conflict-card"
            :class="{ resolved: c.state === 'resolved' }"
          >
            <div class="record-head">
              <p class="record-title">候选任务：{{ c.candidate.task }}</p>
              <span class="status" :class="c.state === 'pending' ? 'busy' : 'free'">
                {{ c.state === "pending" ? "待处理" : `已处理（${c.resolution === "promoted" ? "采用候选" : "放弃候选"}）` }}
              </span>
            </div>
            <div class="details">
              <span>候选车辆：{{ plateOf(c.candidate.vehicleId) }}</span>
              <span>候选司机：{{ c.candidate.driver }}</span>
              <span>候选时段：{{ store.fmtRange(c.candidate) }}</span>
              <span>候选确认：{{ fmt(new Date(c.candidate.confirmedAt).toISOString()) }} #{{ c.candidate.seq }}</span>
            </div>
            <ul class="reasons">
              <li v-for="(r, i) in c.reasons" :key="i">{{ r.message }}</li>
            </ul>
            <div v-if="conflictWinner(c.winnerDispatchId)" class="winner">
              保留版本：{{ conflictWinner(c.winnerDispatchId)?.task }} /
              {{ plateOf(conflictWinner(c.winnerDispatchId)?.vehicleId ?? "") }} ·
              {{ store.fmtRange(conflictWinner(c.winnerDispatchId)!) }}
            </div>
            <div v-if="c.state === 'pending'" class="actions">
              <button type="button" @click="store.resolvePromote(c.id)">采用候选（释放对方）</button>
              <button type="button" class="secondary" @click="store.resolveDiscard(c.id)">
                放弃候选（维持先确认版）
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useDispatchStore } from "../stores/dispatch";
import { fmtRange, fmtTime } from "../lib/format";
import { versionText } from "../lib/version";
import type { Conflict } from "../types";

const store = useDispatchStore();
const unresolved = computed(() => store.unresolvedConflicts);
const resolved = computed(() => store.resolvedConflicts.slice(0, 3));

const taskOf = (id: string) => store.tasks.find((t) => t.id === id);
const plateOf = (id: string | null) => (id ? store.vehicleById.get(id)?.plate ?? "?" : "—");
const driverOf = (id: string | null) => (id ? store.driverById.get(id)?.name ?? "?" : "—");
const kindText = (kind: Conflict["kind"]) => (kind === "vehicle-overlap" ? "同一车辆时段重叠" : "同一司机重复分配");
const subjectOf = (c: Conflict) => (c.kind === "vehicle-overlap" ? `车辆 ${plateOf(c.vehicleId)}` : `司机 ${driverOf(c.driverId)}`);
const statusText: Record<string, string> = { active: "有效", conflicted: "冲突", cancelled: "已取消", completed: "已完成" };
const originText: Record<string, string> = { local: "本地", remote: "对端", migration: "迁移" };
</script>

<template>
  <section v-if="unresolved.length > 0" class="list-panel conflict-zone">
    <div class="toolbar">
      <h2>冲突区（{{ unresolved.length }}）</h2>
      <span class="hint">先确认的一版已自动保留，可改留其他版本</span>
    </div>
    <div class="record-grid">
      <article v-for="c in unresolved" :key="c.id" class="record conflict">
        <div class="record-head">
          <p class="record-title">{{ kindText(c.kind) }} · {{ subjectOf(c) }}</p>
          <span class="status st-conflict">待解决</span>
        </div>
        <p class="hint">检测于 {{ fmtTime(c.detectedAt) }}</p>
        <div v-for="tid in c.taskIds" :key="tid" class="conflict-task">
          <template v-if="taskOf(tid)">
            <div class="conflict-task-info">
              <strong>{{ taskOf(tid).cargo || "（未命名任务）" }}</strong>
              <span>{{ plateOf(taskOf(tid).vehicleId) }} / {{ driverOf(taskOf(tid).driverId) }}</span>
              <span>{{ fmtRange(taskOf(tid).startAt, taskOf(tid).endAt) }}</span>
              <span>版本 {{ versionText(taskOf(tid).version) }} · {{ originText[taskOf(tid).origin] }} · {{ statusText[taskOf(tid).status] }}</span>
            </div>
            <div class="conflict-task-side">
              <span v-if="tid === c.winnerId" class="status st-winner">当前保留</span>
              <button type="button" @click="store.resolveConflict(c.id, tid)">保留这一版</button>
            </div>
          </template>
        </div>
      </article>
    </div>
  </section>
  <section v-else-if="resolved.length > 0" class="list-panel">
    <div class="toolbar">
      <h2>冲突区</h2>
      <span class="hint">暂无未解决冲突</span>
    </div>
    <details class="resolved-history">
      <summary>最近已解决（{{ resolved.length }}）</summary>
      <p v-for="c in resolved" :key="c.id" class="resolved-item">
        {{ kindText(c.kind) }} · {{ subjectOf(c) }} · 保留版本
        {{ c.keepTaskId && taskOf(c.keepTaskId) ? versionText(taskOf(c.keepTaskId).version) : "?" }} · 解决于
        {{ c.resolvedAt ? fmtTime(c.resolvedAt) : "" }}
      </p>
    </details>
  </section>
</template>

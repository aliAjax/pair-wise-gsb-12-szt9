<script setup lang="ts">
import { computed, ref } from "vue";
import { useDispatchStore } from "../stores/dispatch";
import { fmtRange } from "../lib/format";
import { versionText } from "../lib/version";

const store = useDispatchStore();
const filter = ref("全部");
const options = ["全部", "有效", "冲突", "已取消", "已完成"];
const statusText: Record<string, string> = { active: "有效", conflicted: "冲突", cancelled: "已取消", completed: "已完成" };
const originText: Record<string, string> = { local: "本地", remote: "对端", migration: "迁移" };
const rows = computed(() => store.ledger.filter((t) => filter.value === "全部" || statusText[t.status] === filter.value));
const plateOf = (id: string) => store.vehicleById.get(id)?.plate ?? "?";
const driverOf = (id: string) => store.driverById.get(id)?.name ?? "?";
const rowClass = (status: string) =>
  ({ active: "st-active", conflicted: "st-conflict", cancelled: "st-cancelled", completed: "st-completed" })[status] ?? "";
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>占用台账</h2>
      <select v-model="filter">
        <option v-for="o in options" :key="o">{{ o }}</option>
      </select>
    </div>
    <div class="ledger-wrap">
      <table class="ledger">
        <thead>
          <tr>
            <th>车辆</th>
            <th>司机</th>
            <th>任务</th>
            <th>占用时段</th>
            <th>版本</th>
            <th>状态</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in rows" :key="t.id">
            <td>{{ plateOf(t.vehicleId) }}</td>
            <td>{{ driverOf(t.driverId) }}</td>
            <td>{{ t.cargo || "—" }}</td>
            <td>{{ fmtRange(t.startAt, t.endAt) }}</td>
            <td class="mono">{{ versionText(t.version) }}</td>
            <td><span class="status" :class="rowClass(t.status)">{{ statusText[t.status] }}</span></td>
            <td>{{ originText[t.origin] }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="7" class="empty">暂无台账记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

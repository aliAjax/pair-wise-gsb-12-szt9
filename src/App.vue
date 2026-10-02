<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useDispatchStore } from "./stores/dispatch";
import DispatchForm from "./components/DispatchForm.vue";
import VehicleList from "./components/VehicleList.vue";
import ConflictZone from "./components/ConflictZone.vue";
import LedgerTable from "./components/LedgerTable.vue";
import { fmtTime } from "./lib/format";

const store = useDispatchStore();
onMounted(() => store.init());

const metrics = computed(() => [
  { label: "车辆总数", value: store.vehicles.length },
  { label: "执行中任务", value: store.tasks.filter((t) => t.status === "active").length },
  { label: "待同步", value: store.outbox.length },
  { label: "未解决冲突", value: store.unresolvedConflicts.length },
]);

function resetAll() {
  if (window.confirm("确定清空本地与服务端台账并恢复演示数据？")) store.resetAll();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">物流行业 · 本地优先调度</p>
          <h1>车辆调度小工具</h1>
          <p class="subtitle">
            车辆清单、派车登记、占用台账接成本地优先流程：断网照常登记，恢复后自动合并；同一车辆重叠时段只保留先确认的一版，其余进入冲突区。
          </p>
        </div>
        <div class="side">
          <div class="net-row">
            <span class="net-badge" :class="store.online ? 'on' : 'off'">{{ store.online ? "● 在线" : "● 离线" }}</span>
            <span class="tag">站点 {{ store.siteId || "…" }}</span>
            <span class="tag">schema v2</span>
          </div>
          <div class="net-row">
            <button type="button" class="secondary" @click="store.toggleOnline()">
              {{ store.online ? "模拟断网" : "恢复网络" }}
            </button>
            <button type="button" :disabled="!store.online" @click="store.syncNow()">
              立即同步{{ store.outbox.length ? `（${store.outbox.length}）` : "" }}
            </button>
            <button type="button" class="danger" @click="resetAll">重置演示数据</button>
          </div>
          <p v-if="store.lastSyncAt" class="hint">上次同步 {{ fmtTime(store.lastSyncAt) }}</p>
        </div>
      </header>

      <div v-if="store.notices.length" class="notices">
        <p v-for="(n, i) in store.notices" :key="i" class="notice">
          {{ n }}
          <button type="button" class="notice-x" @click="store.dismissNotice(i)">×</button>
        </p>
      </div>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="left-col">
          <DispatchForm />
        </div>
        <div class="right-col">
          <ConflictZone />
          <VehicleList />
          <LedgerTable />
        </div>
      </section>
    </div>
  </main>
</template>

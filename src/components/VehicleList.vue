<script setup lang="ts">
import { computed } from "vue";
import { useDispatchStore } from "../stores/dispatch";
import { fmtRange } from "../lib/format";
import { versionText } from "../lib/version";

const store = useDispatchStore();
const cards = computed(() => store.vehicleCards);
const driverName = (id: string): string => store.driverById.get(id)?.name ?? "—";
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>车辆清单</h2>
      <span class="hint">有未解决冲突的车辆暂停派车</span>
    </div>
    <div class="record-grid">
      <div v-if="cards.length === 0" class="empty">暂无车辆</div>
      <article v-for="card in cards" :key="card.vehicle.id" class="record" :class="{ paused: card.paused }">
        <div class="record-head">
          <p class="record-title">
            {{ card.vehicle.plate }} <span class="zone-tag">{{ card.vehicle.zone }}</span>
          </p>
          <span class="status" :class="card.paused ? 'st-paused' : card.current ? 'st-busy' : 'st-idle'">
            {{ card.status }}
          </span>
        </div>
        <p v-if="card.conflictCount > 0" class="conflict-flag">⚠ {{ card.conflictCount }} 条冲突未解决，已暂停派车</p>
        <div class="details">
          <template v-if="card.current">
            <span>当前任务：{{ card.current.cargo }}</span>
            <span>司机：{{ driverName(card.current.driverId) }}</span>
            <span>时段：{{ fmtRange(card.current.startAt, card.current.endAt) }}</span>
            <span>版本：{{ versionText(card.current.version) }}</span>
          </template>
          <span v-else-if="card.upcoming">下一占用：{{ fmtRange(card.upcoming.startAt, card.upcoming.endAt) }}</span>
          <span v-else>当前空闲，可派车</span>
          <span v-if="card.vehicle.notes">备注：{{ card.vehicle.notes }}</span>
        </div>
        <div v-if="card.current" class="actions">
          <button type="button" @click="store.completeTask(card.current.id)">完成任务</button>
          <button type="button" class="secondary" @click="store.cancelTask(card.current.id)">取消任务</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useDispatchStore } from "../stores/dispatch";
import { fromLocalInput, toLocalInput } from "../lib/format";

const store = useDispatchStore();

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d.toISOString());
}

function defaultEnd(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 5);
  return toLocalInput(d.toISOString());
}

const form = reactive({
  vehicleId: "",
  driverId: "",
  zone: "",
  cargo: "",
  startAt: defaultStart(),
  endAt: defaultEnd(),
  notes: "",
});

const error = ref("");
const ok = ref("");
const peerMsg = ref("");

const paused = computed(() => store.pausedVehicleIds);

function onVehicleChange() {
  const vehicle = store.vehicleById.get(form.vehicleId);
  if (vehicle) form.zone = vehicle.zone;
}

function payload() {
  return { ...form, startAt: fromLocalInput(form.startAt), endAt: fromLocalInput(form.endAt) };
}

function submit() {
  error.value = "";
  ok.value = "";
  const err = store.register(payload());
  if (err) {
    error.value = err;
    return;
  }
  ok.value = store.online ? "已登记并同步到服务端台账" : "已离线登记，网络恢复后自动合并";
  form.cargo = "";
  form.notes = "";
}

function simulatePeer() {
  peerMsg.value = "";
  if (!form.vehicleId || !form.driverId) {
    peerMsg.value = "请先选择车辆和司机，再模拟对端提交";
    return;
  }
  store.peerDispatch(payload());
  peerMsg.value = store.online
    ? "对端任务已提交并合并：若时段重叠，先确认的一版保留，另一版已进入冲突区"
    : "对端任务已写入服务端台账，恢复网络后合并";
}
</script>

<template>
  <form class="panel" @submit.prevent="submit">
    <h2>派车登记</h2>
    <div class="form-grid">
      <label>
        车辆
        <select v-model="form.vehicleId" required @change="onVehicleChange">
          <option value="">请选择车辆</option>
          <option v-for="v in store.vehicles" :key="v.id" :value="v.id" :disabled="paused.has(v.id)">
            {{ v.plate }}（{{ v.zone }}）{{ paused.has(v.id) ? "· 暂停派车" : "" }}
          </option>
        </select>
      </label>
      <label>
        司机
        <select v-model="form.driverId" required>
          <option value="">请选择司机</option>
          <option v-for="d in store.drivers" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>
      <label>
        配送区域
        <input v-model="form.zone" placeholder="默认取车辆所属区域" />
      </label>
      <label>
        配送任务
        <input v-model="form.cargo" required placeholder="如：商超补货" />
      </label>
      <label>
        占用开始
        <input v-model="form.startAt" type="datetime-local" required />
      </label>
      <label>
        占用结束
        <input v-model="form.endAt" type="datetime-local" required />
      </label>
      <label>
        备注
        <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
      </label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <p v-if="ok" class="form-ok">{{ ok }}</p>
      <button type="submit">分配任务</button>
    </div>

    <div class="peer-box">
      <p class="peer-title">双端演练</p>
      <p class="peer-desc">
        模拟另一调度员（站点 dispatch-b）把同一车辆/时段的任务直接提交到服务端台账：在线时立即合并，离线时等网络恢复后合并。
      </p>
      <button type="button" class="secondary" @click="simulatePeer">对端提交相同时段任务</button>
      <p v-if="peerMsg" class="peer-msg">{{ peerMsg }}</p>
    </div>
  </form>
</template>

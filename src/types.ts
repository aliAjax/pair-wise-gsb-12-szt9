// 任务版本：Lamport 时间戳 + 站点 ID，多端同时提交时排序确定
export interface TaskVersion {
  lamport: number;
  siteId: string;
}

export type TaskStatus = "active" | "completed" | "cancelled" | "conflicted";
export type TaskOrigin = "local" | "remote" | "migration";

export interface DispatchTask {
  id: string;
  vehicleId: string;
  driverId: string;
  zone: string;
  cargo: string;
  startAt: string; // 占用开始（ISO）
  endAt: string; // 占用结束（ISO）
  version: TaskVersion;
  status: TaskStatus;
  notes: string;
  origin: TaskOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface Vehicle {
  id: string;
  plate: string;
  zone: string;
  notes: string;
  createdAt: string;
}

export interface Driver {
  id: string;
  name: string;
  createdAt: string;
}

export type ConflictKind = "vehicle-overlap" | "driver-overlap";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  vehicleId: string | null;
  driverId: string | null;
  taskIds: string[]; // 全部竞争任务
  winnerId: string; // 自动保留的先确认版本
  detectedAt: string;
  resolvedAt: string | null;
  keepTaskId: string | null; // 人工解决时实际保留的任务
}

export interface OutboxEntry {
  task: DispatchTask;
  enqueuedAt: string;
}

export interface PersistedState {
  schemaVersion: number;
  vehicles: Vehicle[];
  drivers: Driver[];
  tasks: DispatchTask[];
  conflicts: Conflict[];
  outbox: OutboxEntry[];
  clock: number; // 本地 Lamport 时钟
}

export interface RemoteLedger {
  tasks: DispatchTask[];
  updatedAt: string | null;
}

export const SCHEMA_VERSION = 2;
export const DEFAULT_TASK_HOURS = 4;

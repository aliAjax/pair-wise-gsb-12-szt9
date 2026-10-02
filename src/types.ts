// 本地优先调度领域模型
// 三张主表：车辆清单 vehicles、派车登记 dispatches、占用台账 occupancy
// 辅助：冲突区 conflicts、离线发件箱 outbox、远端快照 remote（模拟另一调度员/服务端）

export const SCHEMA_VERSION = 2;

/** 车辆生命周期状态 */
export type VehicleStatus = "空闲" | "待派出" | "执行中";

/** 派车任务状态：只有 confirmed/executing 占用车辆与司机 */
export type DispatchStatus = "confirmed" | "executing" | "finished" | "cancelled";

/** 冲突处理状态 */
export type ConflictState = "pending" | "resolved";

/** 离线操作类型 */
export type OutboxOpType = "dispatch" | "finish" | "cancel";

export interface TimeWindow {
  /** ISO 时间串，占用时段起 */
  startAt: string;
  /** ISO 时间串，占用时段止 */
  endAt: string;
}

export interface Vehicle {
  id: string;
  /** 车牌号，业务唯一键 */
  plate: string;
  /** 默认司机 */
  driver: string;
  zone: string;
  note?: string;
  /** 数据版本，每次修改 +1（旧数据迁移前可能缺失） */
  version: number;
  updatedAt: string;
}

export interface Dispatch extends TimeWindow {
  id: string;
  /** 任务版本（乐观锁/合并依据，旧数据可能缺失，需迁移补齐） */
  version: number;
  vehicleId: string;
  driver: string;
  zone: string;
  task: string;
  note?: string;
  status: DispatchStatus;
  /** 调度员确认时刻（毫秒），同时提交时数值小者胜 */
  confirmedAt: number;
  /** 同源自增序号，confirmedAt 相同时的平局判定 */
  seq: number;
  /** 提交来源：本地 / 远端合并 */
  origin: "local" | "remote";
  createdAt: string;
  /** 是否已同步到远端（断网期间登记的任务为 false） */
  synced?: boolean;
}

/** 占用台账：一条有效任务对应一条占用，任务结束即关闭 */
export interface OccupancyEntry extends TimeWindow {
  id: string;
  dispatchId: string;
  vehicleId: string;
  driver: string;
  task: string;
  /** open=占用中，closed=任务已完成/取消 */
  state: "open" | "closed";
  version: number;
  openedAt: string;
  closedAt?: string;
}

export interface Conflict {
  id: string;
  /** 被拒任务快照 */
  candidate: Dispatch;
  state: ConflictState;
  reasons: ConflictReason[];
  /** 先确认而保留的任务 */
  winnerDispatchId: string;
  detectedAt: number;
  resolvedAt?: number;
  resolution?: "cancelled" | "promoted";
}

export interface ConflictReason {
  kind: "vehicle-overlap" | "driver-overlap" | "stale-version";
  message: string;
}

export interface OutboxOp {
  id: string;
  type: OutboxOpType;
  payload: unknown;
  createdAt: number;
}

export interface MigrationInfo {
  fromVersion: number;
  toVersion: number;
  status: "done" | "interrupted-recovered";
  migratedAt: string;
  restoredFromSnapshot?: boolean;
}

/** 本地数据库（单 key 原子持久化） */
export interface LocalDB {
  schemaVersion: number;
  vehicles: Vehicle[];
  dispatches: Dispatch[];
  occupancy: OccupancyEntry[];
  conflicts: Conflict[];
  outbox: OutboxOp[];
  seq: number;
  lastMigration?: MigrationInfo;
}

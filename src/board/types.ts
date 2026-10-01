export type TaskStatus = "blocked" | "queued" | "claimed" | "done" | "failed" | "cancelled";
export type TaskOrigin = "coordinator" | `worker:${string}`;
export type ResultStatus = "done" | "failed";

export interface BoardResult {
  status: ResultStatus;
  summary: string;
  output: string;
  links: string[];
  worker: string;
  submitted_at: string;
}

export interface BoardTask {
  id: string;
  title: string;
  body: string;
  tags: string[];
  requires: string[];
  priority: number;
  origin: TaskOrigin;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  lease_s: number;
  claimed_by?: string;
  lease_expires_at?: string;
  not_workers: string[];
  batch_id?: string;
  depends_on: string[];
  dedupe_key?: string;
  replica_group_id?: string;
  replica_index?: number;
  review_of?: string;
  created_at: string;
  updated_at: string;
  result?: BoardResult;
  failure_reason?: string;
}

export interface BoardBatch {
  id: string;
  task_ids: string[];
  created_at: string;
}

export interface BoardState {
  tasks: Record<string, BoardTask>;
  batches: Record<string, BoardBatch>;
}

export interface WorkerIdentity {
  name: string;
  capabilities: string[];
  can_post: boolean;
  max_concurrent: number;
}

export interface BoardSnapshotFile {
  version: 2;
  /** seq of the last event included in `state`; replay skips events with seq <= this. */
  seq: number;
  state: BoardState;
}

export type BoardEvent = BoardEventBody & { seq?: number };

export type BoardEventBody =
  | { type: "task_posted"; task: BoardTask }
  | { type: "batch_posted"; batch: BoardBatch }
  | { type: "task_claimed"; task_id: string; worker: string; lease_expires_at: string; at: string }
  | { type: "task_heartbeat"; task_id: string; worker: string; lease_expires_at: string; at: string }
  | { type: "task_released"; task_id: string; worker: string; reason: string; at: string }
  | { type: "task_submitted"; task_id: string; result: BoardResult; retryable: boolean; at: string }
  | { type: "task_cancelled"; task_id: string; reason: string; at: string }
  | { type: "task_requeued"; task_id: string; reason: string; at: string }
  | { type: "task_failed"; task_id: string; reason: string; at: string }
  | { type: "task_unblocked"; task_id: string; body: string; at: string }
  | { type: "task_not_workers_added"; task_id: string; workers: string[]; at: string };

export interface TokenRecord extends WorkerIdentity {
  hash: string;
  created_at: string;
  revoked_at?: string;
  last_seen_at?: string;
}

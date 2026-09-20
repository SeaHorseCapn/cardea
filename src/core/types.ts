import type { EventBus, RunMode, WorkerName } from "./events.js";
import type { TierName } from "./config.js";

export interface RunOptions {
  prompt: string;
  cwd: string;
  mode: RunMode;
  /** Only set when mode === "single". */
  worker?: WorkerName;
  allowWrites: boolean;
  /** Coordinator permission posture: "safe" = plan mode, "yolo" = acceptEdits. */
  posture: "safe" | "default" | "yolo";
  timeoutS?: number;
  model?: string;
  /** Cost/capability tier for single/panel workers (default standard). */
  tier?: TierName;
  /** Native session id to resume (single mode only) — continues that CLI's session. */
  resumeId?: string;
}

export interface WorkerInvokeOpts {
  cwd: string;
  timeoutMs: number;
  allowWrites: boolean;
  model?: string;
  effort?: string;
  extraArgs?: string[];
  /** Native session id — when set, the worker resumes that session instead of starting fresh. */
  resumeId?: string;
}

export interface WorkerResult {
  output: string;
  exitCode: number;
  durationMs: number;
  /** Raw parsed events/lines for debugging; not part of the stable contract. */
  raw?: unknown;
}

export interface WorkerContext {
  bus: EventBus;
  taskId: string;
  delegationId: string;
}

export interface Worker {
  readonly name: WorkerName;
  invoke(
    task: string,
    opts: WorkerInvokeOpts,
    ctx: WorkerContext,
  ): Promise<WorkerResult>;
}

/**
 * Event contract between the core engine and any frontend (CLI now, dashboard later).
 * Every event is JSON-serializable by construction so it can be forwarded over a
 * WebSocket unchanged.
 */

export type WorkerName = string;

export type RunMode = "coordinate" | "single" | "panel";

export type CardeaEvent =
  | {
      type: "task_started";
      taskId: string;
      prompt: string;
      cwd: string;
      mode: RunMode;
      ts: number;
    }
  | { type: "coordinator_text"; taskId: string; text: string; ts: number }
  | {
      type: "coordinator_tool_use";
      taskId: string;
      tool: string;
      input: unknown;
      ts: number;
    }
  | {
      type: "delegation_started";
      taskId: string;
      delegationId: string;
      worker: WorkerName;
      prompt: string;
      ts: number;
    }
  | {
      type: "worker_output_chunk";
      taskId: string;
      delegationId: string;
      worker: WorkerName;
      stream: "stdout" | "stderr";
      chunk: string;
      ts: number;
    }
  | {
      type: "delegation_finished";
      taskId: string;
      delegationId: string;
      worker: WorkerName;
      output: string;
      exitCode: number;
      durationMs: number;
      ts: number;
    }
  | {
      type: "task_finished";
      taskId: string;
      result: string;
      costUsd?: number;
      durationMs: number;
      ts: number;
    }
  | {
      type: "error";
      taskId: string;
      scope: "coordinator" | WorkerName;
      message: string;
      fatal: boolean;
      ts: number;
    };

export type EventHandler = (ev: CardeaEvent) => void;

/** Minimal typed pub/sub. Handlers must not throw; errors are swallowed so one
 *  bad renderer can't kill a run. */
export class EventBus {
  private handlers: EventHandler[] = [];

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(ev: CardeaEvent): void {
    for (const h of this.handlers) {
      try {
        h(ev);
      } catch {
        // renderer errors must not break the run
      }
    }
  }
}

export function now(): number {
  return Date.now();
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

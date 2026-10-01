import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { boardDir, ensureBoardDir } from "./tokens.js";
import type { BoardSnapshotFile, BoardBatch, BoardEvent, BoardState, BoardTask, TaskStatus, WorkerIdentity } from "./types.js";
import {
  applyEvents,
  cancelTaskEvents,
  claimTaskEvents,
  countsByStatus,
  emptyState,
  heartbeatEvents,
  maintenanceEvents,
  postBatchEvents,
  postTaskEvents,
  releaseTaskEvents,
  submitResultEvents,
  type PostTaskInput,
} from "./state.js";

export class BoardStore {
  private state: BoardState = emptyState();
  /** seq of the last event applied; every appended event gets the next value. */
  private seq = 0;

  constructor(private readonly dir = boardDir()) {}

  get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  get snapshotPath(): string {
    return join(this.dir, "snapshot.json");
  }

  load(): void {
    ensureBoardDir(this.dir);
    this.state = emptyState();
    this.seq = 0;
    // A temp snapshot is only ever a torn write that never reached the rename; discard it.
    rmSync(`${this.snapshotPath}.tmp`, { force: true });

    const events = this.readEvents();
    let snapshotSeq = 0;
    if (existsSync(this.snapshotPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as Partial<BoardSnapshotFile> & Partial<BoardState>;
        if (parsed.state && typeof parsed.seq === "number") {
          this.state = parsed.state;
          snapshotSeq = parsed.seq;
        } else if (parsed.tasks && parsed.batches) {
          // pre-seq snapshot: a bare state, taken before any seq existed
          this.state = { tasks: parsed.tasks, batches: parsed.batches };
        } else {
          throw new Error("unrecognised snapshot shape");
        }
      } catch (err) {
        // Falling back to a full replay is only safe if the log still starts at the beginning.
        const first = events[0];
        if (!first || first.seq !== 1) {
          throw new Error(`board snapshot ${this.snapshotPath} is unreadable (${(err as Error).message}) and the event log is not a complete history; refusing to start with an empty board. Restore snapshot.json from a backup.`);
        }
        this.state = emptyState();
        snapshotSeq = 0;
      }
    }
    this.seq = snapshotSeq;
    const pending: BoardEvent[] = [];
    for (const event of events) {
      if (event.seq !== undefined && event.seq <= snapshotSeq) continue; // already inside the snapshot
      pending.push(event);
      this.seq = Math.max(this.seq, event.seq ?? 0);
    }
    this.state = applyEvents(this.state, pending);
  }

  /** Read the log. Seq-less (pre-seq) lines get an implicit seq: the previous line's seq plus one. */
  private readEvents(): BoardEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const lines = readFileSync(this.eventsPath, "utf8").split("\n").filter(Boolean);
    const events: BoardEvent[] = [];
    let prev = 0;
    for (const [i, line] of lines.entries()) {
      let event: BoardEvent;
      try {
        event = JSON.parse(line) as BoardEvent;
      } catch (err) {
        // a torn final line from a crash mid-append is dropped; corruption elsewhere is fatal
        if (i !== lines.length - 1) throw err;
        continue;
      }
      event.seq = typeof event.seq === "number" ? event.seq : prev + 1;
      prev = event.seq;
      events.push(event);
    }
    return events;
  }

  compact(maxBytes = 1024 * 1024): void {
    if (!existsSync(this.eventsPath) || statSync(this.eventsPath).size < maxBytes) return;
    this.writeSnapshot();
    this.truncateLog();
  }

  /** Atomically persist the current state plus the seq of the last event it includes. */
  writeSnapshot(): void {
    const tmp = `${this.snapshotPath}.tmp`;
    const body: BoardSnapshotFile = { version: 2, seq: this.seq, state: this.state };
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
    this.fsyncDir();
  }

  /** Empty the log. Only call after writeSnapshot() has completed. */
  truncateLog(): void {
    const fd = openSync(this.eventsPath, "w", 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private fsyncDir(): void {
    try {
      const fd = openSync(this.dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // directories cannot be fsynced on every platform
    }
  }

  snapshot(): BoardState {
    return JSON.parse(JSON.stringify(this.state)) as BoardState;
  }

  private applyAndAppend(events: BoardEvent[]): BoardEvent[] {
    if (!events.length) return [];
    ensureBoardDir(this.dir);
    for (const event of events) {
      event.seq = ++this.seq;
      appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.state = applyEvents(this.state, events);
    this.compact();
    return events;
  }

  maintenance(at = new Date().toISOString()): BoardEvent[] {
    return this.applyAndAppend(maintenanceEvents(this.state, at));
  }

  postTask(input: PostTaskInput, origin: "coordinator" | `worker:${string}`): BoardTask[] {
    this.maintenance();
    if (input.dedupe_key) {
      // idempotent posting: an equal dedupe_key returns the live task instead of creating a duplicate
      const existing = Object.values(this.state.tasks).filter((t) => t.dedupe_key === input.dedupe_key && t.status !== "failed" && t.status !== "cancelled");
      if (existing.length) return existing;
    }
    const events = this.applyAndAppend(postTaskEvents(this.state, input, origin));
    return events.filter((event) => event.type === "task_posted").map((event) => event.task);
  }

  postBatch(input: { template: string; items: string[]; title?: string; tags?: string[]; requires?: string[]; priority?: number; max_attempts?: number; lease_s?: number }, origin: "coordinator" | `worker:${string}`): BoardBatch {
    this.maintenance();
    const events = this.applyAndAppend(postBatchEvents(this.state, input, origin));
    const posted = events.find((event) => event.type === "batch_posted");
    if (!posted || posted.type !== "batch_posted") throw new Error("batch was not posted");
    return posted.batch;
  }

  claim(worker: WorkerIdentity, capabilities?: string[]): BoardTask | undefined {
    this.maintenance();
    const events = this.applyAndAppend(claimTaskEvents(this.state, worker, capabilities));
    const claimed = events.find((event) => event.type === "task_claimed");
    return claimed?.type === "task_claimed" ? this.state.tasks[claimed.task_id] : undefined;
  }

  heartbeat(taskId: string, worker: string): BoardTask {
    this.maintenance();
    this.applyAndAppend(heartbeatEvents(this.state, taskId, worker));
    const task = this.state.tasks[taskId];
    if (!task) throw new Error("task not found");
    return task;
  }

  release(taskId: string, worker: string, reason: string): BoardTask {
    this.maintenance();
    this.applyAndAppend(releaseTaskEvents(this.state, taskId, worker, reason));
    const task = this.state.tasks[taskId];
    if (!task) throw new Error("task not found");
    return task;
  }

  submit(taskId: string, worker: string, result: { status: "done" | "failed"; summary: string; output?: string; links?: string[]; retryable?: boolean }): BoardTask {
    this.maintenance();
    this.applyAndAppend(submitResultEvents(this.state, taskId, worker, result));
    const task = this.state.tasks[taskId];
    if (!task) throw new Error("task not found");
    return task;
  }

  cancel(taskId: string, reason?: string): BoardTask {
    this.maintenance();
    this.applyAndAppend(cancelTaskEvents(this.state, taskId, reason));
    const task = this.state.tasks[taskId];
    if (!task) throw new Error("task not found");
    return task;
  }

  getTask(id: string): BoardTask | undefined {
    this.maintenance();
    return this.state.tasks[id];
  }

  listTasks(filter: { status?: TaskStatus; batch_id?: string; tag?: string } = {}): BoardTask[] {
    this.maintenance();
    return Object.values(this.state.tasks)
      .filter((task) => !filter.status || task.status === filter.status)
      .filter((task) => !filter.batch_id || task.batch_id === filter.batch_id)
      .filter((task) => !filter.tag || task.tags.includes(filter.tag))
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  }

  getBatch(id: string): { batch: BoardBatch; counts: Record<TaskStatus, number>; results: BoardTask[] } | undefined {
    this.maintenance();
    const batch = this.state.batches[id];
    if (!batch) return undefined;
    const tasks = batch.task_ids.map((taskId) => this.state.tasks[taskId]).filter((task): task is BoardTask => Boolean(task));
    return { batch, counts: countsByStatus(tasks), results: tasks };
  }

  stats(): { counts: Record<TaskStatus, number>; total: number; batches: number } {
    this.maintenance();
    const tasks = Object.values(this.state.tasks);
    return { counts: countsByStatus(tasks), total: tasks.length, batches: Object.keys(this.state.batches).length };
  }
}

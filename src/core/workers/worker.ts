import { spawn } from "node:child_process";
import type { WorkerContext } from "../types.js";
import { now } from "../events.js";
import type { WorkerName } from "../events.js";

export interface SpawnSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Written to the child's stdin, then stdin is closed. */
  stdinData?: string;
}

export interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

const KILL_GRACE_MS = 5000;

/**
 * Spawn a worker CLI headlessly. Never uses a shell (no injection surface),
 * kills the whole process group on timeout (SIGTERM, then SIGKILL), and
 * streams stdout/stderr lines into worker_output_chunk events.
 */
export function spawnWorker(
  spec: SpawnSpec,
  worker: WorkerName,
  ctx: WorkerContext,
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    let timedOut = false;
    let settled = false;

    const child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // negative pid = process group
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
    }, spec.timeoutMs);

    let stdout = "";
    let stderr = "";
    const lineBuffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

    const onData = (stream: "stdout" | "stderr") => (data: Buffer) => {
      const text = data.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;

      lineBuffers[stream] += text;
      let idx: number;
      while ((idx = lineBuffers[stream].indexOf("\n")) >= 0) {
        const line = lineBuffers[stream].slice(0, idx);
        lineBuffers[stream] = lineBuffers[stream].slice(idx + 1);
        if (line.trim().length > 0) {
          ctx.bus.emit({
            type: "worker_output_chunk",
            taskId: ctx.taskId,
            delegationId: ctx.delegationId,
            worker,
            stream,
            chunk: line,
            ts: now(),
          });
        }
      }
    };

    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : 1),
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    if (spec.stdinData !== undefined) {
      child.stdin.write(spec.stdinData);
    }
    child.stdin.end();
  });
}

/** Parse a JSONL string tolerantly: unparseable lines come back as plain text. */
export function parseJsonLines(text: string): { objects: unknown[]; plain: string[] } {
  const objects: unknown[] = [];
  const plain: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        objects.push(JSON.parse(trimmed));
        continue;
      } catch {
        /* fall through to plain */
      }
    }
    plain.push(trimmed);
  }
  return { objects, plain };
}

export function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n[cardea: output truncated at ${cap} chars — ${text.length - cap} chars omitted]`;
}

export function appendLine(text: string, line: string | undefined): string {
  if (!line) return text;
  return text ? `${text.trimEnd()}\n${line}` : line;
}

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import type { CardeaEvent, EventBus } from "./events.js";

export function runsDir(): string {
  const dir = join(getConfigDir(), "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function attachRunPersistence(bus: EventBus): { getRunId: () => string | undefined } {
  let file: string | undefined;
  let runId: string | undefined;
  bus.on((ev) => {
    if (ev.type === "task_started") {
      runId = `${ev.ts}-${ev.taskId}`;
      file = join(runsDir(), `${runId}.jsonl`);
    }
    if (!file) return;
    appendFileSync(file, JSON.stringify(ev) + "\n");
  });
  return { getRunId: () => runId };
}

export function listPersistedRuns(): {
  id: string;
  prompt: string;
  mode: string;
  startedAt: number;
  finished: boolean;
}[] {
  const out: { id: string; prompt: string; mode: string; startedAt: number; finished: boolean }[] = [];
  for (const f of readdirSync(runsDir())) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const lines = readFileSync(join(runsDir(), f), "utf8").trim().split("\n");
      const first = JSON.parse(lines[0]!) as CardeaEvent;
      if (first.type !== "task_started") continue;
      const last = JSON.parse(lines[lines.length - 1]!) as CardeaEvent;
      out.push({
        id: f.replace(/\.jsonl$/, ""),
        prompt: first.prompt.slice(0, 200),
        mode: first.mode,
        startedAt: first.ts,
        finished: last.type === "task_finished" || (last.type === "error" && last.fatal),
      });
    } catch {
      /* skip unreadable run files */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
}

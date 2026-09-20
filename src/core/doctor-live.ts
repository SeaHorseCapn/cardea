import pc from "picocolors";
import { isCliWorker, type CardeaConfig } from "./config.js";
import { EventBus, newId } from "./events.js";
import type { Worker } from "./types.js";
import { ClaudeWorker } from "./workers/claude-worker.js";
import { CodexWorker } from "./workers/codex.js";
import { GrokWorker } from "./workers/grok.js";

const SMOKE_PROMPT = "Reply with exactly: OK";
const SMOKE_TIMEOUT_MS = 120_000;

/** Fire a one-line prompt through each worker — the only true proof that OAuth is valid. */
export async function runLiveChecks(cfg: CardeaConfig): Promise<boolean> {
  console.log(pc.dim("\nlive checks (1-line smoke prompt per worker, up to 120s each)…"));
  const bus = new EventBus(); // silent bus — we only care about the result line
  const workers: Worker[] = Object.entries(cfg.workers)
    .filter(([, worker]) => worker.enabled && isCliWorker(worker))
    .map(([, worker]) => {
      if (worker.kind === "claude-cli") return new ClaudeWorker(cfg);
      if (worker.kind === "codex-cli") return new CodexWorker(cfg);
      return new GrokWorker(cfg);
    });

  const results = await Promise.allSettled(
    workers.map((w) =>
      w
        .invoke(
          SMOKE_PROMPT,
          { cwd: process.cwd(), timeoutMs: SMOKE_TIMEOUT_MS, allowWrites: false },
          { bus, taskId: newId("doctor"), delegationId: newId("live") },
        )
        .then((r) => ({ worker: w.name, ...r })),
    ),
  );

  let allOk = true;
  results.forEach((res, i) => {
    const name = workers[i]!.name;
    if (res.status === "fulfilled") {
      const ok = res.value.exitCode === 0 && res.value.output.length > 0;
      if (!ok) allOk = false;
      const icon = ok ? pc.green("✔") : pc.red("✘");
      const preview = res.value.output.replace(/\s+/g, " ").slice(0, 60);
      console.log(
        `${icon} ${pc.bold(`${name} live`.padEnd(18))} ${(res.value.durationMs / 1000).toFixed(1)}s — "${preview}"`,
      );
    } else {
      allOk = false;
      console.log(
        `${pc.red("✘")} ${pc.bold(`${name} live`.padEnd(18))} ${String(res.reason).slice(0, 120)}`,
      );
    }
  });
  return allOk;
}

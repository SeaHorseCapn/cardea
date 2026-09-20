import { resolve } from "node:path";
import pc from "picocolors";
import { enabledWorkerNames, loadConfig, ensureConfigDir } from "../core/config.js";
import { EventBus, type WorkerName } from "../core/events.js";
import type { RunOptions } from "../core/types.js";
import { runTask } from "../core/orchestrator.js";
import { attachJsonRenderer, attachPrettyRenderer } from "./render.js";
import { attachRunPersistence } from "../core/runs.js";

export async function runFromCli(prompt: string, opts: Record<string, unknown>): Promise<void> {
  const cfg = loadConfig();
  ensureConfigDir();
  const workerNames = enabledWorkerNames(cfg);

  let mode: RunOptions["mode"] = "coordinate";
  let worker: WorkerName | undefined;
  let explicitModel: string | undefined;
  if (opts.model) {
    const [requested, ...rest] = String(opts.model).split(":");
    if (!requested) throw new Error("--model requires a worker name");
    if (!workerNames.includes(requested)) {
      throw new Error(
        `--model must be one of ${workerNames.join("|")} (optionally worker:model), got "${String(opts.model)}"`,
      );
    }
    mode = "single";
    worker = requested as WorkerName;
    if (rest.length) explicitModel = rest.join(":");
  }
  let tier: RunOptions["tier"];
  if (opts.tier) {
    const t = String(opts.tier);
    if (!["fast", "standard", "deep"].includes(t)) {
      throw new Error(`--tier must be fast|standard|deep, got "${t}"`);
    }
    tier = t as RunOptions["tier"];
  }
  if (opts.panel) {
    if (worker) throw new Error("--panel and --model are mutually exclusive");
    mode = "panel";
  }
  if (opts.safe && opts.yolo) throw new Error("--safe and --yolo are mutually exclusive");
  if (opts.resume && mode !== "single") {
    throw new Error("--resume requires --model <worker> to name which provider's session to resume");
  }

  const runOpts: RunOptions = {
    prompt,
    cwd: resolve(String(opts.cwd ?? process.cwd())),
    mode,
    worker,
    allowWrites: Boolean(opts.allowWrites) && !opts.safe,
    posture: opts.safe ? "safe" : opts.yolo ? "yolo" : "default",
    timeoutS: opts.timeout ? Number(opts.timeout) : undefined,
    model: explicitModel,
    tier,
    resumeId: opts.resume ? String(opts.resume) : undefined,
  };

  const bus = new EventBus();
  attachRunPersistence(bus);
  if (opts.json) attachJsonRenderer(bus);
  else attachPrettyRenderer(bus);

  try {
    await runTask(runOpts, cfg, bus);
  } catch (err) {
    if (!opts.json) {
      console.error(pc.red(`run failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    process.exitCode = 1;
  }
}

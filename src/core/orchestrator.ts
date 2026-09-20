import {
  enabledWorkerNames,
  isOpenAICompatibleWorker,
  resolveTier,
  type CardeaConfig,
} from "./config.js";
import { EventBus, newId, now, type WorkerName } from "./events.js";
import type { RunOptions, Worker } from "./types.js";
import { runCoordinator } from "./coordinator.js";
import { pickTier } from "./autotier.js";
import { panelSynthesisPrompt } from "./prompts.js";
import { isProtectedPath } from "./config.js";
import { ClaudeWorker } from "./workers/claude-worker.js";
import { CodexWorker } from "./workers/codex.js";
import { GrokWorker } from "./workers/grok.js";
import { OpenAICompatibleWorker } from "./workers/local.js";

export interface TaskOutcome {
  result: string;
  costUsd?: number;
  durationMs: number;
}

export function buildWorkers(cfg: CardeaConfig): Record<WorkerName, Worker> {
  const workers: Record<WorkerName, Worker> = {};
  for (const [name, workerCfg] of Object.entries(cfg.workers)) {
    if (workerCfg.kind === "claude-cli") workers[name] = new ClaudeWorker(cfg);
    else if (workerCfg.kind === "codex-cli") workers[name] = new CodexWorker(cfg);
    else if (workerCfg.kind === "grok-cli") workers[name] = new GrokWorker(cfg);
    else if (isOpenAICompatibleWorker(workerCfg)) workers[name] = new OpenAICompatibleWorker(cfg, name);
  }
  return workers;
}

/** Effective write permission for workers: never inside protected paths. */
function workerWritesAllowed(cfg: CardeaConfig, opts: RunOptions): boolean {
  return opts.allowWrites && !isProtectedPath(cfg, opts.cwd);
}

export async function runTask(
  opts: RunOptions,
  cfg: CardeaConfig,
  bus: EventBus,
): Promise<TaskOutcome> {
  const taskId = newId("task");
  const started = Date.now();
  bus.emit({
    type: "task_started",
    taskId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    mode: opts.mode,
    ts: now(),
  });

  const workers = buildWorkers(cfg);

  try {
    let result: string;
    let costUsd: number | undefined;

    // Auto-tier: single/panel runs with no explicit tier get a cheap-classifier pass.
    // (Coordinate mode doesn't need it — the coordinator picks tiers per delegation.)
    if (
      opts.mode !== "coordinate" &&
      opts.tier === undefined &&
      opts.model === undefined &&
      cfg.defaults.autoTier
    ) {
      const classifier = workers.claude;
      if (classifier) {
        opts = { ...opts, tier: await pickTier(opts.prompt, cfg, classifier, bus, taskId) };
      }
    }

    if (opts.mode === "single") {
      result = await runSingle(opts, cfg, bus, taskId, workers);
    } else if (opts.mode === "panel") {
      result = await runPanel(opts, cfg, bus, taskId, workers);
    } else {
      const out = await runCoordinator(opts, { cfg, bus, taskId, workers });
      result = out.result;
      costUsd = out.costUsd;
    }

    const durationMs = Date.now() - started;
    bus.emit({ type: "task_finished", taskId, result, costUsd, durationMs, ts: now() });
    return { result, costUsd, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus.emit({ type: "error", taskId, scope: "coordinator", message, fatal: true, ts: now() });
    throw err;
  }
}

async function runSingle(
  opts: RunOptions,
  cfg: CardeaConfig,
  bus: EventBus,
  taskId: string,
  workers: Record<WorkerName, Worker>,
): Promise<string> {
  const worker = workers[opts.worker ?? "claude"];
  if (!worker) throw new Error(`unknown or disabled worker "${opts.worker ?? "claude"}"`);
  const { model, effort } = resolveTier(cfg, worker.name, opts.tier, opts.model);
  const delegationId = newId("dlg");
  bus.emit({
    type: "delegation_started",
    taskId,
    delegationId,
    worker: worker.name,
    prompt: `${opts.resumeId ? `[resume ${opts.resumeId.slice(0, 8)}] ` : ""}[${opts.tier ?? "standard"}${model ? `:${model}` : ""}] ${opts.prompt}`,
    ts: now(),
  });
  const result = await worker.invoke(
    opts.prompt,
    {
      cwd: opts.cwd,
      timeoutMs: (opts.timeoutS ?? cfg.defaults.timeoutS) * 1000,
      allowWrites: workerWritesAllowed(cfg, opts),
      model,
      effort,
      extraArgs: cfg.workers[worker.name]!.extraArgs,
      resumeId: opts.resumeId,
    },
    { bus, taskId, delegationId },
  );
  bus.emit({
    type: "delegation_finished",
    taskId,
    delegationId,
    worker: worker.name,
    output: result.output,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ts: now(),
  });
  return result.output;
}

async function runPanel(
  opts: RunOptions,
  cfg: CardeaConfig,
  bus: EventBus,
  taskId: string,
  workers: Record<WorkerName, Worker>,
): Promise<string> {
  const seats: WorkerName[] = enabledWorkerNames(cfg);
  const settled = await Promise.allSettled(
    seats.map(async (name) => {
      const worker = workers[name];
      if (!worker) throw new Error(`unknown or disabled worker "${name}"`);
      const { model, effort } = resolveTier(cfg, name, opts.tier);
      const delegationId = newId("dlg");
      bus.emit({
        type: "delegation_started",
        taskId,
        delegationId,
        worker: name,
        prompt: `[${opts.tier ?? "standard"}${model ? `:${model}` : ""}] ${opts.prompt}`,
        ts: now(),
      });
      const result = await worker.invoke(
        opts.prompt,
        {
          cwd: opts.cwd,
          timeoutMs: (opts.timeoutS ?? cfg.defaults.timeoutS) * 1000,
          allowWrites: false, // panel seats are always read-only
          model,
          effort,
          extraArgs: cfg.workers[name]!.extraArgs,
        },
        { bus, taskId, delegationId },
      );
      bus.emit({
        type: "delegation_finished",
        taskId,
        delegationId,
        worker: name,
        output: result.output,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ts: now(),
      });
      return result.output;
    }),
  );

  const outputs = settled.map((res, i) => ({
    worker: seats[i]!,
    output: res.status === "fulfilled" ? res.value : "",
    error: res.status === "rejected" ? String(res.reason) : undefined,
  }));

  for (const o of outputs) {
    if (o.error) {
      bus.emit({
        type: "error",
        taskId,
        scope: o.worker,
        message: `panel seat failed: ${o.error}`,
        fatal: false,
        ts: now(),
      });
    }
  }

  const usable = outputs.filter((o) => !o.error && o.output.trim().length > 0);
  if (usable.length === 0) {
    throw new Error("all panel seats failed — nothing to synthesize");
  }

  // Synthesis pass: one read-only Claude turn over the three answers.
  const synthesisId = newId("dlg");
  bus.emit({
    type: "delegation_started",
    taskId,
    delegationId: synthesisId,
    worker: "claude",
    prompt: "[panel synthesis]",
    ts: now(),
  });
  const synthTier = resolveTier(cfg, "claude", opts.tier ?? "deep");
  const claude = workers.claude;
  if (!claude) throw new Error("panel synthesis requires the claude worker");
  const synthesis = await claude.invoke(
    panelSynthesisPrompt(opts.prompt, outputs),
    {
      cwd: opts.cwd,
      timeoutMs: (opts.timeoutS ?? cfg.defaults.timeoutS) * 1000,
      allowWrites: false,
      model: synthTier.model,
      effort: synthTier.effort,
    },
    { bus, taskId, delegationId: synthesisId },
  );
  bus.emit({
    type: "delegation_finished",
    taskId,
    delegationId: synthesisId,
    worker: "claude",
    output: synthesis.output,
    exitCode: synthesis.exitCode,
    durationMs: synthesis.durationMs,
    ts: now(),
  });
  return synthesis.output;
}

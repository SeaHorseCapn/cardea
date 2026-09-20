import { accessSync, constants, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  enabledWorkerNames,
  ensureConfigDir,
  isCliWorker,
  isOpenAICompatibleWorker,
  isProtectedPath,
  loadConfig,
  resolveTier,
  type CardeaConfig,
  type TierName,
} from "../core/config.js";
import { EventBus, newId, now } from "../core/events.js";
import { buildWorkers } from "../core/orchestrator.js";
import { runFanOut } from "../core/fanout.js";
import { attachRunPersistence } from "../core/runs.js";
import { truncate } from "../core/workers/worker.js";
import type { Worker, WorkerResult } from "../core/types.js";

interface McpServerOptions {
  allowWrites: boolean;
  cwd: string;
}

const tierSchema = z.enum(["fast", "standard", "deep"]).optional();

const delegateSchema = {
  worker: z.string().describe("Enabled Cardea worker name, such as claude, codex, grok, local, or a configured OpenAI-compatible worker."),
  prompt: z.string().min(1).describe("Self-contained task for the worker. Include paths and context; workers do not share host context."),
  tier: tierSchema.describe("Cost/capability tier. Defaults to standard."),
  model: z.string().optional().describe("Explicit model override. Prefer tier unless you need a specific model id."),
  cwd: z.string().optional().describe("Existing working directory. Defaults to the MCP server's startup cwd."),
  allow_writes: z.boolean().default(false).describe("Request filesystem writes. Honored only when cardea mcp started with --allow-writes and cwd is not protected."),
  timeout_s: z.number().int().positive().optional().describe("Timeout in seconds for this worker run."),
};

const fanOutSchema = {
  worker: z.string().describe("Enabled Cardea worker name that will run every item."),
  tier: tierSchema.default("fast").describe("Cost/capability tier. Defaults to fast for cheap wide passes."),
  template: z.string().min(1).describe("Prompt template containing the literal placeholder {item}; each item is substituted into a separate worker run."),
  items: z.array(z.string()).min(1).max(20).describe("Independent items to run, maximum 20."),
  cwd: z.string().optional().describe("Existing working directory. Defaults to the MCP server's startup cwd."),
};

const panelSchema = {
  prompt: z.string().min(1).describe("Self-contained task sent to each enabled worker. The host LLM should synthesize the answers."),
  tier: tierSchema.describe("Cost/capability tier. Defaults to standard."),
  cwd: z.string().optional().describe("Existing working directory. Defaults to the MCP server's startup cwd."),
};

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
};

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text }], structuredContent, isError };
}

async function progress(extra: Extra, progressValue: number, total: number, message: string): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || !extra.sendNotification) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress: progressValue, total, message },
  });
}

function resolveCwd(input: string | undefined, defaultCwd: string): string {
  const cwd = resolve(input ?? defaultCwd);
  const stat = statSync(cwd);
  if (!stat.isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  accessSync(cwd, constants.R_OK);
  return cwd;
}

function workerEnabled(cfg: CardeaConfig, name: string): boolean {
  return Boolean(cfg.workers[name]?.enabled);
}

function assertWorker(cfg: CardeaConfig, workers: Record<string, Worker>, name: string): Worker {
  if (!workerEnabled(cfg, name) || !workers[name]) {
    throw new Error(`unknown or disabled worker "${name}"`);
  }
  return workers[name]!;
}

function binaryReachable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    execFileSync(path, ["--version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function endpointReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function invokePersisted(params: {
  cfg: CardeaConfig;
  worker: Worker;
  prompt: string;
  cwd: string;
  tier: TierName;
  modelOverride?: string;
  allowWrites: boolean;
  timeoutS?: number;
  bus: EventBus;
  taskId: string;
}): Promise<{ result: WorkerResult; model?: string; runTier: TierName }> {
  const { cfg, worker, prompt, cwd, tier, modelOverride, allowWrites, timeoutS, bus, taskId } = params;
  const { model, effort } = resolveTier(cfg, worker.name, tier, modelOverride);
  const delegationId = newId("dlg");
  bus.emit({
    type: "delegation_started",
    taskId,
    delegationId,
    worker: worker.name,
    prompt: `[${tier}${model ? `:${model}` : ""}] ${prompt}`,
    ts: now(),
  });
  const result = await worker.invoke(
    prompt,
    {
      cwd,
      timeoutMs: (timeoutS ?? cfg.defaults.timeoutS) * 1000,
      allowWrites,
      model,
      effort,
      extraArgs: cfg.workers[worker.name]?.extraArgs,
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
  return { result, model, runTier: tier };
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const cfg = loadConfig();
  ensureConfigDir();
  const workers = buildWorkers(cfg);
  const server = createMcpServer(cfg, workers, options);
  await server.connect(new StdioServerTransport());
}

export function createMcpServer(
  cfg: CardeaConfig,
  workers: Record<string, Worker>,
  options: McpServerOptions,
): McpServer {
  const server = new McpServer(
    { name: "cardea", version: "0.2.0" },
    {
      instructions:
        "Use Cardea to delegate self-contained tasks to configured LLM workers. OpenAI-compatible workers are text-only; the host LLM remains responsible for coordination and synthesis.",
    },
  );

  server.registerTool(
    "list_workers",
    {
      description:
        "List enabled Cardea workers with tiers/models, auth mode, and binary or endpoint reachability. Does not send live prompts and never reveals API key values.",
    },
    async () => {
      const rows = await Promise.all(
        enabledWorkerNames(cfg).map(async (name) => {
          const worker = cfg.workers[name]!;
          const reachable = isCliWorker(worker)
            ? binaryReachable(
                worker.kind === "claude-cli"
                  ? cfg.binaries.claude
                  : worker.kind === "codex-cli"
                    ? cfg.binaries.codex
                    : cfg.binaries.grok,
              )
            : isOpenAICompatibleWorker(worker)
              ? await endpointReachable(worker.baseUrl)
              : false;
          return {
            name,
            kind: worker.kind,
            roleHint: worker.roleHint,
            tiers: worker.tiers,
            auth: worker.auth,
            apiKeyEnv: worker.apiKeyEnv,
            reachable,
            textOnly: isOpenAICompatibleWorker(worker),
          };
        }),
      );
      return textResult(JSON.stringify(rows, null, 2), { workers: rows });
    },
  );

  server.registerTool(
    "delegate",
    {
      description:
        "Run one enabled Cardea worker on a self-contained task and return its final text plus worker, tier, model, duration, and run id. Writes require server --allow-writes and never occur under protected paths.",
      inputSchema: delegateSchema,
    },
    async (input, extra) => {
      let cwd: string;
      try {
        cwd = resolveCwd(input.cwd, options.cwd);
        if (input.allow_writes && !options.allowWrites) {
          return textResult("write access refused: cardea mcp was not started with --allow-writes", {}, true);
        }
        if (input.allow_writes && isProtectedPath(cfg, cwd)) {
          return textResult("write access refused: cwd is under a protected path", {}, true);
        }
        const worker = assertWorker(cfg, workers, input.worker);
        const taskId = newId("task");
        const bus = new EventBus();
        const persisted = attachRunPersistence(bus);
        const started = Date.now();
        bus.emit({ type: "task_started", taskId, prompt: input.prompt, cwd, mode: "single", ts: now() });
        await progress(extra as Extra, 0, 1, `${input.worker} started`);
        const out = await invokePersisted({
          cfg,
          worker,
          prompt: input.prompt,
          cwd,
          tier: input.tier ?? "standard",
          modelOverride: input.model,
          allowWrites: input.allow_writes === true,
          timeoutS: input.timeout_s,
          bus,
          taskId,
        });
        const durationMs = Date.now() - started;
        const output = truncate(out.result.output, cfg.defaults.outputCapChars);
        bus.emit({ type: "task_finished", taskId, result: output, durationMs, ts: now() });
        await progress(extra as Extra, 1, 1, `${input.worker} finished`);
        const meta = {
          output,
          worker: input.worker,
          tier: out.runTier,
          model: out.model,
          duration_ms: durationMs,
          run_id: persisted.getRunId(),
        };
        return textResult(output, meta);
      } catch (err) {
        return textResult((err as Error).message, {}, true);
      }
    },
  );

  server.registerTool(
    "fan_out",
    {
      description:
        "Run one prompt template over up to 20 independent items with the same worker, defaulting to fast tier. Use for cheap wide passes; the host LLM should inspect and escalate interesting findings.",
      inputSchema: fanOutSchema,
    },
    async (input, extra) => {
      try {
        const cwd = resolveCwd(input.cwd, options.cwd);
        const worker = assertWorker(cfg, workers, input.worker);
        const taskId = newId("task");
        const bus = new EventBus();
        const persisted = attachRunPersistence(bus);
        const started = Date.now();
        bus.emit({ type: "task_started", taskId, prompt: input.template, cwd, mode: "single", ts: now() });
        const results = await runFanOut({
          template: input.template,
          items: input.items,
          tier: input.tier,
          invoke: async (prompt, item, index) => {
            await progress(extra as Extra, index, input.items.length, `fan_out ${index + 1}/${input.items.length}: ${item.slice(0, 60)}`);
            const out = await invokePersisted({
              cfg,
              worker,
              prompt,
              cwd,
              tier: input.tier,
              allowWrites: false,
              bus,
              taskId,
            });
            return truncate(out.result.output, cfg.defaults.outputCapChars);
          },
        });
        const durationMs = Date.now() - started;
        const text = results
          .map((r, i) => `### [${i + 1}/${results.length}] ${r.item}\n${r.output}`)
          .join("\n\n");
        const capped = truncate(text, cfg.defaults.outputCapChars);
        bus.emit({ type: "task_finished", taskId, result: capped, durationMs, ts: now() });
        await progress(extra as Extra, input.items.length, input.items.length, "fan_out finished");
        return textResult(capped, {
          results,
          worker: input.worker,
          tier: input.tier,
          duration_ms: durationMs,
          run_id: persisted.getRunId(),
        });
      } catch (err) {
        return textResult((err as Error).message, {}, true);
      }
    },
  );

  server.registerTool(
    "panel",
    {
      description:
        "Send the same prompt to each enabled Cardea worker and return each answer separately. Cardea does no synthesis here; the host LLM should compare and synthesize.",
      inputSchema: panelSchema,
    },
    async (input, extra) => {
      try {
        const cwd = resolveCwd(input.cwd, options.cwd);
        const names = enabledWorkerNames(cfg);
        const taskId = newId("task");
        const bus = new EventBus();
        const persisted = attachRunPersistence(bus);
        const started = Date.now();
        bus.emit({ type: "task_started", taskId, prompt: input.prompt, cwd, mode: "panel", ts: now() });
        const settled = await Promise.allSettled(
          names.map(async (name, index) => {
            await progress(extra as Extra, index, names.length, `${name} started`);
            const worker = assertWorker(cfg, workers, name);
            const out = await invokePersisted({
              cfg,
              worker,
              prompt: input.prompt,
              cwd,
              tier: input.tier ?? "standard",
              allowWrites: false,
              bus,
              taskId,
            });
            return {
              worker: name,
              output: truncate(out.result.output, cfg.defaults.outputCapChars),
              duration_ms: out.result.durationMs,
              model: out.model,
            };
          }),
        );
        const results = settled.map((res, i) =>
          res.status === "fulfilled"
            ? res.value
            : { worker: names[i]!, output: "", error: String(res.reason) },
        );
        const durationMs = Date.now() - started;
        const text = results
          .map((r) => `## ${r.worker}\n${"error" in r ? `(failed: ${r.error})` : r.output}`)
          .join("\n\n");
        const capped = truncate(text, cfg.defaults.outputCapChars);
        bus.emit({ type: "task_finished", taskId, result: capped, durationMs, ts: now() });
        await progress(extra as Extra, names.length, names.length, "panel finished");
        return textResult(capped, { results, duration_ms: durationMs, run_id: persisted.getRunId() });
      } catch (err) {
        return textResult((err as Error).message, {}, true);
      }
    },
  );

  return server;
}

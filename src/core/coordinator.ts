import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  coordinatorEnv,
  enabledWorkerNames,
  isOpenAICompatibleWorker,
  isProtectedPath,
  resolveTier,
  type CardeaConfig,
  type TierName,
} from "./config.js";
import { EventBus, newId, now } from "./events.js";
import type { RunOptions, Worker } from "./types.js";
import { coordinatorAppend } from "./prompts.js";
import { truncate } from "./workers/worker.js";
import { runFanOut } from "./fanout.js";

/** Simple counting semaphore for the delegation concurrency cap. */
class Semaphore {
  private queue: (() => void)[] = [];
  private available: number;
  constructor(n: number) {
    this.available = n;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((res) => this.queue.push(res));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

interface CoordinatorDeps {
  cfg: CardeaConfig;
  bus: EventBus;
  taskId: string;
  workers: Record<string, Worker>;
}

const tierParam = z
  .enum(["fast", "standard", "deep"])
  .optional()
  .describe(
    "Cost/capability tier (default standard). fast = cheapest, for lookups, mechanical edits, classification, summaries. deep = most capable, only for genuinely hard reasoning.",
  );

const delegationInputShape = {
  prompt: z
    .string()
    .describe(
      "Self-contained task for the worker. It shares no context with you — include absolute paths and all background.",
    ),
  tier: tierParam,
  model: z.string().optional().describe("Explicit model override (rare; prefer tier)."),
  cwd: z.string().optional().describe("Working directory (defaults to the task cwd)."),
  allow_writes: z
    .boolean()
    .optional()
    .describe("Let the worker modify files. Only honored if the run allows writes and cwd is not protected."),
  timeout_s: z.number().int().positive().optional().describe("Timeout override in seconds."),
};

const fanOutInputShape = {
  worker: z.string().describe("Which enabled worker runs every item."),
  tier: tierParam,
  prompt_template: z
    .string()
    .describe(
      "Prompt template containing the literal placeholder {item}; each item is substituted in. Must be self-contained per item.",
    ),
  items: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe("One subagent run per item (max 20). Keep items small and independent."),
  cwd: z.string().optional().describe("Working directory (defaults to the task cwd)."),
  timeout_s: z.number().int().positive().optional().describe("Per-item timeout in seconds."),
};

function buildDelegationServer(deps: CoordinatorDeps, runOpts: RunOptions) {
  const { cfg, bus, taskId, workers } = deps;
  const sem = new Semaphore(cfg.defaults.maxConcurrentDelegations);
  let delegationCount = 0;

  interface DelegationParams {
    prompt: string;
    tier?: TierName;
    model?: string;
    cwd?: string;
    allow_writes?: boolean;
    timeout_s?: number;
  }

  /** One delegation: cap check, tier resolution, safety gating, events, semaphore. */
  const invokeOne = async (worker: Worker, input: DelegationParams): Promise<string> => {
    delegationCount += 1;
    if (delegationCount > cfg.defaults.maxDelegationsPerTask) {
      return `Delegation refused: per-task cap of ${cfg.defaults.maxDelegationsPerTask} reached. Finish with what you have.`;
    }
    const cwd = input.cwd ?? runOpts.cwd;
    const wantsWrites = input.allow_writes === true;
    const protectedCwd = isProtectedPath(cfg, cwd);
    const allowWrites = wantsWrites && runOpts.allowWrites && !protectedCwd;
    const tier = input.tier ?? "standard";
    const { model, effort } = resolveTier(cfg, worker.name, tier, input.model);

    const delegationId = newId("dlg");
    bus.emit({
      type: "delegation_started",
      taskId,
      delegationId,
      worker: worker.name,
      prompt: `[${tier}${model ? `:${model}` : ""}] ${input.prompt}`,
      ts: now(),
    });

    const release = await sem.acquire();
    try {
      const result = await worker.invoke(
        input.prompt,
        {
          cwd,
          timeoutMs: (input.timeout_s ?? runOpts.timeoutS ?? cfg.defaults.timeoutS) * 1000,
          allowWrites,
          model,
          effort,
          extraArgs: cfg.workers[worker.name]!.extraArgs,
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
      let text = truncate(result.output, cfg.defaults.outputCapChars);
      if (wantsWrites && !allowWrites) {
        text += `\n\n[cardea: write access was requested but denied — ${
          protectedCwd ? "cwd is under a protected path" : "this run has writes disabled"
        }; the worker ran read-only]`;
      }
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bus.emit({ type: "error", taskId, scope: worker.name, message, fatal: false, ts: now() });
      return `Worker ${worker.name} failed: ${message}`;
    } finally {
      release();
    }
  };

  const makeHandler = (worker: Worker) => async (input: DelegationParams) => ({
    content: [{ type: "text" as const, text: await invokeOne(worker, input) }],
  });

  const fanOutHandler = async (input: {
    worker: string;
    tier?: TierName;
    prompt_template: string;
    items: string[];
    cwd?: string;
    timeout_s?: number;
  }) => {
    if (!workers[input.worker]) {
      return {
        content: [
          { type: "text" as const, text: `fan_out error: unknown or disabled worker "${input.worker}"` },
        ],
        isError: true,
      };
    }
    const worker = workers[input.worker]!;
    const tier = input.tier ?? "fast";
    let outputs: { item: string; output: string }[];
    try {
      outputs = await runFanOut({
        template: input.prompt_template,
        items: input.items,
        tier,
        invoke: (prompt) =>
          invokeOne(worker, {
            prompt,
            tier,
            cwd: input.cwd,
            timeout_s: input.timeout_s,
          }),
      });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `fan_out error: ${(err as Error).message}` }],
        isError: true,
      };
    }
    const combined = outputs
      .map((o, i) => `### [${i + 1}/${outputs.length}] ${o.item.slice(0, 80)}\n${o.output}`)
      .join("\n\n");
    return { content: [{ type: "text" as const, text: truncate(combined, cfg.defaults.outputCapChars) }] };
  };

  const tools: any[] = enabledWorkerNames(cfg).map((name) => {
    const w = cfg.workers[name]!;
    const textOnly = isOpenAICompatibleWorker(w) ? " Text-only: no tools or file access." : "";
    return tool(
      `delegate_to_${name}`,
      `Delegate a self-contained task to ${name}. Best for: ${w.roleHint}.${textOnly} Pick the cheapest sufficient tier.`,
      delegationInputShape,
      makeHandler(workers[name]!),
    );
  });

  tools.push(
    tool(
      "fan_out",
      "Run the same prompt template over many items in parallel, one cheap subagent per item (default tier: fast). Use for embarrassingly parallel work: reviewing N files, checking N candidates, summarizing N documents. Much faster and cheaper than doing items sequentially yourself.",
      fanOutInputShape,
      fanOutHandler,
    ),
  );

  return createSdkMcpServer({ name: "cardea", version: "0.2.0", tools });
}

/** Delegation tool names the coordinator may call, gated on local being enabled. */
export function delegationToolNames(cfg: CardeaConfig): string[] {
  return [
    ...enabledWorkerNames(cfg).map((name) => `mcp__cardea__delegate_to_${name}`),
    "mcp__cardea__fan_out",
  ];
}

/** Run a coordinate-mode task: Claude leads, delegating via the MCP tools. */
export async function runCoordinator(
  runOpts: RunOptions,
  deps: CoordinatorDeps,
): Promise<{ result: string; costUsd?: number }> {
  const { cfg, bus, taskId } = deps;
  const server = buildDelegationServer(deps, runOpts);

  const allowedTools = [
    "Bash",
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    ...delegationToolNames(cfg),
    ...(runOpts.allowWrites ? ["Edit", "Write"] : []),
  ];

  const permissionMode =
    runOpts.posture === "safe" ? "plan" : runOpts.posture === "yolo" ? "acceptEdits" : "default";

  const response = query({
    prompt: runOpts.prompt,
    options: {
      cwd: runOpts.cwd,
      env: coordinatorEnv(cfg),
      mcpServers: { cardea: server },
      allowedTools,
      permissionMode,
      maxTurns: cfg.defaults.maxTurns,
      ...(runOpts.model ? { model: runOpts.model } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: coordinatorAppend(cfg, { cwd: runOpts.cwd, allowWrites: runOpts.allowWrites }),
      },
    },
  });

  let result = "";
  let costUsd: number | undefined;

  for await (const message of response) {
    const m = message as Record<string, any>;
    if (m.type === "assistant") {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            bus.emit({ type: "coordinator_text", taskId, text: block.text, ts: now() });
          } else if (block?.type === "tool_use") {
            bus.emit({
              type: "coordinator_tool_use",
              taskId,
              tool: String(block.name ?? "unknown"),
              input: block.input,
              ts: now(),
            });
          }
        }
      }
    } else if (m.type === "result") {
      if (typeof m.result === "string") result = m.result;
      if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd;
      if (m.subtype && m.subtype !== "success") {
        bus.emit({
          type: "error",
          taskId,
          scope: "coordinator",
          message: `coordinator ended with ${m.subtype}`,
          fatal: false,
          ts: now(),
        });
      }
    }
  }

  return { result, costUsd };
}

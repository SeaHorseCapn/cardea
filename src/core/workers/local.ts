import type { Worker, WorkerContext, WorkerInvokeOpts, WorkerResult } from "../types.js";
import {
  assertApiKeyAvailable,
  isOpenAICompatibleWorker,
  type CardeaConfig,
} from "../config.js";
import { now } from "../events.js";

/**
 * Text-only adapter for any OpenAI-compatible chat completions endpoint:
 * local servers, OpenRouter, Gemini's compatibility endpoint, xAI API, etc.
 * It does not provide tools or filesystem access to the model.
 */
export class OpenAICompatibleWorker implements Worker {
  constructor(
    private cfg: CardeaConfig,
    public readonly name: string,
  ) {}

  async invoke(task: string, opts: WorkerInvokeOpts, ctx: WorkerContext): Promise<WorkerResult> {
    const worker = this.cfg.workers[this.name];
    if (!worker || !isOpenAICompatibleWorker(worker)) {
      throw new Error(`${this.name} is not an OpenAI-compatible worker`);
    }
    if (!worker.enabled) {
      throw new Error(
        `${this.name} is disabled — set workers.${this.name}.enabled=true and configure baseUrl plus tier model names`,
      );
    }
    if (!opts.model) {
      throw new Error(
        `${this.name} has no model for this tier — set workers.${this.name}.tiers.<tier>.model in ~/.cardea/config.json`,
      );
    }
    if (worker.auth === "api-key") {
      assertApiKeyAvailable(this.cfg, this.name);
    }

    const apiKey = worker.apiKeyEnv ? process.env[worker.apiKeyEnv] : undefined;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(`${worker.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: worker.maxTokens,
          messages: [{ role: "user", content: task }],
        }),
      });
      const durationMs = Date.now() - started;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return {
          output: `${this.name} endpoint error ${res.status}: ${body}`,
          exitCode: 1,
          durationMs,
        };
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const output = data.choices?.[0]?.message?.content?.trim() ?? "";
      ctx.bus.emit({
        type: "worker_output_chunk",
        taskId: ctx.taskId,
        delegationId: ctx.delegationId,
        worker: this.name,
        stream: "stdout",
        chunk: `${opts.model} responded (${output.length} chars)`,
        ts: now(),
      });
      return { output, exitCode: output ? 0 : 1, durationMs, raw: data };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LocalWorker extends OpenAICompatibleWorker {
  constructor(cfg: CardeaConfig) {
    super(cfg, "local");
  }
}

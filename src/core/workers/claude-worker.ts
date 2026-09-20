import type { Worker, WorkerContext, WorkerInvokeOpts, WorkerResult } from "../types.js";
import { childEnv, ignoredApiKeyNotice, type CardeaConfig } from "../config.js";
import { appendLine, parseJsonLines, spawnWorker } from "./worker.js";

/**
 * Adapter for the Claude Code CLI in print mode. Used only for `--model claude`
 * (forced single-worker) and panel seats — the coordinator itself talks to
 * Claude through the Agent SDK instead.
 */
export class ClaudeWorker implements Worker {
  readonly name = "claude" as const;

  constructor(private cfg: CardeaConfig) {}

  async invoke(task: string, opts: WorkerInvokeOpts, ctx: WorkerContext): Promise<WorkerResult> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose", // required with stream-json in print mode
      "--permission-mode",
      opts.allowWrites ? "acceptEdits" : "plan",
    ];
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeId) args.push("--resume", opts.resumeId);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    const notice = ignoredApiKeyNotice(this.cfg, this.name);
    const outcome = await spawnWorker(
      {
        bin: this.cfg.binaries.claude,
        args,
        cwd: opts.cwd,
        env: childEnv(this.cfg, this.name),
        timeoutMs: opts.timeoutMs,
        stdinData: task,
      },
      this.name,
      ctx,
    ).catch((err) => {
      throw new Error(appendLine(err instanceof Error ? err.message : String(err), notice));
    });

    const { objects, plain } = parseJsonLines(outcome.stdout);
    let finalMessage = "";
    const assistantTexts: string[] = [];
    for (const obj of objects) {
      const o = obj as Record<string, any>;
      if (o.type === "result" && typeof o.result === "string") {
        finalMessage = o.result;
      } else if (o.type === "assistant") {
        const content = o.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              assistantTexts.push(block.text);
            }
          }
        }
      }
    }
    if (!finalMessage) finalMessage = assistantTexts.at(-1) ?? plain.join("\n");
    if (!finalMessage) finalMessage = outcome.stderr.trim();
    if (outcome.timedOut) {
      finalMessage += "\n[cardea: claude timed out and was killed]";
    }
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      finalMessage = appendLine(finalMessage, notice);
    }

    return {
      output: finalMessage.trim(),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      raw: objects,
    };
  }
}

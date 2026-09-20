import type { Worker, WorkerContext, WorkerInvokeOpts, WorkerResult } from "../types.js";
import { childEnv, ignoredApiKeyNotice, type CardeaConfig } from "../config.js";
import { appendLine, parseJsonLines, spawnWorker } from "./worker.js";

/**
 * Adapter for xAI Grok CLI (Grok Build) using xAI-subscription OAuth from
 * ~/.grok/auth.json.
 *
 * `-p/--single` runs one headless turn. Its flag set mirrors Claude Code, so
 * streaming-json is expected to be Claude-Code-like ({"type":"result",...}),
 * but the parser tolerates unknown shapes and falls back to plain stdout.
 */
export class GrokWorker implements Worker {
  readonly name = "grok" as const;

  constructor(private cfg: CardeaConfig) {}

  async invoke(task: string, opts: WorkerInvokeOpts, ctx: WorkerContext): Promise<WorkerResult> {
    const args = [
      "-p",
      task,
      "--output-format",
      "streaming-json",
      "--cwd",
      opts.cwd,
      "--permission-mode",
      opts.allowWrites ? "auto" : "plan",
      "--max-turns",
      "30",
      "--verbatim",
    ];
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.model) args.push("-m", opts.model);
    if (opts.resumeId) args.push("--resume", opts.resumeId);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    const notice = ignoredApiKeyNotice(this.cfg, this.name);
    const outcome = await spawnWorker(
      {
        bin: this.cfg.binaries.grok,
        args,
        cwd: opts.cwd,
        env: childEnv(this.cfg, this.name),
        timeoutMs: opts.timeoutMs,
      },
      this.name,
      ctx,
    ).catch((err) => {
      throw new Error(appendLine(err instanceof Error ? err.message : String(err), notice));
    });

    const { objects, plain } = parseJsonLines(outcome.stdout);
    let finalMessage = "";
    const textDeltas: string[] = [];
    const assistantTexts: string[] = [];
    for (const obj of objects) {
      const o = obj as Record<string, any>;
      // grok 0.2.x shape: {"type":"text","data":"..."} deltas + {"type":"end",...}
      if (o.type === "text" && typeof o.data === "string") {
        textDeltas.push(o.data);
      } else if (o.type === "result" && typeof o.result === "string") {
        finalMessage = o.result;
      } else if (o.type === "assistant" || o.type === "message") {
        const content = o.message?.content ?? o.content;
        if (typeof content === "string") assistantTexts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              assistantTexts.push(block.text);
            }
          }
        }
      }
    }
    if (!finalMessage && textDeltas.length) finalMessage = textDeltas.join("");
    if (!finalMessage) {
      finalMessage =
        assistantTexts.at(-1) ?? plain.join("\n") ?? "";
    }
    if (!finalMessage) finalMessage = outcome.stderr.trim();
    if (outcome.timedOut) {
      finalMessage += "\n[cardea: grok timed out and was killed]";
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

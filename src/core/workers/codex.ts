import type { Worker, WorkerContext, WorkerInvokeOpts, WorkerResult } from "../types.js";
import { childEnv, ignoredApiKeyNotice, type CardeaConfig } from "../config.js";
import { appendLine, parseJsonLines, spawnWorker } from "./worker.js";

/**
 * Adapter for OpenAI Codex CLI (`codex exec`) using ChatGPT-subscription OAuth
 * from ~/.codex/auth.json.
 *
 * `--json` moves all events to stdout as JSONL. The final agent message shape
 * has churned across versions, so extraction is deliberately tolerant.
 */
export class CodexWorker implements Worker {
  readonly name = "codex" as const;

  constructor(private cfg: CardeaConfig) {}

  async invoke(task: string, opts: WorkerInvokeOpts, ctx: WorkerContext): Promise<WorkerResult> {
    // `exec resume <id>` accepts a narrower flag set — no -C / --sandbox / --color;
    // it runs in the child process's cwd (set by spawnWorker) and reuses the
    // original session's sandbox.
    const args = opts.resumeId
      ? ["exec", "resume", opts.resumeId, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral", "-C", opts.cwd, "--sandbox", opts.allowWrites ? "workspace-write" : "read-only"];
    if (opts.model) args.push("-m", opts.model);
    if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
    if (opts.extraArgs) args.push(...opts.extraArgs);
    args.push("-"); // prompt via stdin

    const notice = ignoredApiKeyNotice(this.cfg, this.name);
    const outcome = await spawnWorker(
      {
        bin: this.cfg.binaries.codex,
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
    for (const obj of objects) {
      const o = obj as Record<string, any>;
      // newer shape: {"type":"item.completed","item":{"type":"agent_message","text":...}}
      if (o.item?.type === "agent_message" && typeof o.item.text === "string") {
        finalMessage = o.item.text;
      }
      // older shape: {"msg":{"type":"agent_message","message":...}}
      else if (o.msg?.type === "agent_message" && typeof o.msg.message === "string") {
        finalMessage = o.msg.message;
      }
      // flat shape: {"type":"agent_message", "message"/"text": ...}
      else if (o.type === "agent_message") {
        const text = o.message ?? o.text;
        if (typeof text === "string") finalMessage = text;
      }
    }
    if (!finalMessage) finalMessage = plain.join("\n") || outcome.stderr.trim();
    if (outcome.timedOut) {
      finalMessage += "\n[cardea: codex timed out and was killed]";
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

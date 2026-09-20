import pc from "picocolors";
import type { CardeaEvent, EventBus, WorkerName } from "../core/events.js";

const workerColor: Record<string, (s: string) => string> = {
  claude: pc.cyan,
  codex: pc.green,
  grok: pc.magenta,
  local: pc.yellow,
};

function tag(worker: WorkerName): string {
  return (workerColor[worker] ?? pc.blue)(`[${worker}]`);
}

/** Line-oriented TTY renderer. Pipes cleanly; no alt-screen tricks. */
export function attachPrettyRenderer(bus: EventBus): void {
  bus.on((ev: CardeaEvent) => {
    switch (ev.type) {
      case "task_started":
        console.log(pc.bold(`\n▶ cardea (${ev.mode}) in ${ev.cwd}`));
        break;
      case "coordinator_text":
        console.log(`${pc.cyan("[cardea]")} ${ev.text}`);
        break;
      case "coordinator_tool_use": {
        const summary =
          typeof ev.input === "object" && ev.input !== null
            ? JSON.stringify(ev.input).slice(0, 120)
            : String(ev.input);
        console.log(pc.dim(`  ⚙ ${ev.tool} ${summary}`));
        break;
      }
      case "delegation_started":
        console.log(
          `${tag(ev.worker)} ${pc.bold("started")} ${pc.dim(ev.prompt.replace(/\s+/g, " ").slice(0, 100))}`,
        );
        break;
      case "worker_output_chunk": {
        // stderr progress is noisy; show dimmed. stdout JSONL is machine data; skip raw JSON lines.
        if (ev.chunk.startsWith("{")) break;
        console.log(pc.dim(`${tag(ev.worker)} ${ev.chunk.slice(0, 200)}`));
        break;
      }
      case "delegation_finished":
        console.log(
          `${tag(ev.worker)} ${pc.bold("finished")} in ${(ev.durationMs / 1000).toFixed(1)}s (exit ${ev.exitCode})`,
        );
        break;
      case "task_finished":
        console.log(pc.bold(`\n■ done in ${(ev.durationMs / 1000).toFixed(1)}s`));
        if (ev.costUsd !== undefined) console.log(pc.dim(`  cost: $${ev.costUsd.toFixed(4)}`));
        console.log(`\n${ev.result}`);
        break;
      case "error":
        console.error(
          `${pc.red(ev.fatal ? "✘ fatal" : "⚠")} ${pc.bold(`[${ev.scope}]`)} ${ev.message}`,
        );
        break;
    }
  });
}

/** JSONL mode: every event straight to stdout — this is the future dashboard protocol. */
export function attachJsonRenderer(bus: EventBus): void {
  bus.on((ev) => console.log(JSON.stringify(ev)));
}

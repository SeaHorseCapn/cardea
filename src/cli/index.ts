#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, CONFIG_PATH } from "../core/config.js";
import { runDoctor } from "../core/doctor.js";

const program = new Command();

program
  .name("cardea")
  .description(
    "Multi-model orchestration across vendor CLIs and OpenAI-compatible workers",
  )
  .version("0.2.0");

program
  .command("doctor")
  .description("Check binaries, auth, and environment health")
  .option("--live", "send a 1-line smoke prompt through each worker (proves OAuth)")
  .action(async (opts: { live?: boolean }) => {
    const cfg = loadConfig();
    const report = runDoctor(cfg);
    for (const c of report.checks) {
      const icon =
        c.level === "ok" ? pc.green("✔") : c.level === "warn" ? pc.yellow("⚠") : pc.red("✘");
      console.log(`${icon} ${pc.bold(c.name.padEnd(18))} ${c.detail}`);
    }
    if (opts.live) {
      const { runLiveChecks } = await import("../core/doctor-live.js");
      const ok = await runLiveChecks(cfg);
      if (!ok) process.exitCode = 1;
    }
    if (!report.healthy) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("Run Cardea as a stdio MCP server")
  .option("--allow-writes", "allow MCP delegate calls to request worker write access", false)
  .action(async (opts: { allowWrites?: boolean }) => {
    const { runMcpServer } = await import("../mcp/server.js");
    await runMcpServer({ allowWrites: Boolean(opts.allowWrites), cwd: process.cwd() });
  });

program
  .command("serve")
  .description("Start the local web dashboard")
  .option("--port <port>", "port to listen on", "4317")
  .option("--host <host>", "bind address (127.0.0.1 local-only; use a Tailscale IP for LAN/tailnet)", "127.0.0.1")
  .action(async (opts: { port: string; host: string }) => {
    const { serve } = await import("../server/serve.js");
    await serve(Number(opts.port) || 4317, opts.host || "127.0.0.1");
  });

program
  .command("config")
  .description("Print the resolved configuration")
  .action(() => {
    const cfg = loadConfig();
    console.log(pc.dim(`# resolved from ${CONFIG_PATH} (missing keys use defaults)`));
    console.log(JSON.stringify(cfg, null, 2));
  });

program
  .argument("[prompt...]", "task for the cardea")
  .option("--cwd <path>", "working directory for coordinator and workers", process.cwd())
  .option(
    "--model <worker[:model]>",
    "bypass the coordinator and run a single configured worker, optionally with an explicit model, e.g. claude:haiku",
  )
  .option("--tier <tier>", "cost/capability tier for single/panel workers: fast|standard|deep")
  .option("--panel", "fan the prompt out to enabled workers, then synthesize", false)
  .option("--allow-writes", "let workers modify files (never inside protected paths)", false)
  .option("--safe", "coordinator runs in plan mode (read-only)", false)
  .option("--yolo", "coordinator auto-accepts its own edits", false)
  .option("--timeout <seconds>", "per-delegation timeout")
  .option("--resume <sessionId>", "resume a past session (requires --model <provider>; continues that CLI's session)")
  .option("--json", "emit raw CardeaEvent JSONL instead of pretty output", false)
  .action(async (promptParts: string[], opts: Record<string, unknown>) => {
    if (!promptParts.length) {
      program.help();
      return;
    }
    const { runFromCli } = await import("./run.js");
    await runFromCli(promptParts.join(" "), opts);
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(`cardea: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});

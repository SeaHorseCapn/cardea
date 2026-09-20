import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import pc from "picocolors";
import { enabledWorkerNames, ensureConfigDir, loadConfig, type CardeaConfig } from "../core/config.js";
import { EventBus, type WorkerName } from "../core/events.js";
import type { RunOptions } from "../core/types.js";
import { runTask } from "../core/orchestrator.js";
import { listSessions, readSession } from "./sessions.js";
import { INDEX_HTML } from "./ui.js";
import { attachRunPersistence, listPersistedRuns, runsDir } from "../core/runs.js";

interface RunRequest {
  type: "run";
  clientRef?: string;
  prompt: string;
  mode?: "coordinate" | "single" | "panel";
  worker?: string;
  cwd?: string;
  allowWrites?: boolean;
  posture?: "safe" | "default" | "yolo";
  timeoutS?: number;
  tier?: string;
  resumeId?: string;
}

function startRun(cfg: CardeaConfig, req: RunRequest, submitter: WebSocket, broadcast: (s: string) => void): void {
  const bus = new EventBus();
  let accepted = false;
  attachRunPersistence(bus);

  bus.on((ev) => {
    if (ev.type === "task_started") {
      if (!accepted) {
        accepted = true;
        try {
          submitter.send(JSON.stringify({ type: "run_accepted", clientRef: req.clientRef, taskId: ev.taskId }));
        } catch {
          /* client gone */
        }
      }
    }
    broadcast(JSON.stringify(ev));
  });

  // Resume forces single-worker mode for the session's own provider.
  const resumeId = req.resumeId && typeof req.resumeId === "string" ? req.resumeId : undefined;
  const mode = resumeId ? "single" : (req.mode ?? "coordinate");
  const workerNames = enabledWorkerNames(cfg);
  const worker = workerNames.includes(req.worker ?? "") ? (req.worker as WorkerName) : undefined;
  const opts: RunOptions = {
    prompt: String(req.prompt),
    cwd: req.cwd && req.cwd.trim() ? req.cwd.trim() : process.cwd(),
    mode: mode === "single" && !worker ? "coordinate" : mode,
    worker: mode === "single" ? (worker ?? "claude") : undefined,
    allowWrites: Boolean(req.allowWrites) && req.posture !== "safe",
    posture: req.posture ?? "default",
    timeoutS: typeof req.timeoutS === "number" && req.timeoutS > 0 ? req.timeoutS : undefined,
    tier: ["fast", "standard", "deep"].includes(req.tier ?? "")
      ? (req.tier as RunOptions["tier"])
      : undefined,
    resumeId,
  };

  runTask(opts, cfg, bus).catch(() => {
    /* fatal error already emitted on the bus */
  });
}

export async function serve(port: number, host = "127.0.0.1"): Promise<void> {
  const cfg = loadConfig();
  ensureConfigDir();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
    } else if (url === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(listPersistedRuns()));
    } else if (url.startsWith("/api/sessions/detail")) {
      const token = new URL(url, "http://x").searchParams.get("token") ?? "";
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(readSession(token)));
      } catch {
        res.writeHead(404).end("not found");
      }
    } else if (url.startsWith("/api/sessions")) {
      const q = new URL(url, "http://x").searchParams;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          listSessions({
            provider: q.get("provider") ?? undefined,
            q: q.get("q") ?? undefined,
            limit: q.get("limit") ? Number(q.get("limit")) : undefined,
          }),
        ),
      );
    } else if (url.startsWith("/api/runs/")) {
      const id = decodeURIComponent(url.slice("/api/runs/".length));
      if (!/^[\w.-]+$/.test(id)) {
        res.writeHead(400).end("bad id");
        return;
      }
      try {
        const body = readFileSync(join(runsDir(), `${id}.jsonl`), "utf8");
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    } else {
      res.writeHead(404).end("not found");
    }
  });

  const wss = new WebSocketServer({ server });
  const broadcast = (s: string) => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(s);
        } catch {
          /* client gone */
        }
      }
    }
  };

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "hello",
        version: "0.2.0",
        defaultCwd: process.cwd(),
        protectedPaths: cfg.safety.protectedPaths,
        workers: enabledWorkerNames(cfg),
      }),
    );
    ws.on("message", (data) => {
      let msg: RunRequest;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "run" && typeof msg.prompt === "string" && msg.prompt.trim()) {
        startRun(cfg, msg, ws, broadcast);
      }
    });
  });

  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  console.log(pc.bold(`cardea dashboard: ${pc.cyan(`http://${host}:${port}`)}`));
  console.log(pc.dim("localhost only — Ctrl-C to stop"));
}

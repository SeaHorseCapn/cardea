import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { BoardStore } from "./store.js";
import { boardDir, ensureBoardDir } from "./tokens.js";

/**
 * The operator (coordinator / CLI) API.
 *
 * It is deliberately NOT served on the worker listener. The worker listener is the one an operator
 * may put behind a tunnel or reverse proxy, and anything arriving through such a proxy looks like a
 * loopback connection, so no header or source-address check there could be trusted. Instead the
 * operator API lives on a Unix domain socket inside the owner-only board directory (filesystem
 * permissions are the authentication). Where Unix sockets are unavailable (win32) it falls back to
 * a separate loopback listener that requires a random bearer secret stored in an owner-only file.
 */

export type OperatorTransport = "unix" | "tcp";

export function defaultOperatorTransport(): OperatorTransport {
  return process.platform === "win32" ? "tcp" : "unix";
}

export function operatorSocketPath(dir = boardDir()): string {
  return join(dir, "operator.sock");
}

export function operatorInfoPath(dir = boardDir()): string {
  return join(dir, "operator.json");
}

export interface OperatorTcpInfo {
  port: number;
  secret: string;
  pid: number;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 8 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) resolve({});
      else {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function handleOperatorApi(req: IncomingMessage, res: ServerResponse, store: BoardStore): Promise<void> {
  const url = new URL(req.url ?? "/", "http://operator.invalid");
  try {
    if (req.method === "POST" && url.pathname === "/api/tasks") {
      const tasks = store.postTask((await readBody(req)) as Parameters<BoardStore["postTask"]>[0], "coordinator");
      sendJson(res, 200, { tasks });
    } else if (req.method === "POST" && url.pathname === "/api/batches") {
      const batch = store.postBatch((await readBody(req)) as Parameters<BoardStore["postBatch"]>[0], "coordinator");
      sendJson(res, 200, { batch });
    } else if (req.method === "GET" && url.pathname === "/api/tasks") {
      sendJson(res, 200, {
        tasks: store.listTasks({
          status: (url.searchParams.get("status") ?? undefined) as never,
          batch_id: url.searchParams.get("batch_id") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
        }),
      });
    } else if (req.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
      const task = store.getTask(decodeURIComponent(url.pathname.slice("/api/tasks/".length)));
      if (!task) sendJson(res, 404, { error: "task not found" });
      else sendJson(res, 200, { task });
    } else if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/cancel")) {
      const id = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/cancel".length));
      const body = (await readBody(req)) as { reason?: string };
      sendJson(res, 200, { task: store.cancel(id, body.reason) });
    } else if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
      const batch = store.getBatch(decodeURIComponent(url.pathname.slice("/api/batches/".length)));
      if (!batch) sendJson(res, 404, { error: "batch not found" });
      else sendJson(res, 200, batch);
    } else if (req.method === "GET" && url.pathname === "/api/stats") {
      sendJson(res, 200, store.stats());
    } else if (req.method === "GET" && url.pathname === "/api/wait") {
      const taskId = url.searchParams.get("task_id") ?? undefined;
      const batchId = url.searchParams.get("batch_id") ?? undefined;
      const timeoutS = Math.min(Number(url.searchParams.get("timeout_s") ?? "25") || 25, 25);
      const deadline = Date.now() + timeoutS * 1000;
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      while (Date.now() < deadline && !closed) {
        if (taskId) {
          const task = store.getTask(taskId);
          if (task && ["done", "failed", "cancelled"].includes(task.status)) {
            sendJson(res, 200, { task });
            return;
          }
        }
        if (batchId) {
          const batch = store.getBatch(batchId);
          if (batch && Object.entries(batch.counts).every(([status, count]) => status === "done" || status === "failed" || status === "cancelled" || count === 0)) {
            sendJson(res, 200, batch);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!closed) sendJson(res, 200, { timeout: true });
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { error: (err as Error).message });
  }
}

function secretMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

export interface OperatorServer {
  transport: OperatorTransport;
  server: Server;
  /** Filesystem path of the socket (unix) or of operator.json (tcp). */
  location: string;
  close: () => Promise<void>;
}

export async function startOperatorServer(store: BoardStore, options: { dir?: string; transport?: OperatorTransport } = {}): Promise<OperatorServer> {
  const dir = ensureBoardDir(options.dir ?? boardDir());
  const transport = options.transport ?? defaultOperatorTransport();

  if (transport === "unix") {
    const path = operatorSocketPath(dir);
    if (existsSync(path)) {
      if (await probeSocket(path)) throw new Error("another board is already running for this Cardea home");
      unlinkSync(path);
    }
    const server = createServer((req, res) => void handleOperatorApi(req, res, store));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
    return {
      transport,
      server,
      location: path,
      close: () =>
        new Promise((resolve) => {
          server.close(() => {
            try {
              unlinkSync(path);
            } catch {
              // already gone
            }
            resolve();
          });
          server.closeAllConnections?.();
        }),
    };
  }

  const infoPath = operatorInfoPath(dir);
  const secret = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    if (!secretMatches(req.headers.authorization, secret)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    void handleOperatorApi(req, res, store);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const info: OperatorTcpInfo = { port, secret, pid: process.pid };
  writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
  try {
    chmodSync(infoPath, 0o600);
  } catch {
    // not supported on this platform
  }
  return {
    transport,
    server,
    location: infoPath,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          try {
            unlinkSync(infoPath);
          } catch {
            // already gone
          }
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}

export function readOperatorTcpInfo(dir = boardDir()): OperatorTcpInfo | undefined {
  const path = operatorInfoPath(dir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OperatorTcpInfo;
  } catch {
    return undefined;
  }
}

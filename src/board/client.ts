import { request as httpRequest, type RequestOptions } from "node:http";
import { existsSync } from "node:fs";
import { boardDir } from "./tokens.js";
import { defaultOperatorTransport, operatorSocketPath, readOperatorTcpInfo, type OperatorTransport } from "./operator.js";

const NOT_RUNNING = "no running board found; start one with `cardea board serve`";

function connectionOptions(transport: OperatorTransport): RequestOptions {
  const dir = boardDir();
  if (transport === "unix") {
    const socketPath = operatorSocketPath(dir);
    if (!existsSync(socketPath)) throw new Error(NOT_RUNNING);
    return { socketPath };
  }
  const info = readOperatorTcpInfo(dir);
  if (!info) throw new Error(NOT_RUNNING);
  return { host: "127.0.0.1", port: info.port, headers: { authorization: `Bearer ${info.secret}` } };
}

/** Talk to the operator API of the board running for the current Cardea home. */
export async function operatorRequest(path: string, init: { method?: string; body?: unknown; transport?: OperatorTransport } = {}): Promise<unknown> {
  const transport = init.transport ?? defaultOperatorTransport();
  const conn = connectionOptions(transport);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        ...conn,
        path,
        method: init.method ?? "GET",
        headers: {
          ...(conn.headers ?? {}),
          "content-type": "application/json",
          ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let body: { error?: string } = {};
          try {
            body = text ? (JSON.parse(text) as { error?: string }) : {};
          } catch {
            // non-JSON error body
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(body.error ?? `board request failed: ${res.statusCode}`));
          else resolve(body);
        });
      },
    );
    req.on("error", () => reject(new Error("no board is running for this Cardea home; start one with `cardea board serve`")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const boardClient = {
  postTask: (input: unknown) => operatorRequest("/api/tasks", { method: "POST", body: input }),
  postBatch: (input: unknown) => operatorRequest("/api/batches", { method: "POST", body: input }),
  listTasks: (params: URLSearchParams) => operatorRequest(`/api/tasks?${params.toString()}`),
  getTask: (id: string) => operatorRequest(`/api/tasks/${encodeURIComponent(id)}`),
  getBatch: (id: string) => operatorRequest(`/api/batches/${encodeURIComponent(id)}`),
  cancelTask: (id: string, reason?: string) => operatorRequest(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason } }),
  stats: () => operatorRequest("/api/stats"),
  waitFor: (params: URLSearchParams) => operatorRequest(`/api/wait?${params.toString()}`),
};

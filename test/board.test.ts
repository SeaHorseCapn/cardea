import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BoardStore } from "../src/board/store.js";
import { applyEvents, claimTaskEvents, emptyState, maintenanceEvents, postBatchEvents, postTaskEvents, submitResultEvents } from "../src/board/state.js";
import { createBoardHttpServer, startupWarnings } from "../src/board/http.js";
import { operatorInfoPath, operatorSocketPath } from "../src/board/operator.js";
import { operatorRequest } from "../src/board/client.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { parseConfig } from "../src/core/config.js";
import { buildWorkers } from "../src/core/orchestrator.js";
import { canListenTcp, canListenUnix } from "./socket-support.js";
import { createWorkerToken, ensureBoardDir, hashToken, revokeWorkerToken } from "../src/board/tokens.js";
import type { WorkerIdentity } from "../src/board/types.js";

let oldHome: string | undefined;

function hermeticHome(): string {
  if (oldHome === undefined) oldHome = process.env.CARDEA_HOME ?? "";
  const home = mkdtempSync(join(tmpdir(), "cardea-board-test-"));
  process.env.CARDEA_HOME = home;
  return home;
}

afterEach(() => {
  if (oldHome === undefined || oldHome === "") delete process.env.CARDEA_HOME;
  else process.env.CARDEA_HOME = oldHome;
  oldHome = undefined;
});

function worker(name: string, caps: string[] = [], max = 1): WorkerIdentity {
  return { name, capabilities: caps, can_post: false, max_concurrent: max };
}

describe("board state machine", () => {
  it("moves through claim, heartbeat, release, submit, and cancel transitions", () => {
    const store = new BoardStore(hermeticHome());
    store.load();
    const [task] = store.postTask({ title: "t", body: "body" }, "coordinator");
    expect(task?.status).toBe("queued");
    const claimed = store.claim(worker("w1"));
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.attempts).toBe(1);
    expect(store.heartbeat(claimed!.id, "w1").lease_expires_at).toBeTruthy();
    expect(store.release(claimed!.id, "w1", "pause").status).toBe("queued");
    const again = store.claim(worker("w1"));
    const done = store.submit(again!.id, "w1", { status: "done", summary: "complete" });
    expect(done.status).toBe("done");

    const [other] = store.postTask({ title: "cancel", body: "body" }, "coordinator");
    expect(store.cancel(other!.id).status).toBe("cancelled");
  });

  it("lets exactly one worker win a race for one task", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "race", body: "body" }, "coordinator", "2026-01-01T00:00:00.000Z"));
    const w1 = claimTaskEvents(state, worker("a"), undefined, "2026-01-01T00:00:01.000Z");
    state = applyEvents(state, w1);
    const w2 = claimTaskEvents(state, worker("b"), undefined, "2026-01-01T00:00:01.000Z");
    expect(w1).toHaveLength(1);
    expect(w2).toHaveLength(0);
  });

  it("requeues expired leases and counts an attempt", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "lease", body: "body", lease_s: 1 }, "coordinator", "2026-01-01T00:00:00.000Z"));
    state = applyEvents(state, claimTaskEvents(state, worker("w"), undefined, "2026-01-01T00:00:00.000Z"));
    state = applyEvents(state, maintenanceEvents(state, "2026-01-01T00:00:02.000Z"));
    const task = Object.values(state.tasks)[0]!;
    expect(task.status).toBe("queued");
    expect(task.attempts).toBe(1);
  });

  it("fails on max_attempts exhaustion", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "lease", body: "body", lease_s: 1, max_attempts: 1 }, "coordinator", "2026-01-01T00:00:00.000Z"));
    state = applyEvents(state, claimTaskEvents(state, worker("w"), undefined, "2026-01-01T00:00:00.000Z"));
    state = applyEvents(state, maintenanceEvents(state, "2026-01-01T00:00:02.000Z"));
    expect(Object.values(state.tasks)[0]!.status).toBe("failed");
  });

  it("enforces capabilities and not_workers", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "cap", body: "body", requires: ["browser"], not_workers: ["blocked"] }, "coordinator"));
    expect(claimTaskEvents(state, worker("plain"))).toHaveLength(0);
    expect(claimTaskEvents(state, worker("blocked", ["browser"]))).toHaveLength(0);
    expect(claimTaskEvents(state, worker("ok", ["browser"]))).toHaveLength(1);
  });

  it("assigns replicas to distinct workers", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "rep", body: "body", replicas: 2 }, "coordinator"));
    state = applyEvents(state, claimTaskEvents(state, worker("a"), undefined, "2026-01-01T00:00:00.000Z"));
    expect(claimTaskEvents(state, worker("a"), undefined, "2026-01-01T00:00:01.000Z")).toHaveLength(0);
    expect(claimTaskEvents(state, worker("b"), undefined, "2026-01-01T00:00:01.000Z")).toHaveLength(1);
  });

  it("unblocks dependencies and propagates dependency failure", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "parent", body: "body" }, "coordinator"));
    const parent = Object.values(state.tasks)[0]!;
    state = applyEvents(state, postTaskEvents(state, { title: "child", body: "child", depends_on: [parent.id] }, "coordinator"));
    state = applyEvents(state, claimTaskEvents(state, worker("w")));
    state = applyEvents(state, submitResultEvents(state, parent.id, "w", { status: "done", summary: "parent summary" }));
    const child = Object.values(state.tasks).find((task) => task.title === "child")!;
    expect(child.status).toBe("queued");
    expect(child.body).toContain("parent summary");

    state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "p", body: "body" }, "coordinator"));
    const p = Object.values(state.tasks)[0]!;
    state = applyEvents(state, postTaskEvents(state, { title: "c", body: "body", depends_on: [p.id] }, "coordinator"));
    state = applyEvents(state, claimTaskEvents(state, worker("w")));
    state = applyEvents(state, submitResultEvents(state, p.id, "w", { status: "failed", summary: "no" }));
    expect(Object.values(state.tasks).find((task) => task.title === "c")!.status).toBe("failed");
  });

  it("returns batch counts", () => {
    const store = new BoardStore(hermeticHome());
    store.load();
    const batch = store.postBatch({ template: "do {item}", items: ["a", "b"] }, "coordinator");
    const info = store.getBatch(batch.id)!;
    expect(info.counts.queued).toBe(2);
    expect(info.results).toHaveLength(2);
  });

  it("review_of excludes the implementer", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "impl", body: "body" }, "coordinator"));
    const impl = Object.values(state.tasks)[0]!;
    state = applyEvents(state, claimTaskEvents(state, worker("alice")));
    state = applyEvents(state, submitResultEvents(state, impl.id, "alice", { status: "done", summary: "built it" }));
    state = applyEvents(state, postTaskEvents(state, { title: "review", body: "review", review_of: impl.id }, "coordinator"));
    const review = Object.values(state.tasks).find((task) => task.title === "review")!;
    expect(review.not_workers).toContain("alice");
    expect(claimTaskEvents(state, worker("alice"))).toHaveLength(0);
    expect(claimTaskEvents(state, worker("bob"))).toHaveLength(1);
  });

  it("enforces size caps and summary word cap", () => {
    let state = emptyState();
    expect(() => postTaskEvents(state, { title: "big", body: "x".repeat(65 * 1024) }, "coordinator")).toThrow(/64 KB/);
    state = applyEvents(state, postTaskEvents(state, { title: "t", body: "body" }, "coordinator"));
    state = applyEvents(state, claimTaskEvents(state, worker("w")));
    expect(() => submitResultEvents(state, Object.values(state.tasks)[0]!.id, "w", { status: "done", summary: Array.from({ length: 201 }, () => "x").join(" ") })).toThrow(/200 words/);
  });

  it("replays the event log to the same state", () => {
    const home = hermeticHome();
    const store = new BoardStore(join(home, "board"));
    store.load();
    const [task] = store.postTask({ title: "persist", body: "body" }, "coordinator");
    store.claim(worker("w"));
    store.submit(task!.id, "w", { status: "done", summary: "ok" });
    const before = store.snapshot();
    const reloaded = new BoardStore(join(home, "board"));
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(before);
  });
});

describe("board log compaction is crash-safe", () => {
  function seeded(dir: string): BoardStore {
    const store = new BoardStore(dir);
    store.load();
    const [t1] = store.postTask({ title: "a", body: "b", max_attempts: 5 }, "coordinator");
    store.claim(worker("w"));
    store.release(t1!.id, "w", "again");
    store.claim(worker("w")); // attempts == 2
    store.postTask({ title: "c", body: "b" }, "coordinator");
    return store;
  }

  it("assigns increasing seq numbers to every event", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const seqs = readFileSync(store.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs.length).toBeGreaterThan(3);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("survives a crash after the snapshot is written but before the log is truncated", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const live = store.snapshot();
    expect(Object.values(live.tasks).find((t) => t.title === "a")!.attempts).toBe(2);
    store.writeSnapshot(); // crash here: log NOT truncated
    expect(readFileSync(store.eventsPath, "utf8").length).toBeGreaterThan(0);
    const reloaded = new BoardStore(dir);
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(live);
    expect(Object.values(reloaded.snapshot().tasks).find((t) => t.title === "a")!.attempts).toBe(2);
    // and new events continue the sequence, still correct after a further reload
    reloaded.postTask({ title: "d", body: "b" }, "coordinator");
    const again = new BoardStore(dir);
    again.load();
    expect(again.snapshot()).toEqual(reloaded.snapshot());
  });

  it("reloads identically after a full compaction and keeps counting from the snapshot seq", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const live = store.snapshot();
    store.compact(0);
    expect(readFileSync(store.eventsPath, "utf8")).toBe("");
    const reloaded = new BoardStore(dir);
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(live);
    reloaded.postTask({ title: "after", body: "b" }, "coordinator");
    const seq = (JSON.parse(readFileSync(reloaded.eventsPath, "utf8").trim().split("\n")[0]!) as { seq: number }).seq;
    expect(seq).toBeGreaterThan(5);
    const third = new BoardStore(dir);
    third.load();
    expect(third.snapshot()).toEqual(reloaded.snapshot());
  });

  it("ignores and cleans up a torn temp snapshot", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const live = store.snapshot();
    writeFileSync(`${store.snapshotPath}.tmp`, '{"version":2,"seq":99,"sta');
    const reloaded = new BoardStore(dir);
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(live);
    expect(existsSync(`${store.snapshotPath}.tmp`)).toBe(false);
  });

  it("loads event logs written before seq existed, and a pre-seq snapshot", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const live = store.snapshot();
    const legacy = readFileSync(store.eventsPath, "utf8").split("\n").filter(Boolean).map((l) => {
      const e = JSON.parse(l) as { seq?: number };
      delete e.seq;
      return JSON.stringify(e);
    });
    writeFileSync(store.eventsPath, `${legacy.join("\n")}\n`);
    const reloaded = new BoardStore(dir);
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(live);
    // compacting a legacy log, then crashing before truncation, must not double-apply
    reloaded.writeSnapshot();
    const afterCrash = new BoardStore(dir);
    afterCrash.load();
    expect(afterCrash.snapshot()).toEqual(live);

    // a bare pre-seq snapshot plus an empty log
    const dir2 = join(hermeticHome(), "board");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "snapshot.json"), JSON.stringify(live));
    const fromBare = new BoardStore(dir2);
    fromBare.load();
    expect(fromBare.snapshot()).toEqual(live);
  });

  it("falls back to a full replay for a corrupt snapshot only when the whole log is present", () => {
    const dir = join(hermeticHome(), "board");
    const store = seeded(dir);
    const live = store.snapshot();
    writeFileSync(store.snapshotPath, "{not json");
    const replayed = new BoardStore(dir);
    replayed.load();
    expect(replayed.snapshot()).toEqual(live);

    // after a real compaction the log is no longer a full history: refuse rather than start empty
    const store2 = new BoardStore(dir);
    store2.load();
    store2.compact(0);
    writeFileSync(store2.snapshotPath, "{not json");
    expect(() => new BoardStore(dir).load()).toThrow(/refusing to start/);
    store2.postTask({ title: "later", body: "b" }, "coordinator");
    expect(() => new BoardStore(dir).load()).toThrow(/refusing to start/);
  });
});

describe("board hardening (state)", () => {
  it("passes only dependency summaries, labelled untrusted, never full output", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "parent", body: "body" }, "coordinator"));
    const parent = Object.values(state.tasks)[0]!;
    state = applyEvents(state, postTaskEvents(state, { title: "child", body: "child body", depends_on: [parent.id] }, "coordinator"));
    state = applyEvents(state, claimTaskEvents(state, worker("w")));
    state = applyEvents(state, submitResultEvents(state, parent.id, "w", { status: "done", summary: "short summary", output: "FULL-OUTPUT-SECRET-MARKER" }));
    const child = Object.values(state.tasks).find((task) => task.title === "child")!;
    expect(child.body).toContain("short summary");
    expect(child.body).toMatch(/untrusted/i);
    expect(child.body).not.toContain("FULL-OUTPUT-SECRET-MARKER");
    expect(child.body.endsWith("child body")).toBe(true);
  });

  it("never lets a claim widen the capabilities a token was issued with", () => {
    let state = emptyState();
    state = applyEvents(state, postTaskEvents(state, { title: "cap", body: "body", requires: ["browser"] }, "coordinator"));
    expect(claimTaskEvents(state, worker("plain", []), ["browser"])).toHaveLength(0);
    expect(claimTaskEvents(state, worker("real", ["browser", "code"]), ["browser"])).toHaveLength(1);
  });

  it("rejects unknown dependencies and cross-origin references from workers", () => {
    let state = emptyState();
    expect(() => postTaskEvents(state, { title: "x", body: "b", depends_on: ["task_missing"] }, "coordinator")).toThrow(/unknown task/);
    state = applyEvents(state, postTaskEvents(state, { title: "coord", body: "b" }, "coordinator"));
    const coord = Object.values(state.tasks)[0]!;
    expect(() => postTaskEvents(state, { title: "snoop", body: "b", depends_on: [coord.id] }, "worker:evil")).toThrow(/their own/);
    expect(() => postTaskEvents(state, { title: "snoop", body: "b", review_of: coord.id }, "worker:evil")).toThrow(/their own/);
  });

  it("deduplicates on dedupe_key while the earlier task is live", () => {
    const store = new BoardStore(hermeticHome());
    store.load();
    const [first] = store.postTask({ title: "t", body: "b", dedupe_key: "k" }, "coordinator");
    const again = store.postTask({ title: "t", body: "b", dedupe_key: "k" }, "coordinator");
    expect(again[0]!.id).toBe(first!.id);
    expect(store.stats().total).toBe(1);
    store.cancel(first!.id);
    expect(store.postTask({ title: "t", body: "b", dedupe_key: "k" }, "coordinator")[0]!.id).not.toBe(first!.id);
  });

  it("caps batch size", () => {
    const state = emptyState();
    expect(() => postBatchEvents(state, { template: "{item}", items: Array.from({ length: 1001 }, (_, i) => String(i)) }, "coordinator")).toThrow(/at most/);
  });

  it("survives a torn final event-log line", () => {
    const dir = join(hermeticHome(), "board");
    const store = new BoardStore(dir);
    store.load();
    store.postTask({ title: "t", body: "b" }, "coordinator");
    appendFileSync(store.eventsPath, '{"type":"task_cla');
    const reloaded = new BoardStore(dir);
    reloaded.load();
    expect(reloaded.stats().total).toBe(1);
  });

  it("warns for non-loopback hosts and URL tokens only", () => {
    expect(startupWarnings("127.0.0.1", false)).toEqual([]);
    expect(startupWarnings("localhost", false)).toEqual([]);
    expect(startupWarnings("::1", false)).toEqual([]);
    expect(startupWarnings("0.0.0.0", false).join()).toMatch(/non-loopback/);
    expect(startupWarnings("127.0.0.1", true).join()).toMatch(/URL tokens/);
  });

  it("persists only token hashes, with owner-only permissions", () => {
    const home = hermeticHome();
    const created = createWorkerToken({ name: "w1" });
    const file = join(home, "board", "tokens.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(created.token);
    expect(text).toContain(hashToken(created.token));
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "board")).mode & 0o777).toBe(0o700);
    }
  });
});

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : entry.isFile() ? [path] : [];
  });
}

async function connectWorker(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

describe.skipIf(!canListenTcp)("board worker listener (real HTTP)", () => {
  it("requires auth, rejects wrong and revoked tokens, and rate limits", async () => {
    hermeticHome();
    const created = createWorkerToken({ name: "w" });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, rateLimit: 1 });
    try {
      expect((await fetch(`${running.url}/mcp`)).status).toBe(401);
      expect((await fetch(`${running.url}/mcp`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      expect((await fetch(`${running.url}/mcp`, { headers: { authorization: `Bearer ${created.token}` } })).status).not.toBe(401);
      expect((await fetch(`${running.url}/mcp`, { headers: { authorization: `Bearer ${created.token}` } })).status).toBe(429);
    } finally {
      await running.close();
    }

    const second = createWorkerToken({ name: "revoked" });
    revokeWorkerToken("revoked");
    const running2 = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    try {
      expect((await fetch(`${running2.url}/mcp`, { headers: { authorization: `Bearer ${second.token}` } })).status).toBe(401);
    } finally {
      await running2.close();
    }
  });

  it("serves no operator surface: x-cardea-local and operator paths are 404 and do nothing", async () => {
    hermeticHome();
    const worker1 = createWorkerToken({ name: "w", can_post: true });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    try {
      const attempts: [string, string, Record<string, string>, string?][] = [
        ["POST", "/api/tasks", { "x-cardea-local": "1", "content-type": "application/json" }, JSON.stringify({ title: "evil", body: "evil" })],
        ["POST", "/api/batches", { "x-cardea-local": "1", "content-type": "application/json" }, JSON.stringify({ template: "{item}", items: ["a"] })],
        ["GET", "/api/tasks", { "x-cardea-local": "1" }],
        ["GET", "/api/stats", { "x-cardea-local": "1" }],
        ["GET", "/api/wait?task_id=x", { "x-cardea-local": "1" }],
        ["POST", "/api/tasks/task_x/cancel", { "x-cardea-local": "1" }, "{}"],
        // even a valid worker token and loopback source grant nothing outside /mcp
        ["POST", "/api/tasks", { authorization: `Bearer ${worker1.token}`, "x-cardea-local": "1", "content-type": "application/json" }, JSON.stringify({ title: "evil", body: "evil" })],
        ["GET", "/", {}],
        ["GET", "/mcp/" + worker1.token, {}],
      ];
      for (const [method, path, headers, body] of attempts) {
        const res = await fetch(`${running.url}${path}`, { method, headers, body });
        expect([401, 404], `${method} ${path}`).toContain(res.status);
        expect(await res.text()).not.toMatch(/"tasks"|"task"|"counts"/);
      }
      expect(running.store.stats().total).toBe(0);
    } finally {
      await running.close();
    }
  });

  it("round trips over real HTTP with the MCP SDK and lists only board worker tools", async () => {
    hermeticHome();
    const created = createWorkerToken({ name: "worker", capabilities: ["code"] });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    const client = await connectWorker(running.url, created.token);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["claim_task", "heartbeat", "list_my_tasks", "release_task", "submit_result", "whoami"]);
      for (const forbidden of ["delegate", "fan_out", "panel", "list_workers", "post_task", "post_batch"]) expect(names).not.toContain(forbidden);

      const [posted] = running.store.postTask({ title: "remote", body: "do it", requires: ["code"] }, "coordinator");
      const claimed = await client.callTool({ name: "claim_task", arguments: { capabilities: ["code"] } });
      const task = claimed.structuredContent?.task as { id: string };
      expect(task.id).toBe(posted!.id);
      const beat = await client.callTool({ name: "heartbeat", arguments: { task_id: task.id, note: "working" } });
      expect(beat.isError).not.toBe(true);
      const submitted = await client.callTool({ name: "submit_result", arguments: { task_id: task.id, status: "done", summary: "finished", output: "details" } });
      expect(submitted.structuredContent?.task).toMatchObject({ status: "done" });
      expect(running.store.getTask(task.id)?.result?.summary).toBe("finished");
    } finally {
      await client.close();
      await running.close();
    }
  });

  it("describes every worker-facing tool that returns worker text as untrusted", async () => {
    hermeticHome();
    const created = createWorkerToken({ name: "p", can_post: true });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    const client = await connectWorker(running.url, created.token);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ["claim_task", "submit_result", "list_my_tasks", "post_task", "post_batch", "heartbeat", "release_task"]) {
        expect(tools.find((t) => t.name === name)?.description, name).toMatch(/untrusted/i);
      }
    } finally {
      await client.close();
      await running.close();
    }
  });

  it("gates can_post and records worker origins", async () => {
    hermeticHome();
    const noPost = createWorkerToken({ name: "nopost" });
    const canPost = createWorkerToken({ name: "poster", can_post: true });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    try {
      const plain = await connectWorker(running.url, noPost.token);
      try {
        expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain("post_task");
        const denied = await plain.callTool({ name: "post_task", arguments: { title: "x", body: "y" } }).then((r) => r.isError === true, () => true);
        expect(denied).toBe(true);
      } finally {
        await plain.close();
      }
      expect(running.store.stats().total).toBe(0);

      const poster = await connectWorker(running.url, canPost.token);
      try {
        const res = await poster.callTool({ name: "post_task", arguments: { title: "from worker", body: "body" } });
        expect(res.isError).not.toBe(true);
        expect((res.structuredContent?.tasks as { origin: string }[])[0]!.origin).toBe("worker:poster");
      } finally {
        await poster.close();
      }
    } finally {
      await running.close();
    }
  });

  it("makes exactly one of two racing workers win one task over HTTP", async () => {
    hermeticHome();
    const a = createWorkerToken({ name: "a" });
    const b = createWorkerToken({ name: "b" });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    const [ca, cb] = await Promise.all([connectWorker(running.url, a.token), connectWorker(running.url, b.token)]);
    try {
      running.store.postTask({ title: "one", body: "b" }, "coordinator");
      const [ra, rb] = await Promise.all([ca.callTool({ name: "claim_task", arguments: {} }), cb.callTool({ name: "claim_task", arguments: {} })]);
      const winners = [ra, rb].filter((r) => (r.structuredContent as { task: unknown }).task);
      expect(winners).toHaveLength(1);
    } finally {
      await Promise.all([ca.close(), cb.close()]);
      await running.close();
    }
  });

  it("never writes raw tokens to the event log or anywhere else under the home", async () => {
    const home = hermeticHome();
    const created = createWorkerToken({ name: "w", can_post: true });
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    const client = await connectWorker(running.url, created.token);
    try {
      await client.callTool({ name: "post_task", arguments: { title: "t", body: "b" } });
      await client.callTool({ name: "claim_task", arguments: {} });
    } finally {
      await client.close();
      await running.close();
    }
    const files = allFiles(home);
    expect(files.some((f) => f.endsWith("events.jsonl"))).toBe(true);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain(created.token);
  });

  it("only accepts /mcp/<token> when explicitly opted in", async () => {
    hermeticHome();
    const created = createWorkerToken({ name: "w" });
    const off = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true });
    try {
      expect((await fetch(`${off.url}/mcp/${created.token}`)).status).toBe(404);
    } finally {
      await off.close();
    }
    const on = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, allowUrlToken: true });
    try {
      expect((await fetch(`${on.url}/mcp/${created.token}`)).status).not.toBe(401);
      expect((await fetch(`${on.url}/mcp/wrong`)).status).toBe(401);
    } finally {
      await on.close();
    }
  });
});

describe("board operator API", () => {
  it.skipIf(!canListenUnix)("is served on an owner-only Unix socket and works over it", async () => {
    const home = hermeticHome();
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "unix" });
    try {
      const sock = operatorSocketPath();
      expect(sock).toBe(join(home, "board", "operator.sock"));
      expect(statSync(sock).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "board")).mode & 0o777).toBe(0o700);

      const posted = (await operatorRequest("/api/tasks", { method: "POST", body: { title: "from operator", body: "b" }, transport: "unix" })) as { tasks: { id: string; origin: string }[] };
      expect(posted.tasks[0]!.origin).toBe("coordinator");
      const id = posted.tasks[0]!.id;
      expect(((await operatorRequest("/api/stats", { transport: "unix" })) as { total: number }).total).toBe(1);
      expect(((await operatorRequest(`/api/tasks/${id}`, { transport: "unix" })) as { task: { status: string } }).task.status).toBe("queued");
      const cancelled = (await operatorRequest(`/api/tasks/${id}/cancel`, { method: "POST", body: { reason: "x" }, transport: "unix" })) as { task: { status: string } };
      expect(cancelled.task.status).toBe("cancelled");
      await expect(operatorRequest("/api/tasks/task_nope", { transport: "unix" })).rejects.toThrow(/not found/);
    } finally {
      await running.close();
    }
    expect(() => statSync(operatorSocketPath())).toThrow();
    await expect(operatorRequest("/api/stats", { transport: "unix" })).rejects.toThrow(/no running board/);
  });

  it.skipIf(!canListenUnix)("refuses to start a second board on a live socket", async () => {
    hermeticHome();
    const first = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "unix" });
    try {
      await expect(createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "unix" })).rejects.toThrow(/already running/);
    } finally {
      await first.close();
    }
  });

  it.skipIf(!canListenUnix)("replaces a stale socket file left by a crashed board", async () => {
    hermeticHome();
    ensureBoardDir();
    writeFileSync(operatorSocketPath(), "stale");
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "unix" });
    try {
      expect(((await operatorRequest("/api/stats", { transport: "unix" })) as { total: number }).total).toBe(0);
    } finally {
      await running.close();
    }
  });

  it.skipIf(!canListenTcp)("falls back to a secret-protected loopback listener when unix sockets are unavailable", async () => {
    const home = hermeticHome();
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "tcp" });
    try {
      const infoPath = operatorInfoPath();
      expect(infoPath).toBe(join(home, "board", "operator.json"));
      if (process.platform !== "win32") expect(statSync(infoPath).mode & 0o777).toBe(0o600);
      const info = JSON.parse(readFileSync(infoPath, "utf8")) as { port: number; secret: string };
      expect(info.secret).toMatch(/^[0-9a-f]{64}$/);
      const base = `http://127.0.0.1:${info.port}`;
      expect((await fetch(`${base}/api/stats`)).status).toBe(401);
      expect((await fetch(`${base}/api/stats`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${info.secret}`, "x-cardea-local": "1" } })).status).toBe(200);
      const posted = (await operatorRequest("/api/tasks", { method: "POST", body: { title: "t", body: "b" }, transport: "tcp" })) as { tasks: unknown[] };
      expect(posted.tasks).toHaveLength(1);
      // the fallback port is never the worker port and the worker listener still exposes nothing
      expect(info.port).not.toBe(Number(new URL(running.url).port));
    } finally {
      await running.close();
    }
    expect(() => statSync(operatorInfoPath())).toThrow();
  });

  it.skipIf(!canListenUnix)("lets the stdio coordinator MCP tools drive the board over the socket and labels results untrusted", async () => {
    hermeticHome();
    const running = await createBoardHttpServer({ port: 0, host: "127.0.0.1", silent: true, operatorTransport: "unix" });
    const cfg = parseConfig();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(cfg, buildWorkers(cfg), { allowWrites: false, cwd: tmpdir() });
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ["get_task", "get_batch", "list_tasks", "wait_for"]) expect(tools.find((t) => t.name === name)?.description, name).toMatch(/untrusted/i);
      const posted = await client.callTool({ name: "post_task", arguments: { title: "t", body: "b" } });
      const id = (posted.structuredContent?.tasks as { id: string }[])[0]!.id;
      const got = await client.callTool({ name: "get_task", arguments: { task_id: id } });
      expect(JSON.stringify(got.content)).toMatch(/UNTRUSTED DATA/);
      expect((got.structuredContent as { task: { id: string } }).task.id).toBe(id);
      expect(((await client.callTool({ name: "board_stats", arguments: {} })).structuredContent as { total: number }).total).toBe(1);
    } finally {
      await client.close();
      await running.close();
    }
    // with no board running the tools say so plainly
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const server2 = createMcpServer(cfg, buildWorkers(cfg), { allowWrites: false, cwd: tmpdir() });
    const client2 = new Client({ name: "test", version: "0" });
    await Promise.all([server2.connect(st2), client2.connect(ct2)]);
    const none = await client2.callTool({ name: "board_stats", arguments: {} });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toMatch(/no running board/);
    await client2.close();
  });
});

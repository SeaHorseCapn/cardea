import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexWorker } from "../src/core/workers/codex.js";
import { GrokWorker } from "../src/core/workers/grok.js";
import { parseJsonLines, spawnWorker, truncate } from "../src/core/workers/worker.js";
import { EventBus, newId, type CardeaEvent } from "../src/core/events.js";
import {
  childEnv,
  parseConfig,
  isProtectedPath,
  resolveTier,
  type CardeaConfig,
} from "../src/core/config.js";
import { runDoctor } from "../src/core/doctor.js";
import { createMcpServer } from "../src/mcp/server.js";
import { buildWorkers } from "../src/core/orchestrator.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fakeCfg(overrides: { codex?: string; grok?: string }) {
  const cfg = parseConfig();
  if (overrides.codex) cfg.binaries.codex = overrides.codex;
  if (overrides.grok) cfg.binaries.grok = overrides.grok;
  return cfg;
}

async function connectMcp(cfg: CardeaConfig, opts?: { allowWrites?: boolean; cwd?: string }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(cfg, buildWorkers(cfg), {
    allowWrites: opts?.allowWrites ?? false,
    cwd: opts?.cwd ?? tmpdir(),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function ctx(bus = new EventBus()) {
  return { bus, taskId: newId("t"), delegationId: newId("d") };
}

describe("parseJsonLines", () => {
  it("splits objects from plain text tolerantly", () => {
    const { objects, plain } = parseJsonLines('{"a":1}\nnot json\n{"b":2}\n{broken\n');
    expect(objects).toEqual([{ a: 1 }, { b: 2 }]);
    expect(plain).toEqual(["not json", "{broken"]);
  });
});

describe("truncate", () => {
  it("caps long output with a marker", () => {
    const out = truncate("x".repeat(100), 10);
    expect(out).toContain("truncated at 10 chars");
  });
});

describe("CodexWorker", () => {
  it("extracts the final agent_message from JSONL", async () => {
    const w = new CodexWorker(fakeCfg({ codex: join(fixtures, "fake-codex.sh") }));
    const r = await w.invoke(
      "hi",
      { cwd: "/tmp", timeoutMs: 10000, allowWrites: false },
      ctx(),
    );
    expect(r.output).toBe("FAKE CODEX ANSWER");
    expect(r.exitCode).toBe(0);
  });
});

describe("GrokWorker", () => {
  it("joins text deltas into the final message", async () => {
    const bus = new EventBus();
    const chunks: CardeaEvent[] = [];
    bus.on((ev) => {
      if (ev.type === "worker_output_chunk") chunks.push(ev);
    });
    const w = new GrokWorker(fakeCfg({ grok: join(fixtures, "fake-grok.sh") }));
    const r = await w.invoke(
      "hi",
      { cwd: "/tmp", timeoutMs: 10000, allowWrites: false },
      ctx(bus),
    );
    expect(r.output).toBe("FAKE GROK ANSWER");
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("timeout kill", () => {
  it("kills a hung worker and reports timedOut output", async () => {
    const started = Date.now();
    const outcome = await spawnWorker(
      {
        bin: join(fixtures, "fake-slow.sh"),
        args: [],
        cwd: "/tmp",
        env: process.env,
        timeoutMs: 1500,
        stdinData: "hi",
      },
      "codex",
      ctx(),
    );
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe("LocalWorker placeholder", () => {
  it("throws a helpful error while disabled", async () => {
    const { LocalWorker } = await import("../src/core/workers/local.js");
    const cfg = parseConfig();
    expect(cfg.workers.local.enabled).toBe(false);
    const w = new LocalWorker(cfg);
    await expect(
      w.invoke("hi", { cwd: "/tmp", timeoutMs: 5000, allowWrites: false }, ctx()),
    ).rejects.toThrow(/disabled/);
  });

  it("requires a tier model once enabled", async () => {
    const { LocalWorker } = await import("../src/core/workers/local.js");
    const cfg = parseConfig();
    cfg.workers.local.enabled = true;
    const w = new LocalWorker(cfg);
    await expect(
      w.invoke("hi", { cwd: "/tmp", timeoutMs: 5000, allowWrites: false }, ctx()),
    ).rejects.toThrow(/no model for this tier/);
  });
});

describe("resolveTier", () => {
  it("maps default tiers to the expected cost ladder", () => {
    const cfg = parseConfig();
    expect(resolveTier(cfg, "claude", "fast").model).toBe("haiku");
    expect(resolveTier(cfg, "claude", "deep").model).toBe("opus");
    expect(resolveTier(cfg, "codex", "fast").effort).toBe("low");
    expect(resolveTier(cfg, "codex", "deep").effort).toBe("high");
    expect(resolveTier(cfg, "grok", "deep").model).toBe("grok-4.5");
    // default tier is standard
    expect(resolveTier(cfg, "claude").model).toBe("sonnet");
    // explicit model override wins
    expect(resolveTier(cfg, "claude", "fast", "opus").model).toBe("opus");
  });
});

describe("auth modes", () => {
  it("defaults CLI workers and the coordinator to cli-login", () => {
    const cfg = parseConfig();
    expect(cfg.workers.claude?.auth).toBe("cli-login");
    expect(cfg.workers.codex?.auth).toBe("cli-login");
    expect(cfg.workers.grok?.auth).toBe("cli-login");
    expect(cfg.coordinator.auth).toBe("cli-login");
  });

  it("scrubs keys by default and passes them only with api-key opt-in", () => {
    process.env.OPENAI_API_KEY = "sk-auto-test";
    try {
      const cli = parseConfig();
      expect(childEnv(cli, "codex").OPENAI_API_KEY).toBeUndefined();
      const apiKey = parseConfig({ workers: { codex: { auth: "api-key" } } });
      expect(childEnv(apiKey, "codex").OPENAI_API_KEY).toBe("sk-auto-test");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("passes keys in explicit auto mode", () => {
    process.env.OPENAI_API_KEY = "sk-auto-test";
    try {
      const auto = parseConfig({ workers: { codex: { auth: "auto" } } });
      expect(childEnv(auto, "codex").OPENAI_API_KEY).toBe("sk-auto-test");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("requires configured API keys at run time", () => {
    const cfg = parseConfig({ workers: { codex: { auth: "api-key" } } });
    delete process.env.OPENAI_API_KEY;
    expect(() => childEnv(cfg, "codex")).toThrow(/OPENAI_API_KEY/);
  });

  it("maps deprecated safety.scrubApiKeyEnvVars to cli-login", () => {
    const cfg = parseConfig({ safety: { scrubApiKeyEnvVars: true } });
    expect(cfg.workers.codex?.auth).toBe("cli-login");
    expect(cfg.workers.claude?.auth).toBe("cli-login");
    expect(cfg.workers.grok?.auth).toBe("cli-login");
  });

  it("maps deprecated safety.scrubApiKeyEnvVars=false to auto", () => {
    const cfg = parseConfig({ safety: { scrubApiKeyEnvVars: false } });
    expect(cfg.workers.codex?.auth).toBe("auto");
    expect(cfg.workers.claude?.auth).toBe("auto");
    expect(cfg.workers.grok?.auth).toBe("auto");
    expect(cfg.coordinator.auth).toBe("auto");
  });

  it("doctor warns when a cli-login key is exported without printing the value", () => {
    process.env.OPENAI_API_KEY = "sk-cardea-secret-test";
    try {
      const cfg = parseConfig();
      const report = runDoctor(cfg);
      const details = report.checks.map((check) => check.detail).join("\n");
      expect(details).toContain(
        'OPENAI_API_KEY is set but ignored (auth: cli-login). To use it, set workers.codex.auth to "api-key" in ~/.cardea/config.json',
      );
      expect(details).not.toContain("sk-cardea-secret-test");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("pickTier (auto-tier)", () => {
  it("uses the classifier verdict and emits the decision", async () => {
    const { pickTier } = await import("../src/core/autotier.js");
    const { ClaudeWorker } = await import("../src/core/workers/claude-worker.js");
    const cfg = parseConfig();
    cfg.binaries.claude = join(fixtures, "fake-claude.sh");
    const bus = new EventBus();
    const decisions: string[] = [];
    bus.on((ev) => {
      if (ev.type === "coordinator_text") decisions.push(ev.text);
    });
    const tier = await pickTier("what is 2+2", cfg, new ClaudeWorker(cfg), bus, "t1");
    expect(tier).toBe("fast");
    expect(decisions[0]).toContain("auto-tier: fast");
  });

  it("falls back to standard when the classifier binary is missing", async () => {
    const { pickTier } = await import("../src/core/autotier.js");
    const { ClaudeWorker } = await import("../src/core/workers/claude-worker.js");
    const cfg = parseConfig();
    cfg.binaries.claude = "/nonexistent/claude";
    const tier = await pickTier("anything", cfg, new ClaudeWorker(cfg), new EventBus(), "t1");
    expect(tier).toBe("standard");
  });
});

describe("protected paths", () => {
  it("uses only configured protected paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cardea-protected-"));
    const cfg = parseConfig({ safety: { protectedPaths: [root] } });
    expect(isProtectedPath(cfg, root)).toBe(true);
    expect(isProtectedPath(cfg, join(root, "sub/dir"))).toBe(true);
    expect(isProtectedPath(cfg, "/tmp")).toBe(false);
    // sibling with matching prefix must NOT match
    expect(isProtectedPath(cfg, root + "_backup")).toBe(false);
  });
});

describe("MCP server", () => {
  it("lists the four public tools", async () => {
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    const { client, server } = await connectMcp(cfg);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "delegate",
        "fan_out",
        "list_workers",
        "panel",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delegates to fake-codex and returns metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "cardea-home-"));
    process.env.CARDEA_HOME = home;
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    const { client, server } = await connectMcp(cfg);
    try {
      const res = await client.callTool({
        name: "delegate",
        arguments: { worker: "codex", prompt: "hi", cwd: tmpdir() },
      });
      expect(res.content[0]?.type).toBe("text");
      expect(res.content[0]?.type === "text" ? res.content[0].text : "").toBe("FAKE CODEX ANSWER");
      expect(res.structuredContent?.worker).toBe("codex");
      expect(res.structuredContent?.run_id).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
      delete process.env.CARDEA_HOME;
    }
  });

  it("refuses writes unless the MCP server was started with --allow-writes", async () => {
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    const { client, server } = await connectMcp(cfg, { allowWrites: false });
    try {
      const res = await client.callTool({
        name: "delegate",
        arguments: { worker: "codex", prompt: "hi", cwd: tmpdir(), allow_writes: true },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.type === "text" ? res.content[0].text : "").toContain("write access refused");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses writes under protected paths", async () => {
    const protectedRoot = mkdtempSync(join(tmpdir(), "cardea-protected-"));
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    cfg.safety.protectedPaths = [protectedRoot];
    const { client, server } = await connectMcp(cfg, { allowWrites: true, cwd: protectedRoot });
    try {
      const res = await client.callTool({
        name: "delegate",
        arguments: { worker: "codex", prompt: "hi", cwd: protectedRoot, allow_writes: true },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.type === "text" ? res.content[0].text : "").toContain("protected path");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("enforces the fan_out item cap", async () => {
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    const { client, server } = await connectMcp(cfg);
    try {
      const res = await client.callTool({
        name: "fan_out",
        arguments: {
          worker: "codex",
          template: "check {item}",
          items: Array.from({ length: 21 }, (_, i) => String(i)),
          cwd: tmpdir(),
        },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.type === "text" ? res.content[0].text : "").toContain("<=20");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not persist API key values in run JSONL", async () => {
    const home = mkdtempSync(join(tmpdir(), "cardea-home-"));
    process.env.CARDEA_HOME = home;
    process.env.OPENAI_API_KEY = "sk-cardea-secret-test";
    const cfg = fakeCfg({ codex: join(fixtures, "fake-codex.sh") });
    cfg.workers.codex!.auth = "api-key";
    const { client, server } = await connectMcp(cfg);
    try {
      await client.callTool({
        name: "delegate",
        arguments: { worker: "codex", prompt: "hi", cwd: tmpdir() },
      });
      const runFiles = readdirSync(join(home, "runs")).filter((f) => f.endsWith(".jsonl"));
      expect(runFiles.length).toBeGreaterThan(0);
      const body = readFileSync(join(home, "runs", runFiles[0]!), "utf8");
      expect(body).not.toContain("sk-cardea-secret-test");
    } finally {
      await client.close();
      await server.close();
      delete process.env.CARDEA_HOME;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("smokes dist stdio MCP initialize and tools/list", async () => {
    const home = mkdtempSync(join(tmpdir(), "cardea-home-"));
    const child = spawn(process.execPath, ["dist/cli/index.js", "mcp"], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, CARDEA_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    child.stdout.on("data", (buf) => {
      lines.push(...String(buf).split("\n").filter(Boolean));
    });
    const waitFor = async (id: number) => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const hit = lines.map((line) => JSON.parse(line)).find((msg) => msg.id === id);
        if (hit) return hit;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`timed out waiting for response ${id}`);
    };
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "vitest", version: "0.0.0" },
          },
        }) + "\n",
      );
      await waitFor(1);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
      const listed = await waitFor(2);
      expect(listed.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "delegate",
        "fan_out",
        "list_workers",
        "panel",
      ]);
    } finally {
      child.kill();
    }
  });
});

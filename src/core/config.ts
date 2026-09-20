import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const home = homedir();

export type TierName = "fast" | "standard" | "deep";
export type AuthMode = "auto" | "cli-login" | "api-key";
export type WorkerKind = "claude-cli" | "codex-cli" | "grok-cli" | "openai-compatible";

const AUTH_MODES = ["auto", "cli-login", "api-key"] as const;

const TierSchema = z
  .object({
    model: z.string().nullable().default(null),
    effort: z.string().nullable().default(null),
  })
  .prefault({});

const BaseWorkerSchema = z.object({
  kind: z.enum(["claude-cli", "codex-cli", "grok-cli", "openai-compatible"]),
  enabled: z.boolean().default(true),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  roleHint: z.string().default(""),
  extraArgs: z.array(z.string()).default([]),
  auth: z.enum(AUTH_MODES).default("auto"),
  apiKeyEnv: z.string().nullable().default(null),
  tiers: z
    .object({
      fast: TierSchema,
      standard: TierSchema,
      deep: TierSchema,
    })
    .prefault({}),
});

const CliWorkerConfigSchema = BaseWorkerSchema.extend({
  kind: z.enum(["claude-cli", "codex-cli", "grok-cli"]),
});

const OpenAICompatibleWorkerConfigSchema = BaseWorkerSchema.extend({
  kind: z.literal("openai-compatible"),
  enabled: z.boolean().default(false),
  baseUrl: z.string().default("http://127.0.0.1:11434/v1"),
  maxTokens: z.number().int().positive().default(4096),
});

export type CliWorkerConfig = z.infer<typeof CliWorkerConfigSchema>;
export type OpenAICompatibleWorkerConfig = z.infer<typeof OpenAICompatibleWorkerConfigSchema>;
export type WorkerConfig = CliWorkerConfig | OpenAICompatibleWorkerConfig;

const CoordinatorConfigSchema = z
  .object({
    auth: z.enum(AUTH_MODES).default("cli-login"),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
  })
  .prefault({});

const RawConfigSchema = z
  .object({
    binaries: z
      .object({
        claude: z.string().default(join(home, ".local/bin/claude")),
        codex: z
          .string()
          .default("/Applications/Codex.app/Contents/Resources/codex"),
        grok: z.string().default(join(home, ".grok/bin/grok")),
      })
      .prefault({}),
    defaults: z
      .object({
        timeoutS: z.number().int().positive().default(600),
        maxTurns: z.number().int().positive().default(50),
        maxConcurrentDelegations: z.number().int().positive().default(2),
        maxDelegationsPerTask: z.number().int().positive().default(8),
        outputCapChars: z.number().int().positive().default(40000),
        autoTier: z.boolean().default(true),
      })
      .prefault({}),
    coordinator: CoordinatorConfigSchema,
    workers: z.record(z.string(), z.unknown()).prefault({}),
    safety: z
      .object({
        protectedPaths: z.array(z.string()).default([]),
        protectedPathPolicy: z.literal("read-only").default("read-only"),
        scrubApiKeyEnvVars: z.boolean().optional(),
      })
      .prefault({}),
  })
  .prefault({});

export interface CardeaConfig {
  binaries: {
    claude: string;
    codex: string;
    grok: string;
  };
  defaults: {
    timeoutS: number;
    maxTurns: number;
    maxConcurrentDelegations: number;
    maxDelegationsPerTask: number;
    outputCapChars: number;
    autoTier: boolean;
  };
  coordinator: z.infer<typeof CoordinatorConfigSchema>;
  workers: Record<string, WorkerConfig>;
  safety: {
    protectedPaths: string[];
    protectedPathPolicy: "read-only";
  };
}

const DEFAULT_WORKERS: Record<string, unknown> = {
  claude: {
    kind: "claude-cli",
    roleHint: "lead reasoning; cheap parallel subagents at the fast tier",
    tiers: {
      fast: { model: "haiku" },
      standard: { model: "sonnet" },
      deep: { model: "opus" },
    },
  },
  codex: {
    kind: "codex-cli",
    roleHint:
      "second-opinion coding, independent code review, parallel implementation attempts",
    tiers: {
      fast: { effort: "low" },
      standard: { effort: "medium" },
      deep: { effort: "high" },
    },
  },
  grok: {
    kind: "grok-cli",
    roleHint:
      "social and market-flavored research, contrarian analysis, alternative perspectives",
    tiers: {
      fast: { model: "grok-4.6" },
      standard: { model: "grok-4.6" },
      deep: { model: "grok-4.5" },
    },
  },
  local: {
    kind: "openai-compatible",
    enabled: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    roleHint:
      "local or private OpenAI-compatible text inference for bulk drafts, summaries, and low-stakes text",
    tiers: {
      fast: {},
      standard: {},
      deep: {},
    },
  },
};

const DEFAULT_API_KEY_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  grok: "XAI_API_KEY",
};

export const CONFIG_DIR = join(home, ".cardea");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return process.env.CARDEA_HOME ? resolve(process.env.CARDEA_HOME) : CONFIG_DIR;
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function inferKind(name: string, raw: Record<string, unknown>): WorkerKind {
  if (raw.kind === "claude-cli" || raw.kind === "codex-cli" || raw.kind === "grok-cli" || raw.kind === "openai-compatible") {
    return raw.kind;
  }
  if (name === "claude") return "claude-cli";
  if (name === "codex") return "codex-cli";
  if (name === "grok") return "grok-cli";
  return "openai-compatible";
}

function normalizeWorker(name: string, rawWorker: unknown, oldScrub?: boolean): WorkerConfig {
  const raw = typeof rawWorker === "object" && rawWorker !== null ? { ...(rawWorker as Record<string, unknown>) } : {};
  const kind = inferKind(name, raw);
  raw.kind = kind;
  if (kind !== "openai-compatible" && raw.auth === undefined) {
    raw.auth = oldScrub === false ? "auto" : "cli-login";
  }
  if (kind !== "openai-compatible" && raw.apiKeyEnv === undefined) {
    raw.apiKeyEnv = DEFAULT_API_KEY_ENV[name] ?? null;
  }
  if (kind === "openai-compatible") {
    if (raw.auth === undefined) raw.auth = "auto";
    return OpenAICompatibleWorkerConfigSchema.parse(raw);
  }
  return CliWorkerConfigSchema.parse(raw);
}

function mergeWorkers(rawWorkers: Record<string, unknown>, oldScrub?: boolean): Record<string, WorkerConfig> {
  const names = new Set([...Object.keys(DEFAULT_WORKERS), ...Object.keys(rawWorkers)]);
  const out: Record<string, WorkerConfig> = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`worker name "${name}" must contain only letters, numbers, "_" or "-"`);
    }
    const defaults = (DEFAULT_WORKERS[name] ?? {}) as Record<string, unknown>;
    const raw = (rawWorkers[name] ?? {}) as Record<string, unknown>;
    out[name] = normalizeWorker(name, { ...defaults, ...raw }, oldScrub);
  }
  return out;
}

export function parseConfig(raw: unknown = {}): CardeaConfig {
  const rawRecord = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawCoordinator =
    typeof rawRecord.coordinator === "object" && rawRecord.coordinator !== null
      ? (rawRecord.coordinator as Record<string, unknown>)
      : {};
  const parsed = RawConfigSchema.parse(raw);
  const oldScrub = parsed.safety.scrubApiKeyEnvVars;
  if (oldScrub !== undefined) {
    process.emitWarning(
      "safety.scrubApiKeyEnvVars is deprecated; set workers.<name>.auth to \"cli-login\" or \"auto\" instead.",
      { code: "CARDEA_DEPRECATED_CONFIG" },
    );
  }
  const coordinator = { ...parsed.coordinator };
  if (oldScrub !== undefined && rawCoordinator.auth === undefined) {
    coordinator.auth = oldScrub ? "cli-login" : "auto";
  }
  return {
    binaries: parsed.binaries,
    defaults: parsed.defaults,
    coordinator,
    workers: mergeWorkers(parsed.workers, oldScrub),
    safety: {
      protectedPaths: parsed.safety.protectedPaths,
      protectedPathPolicy: parsed.safety.protectedPathPolicy,
    },
  };
}

export function loadConfig(path?: string): CardeaConfig {
  let raw: unknown = {};
  const configPath = path ?? getConfigPath();
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  }
  return parseConfig(raw);
}

export function ensureConfigDir(): void {
  mkdirSync(join(getConfigDir(), "tmp"), { recursive: true });
}

export function isProtectedPath(cfg: CardeaConfig, path: string): boolean {
  const target = resolve(path);
  return cfg.safety.protectedPaths.some((p) => {
    const root = resolve(p);
    return target === root || target.startsWith(root + "/");
  });
}

export function resolveTier(
  cfg: CardeaConfig,
  worker: string,
  tier: TierName = "standard",
  modelOverride?: string,
): { model?: string; effort?: string } {
  const w = cfg.workers[worker];
  if (!w) throw new Error(`unknown worker "${worker}"`);
  const t = w.tiers[tier];
  return {
    model: modelOverride ?? t.model ?? w.model ?? undefined,
    effort: t.effort ?? w.effort ?? undefined,
  };
}

export function enabledWorkerNames(cfg: CardeaConfig): string[] {
  return Object.entries(cfg.workers)
    .filter(([, worker]) => worker.enabled)
    .map(([name]) => name);
}

export function isCliWorker(worker: WorkerConfig): worker is CliWorkerConfig {
  return worker.kind !== "openai-compatible";
}

export function isOpenAICompatibleWorker(worker: WorkerConfig): worker is OpenAICompatibleWorkerConfig {
  return worker.kind === "openai-compatible";
}

export function resolvedAuthMode(cfg: CardeaConfig, workerName: string): AuthMode {
  const worker = cfg.workers[workerName];
  if (!worker) throw new Error(`unknown worker "${workerName}"`);
  return worker.auth;
}

export function assertApiKeyAvailable(cfg: CardeaConfig, workerName: string): void {
  const worker = cfg.workers[workerName];
  if (!worker) throw new Error(`unknown worker "${workerName}"`);
  if (worker.auth === "api-key") {
    const key = worker.apiKeyEnv;
    if (!key || !process.env[key]) {
      throw new Error(`${workerName} is configured for api-key auth, but ${key ?? "apiKeyEnv"} is not set`);
    }
  }
}

export function childEnv(cfg: CardeaConfig, workerName: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const worker = cfg.workers[workerName];
  if (!worker) throw new Error(`unknown worker "${workerName}"`);
  if (worker.auth === "api-key") {
    assertApiKeyAvailable(cfg, workerName);
  } else if (worker.auth === "cli-login" && worker.apiKeyEnv) {
    delete env[worker.apiKeyEnv];
  }
  return env;
}

export function ignoredApiKeyNotice(cfg: CardeaConfig, workerName: string): string | undefined {
  const worker = cfg.workers[workerName];
  if (!worker || !isCliWorker(worker) || worker.auth !== "cli-login" || !worker.apiKeyEnv) {
    return undefined;
  }
  if (!process.env[worker.apiKeyEnv]) return undefined;
  return `${worker.apiKeyEnv} is set but ignored (auth: cli-login). To use it, set workers.${workerName}.auth to "api-key" in ~/.cardea/config.json`;
}

export function coordinatorEnv(cfg: CardeaConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (cfg.coordinator.auth === "api-key") {
    if (!process.env[cfg.coordinator.apiKeyEnv]) {
      throw new Error(
        `coordinator is configured for api-key auth, but ${cfg.coordinator.apiKeyEnv} is not set`,
      );
    }
  } else if (cfg.coordinator.auth === "cli-login") {
    delete env[cfg.coordinator.apiKeyEnv];
  }
  return env;
}

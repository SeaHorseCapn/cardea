import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureConfigDir,
  getConfigDir,
  getConfigPath,
  ignoredApiKeyNotice,
  isCliWorker,
  isOpenAICompatibleWorker,
  type CardeaConfig,
} from "./config.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

function binaryCheck(name: string, path: string, versionArgs: string[]): DoctorCheck {
  if (!existsSync(path)) {
    return { name, ok: false, level: "fail", detail: `not found at ${path}` };
  }
  try {
    const out = execFileSync(path, versionArgs, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n")[0];
    return { name, ok: true, level: "ok", detail: `${out} (${path})` };
  } catch (err) {
    return {
      name,
      ok: false,
      level: "fail",
      detail: `exists but failed to run: ${(err as Error).message.slice(0, 200)}`,
    };
  }
}

function authFileCheck(name: string, path: string): DoctorCheck {
  if (!existsSync(path)) {
    return {
      name,
      ok: false,
      level: "fail",
      detail: `${path} missing — run the vendor CLI once interactively to log in`,
    };
  }
  const size = statSync(path).size;
  if (size === 0) {
    return { name, ok: false, level: "fail", detail: `${path} is empty` };
  }
  return { name, ok: true, level: "ok", detail: path };
}

export function runDoctor(cfg: CardeaConfig): DoctorReport {
  const home = homedir();
  const checks: DoctorCheck[] = [];

  // 1. Node runtime
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = (major ?? 0) > 20 || ((major ?? 0) === 20 && (minor ?? 0) >= 10);
  checks.push({
    name: "node",
    ok: nodeOk,
    level: nodeOk ? "ok" : "fail",
    detail: `v${process.versions.node} at ${process.execPath}`,
  });

  // 2. Workers: binary/endpoint reachability and resolved auth mode.
  for (const [name, worker] of Object.entries(cfg.workers)) {
    if (isCliWorker(worker)) {
      const bin =
        worker.kind === "claude-cli"
          ? cfg.binaries.claude
          : worker.kind === "codex-cli"
            ? cfg.binaries.codex
            : cfg.binaries.grok;
      checks.push(binaryCheck(`${name} binary`, bin, ["--version"]));
    } else if (isOpenAICompatibleWorker(worker)) {
      checks.push({
        name: `${name} endpoint`,
        ok: true,
        level: worker.enabled ? "ok" : "warn",
        detail: worker.enabled
          ? `configured at ${worker.baseUrl} (text-only)`
          : `disabled at ${worker.baseUrl}`,
      });
    }

    const key = worker.apiKeyEnv;
    if (!worker.enabled) {
      checks.push({
        name: `${name} auth`,
        ok: true,
        level: "ok",
        detail: `skipped because ${name} is disabled`,
      });
    } else if (worker.auth === "api-key" && (!key || !process.env[key])) {
      checks.push({
        name: `${name} auth`,
        ok: false,
        level: "fail",
        detail: `auth=api-key requires ${key ?? "apiKeyEnv"} to be set`,
      });
    } else {
      checks.push({
        name: `${name} auth`,
        ok: true,
        level: "ok",
        detail: worker.auth === "cli-login" ? "auth=cli-login" : `auth=${worker.auth}${key ? ` via ${key}` : ""}`,
      });
      const notice = ignoredApiKeyNotice(cfg, name);
      if (notice) {
        checks.push({
          name: `${name} auth notice`,
          ok: true,
          level: "warn",
          detail: notice,
        });
      }
    }
  }

  // 3. CLI login files for the default vendor CLIs, when login auth may be used.
  const codex = cfg.workers.codex;
  if (codex && codex.auth !== "api-key") checks.push(authFileCheck("codex login", join(home, ".codex/auth.json")));
  const grok = cfg.workers.grok;
  if (grok && grok.auth !== "api-key") checks.push(authFileCheck("grok login", join(home, ".grok/auth.json")));
  const claude = cfg.workers.claude;
  if (claude && claude.auth !== "api-key") {
    checks.push({
      name: "claude login",
      ok: true,
      level: "ok",
      detail: "vendor CLI login, if needed, is verified by `cardea doctor --live`",
    });
  }

  if (cfg.coordinator.auth === "api-key" && !process.env[cfg.coordinator.apiKeyEnv]) {
    checks.push({
      name: "coordinator auth",
      ok: false,
      level: "fail",
      detail: `auth=api-key requires ${cfg.coordinator.apiKeyEnv} to be set`,
    });
  } else {
    checks.push({
      name: "coordinator auth",
      ok: true,
      level: "ok",
      detail:
        cfg.coordinator.auth === "cli-login"
          ? "auth=cli-login"
          : `auth=${cfg.coordinator.auth} via ${cfg.coordinator.apiKeyEnv}`,
    });
  }

  // 4. Config dir writable + config parses (parse already happened to get cfg).
  try {
    ensureConfigDir();
    accessSync(getConfigDir(), constants.W_OK);
    checks.push({
      name: "config",
      ok: true,
      level: "ok",
      detail: existsSync(getConfigPath())
        ? `loaded ${getConfigPath()}`
        : `using defaults (${getConfigPath()} not present — that's fine)`,
    });
  } catch (err) {
    checks.push({
      name: "config",
      ok: false,
      level: "warn",
      detail: `${getConfigDir()} not writable: ${(err as Error).message}`,
    });
  }

  return { checks, healthy: checks.every((c) => c.level !== "fail") };
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getConfigDir } from "../core/config.js";
import type { TokenRecord, WorkerIdentity } from "./types.js";

export function boardDir(): string {
  return join(getConfigDir(), "board");
}

/** Create the board directory owner-only (0700). Holds tokens, the event log and the operator socket. */
export function ensureBoardDir(dir = boardDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort on filesystems without POSIX modes
    }
  }
  return dir;
}

export function tokensPath(): string {
  return join(boardDir(), "tokens.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function readTokens(): TokenRecord[] {
  if (!existsSync(tokensPath())) return [];
  const parsed = JSON.parse(readFileSync(tokensPath(), "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as TokenRecord[]) : [];
}

function writeTokens(tokens: TokenRecord[]): void {
  ensureBoardDir(dirname(tokensPath()));
  const tmp = `${tokensPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmp, tokensPath());
}

export function createWorkerToken(input: { name: string; capabilities?: string[]; can_post?: boolean; max_concurrent?: number }): { token: string; record: TokenRecord } {
  if (!/^[A-Za-z0-9_-]+$/.test(input.name)) throw new Error("worker name must contain only letters, numbers, _ or -");
  const tokens = readTokens();
  const token = `cardea_${randomBytes(32).toString("base64url")}`;
  const record: TokenRecord = {
    name: input.name,
    capabilities: input.capabilities ?? [],
    can_post: input.can_post === true,
    max_concurrent: input.max_concurrent ?? 1,
    hash: hashToken(token),
    created_at: new Date().toISOString(),
  };
  tokens.push(record);
  writeTokens(tokens);
  return { token, record };
}

export function listTokenRecords(): Omit<TokenRecord, "hash">[] {
  return readTokens().map(({ hash: _hash, ...rest }) => rest);
}

export function revokeWorkerToken(name: string): boolean {
  const tokens = readTokens();
  let changed = false;
  const at = new Date().toISOString();
  for (const token of tokens) {
    if (token.name === name && !token.revoked_at) {
      token.revoked_at = at;
      changed = true;
    }
  }
  if (changed) writeTokens(tokens);
  return changed;
}

export function authenticateToken(raw: string): WorkerIdentity | undefined {
  const hash = hashToken(raw);
  for (const token of readTokens()) {
    if (!token.revoked_at && safeEqualHex(hash, token.hash)) {
      return {
        name: token.name,
        capabilities: token.capabilities,
        can_post: token.can_post,
        max_concurrent: token.max_concurrent,
      };
    }
  }
  return undefined;
}

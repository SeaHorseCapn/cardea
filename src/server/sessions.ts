/**
 * Cross-provider session history reader.
 *
 * Reads the LOCAL session stores each vendor CLI writes to disk and normalizes
 * them into one shape, so the dashboard can browse/search every Claude, Codex,
 * and Grok session in one place. Read-only; never modifies the stores.
 *
 *   claude → ~/.claude/projects/<cwd-dashed>/<uuid>.jsonl   (cwd + ts in the lines)
 *   codex  → ~/.codex/session_index.jsonl (index) + ~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl
 *   grok   → ~/.grok/sessions/<enc-cwd>/<uuid>/summary.json + chat_history.jsonl
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "claude" | "codex" | "grok";

export interface SessionMeta {
  provider: Provider;
  id: string;
  cwd: string;
  title: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms
  messageCount: number; // -1 when unknown without a full parse
  token: string; // opaque handle for the detail endpoint (base64url of the file path)
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

const HOME = homedir();
const CLAUDE_ROOT = join(HOME, ".claude", "projects");
const CODEX_SESSIONS = join(HOME, ".codex", "sessions");
const CODEX_INDEX = join(HOME, ".codex", "session_index.jsonl");
const GROK_ROOT = join(HOME, ".grok", "sessions");
const ROOTS = [CLAUDE_ROOT, CODEX_SESSIONS, GROK_ROOT];

const enc = (p: string) => Buffer.from(p).toString("base64url");
const dec = (t: string) => Buffer.from(t, "base64url").toString("utf8");

function toMs(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/** Read the first `bytes` of a file (caps cost for multi-MB transcripts). */
function readHead(path: string, bytes = 65536): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function* jsonLines(text: string): Generator<Record<string, any>> {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* skip partial trailing line */
    }
  }
}

/** Text out of a message content that may be a string or an array of blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b === "object") {
        const o = b as Record<string, any>;
        if (typeof o.text === "string") parts.push(o.text);
        else if (o.type === "tool_use") parts.push(`[tool: ${o.name ?? "?"}]`);
        else if (o.type === "tool_result") parts.push("[tool result]");
      }
    }
    return parts.join("");
  }
  return "";
}

function firstLine(s: string, cap = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap) + "…" : t;
}

// ─────────────────────────────── claude ───────────────────────────────

function listClaude(): SessionMeta[] {
  if (!existsSync(CLAUDE_ROOT)) return [];
  const out: SessionMeta[] = [];
  for (const dir of readdirSync(CLAUDE_ROOT)) {
    const dirPath = join(CLAUDE_ROOT, dir);
    let st;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dirPath, f);
      try {
        const head = readHead(p);
        let cwd = "";
        let startedAt = 0;
        let title = "";
        for (const d of jsonLines(head)) {
          if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
          if (!startedAt && d.timestamp) startedAt = toMs(d.timestamp);
          if (!title && d.type === "user" && d.message) {
            const txt = contentText(d.message.content);
            if (txt.trim()) title = firstLine(txt);
          }
          if (cwd && startedAt && title) break;
        }
        out.push({
          provider: "claude",
          id: f.replace(/\.jsonl$/, ""),
          cwd,
          title: title || "(no user text)",
          startedAt,
          updatedAt: statSync(p).mtimeMs,
          messageCount: -1,
          token: enc(p),
        });
      } catch {
        /* unreadable transcript */
      }
    }
  }
  return out;
}

function readClaude(path: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  for (const d of jsonLines(readFileSync(path, "utf8"))) {
    if (d.type === "user" && d.message?.role === "user") {
      const t = contentText(d.message.content);
      if (t.trim()) msgs.push({ role: "user", text: t });
    } else if (d.type === "assistant" && d.message) {
      const t = contentText(d.message.content);
      if (t.trim()) msgs.push({ role: "assistant", text: t });
    }
  }
  return msgs;
}

// ─────────────────────────────── codex ───────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function listCodex(): SessionMeta[] {
  if (!existsSync(CODEX_INDEX)) return [];
  // id → rollout file path
  const rollouts = new Map<string, string>();
  for (const p of walk(CODEX_SESSIONS)) {
    const m = p.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/);
    if (m) rollouts.set(m[1]!, p);
  }
  const out: SessionMeta[] = [];
  for (const d of jsonLines(readFileSync(CODEX_INDEX, "utf8"))) {
    if (typeof d.id !== "string") continue;
    const path = rollouts.get(d.id);
    let cwd = "";
    let startedAt = 0;
    if (path) {
      for (const line of jsonLines(readHead(path))) {
        if (line.type === "session_meta" && line.payload) {
          cwd = line.payload.cwd ?? "";
          startedAt = toMs(line.payload.timestamp);
          break;
        }
      }
    }
    out.push({
      provider: "codex",
      id: d.id,
      cwd,
      title: firstLine(String(d.thread_name ?? "(untitled)")),
      startedAt,
      updatedAt: toMs(d.updated_at) || startedAt,
      messageCount: -1,
      token: path ? enc(path) : "",
    });
  }
  return out.filter((s) => s.token);
}

function readCodex(path: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  for (const d of jsonLines(readFileSync(path, "utf8"))) {
    const p = d.payload;
    if (!p || typeof p !== "object") continue;
    if (d.type === "event_msg" && p.type === "user_message") {
      const t = typeof p.message === "string" ? p.message : contentText(p.text_elements);
      if (t.trim()) msgs.push({ role: "user", text: t });
    } else if (d.type === "event_msg" && p.type === "agent_message") {
      if (typeof p.message === "string" && p.message.trim()) msgs.push({ role: "assistant", text: p.message });
    }
  }
  return msgs;
}

// ─────────────────────────────── grok ───────────────────────────────

function listGrok(): SessionMeta[] {
  if (!existsSync(GROK_ROOT)) return [];
  const out: SessionMeta[] = [];
  for (const encCwd of readdirSync(GROK_ROOT)) {
    const cwdDir = join(GROK_ROOT, encCwd);
    let st;
    try {
      st = statSync(cwdDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const sid of readdirSync(cwdDir)) {
      const summaryPath = join(cwdDir, sid, "summary.json");
      const chatPath = join(cwdDir, sid, "chat_history.jsonl");
      if (!existsSync(summaryPath) || !existsSync(chatPath)) continue;
      try {
        const s = JSON.parse(readFileSync(summaryPath, "utf8"));
        out.push({
          provider: "grok",
          id: s.info?.id ?? sid,
          cwd: s.info?.cwd ?? decodeURIComponent(encCwd),
          title: firstLine(String(s.session_summary ?? "(untitled)")),
          startedAt: toMs(s.created_at),
          updatedAt: toMs(s.updated_at),
          messageCount: typeof s.num_chat_messages === "number" ? s.num_chat_messages : -1,
          token: enc(chatPath),
        });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function readGrok(path: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  for (const d of jsonLines(readFileSync(path, "utf8"))) {
    const role = d.type;
    if (role !== "user" && role !== "assistant") continue; // skip system/tool noise
    const t = contentText(d.content);
    if (t.trim()) msgs.push({ role, text: t });
  }
  return msgs;
}

// ─────────────────────────────── public API ───────────────────────────────

let cache: { at: number; items: SessionMeta[] } | null = null;
const TTL_MS = 60_000;

export function listSessions(opts: { provider?: string; q?: string; limit?: number } = {}): SessionMeta[] {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const items = [...listClaude(), ...listCodex(), ...listGrok()];
    cache = { at: Date.now(), items };
  }
  let items = cache.items;
  if (opts.provider && ["claude", "codex", "grok"].includes(opts.provider)) {
    items = items.filter((s) => s.provider === opts.provider);
  }
  if (opts.q) {
    const q = opts.q.toLowerCase();
    items = items.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }
  items = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, opts.limit ?? 200);
}

export interface Transcript {
  provider: Provider;
  messages: TranscriptMessage[];
}

/** Read one transcript by opaque token. Validates the path is inside a known store. */
export function readSession(token: string): Transcript {
  const path = dec(token);
  const root = ROOTS.find((r) => path.startsWith(r + "/"));
  if (!root || !existsSync(path)) throw new Error("unknown session");
  if (root === CLAUDE_ROOT) return { provider: "claude", messages: readClaude(path) };
  if (root === CODEX_SESSIONS) return { provider: "codex", messages: readCodex(path) };
  return { provider: "grok", messages: readGrok(path) };
}

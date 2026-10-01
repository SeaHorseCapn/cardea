import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Detect once whether this environment can open sockets. Tests that need them use
 * `it.skipIf(!canListenTcp)` so a restricted sandbox shows them as skipped, never as passed.
 */
export const canListenTcp: boolean = await new Promise<boolean>((resolve) => {
  const server = createServer((_req, res) => res.end("ok"));
  server.once("error", () => resolve(false));
  server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
});

export const canListenUnix: boolean =
  process.platform === "win32"
    ? false
    : await new Promise<boolean>((resolve) => {
        const dir = mkdtempSync(join(tmpdir(), "cs-"));
        const server = createNetServer();
        const done = (ok: boolean) => {
          rmSync(dir, { recursive: true, force: true });
          resolve(ok);
        };
        server.once("error", () => done(false));
        server.listen(join(dir, "s.sock"), () => server.close(() => done(true)));
      });

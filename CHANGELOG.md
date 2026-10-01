# Changelog

## Unreleased

- Added a practical routing guide with measured delegation results and coordinator hygiene rules.

## 0.3.0

- Added the Cardea task board for pull-based remote workers: append-only storage, leases, batches, replicas, dependencies, `review_of`, hashed worker tokens, rate limiting, and worker MCP over Streamable HTTP.
- Added `cardea board ...` CLI commands and coordinator board tools on `cardea mcp`. They reach the board over an owner-only Unix socket (`board/operator.sock`, or a secret-protected loopback listener on Windows); the worker listener serves only `/mcp` and has no operator surface.
- Documented the board safety model and remote endpoint threat model.

## 0.2.0

- Added `cardea mcp`, a stdio MCP server with `list_workers`, `delegate`, `fan_out`, and `panel` tools.
- Added per-worker auth modes: `cli-login` is the default for vendor CLI workers and the coordinator; `auto` and `api-key` are explicit opt-ins.
- Generalized `local` into named OpenAI-compatible workers.
- Removed personal protected-path defaults and refreshed release documentation.
- Added package metadata, CI, security, access, and contributor docs for public release.

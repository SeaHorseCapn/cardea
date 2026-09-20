# Changelog

## 0.2.0

- Added `cardea mcp`, a stdio MCP server with `list_workers`, `delegate`, `fan_out`, and `panel` tools.
- Added per-worker auth modes: `cli-login` is the default for vendor CLI workers and the coordinator; `auto` and `api-key` are explicit opt-ins.
- Generalized `local` into named OpenAI-compatible workers.
- Removed personal protected-path defaults and refreshed release documentation.
- Added package metadata, CI, security, access, and contributor docs for public release.

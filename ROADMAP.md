# Roadmap

Cardea is young. These are the next things worth building, roughly in order. Issues and PRs welcome — adapters for vendor CLIs change fastest and are the best place to start (see CONTRIBUTING.md).

## 0.3 — make delegation production-shaped

- **Async jobs.** `delegate` is synchronous, and real implementation tasks run for many minutes — longer than most MCP hosts will hold a tool call. Add `delegate_async → run_id`, `get_run`, and a completion notification. Runs already persist to `~/.cardea/runs`.
- **Summaries by contract.** Return `{ summary, report_path }` with the full worker output on disk, so the coordinating model's context stays small. The coordinator's context is the expensive place.
- **A write pipeline, not just write permission.** Worktree per write-run → worker implements → Cardea runs a `verify` command itself (never trust a self-reported "tests pass") → policy check on sensitive files (build scripts, CI, tsconfig) → commit on a branch → return the diff stat.
- **Reviewer ≠ implementer.** A built-in review stage that hands the diff and the spec to a *different* model than the one that wrote it.

## 0.4 — know about limits

- **Quota awareness.** Detect rate-limit and usage-window errors, fail over to another worker or tier, resume killed runs, show per-worker usage in `cardea doctor`.
- **Model discovery.** Vendor model ids drift. `doctor --live` should list what each CLI/endpoint actually serves and propose the config fix.

## Later

- **Routing that learns.** Record duration, verify results and review findings per worker × task type and feed them into auto-tier, replacing static role hints.
- Token auth for the dashboard.
- Nightly contract tests against the real vendor CLIs.
- Linux and Windows defaults for binary discovery.
- More first-class CLI adapters (Gemini CLI and others).

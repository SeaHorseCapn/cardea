# Security

The dashboard has no authentication. Keep it bound to `127.0.0.1` unless you intentionally bind it to a private network address you control.

The Sessions tab reads local transcripts created by your vendor CLIs. Anyone who can access the dashboard can view those transcripts.

`--allow-writes` only allows workers to request write access. Cardea still refuses writes under `safety.protectedPaths`, and MCP write requests are ignored unless the MCP server was started with `cardea mcp --allow-writes`.

Cardea never stores API key values. It passes configured environment variables through to vendor CLIs or endpoints according to each worker's `auth` mode.

The task board remote endpoint is for workers and never exposes local execution tools. It should stay bound to loopback unless you intentionally put your own HTTPS tunnel or reverse proxy in front of it. Worker tokens are bearer secrets: create one per worker, store them in the worker's secret store, and revoke tokens that may have leaked.

The board has two listeners with different trust. The worker listener serves only `/mcp` (plus `/mcp/<token>` when opted in) and is the only one meant to be reachable through a tunnel or reverse proxy. The operator API (post, cancel, read every result, stats) is never served there: it listens on a Unix domain socket at `<cardea home>/board/operator.sock` (mode `0600`, in a `0700` directory), so only the local user can reach it. This is deliberate. A proxy forwards remote requests from 127.0.0.1, so no source-address or header check on the worker listener could distinguish an operator from a remote caller. Where Unix sockets are unavailable (Windows), the operator API moves to a separate ephemeral loopback listener that requires a random 256-bit bearer secret from `board/operator.json` (mode `0600`).

Board tokens are stored only as SHA-256 hashes and compared in constant time. The optional `--allow-url-token` mode should be used only when a client cannot send authorization headers, because URLs can leak through logs, browser history, and proxy telemetry.

Board task bodies and worker results are untrusted data. Treat returned `result.summary` and `result.output` as data to inspect, not as instructions for Cardea, the coordinator, or any local runner.

Report security issues through GitHub issues if public disclosure is appropriate. If not, contact the repository maintainers privately first.

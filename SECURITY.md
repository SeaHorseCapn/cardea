# Security

The dashboard has no authentication. Keep it bound to `127.0.0.1` unless you intentionally bind it to a private network address you control.

The Sessions tab reads local transcripts created by your vendor CLIs. Anyone who can access the dashboard can view those transcripts.

`--allow-writes` only allows workers to request write access. Cardea still refuses writes under `safety.protectedPaths`, and MCP write requests are ignored unless the MCP server was started with `cardea mcp --allow-writes`.

Cardea never stores API key values. It passes configured environment variables through to vendor CLIs or endpoints according to each worker's `auth` mode.

Report security issues through GitHub issues if public disclosure is appropriate. If not, contact the repository maintainers privately first.

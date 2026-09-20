# Cardea

One subscription, login, or key can run out. Different models are also good at different work. Cardea gives you one CLI, local dashboard, and MCP server that can route tasks across Claude Code, Codex, Grok, and any OpenAI-compatible endpoint by cost and strength.

Bring your own keys, or load Cardea into the LLM you already use.

## Quick Start

```sh
git clone https://github.com/SeaHorseCapn/cardea.git
cd cardea
npm install
npm run build
npm link
```

Install the vendor CLIs you want Cardea to use, then log in to each one once:

```sh
claude
codex
grok
cardea doctor
```

By default, Cardea uses those CLI logins for `claude`, `codex`, `grok`, and the coordinator. It scrubs each worker's API-key environment variable from the child process, so a stray exported key will not override the vendor CLI login. Cardea requires Node `>=20.10`.

## Three Ways To Use It

### CLI

```sh
cardea "Review this repository for release blockers"
cardea "Check this implementation with a second opinion" --model codex
cardea "Compare approaches for this API" --panel --tier fast
cardea doctor --live
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--cwd <path>` | working directory for coordinator and workers |
| `--model <worker[:model]>` | run one configured worker directly |
| `--panel` | send the prompt to enabled workers, then synthesize |
| `--allow-writes` | let workers modify files, except under protected paths |
| `--safe` / `--yolo` | coordinator plan-mode vs auto-accept-edits |
| `--timeout <s>` | per-delegation timeout |
| `--json` | raw `CardeaEvent` JSONL |

### Dashboard

```sh
cardea serve
```

Open `http://127.0.0.1:4317`. The dashboard is not authenticated; bind it only to localhost or a private network you control.

### MCP Inside Your LLM

Claude Code:

```sh
claude mcp add cardea -- cardea mcp
```

Codex CLI `config.toml`:

```toml
[mcp_servers.cardea]
command = "cardea"
args = ["mcp"]
```

Generic MCP JSON:

```json
{
  "mcpServers": {
    "cardea": {
      "command": "cardea",
      "args": ["mcp"]
    }
  }
}
```

The MCP tools are `list_workers`, `delegate`, `fan_out`, and `panel`. `panel` returns separate answers; the host LLM synthesizes them. Start with `cardea mcp --allow-writes` if you want MCP delegate calls to be allowed to request writes.

## Using API Keys Instead

API keys are opt-in. Configure one worker explicitly:

```json
{
  "workers": {
    "codex": {
      "auth": "api-key"
    }
  }
}
```

Then export the matching key in the same shell that starts Cardea:

```sh
export OPENAI_API_KEY=...
cardea doctor
```

To opt all default CLI workers and the coordinator into API-key auth:

```json
{
  "coordinator": {
    "auth": "api-key"
  },
  "workers": {
    "claude": { "auth": "api-key" },
    "codex": { "auth": "api-key" },
    "grok": { "auth": "api-key" }
  }
}
```

Each CLI worker supports:

- `auth: "cli-login"`: default; scrub that worker's key env var and use the account logged into the vendor CLI.
- `auth: "api-key"`: require the key env var and fail fast if it is missing.
- `auth: "auto"`: pass the key through when its env var is set, otherwise use the vendor CLI login.

Coordinator auth uses the same modes under `coordinator.auth`; its default is also `cli-login`. API-key auth may be useful for automation. See [ACCESS.md](ACCESS.md).

Cardea never reads keys from config and never stores key values.

## Workers And Tiers

Defaults are configurable in `~/.cardea/config.json`.

| Worker | Kind | Default auth | Auth env | Fast | Standard | Deep |
|---|---|---|---|---|---|---|
| `claude` | Claude Code CLI | `cli-login` | `ANTHROPIC_API_KEY` | `haiku` | `sonnet` | `opus` |
| `codex` | Codex CLI | `cli-login` | `OPENAI_API_KEY` | reasoning low | reasoning medium | reasoning high |
| `grok` | Grok CLI | `cli-login` | `XAI_API_KEY` | `grok-4.6` | `grok-4.6` | `grok-4.5` |
| `local` | OpenAI-compatible | `auto` | configurable | unset | unset | unset |

OpenAI-compatible workers are text-only: no tools and no file access.

## OpenAI-Compatible Workers

Define as many named endpoint workers as you need:

```json
{
  "workers": {
    "openrouter": {
      "kind": "openai-compatible",
      "enabled": true,
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "tiers": {
        "fast": { "model": "openai/gpt-4o-mini" },
        "standard": { "model": "anthropic/claude-sonnet-4.5" },
        "deep": { "model": "openai/gpt-5" }
      }
    },
    "ollama": {
      "kind": "openai-compatible",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:11434/v1",
      "auth": "auto",
      "tiers": {
        "fast": { "model": "llama3.2:3b" },
        "standard": { "model": "qwen2.5-coder:14b" },
        "deep": { "model": "qwen2.5:32b" }
      }
    }
  }
}
```

Then run `cardea "summarize these notes" --model openrouter --tier fast`.

## Fan Out Pattern

Use a cheap wide pass, then escalate only the interesting results:

```sh
cardea "Use fan_out fast over the changed files, identify only the risky ones, then ask a deep worker to verify those findings."
```

The coordinator also has a `fan_out` tool. It runs one template over up to 20 items in parallel.

## Safety

Runs are persisted to `~/.cardea/runs/*.jsonl`. `safety.protectedPaths` defaults to `[]`; add paths that should always stay read-only:

```json
{
  "safety": {
    "protectedPaths": ["/path/to/critical/repo"]
  }
}
```

`--allow-writes` lets workers write only when requested and never under protected paths. MCP has a second gate: writes are refused unless the server was started with `cardea mcp --allow-writes`.

## Troubleshooting

Run:

```sh
cardea doctor
cardea doctor --live
```

Vendor model IDs change. Override them per tier:

```json
{
  "workers": {
    "grok": {
      "tiers": {
        "fast": { "model": "grok-4.6" },
        "standard": { "model": "grok-4.6" },
        "deep": { "model": "grok-4.5" }
      }
    }
  }
}
```

If an API-key worker fails, confirm the named env var is exported in the same shell that starts Cardea. If a CLI-login worker fails, sign into that vendor CLI interactively and rerun `cardea doctor --live`.

## Architecture

`src/core` never imports from `src/cli` or `src/server`; the contract is `RunOptions` in, a JSON-serializable `CardeaEvent` stream out. The CLI, dashboard, and MCP server use the same core worker adapters and event stream.

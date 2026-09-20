# Contributing

Cardea is most likely to need help in worker adapters because vendor CLIs change quickly.

To add a worker:

1. Add or extend a `Worker` adapter under `src/core/workers/`.
2. Keep `src/core` independent from `src/cli` and `src/server`.
3. Model auth with `auth: "auto" | "cli-login" | "api-key"` and `apiKeyEnv`; never read key values from config.
4. Emit useful worker output through the `EventBus`, but never log secrets.
5. Add fake-worker fixtures and vitest coverage before relying on a live vendor CLI.
6. Run `npm run build` and `npm test`.

For OpenAI-compatible HTTP endpoints, prefer configuration over code: define another `workers.<name>` with `kind: "openai-compatible"`.

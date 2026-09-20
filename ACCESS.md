# Access And Authentication

This is factual project documentation, not legal advice.

Cardea workers authenticate in three ways:

- Vendor CLI login: Cardea launches the vendor's own unmodified CLI, using the account you logged into that CLI with. This is the default for the Claude, Codex, and Grok CLI workers and for the coordinator.
- API key: With explicit `auth: "api-key"` configuration, Cardea passes the worker's configured environment variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `XAI_API_KEY`, to the vendor CLI or compatible endpoint.
- Local endpoint: Cardea calls an OpenAI-compatible endpoint you configured, such as Ollama or LM Studio.

API keys are opt-in. In the default `cli-login` mode, Cardea removes that worker's API-key environment variable from the child process, so an exported key is ignored unless you configure `auth: "api-key"` or `auth: "auto"`.

API keys are the automation path every vendor documents. Each vendor publishes its own terms for using a subscription login from automation; check the current terms for your account and decide what is appropriate.

Cardea never reads, stores, or proxies tokens. It only launches the vendor's own CLI or calls an endpoint you configured.

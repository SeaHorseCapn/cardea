# Routing guide: what to send where

## The idea

A long-running coordinating model is the most expensive place to do work. Every turn re-reads its whole context, including old specs, diffs, tool output and decisions that are no longer active. Use that context for what it is best at: specifying the work, making choices, and judging results.

Route by quota and by strength. The coordinator should decide what must happen and what counts as done. Separate workers, on separate quotas, should implement, draft, inspect and report back in small summaries.

## Routing table

| Work | Worker | Why |
|---|---|---|
| Brief, spec, review synthesis, final QA judgment | The coordinating model, meaning the LLM you loaded Cardea into | Reasoning stays on the strongest model, and the coordinator keeps ownership of tradeoffs. |
| Spec-driven implementation, fix lists, lint, doc drafts | A coding-agent CLI worker with `--allow-writes`, standard tier, pointed at a spec file | It uses a separate quota and is unaffected by the coordinator's usage window. |
| Deep architecture or security review | A different model than the implementer, deep tier | The reviewer should not share the implementer's blind spots. |
| Contrarian product or design review, research | Another lab's model, read-only | Useful disagreement is often more valuable before code exists. |
| Lookups, summaries of worker output, commit messages | Fast tier, or a local OpenAI-compatible worker | These jobs need clarity more than deep reasoning. |
| Mechanical per-file work | `fan_out` on the fast tier, then escalate only the interesting results | Cheap wide pass, then escalate. |

## Measured costs

The unit below is a weighted token unit: input ×1, cache write ×2, cache read ×0.1, output ×5. It approximates relative cost, not money.

In one full-stack web application rebuilt in a day, the work produced 46 commits and 210 tests. Total usage was about 67M weighted units. Implementation agents running on a top-tier model used 77% of that total, and 34% of that agent spend was runs killed by a usage window and then resumed.

| Task on a top-tier model | Weighted units |
|---|---:|
| Scoped UI build, 4–8 pages | 2.3M–4.8M |
| Domain core plus 150 unit tests | 5.4M |
| Docs, README plus handoff | 1.6M |
| Polish pass, 217 turns | 7.1M |
| 13-item review fix pass | 7.6M + 6.4M |
| Killed-and-resumed pair | ≈1.9× a clean run |
| 334-turn coordinator session, average of ~230k tokens of context per turn | 15.5M |

The same class of work routed through Cardea had a different shape.

First, a feature with tests was sent to a coding-agent CLI on the standard tier. It ran for 406 s and used zero coordinator-side implementation tokens. Review caught two misses: the worker changed a build flag to suit its sandbox, and it queried the wrong table. Coordinator-side cost was 1.72M, of which 1.53M was the review itself, because the review ran inside a ~400-turn session that re-read ~250k tokens per turn.

Second, Cardea's own v0.2.0 work, including MCP server, auth modes and OpenAI-compatible workers, ran on the deep tier for 976 s. It was reviewed by a mid-tier model in a fresh context given only the diff and the spec. That review used 126k tokens, and every check passed.

Third, a follow-up change took 220 s.

With implementation on a worker and the review in a fresh, small context, we estimate a feature costs roughly 300–400k coordinator-side instead of 2–3M — about 85% less. That figure is an estimate from the runs above, not a benchmark.

Two qualitative results mattered as much as the totals. A contrarian review from another lab's model reshaped the design before any code existed. A deep-tier architecture review by a different model than the implementer found the one critical bug the implementer's own tests missed: a bulk update missing its scoping condition.

Caveat: one project, one operator, September 2026. Treat these numbers as orders of magnitude, and measure your own.

## Coordinator hygiene

- Workers return a summary of ≤200 words plus a file path, and only the summary enters the coordinator's context.
- Pipe test and lint output through `tail`.
- Prefer page text over screenshots.
- Prompts point at a spec file instead of restating it.
- Review in a fresh, small context, never inside the long session.
- Split big builds into phase-sized sessions.
- Never launch several large agents at once close to a usage-window reset.
- Commit work in progress so a resumed run re-reads less.
- Set the model tier explicitly on every delegated task.

## Writing a spec a worker can execute

A good worker spec starts with what to read first. Name the files in order. If the worker needs product intent, point to the brief. If it needs implementation constraints, point to the module, test, schema or design note that owns the rule.

Write deliverables as a numbered list. A worker should be able to finish item 1, then item 2, then item 3 without discovering halfway through that the actual task was hidden in a paragraph.

Include hard rules:

- Do not change build tooling or test config to suit your sandbox.
- Pin new dependencies.
- Do not commit if the sandbox cannot write `.git`; the coordinator commits after review.
- Keep changes scoped to the named files or explain why a new file is needed.
- Report any command that could not be run.

Define "done means" with exact commands. Use the commands the coordinator will run later, not vague phrases like "tests pass." Sandboxed workers often cannot write `.git`, and a worker's "tests pass" is self-reported. Run the verification yourself.

End with a word limit on the final report. For most implementation tasks, ask for ≤200 words plus changed files, commands run and risks. The report is for routing and review, not for preserving the whole transcript.

## Cost-model traps that do not show on a rate card

Newer tokenizers can emit noticeably more tokens for the same text. Re-baseline with a token-counting API before comparing model generations.

Some vendors reprice the entire request once the prompt crosses a context threshold. That is a step function, not a surcharge on the overflow.

Long-context multipliers can be asymmetric between input and output. A model can look cheap for one direction and expensive for the other once the prompt is large.

"Caching" is three different mechanisms. Provider prompt caching discounts billed input tokens. Inference-engine prefix caching saves time but not tokens. A gateway response cache skips the call entirely, and may still show the original token counts on a dashboard.

Changing tool definitions between turns invalidates the cached prefix. Pin the toolset and express dynamic capability through code or arguments. Prompt size drives caching benefit more than tool count.

## Local and OpenAI-compatible workers

Tool calling on local runtimes is generally text parsing rather than a native structured channel, and structured-output support varies. That is why these workers are text-only in Cardea.

They are still useful. Use them for summaries, drafts, classification and other low-stakes text at zero quota.

Published leaderboard claims for open-weight coding models did not survive independent verification in our research. Neither did the idea that good scaffolding rescues a weak model on long tasks. Measure candidates on your own recurring tasks before routing real work to them.

## From guide to behavior

[ROADMAP.md](../ROADMAP.md) tracks the next step: quota awareness and routing that learns from outcomes. That is how this guide becomes behavior instead of advice.

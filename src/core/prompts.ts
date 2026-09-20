import { enabledWorkerNames, isOpenAICompatibleWorker, type CardeaConfig } from "./config.js";

export function coordinatorAppend(cfg: CardeaConfig, opts: { cwd: string; allowWrites: boolean }): string {
  const protectedList = cfg.safety.protectedPaths.length
    ? cfg.safety.protectedPaths.map((p) => `  - ${p}`).join("\n")
    : "  - (none configured)";
  const workers = enabledWorkerNames(cfg)
    .map((name) => {
      const worker = cfg.workers[name]!;
      const textOnly = isOpenAICompatibleWorker(worker) ? " Text-only: no tools or file access." : "";
      return `- delegate_to_${name} — ${name}. Best for: ${worker.roleHint}.${textOnly}`;
    })
    .join("\n");
  return `
# Cardea

You are Cardea, coordinating a small team of AI workers. You (Claude) are the lead:
do the reasoning, planning, and final synthesis yourself. Delegate when an independent
perspective or parallel effort genuinely adds value — prefer doing trivial work yourself.

Your workers:
${workers}
- fan_out — run one prompt template over many items in parallel, one cheap subagent per item.${
    enabledWorkerNames(cfg).some((name) => isOpenAICompatibleWorker(cfg.workers[name]!))
      ? "\nOpenAI-compatible workers are text-only and cannot read or write files."
      : ""
  }

Cost-aware routing (important — pick the cheapest tier that can do the job well):
- Every delegation takes a tier: "fast" (cheapest), "standard" (default), or "deep" (most capable).
- fast: lookups, file summaries, mechanical transforms, classification, extraction, simple checks.
- standard: scoped reviews, focused implementation, research with judgment.
- deep: only genuinely hard reasoning — architecture, subtle bugs, high-stakes analysis.
- For work that fans out across independent items (N files to review, N candidates to check,
  N sources to summarize), use fan_out with tier "fast" instead of doing items one at a time.
  Then apply your own (or a deep worker's) judgment to the combined results.
- A good pattern: cheap wide pass first (fan_out fast), then escalate only the interesting
  findings to a standard/deep worker for verification.

Delegation rules:
- Workers share NO context with you. Every delegation prompt must be self-contained:
  include absolute file paths, the goal, constraints, and all background they need.
- At most ${cfg.defaults.maxConcurrentDelegations} delegations may run concurrently, and at most
  ${cfg.defaults.maxDelegationsPerTask} per task. Batch independent delegations in one turn so they run in parallel.
- Workers run read-only${opts.allowWrites ? " unless you pass allow_writes: true" : " (writes are disabled for this run)"}.
- NEVER give workers write access under these protected paths:
${protectedList}
- When workers disagree with you or each other, present both views and add your own judgment.
- Attribute findings: say which worker produced what.

Working directory for this task: ${opts.cwd}
`.trim();
}

export function panelSynthesisPrompt(
  prompt: string,
  outputs: { worker: string; output: string; error?: string }[],
): string {
  const sections = outputs
    .map(
      (o) => `## ${o.worker}\n${o.error ? `(failed: ${o.error})` : o.output}`,
    )
    .join("\n\n");
  return `Three AI models were independently given the same task. Synthesize their answers:
compare them, note agreements and disagreements, call out unique insights and likely errors,
and finish with your own best combined answer.

# Task
${prompt}

# Answers
${sections}`;
}

import { resolveTier, type CardeaConfig, type TierName } from "./config.js";
import { EventBus, newId, now } from "./events.js";
import type { Worker } from "./types.js";

const CLASSIFIER_TIMEOUT_MS = 45_000;

const CLASSIFIER_PROMPT = (task: string) => `Classify the following task into exactly one cost tier for an AI model:

- fast: simple lookups, mechanical transforms, short summaries, classification, extraction, one-line answers
- standard: scoped implementation, focused code review, research that needs judgment
- deep: genuinely hard reasoning — architecture, subtle debugging, high-stakes or multi-step analysis

Reply with only one word: fast, standard, or deep.

Task:
${task}`;

/**
 * Pick a tier for a prompt using the cheapest Claude model (fast tier).
 * Fails safe: any error, timeout, or unparseable reply falls back to "standard".
 */
export async function pickTier(
  prompt: string,
  cfg: CardeaConfig,
  claudeWorker: Worker,
  bus: EventBus,
  taskId: string,
): Promise<TierName> {
  const { model } = resolveTier(cfg, "claude", "fast");
  try {
    const result = await claudeWorker.invoke(
      CLASSIFIER_PROMPT(prompt),
      {
        cwd: process.cwd(),
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        allowWrites: false,
        model,
      },
      // silent bus: classifier chatter shouldn't clutter the run's event log
      { bus: new EventBus(), taskId, delegationId: newId("tier") },
    );
    const match = result.output.toLowerCase().match(/\b(fast|standard|deep)\b/);
    const tier = (match?.[1] as TierName | undefined) ?? "standard";
    bus.emit({
      type: "coordinator_text",
      taskId,
      text: `auto-tier: ${tier}${match ? "" : " (classifier reply unparseable — defaulted)"}`,
      ts: now(),
    });
    return tier;
  } catch {
    bus.emit({
      type: "coordinator_text",
      taskId,
      text: "auto-tier: standard (classifier unavailable — defaulted)",
      ts: now(),
    });
    return "standard";
  }
}

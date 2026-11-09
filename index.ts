import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { budgetPolicyFromEnv, estimateFactorFromEnv } from "./src/budget.ts";
import { compactPromptFromEnv } from "./src/compact.ts";
import liveContextExtension from "./src/index.ts";
import { observationCapFromEnv } from "./src/observation.ts";
import { overflowGuardFromEnv } from "./src/overflow.ts";
import { steeringPathFromEnv } from "./src/steering.ts";

/**
 * Pi-native lifecycle/persistence with strategy-free CLM editing policy.
 *
 * Environment (defaults for every session; the /clm panel's settings page and
 * `/clm config <setting> <value>` override them per session, saved as a session entry):
 * - PI_CLM_BUDGET / PI_CLM_RESERVE / PI_CLM_REMIND_AT — token budget and reminder tiers
 *   (defaults: model window, 2048, 0.5,0.75,0.9).
 * - PI_CLM_OBSERVATION_CAP — max characters per tool result in the effective context (off
 *   by default; the paper's CLM arm used 10000).
 * - PI_CLM_STEERING — path to a markdown steering document appended to the system prompt
 *   (off by default: protocol only).
 * - PI_CLM_OVERFLOW — "withhold" (default): when the estimated request exceeds
 *   min(budget − reserve, window − 4096 − reserve), withhold the oldest tool results and
 *   replace them with notes pointing at saved files; "off" disables.
 * - PI_CLM_ESTIMATE_FACTOR — initial calibration of the chars/4 estimator (1–4, default 1);
 *   the factor is then learned from the provider's own counts each request.
 * - PI_CLM_ONE_TOOL_PER_TURN=1 — paper-harness parity: block every tool call after the first in
 *   an assistant turn. PI_CLM_SIZE_TRAILER=1 — append "[context: ~N of B tokens]" to each tool
 *   result, as the paper's harness does.
 * - PI_CLM_COMPACT_PROMPT — markdown template `/clm-compact` sends instead of the built-in
 *   prompt ({{mirror}} {{current}} {{budget}} {{instructions}}); "default"/"none"/"off" = built in.
 * - PI_CLM_NATIVE_COMPACTION — "auto" (default): cancel Pi's threshold compaction while a
 *   budget is enforced by the overflow guard; "off": cancel all automatic compaction;
 *   "on": Pi default.
 */
function flagFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[name]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function nativeCompactionFromEnv(env: NodeJS.ProcessEnv = process.env): "auto" | "off" | "on" | undefined {
	const raw = env.PI_CLM_NATIVE_COMPACTION?.trim();
	if (!raw) return undefined;
	if (raw === "auto" || raw === "off" || raw === "on") return raw;
	throw new Error(`PI_CLM_NATIVE_COMPACTION must be auto, off or on, got ${raw}`);
}
export default function clmExtension(pi: ExtensionAPI): void {
	liveContextExtension(pi, {
		editingMode: "clm",
		budget: budgetPolicyFromEnv(),
		observationCap: observationCapFromEnv(),
		steeringPath: steeringPathFromEnv(),
		overflow: overflowGuardFromEnv(),
		nativeCompaction: nativeCompactionFromEnv(),
		estimateFactor: estimateFactorFromEnv(),
		oneToolPerTurn: flagFromEnv("PI_CLM_ONE_TOOL_PER_TURN"),
		sizeTrailer: flagFromEnv("PI_CLM_SIZE_TRAILER"),
		compactPromptPath: compactPromptFromEnv(),
		banner: { enabled: true },
	});
}

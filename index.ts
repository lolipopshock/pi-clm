import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { budgetPolicyFromEnv, estimateFactorFromEnv } from "./src/budget.ts";
import { compactPromptFromEnv } from "./src/compact.ts";
import liveContextExtension, { type LiveContextExtensionOptions } from "./src/index.ts";
import { observationCapFromEnv } from "./src/observation.ts";
import { overflowGuardFromEnv } from "./src/overflow.ts";
import { clmSettingsFilePath, loadClmSettingsFile } from "./src/settings-file.ts";
import { steeringPathFromEnv } from "./src/steering.ts";

/**
 * Pi-native lifecycle/persistence with strategy-free CLM editing policy.
 *
 * Defaults for every session come from the settings file (`<agent dir>/pi-clm/settings.json`,
 * see `src/settings-file.ts`) and, overriding it, the environment; the /clm panel's settings
 * page and `/clm config <setting> <value>` override both per session, saved as a session entry.
 *
 * Environment:
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

/** The settings file's defaults, each replaced by its environment variable when that is set. */
export function clmOptions(
	env: NodeJS.ProcessEnv = process.env,
	settingsFile: string = clmSettingsFilePath(getAgentDir()),
): LiveContextExtensionOptions {
	const { defaults: file, warning } = loadClmSettingsFile(settingsFile, join(dirname(fileURLToPath(import.meta.url)), "steering", "house-brief.md"));
	const isSet = (name: string) => Boolean(env[name]?.trim());
	const fileBudget = { ...file.budget };
	const envBudget = budgetPolicyFromEnv(env);
	// PI_CLM_REMIND_AT replaces the file's reminders as a whole, including a file "off".
	if (envBudget.remindAtFractions) delete fileBudget.remindAtReserve;
	return {
		editingMode: "clm",
		budget: { ...fileBudget, ...envBudget },
		observationCap: isSet("PI_CLM_OBSERVATION_CAP") ? observationCapFromEnv(env) : { ...file.observationCap },
		steeringPath: isSet("PI_CLM_STEERING") ? steeringPathFromEnv(env) : file.steeringPath,
		overflow: { ...file.overflow, ...overflowGuardFromEnv(env) },
		nativeCompaction: nativeCompactionFromEnv(env) ?? file.nativeCompaction,
		estimateFactor: estimateFactorFromEnv(env),
		oneToolPerTurn: isSet("PI_CLM_ONE_TOOL_PER_TURN") ? flagFromEnv("PI_CLM_ONE_TOOL_PER_TURN", env) : file.oneToolPerTurn === true,
		sizeTrailer: isSet("PI_CLM_SIZE_TRAILER") ? flagFromEnv("PI_CLM_SIZE_TRAILER", env) : file.sizeTrailer === true,
		compactPromptPath: isSet("PI_CLM_COMPACT_PROMPT") ? compactPromptFromEnv(env) : file.compactPromptPath,
		settingsFileWarning: warning,
		banner: { enabled: true },
	};
}

export default function clmExtension(pi: ExtensionAPI): void {
	liveContextExtension(pi, clmOptions());
}

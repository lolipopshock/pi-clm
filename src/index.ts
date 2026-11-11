import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { applyContextDocument, renderContextDocument } from "./context-document.ts";
import {
	CONTINUITY_SIZE_WARNING_TOKENS,
	DEFAULT_RECALL_TOKENS,
	LIVE_CONTEXT_ANNOTATION,
	MAX_PIN_SOURCE_TOKENS,
	MAX_RECALL_TOKENS,
	MIN_RECALL_TOKENS,
	activeContinuityAnnotations,
	ContinuitySizeTracker,
	createAnnotation,
	findEntryById,
	findSourceEntry,
	formatContinuityMessage,
	formatRecall,
	messageFromSessionEntry,
	reconstructLiveContextAnnotations,
	resolveAnnotation,
	sourceContentHash,
	validateAnnotationSource,
	type ContinuitySessionEntryLike,
	type LiveContextAnnotation,
	type LiveContextRetention,
} from "./continuity.ts";
import { MirrorStore } from "./mirror-store.ts";
import { promptTokens } from "./usage.ts";
import {
	BudgetTracker,
	EstimateCalibrator,
	budgetNoticeText,
	budgetSummaryLine,
	budgetTiers,
	resolveBudget,
	resolveBudgetPolicy,
	type BudgetPolicyConfig,
	type BudgetReading,
} from "./budget.ts";
import { classifyMirrorToolCall } from "./mirror-guard.ts";
import { capObservations, resolveObservationCap, type ObservationCapPolicy } from "./observation.ts";
import {
	applyOverflowGuard,
	overflowGuardLimit,
	overflowNoticeText,
	resolveOverflowGuard,
	type OverflowGuardPolicy,
} from "./overflow.ts";
import { PressureTracker, selectContextVisibleMessages } from "./policy.ts";
import {
	compositionWarningText,
	contextMode,
	outcomeText,
	pressureNoticeText,
	statusDetails,
	systemGuidance,
	type ObservedUsage,
} from "./presentation.ts";
import {
	applyProjection,
	createProjectionCheckpoint,
	PROJECTION_PREFIX_MISMATCH_REASON,
	PROJECTION_SHORTER_REASON,
	recoverProjectionAtEditBoundary,
	recoverProjectionFromRetryErrors,
	type ProjectionCheckpoint,
	type ProjectionRecovery,
} from "./projection.ts";
import {
	LIVE_CONTEXT_STATE,
	initialLiveContextState,
	reconstructLiveContextHistory,
	reconstructLiveContextState,
	resetProjectionState,
	toOutcomeEntry,
} from "./state.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { bannerHeader, bannerLines, bannerMarkerPath, claimFirstRun } from "./banner.ts";
import { buildCompactPrompt, loadCompactPrompt } from "./compact.ts";
import {
	applyOverrides,
	changedSettings,
	CLM_SETTING_COMMAND_KEYS,
	CLM_SETTINGS,
	CLM_SETTINGS_ENTRY,
	type ClmSettings,
	type ClmSettingsOverrides,
	defaultClmSettings,
	formatTokens,
	isClmSettingsEntry,
	sanitizeOverrides,
	settingDescriptor,
} from "./settings.ts";
import { loadSteeringDocument, steeringPromptSection, type SteeringDocument } from "./steering.ts";
import type { LiveContextMessage, TurnBaseline } from "./types.ts";
import {
	buildLiveContextViewModel,
	CLM_VIEW_TABS,
	LIVE_CONTEXT_VIEW_TABS,
	showLiveContextViewer,
	type CurrentContextView,
	type ViewerSettingsController,
} from "./viewer.ts";

const STATUS_KEY = "live-context";
const NOTICE_TYPE = "live-context-notice";
const CONTINUITY_MESSAGE_TYPE = "live-context-continuity";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const AnnotationParameters = Type.Object({
	action: StringEnum(["create", "resolve", "list"] as const),
	source: Type.Optional(Type.String({ description: "Current CTX_TURN block ID or active-branch Pi entry ID" })),
	id: Type.Optional(Type.String({ description: "Annotation ID for resolve" })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
	futureAction: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
	retention: Type.Optional(StringEnum(["pin", "continuity", "archive"] as const)),
	resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
});

const RecallParameters = Type.Object({
	id: Type.String({ description: "Durable live-context annotation ID" }),
	maxTokens: Type.Optional(Type.Integer({ minimum: MIN_RECALL_TOKENS, maximum: MAX_RECALL_TOKENS })),
});

function asLiveMessages(messages: AgentMessage[]): LiveContextMessage[] {
	// SAFETY: LiveContextMessage is a permissive structural view; original Pi objects are retained.
	return messages as unknown as LiveContextMessage[];
}

function asAgentMessages(messages: LiveContextMessage[]): AgentMessage[] {
	// SAFETY: callers reuse Pi messages or validated CLM-lowered messages, never authored wire roles.
	return messages as unknown as AgentMessage[];
}

const tokenEstimateCache = new WeakMap<LiveContextMessage, number>();

function estimateLiveContextTokens(messages: LiveContextMessage[]): number {
	return messages.reduce((total, message) => {
		let tokens = tokenEstimateCache.get(message);
		if (tokens === undefined) {
			// SAFETY: estimates use the same Pi-compatible message objects as the outgoing context.
			tokens = estimateTokens(message as unknown as AgentMessage);
			tokenEstimateCache.set(message, tokens);
		}
		return total + tokens;
	}, 0);
}

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 } as AgentMessage);
}

/**
 * Provider-reported size of the most recent completed request: the usage of the newest
 * successful assistant message. Unlike `ctx.getContextUsage()`, this never blends in
 * harness estimates for trailing messages, so it can be labelled "observed" honestly.
 */
function lastProviderReportedTokens(rawMessages: LiveContextMessage[]): { tokens: number; index: number } | undefined {
	for (let index = rawMessages.length - 1; index >= 0; index--) {
		// SAFETY: rawMessages reuses Pi-sourced messages; restore their union before narrowing the role.
		const message = rawMessages[index] as unknown as AgentMessage;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		if (!usage) continue;
		const tokens = promptTokens(usage);
		if (tokens > 0) return { tokens, index };
	}
	return undefined;
}

/** `/var/folders/…/T/pi-live-context-01a0ebe3-…/LIVE_CONTEXT.md` → `…/pi-live-context-01a0ebe3…/LIVE_CONTEXT.md`. */
function shortPath(path: string): string {
	const parts = path.split(/[\\/]/);
	const file = parts.at(-1) ?? path;
	const dir = parts.at(-2);
	if (!dir) return path;
	return `…/${dir.length > 24 ? `${dir.slice(0, 24)}…` : dir}/${file}`;
}

function requiredToolText(value: string | undefined, name: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text) throw new Error(`${name} is required.`);
	return text;
}

function sameMessageSequence(left: LiveContextMessage[], right: LiveContextMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

export interface LiveContextExtensionOptions {
	editingMode?: "conservative" | "clm";
	/** CLM-mode budget/reminder policy. Ignored in conservative mode, which keeps the percentage tiers. */
	budget?: Partial<BudgetPolicyConfig>;
	/** CLM-mode cap on each tool result in the effective context. Off unless `maxCharacters` is set. */
	observationCap?: Partial<ObservationCapPolicy>;
	/** CLM-mode steering document appended to the system prompt; strategy lives here, not in the harness. */
	steeringPath?: string;
	/** CLM-mode overflow guard: withhold the oldest tool results when the estimated request exceeds the limit. */
	overflow?: Partial<OverflowGuardPolicy>;
	/**
	 * CLM-mode policy for Pi's automatic compaction. `auto` (default) cancels threshold
	 * compactions whenever a budget is enforced by the overflow guard — Pi measures the raw
	 * transcript, which CLM never shrinks, and its summary would discard the model's edits.
	 * `off` cancels every automatic compaction (manual /compact still works). `on` leaves Pi
	 * alone.
	 */
	nativeCompaction?: "auto" | "off" | "on";
	/** Initial estimator calibration factor (≥1); learned from provider counts afterwards. */
	estimateFactor?: number;
	/**
	 * Paper-harness parity: allow exactly one tool call per assistant turn (further calls in
	 * the same turn are blocked with an explanatory error result).
	 */
	oneToolPerTurn?: boolean;
	/** Paper-harness parity: append `[context: ~N of B tokens]` to every tool result. */
	sizeTrailer?: boolean;
	/** `/clm-compact` prompt template (markdown with {{placeholders}}); default is the built-in prompt. */
	compactPromptPath?: string;
	/**
	 * CLM-mode banner: on the first session after install, replace Pi's startup header with a
	 * short introduction; `/clm about` shows it again. Off unless enabled, so hosts and tests
	 * never write the marker file (`<agent dir>/pi-clm/welcomed` unless `markerPath` is given).
	 */
	banner?: { enabled?: boolean; markerPath?: string };
}

export default function liveContextExtension(pi: ExtensionAPI, options: LiveContextExtensionOptions = {}): void {
	const editingMode = options.editingMode ?? "conservative";
	const commandName = editingMode === "clm" ? "clm" : "live-context";
	let state = initialLiveContextState();
	let store: MirrorStore | undefined;
	let turnBaseline: TurnBaseline | undefined;
	let lifecycleEpoch = 0;
	/** A /clm-compact waiting for the agent to go idle; a second one is refused instead of racing it. */
	let compactPending = false;
	let pendingNotice: string | undefined;
	let mirrorMutationSeen = false;
	let invalidationStreak = 0;
	let compositionWarned = false;
	let observedUsage: ObservedUsage | undefined;
	let awaitObservationForRevision: number | undefined;
	let currentContextView: CurrentContextView | undefined;
	let annotations: LiveContextAnnotation[] = [];
	let checkpointHistory: ProjectionCheckpoint[] = [];
	/** The reset revision whose revival already failed; the checked prefix cannot change until the state does. */
	let revivalFailedAt: number | undefined;
	const pressure = new PressureTracker();
	const continuitySize = new ContinuitySizeTracker();
	let budgetPolicy = resolveBudgetPolicy(options.budget);
	let observationCap = resolveObservationCap(options.observationCap);
	let overflowGuard = resolveOverflowGuard(options.overflow);
	let pendingOverflowNotice: string | undefined;
	const calibrator = new EstimateCalibrator({ initial: options.estimateFactor });
	let oneToolPerTurn = editingMode === "clm" && options.oneToolPerTurn === true;
	let sizeTrailer = editingMode === "clm" && options.sizeTrailer === true;
	let toolCallsThisTurn = 0;
	let maxTokensLifts = 0;
	let nativeCompaction = options.nativeCompaction ?? "auto";
	let steering: SteeringDocument | undefined;
	let steeringError: string | undefined;
	// CLM settings: defaults come from the options (environment at load); the panel and
	// `/clm config` store per-session overrides as a branch-local session entry.
	const baseSettings = defaultClmSettings(options);
	let settingsOverrides: ClmSettingsOverrides = {};
	let settings: ClmSettings = baseSettings;
	const bundledSteering = join(EXTENSION_DIR, "..", "steering", "house-brief.md");
	/** Path the current `steering` / `steeringError` belong to; null until first applied. */
	let loadedSteeringPath: string | undefined | null = null;
	const budgetTracker = new BudgetTracker();
	let lastBudgetReading: BudgetReading | undefined;
	/** Saved settings that could not be used at restore, reported in status until settings are saved again. */
	let settingsWarning: string | undefined;
	/**
	 * `/clm reset` or a native compaction replaced the projection since the last request: the
	 * old reading and the session's last provider count describe a context that no longer exists.
	 */
	let projectionReplaced = false;
	if (editingMode === "clm") activateSettings(stageSettings(baseSettings, { strictSteering: false }));

	/** A resolved configuration, ready to activate. */
	interface StagedSettings {
		settings: ClmSettings;
		budgetPolicy: typeof budgetPolicy;
		observationCap: ObservationCapPolicy;
		steering: SteeringDocument | undefined;
		steeringError: string | undefined;
	}

	/**
	 * Resolve `next` without touching the live configuration, so a change can be validated
	 * and persisted before it takes effect. With `strictSteering` (interactive edits), a
	 * steering document or compact prompt that fails to load rejects the whole change;
	 * otherwise a steering failure is recorded and reported, and the rest applies (startup,
	 * resume).
	 */
	function stageSettings(next: ClmSettings, { strictSteering }: { strictSteering: boolean }): StagedSettings {
		let nextSteering = steering;
		let nextSteeringError = steeringError;
		if (next.steering !== loadedSteeringPath) {
			nextSteering = undefined;
			nextSteeringError = undefined;
			if (next.steering) {
				try {
					nextSteering = loadSteeringDocument(next.steering);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (strictSteering) throw new Error(`steering document not loaded: ${message}`);
					nextSteeringError = message;
				}
			}
		}
		// A template that cannot be read is rejected when it is set, not when /clm-compact runs.
		if (strictSteering && next.compactPrompt && next.compactPrompt !== settings.compactPrompt) loadCompactPrompt(next.compactPrompt);
		const sameReminders = next.reminders.join(",") === baseSettings.reminders.join(",");
		const nextBudgetPolicy = resolveBudgetPolicy({
			...options.budget,
			contextBudget: next.budget,
			contextBudgetPercent: next.budgetPercent,
			reserve: next.reserve,
			remindAtFractions: next.reminders,
			remindAtReserve: sameReminders ? options.budget?.remindAtReserve ?? true : next.reminders.length > 0,
		});
		return {
			settings: next,
			budgetPolicy: nextBudgetPolicy,
			observationCap: resolveObservationCap({ maxCharacters: next.cap, headFraction: next.capHead }),
			steering: nextSteering,
			steeringError: nextSteeringError,
		};
	}

	/** Make staged settings the live configuration. */
	function activateSettings(staged: StagedSettings): void {
		const next = staged.settings;
		const budgetChanged =
			next.budget !== settings.budget ||
			next.budgetPercent !== settings.budgetPercent ||
			next.reserve !== settings.reserve ||
			next.reminders.join(",") !== settings.reminders.join(",");
		budgetPolicy = staged.budgetPolicy;
		observationCap = staged.observationCap;
		overflowGuard = resolveOverflowGuard({ mode: next.guard });
		nativeCompaction = next.compaction;
		oneToolPerTurn = next.oneTool;
		sizeTrailer = next.trailer;
		steering = staged.steering;
		steeringError = staged.steeringError;
		loadedSteeringPath = next.steering;
		settings = next;
		if (budgetChanged) {
			budgetTracker.reset();
			lastBudgetReading = undefined;
		}
	}

	/** Save the overrides as a session entry; throws a user-facing message when that fails. */
	function persistSettings(overrides: ClmSettingsOverrides): void {
		try {
			pi.appendEntry(CLM_SETTINGS_ENTRY, { version: 1, overrides });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Settings unchanged: saving them to the session failed (${message}).`);
		}
	}

	function restoreSettings(branch: readonly { type?: string; customType?: string; data?: unknown }[]): void {
		if (editingMode !== "clm") return;
		const entry = [...branch].reverse().find((candidate) => candidate.type === "custom" && candidate.customType === CLM_SETTINGS_ENTRY);
		const { overrides, ignored } = entry && isClmSettingsEntry(entry.data)
			? sanitizeOverrides(entry.data.overrides)
			: { overrides: {}, ignored: [] as string[] };
		settingsWarning = ignored.length > 0 ? `ignored invalid saved settings: ${ignored.join(", ")}` : undefined;
		try {
			activateSettings(stageSettings(applyOverrides(baseSettings, overrides), { strictSteering: false }));
			settingsOverrides = overrides;
		} catch (error) {
			// Saved settings must never break session start: fall back to the defaults.
			activateSettings(stageSettings(baseSettings, { strictSteering: false }));
			settingsOverrides = {};
			settingsWarning = `ignored saved settings: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Apply `/clm config <key> <value>` (or a panel change); throws with a user-facing message. */
	function changeSetting(key: string, text: string, ctx: ExtensionContext): string {
		const descriptor = settingDescriptor(key);
		if (!descriptor) throw new Error(`Unknown setting "${key}". Settings: ${CLM_SETTING_COMMAND_KEYS.join(", ")}.`);
		const parsed = descriptor.parse(text, bundledSteering);
		const nextOverrides: ClmSettingsOverrides = { ...settingsOverrides, ...parsed };
		// Store only what differs from the default, so "changed" means changed.
		for (const [name, value] of Object.entries(parsed) as [keyof ClmSettings, unknown][]) {
			const baseValue = baseSettings[name];
			const normalized = value === null ? undefined : value;
			if (JSON.stringify(normalized) === JSON.stringify(baseValue)) delete nextOverrides[name];
		}
		// Validate, persist, then activate: a change that is not saved never takes effect.
		const staged = stageSettings(applyOverrides(baseSettings, nextOverrides), { strictSteering: true });
		persistSettings(nextOverrides);
		activateSettings(staged);
		settingsOverrides = nextOverrides;
		settingsWarning = undefined; // the saved entry is now well-formed
		updateStatus(ctx);
		return `${descriptor.label}: ${descriptor.format(settings, { modelWindow: ctx.model?.contextWindow })}`;
	}

	function resetSettings(ctx: ExtensionContext): void {
		const staged = stageSettings(applyOverrides(baseSettings, {}), { strictSteering: false });
		persistSettings({});
		activateSettings(staged);
		settingsOverrides = {};
		settingsWarning = undefined;
		updateStatus(ctx);
	}

	/**
	 * Calibrated estimate of a request: system prompt, messages and notices. The budget
	 * reading and the status fallback use this one measure, so they never disagree about
	 * what a request contains.
	 */
	function estimateRequestTokens(ctx: ExtensionContext, messages: LiveContextMessage[], notices: readonly string[] = []): number {
		const systemPromptTokens = estimateTextTokens(ctx.getSystemPrompt?.() ?? "");
		const noticeTokens = notices.reduce((total, notice) => total + estimateTextTokens(notice), 0);
		return calibrator.apply(systemPromptTokens + estimateLiveContextTokens(messages) + noticeTokens);
	}

	/** Calibrated sizes for status text: the next request, and raw vs sent messages. */
	function sizeFigures(ctx: ExtensionContext): {
		next?: number;
		observed?: number;
		budget?: number;
		budgetSource?: "config" | "model-window";
		raw?: number;
		sent?: number;
	} {
		const resolved = resolveBudget(budgetPolicy, ctx.model?.contextWindow);
		const reading = lastBudgetReading && resolved && lastBudgetReading.budget === resolved.budget ? lastBudgetReading : undefined;
		const factor = calibrator.factor;
		const measured = currentContextView !== undefined;
		// After /clm reset or a native compaction, estimate the rebuilt context instead.
		const replaced = projectionReplaced && !measured;
		// Before the first request of this runtime (e.g. after resume), sizes come from the
		// session: the provider's count of the last request, and a rebuilt snapshot.
		const snapshot = measured ? currentContextView! : contextSnapshot(ctx);
		const sessionObserved = reading || replaced ? undefined : lastProviderReportedTokens(snapshot.rawMessages ?? []);
		const sessionObservedStale = sessionObserved !== undefined && state.checkpoint !== undefined &&
			sessionObserved.index < state.checkpoint.sourceMessageCount;
		return {
			// Without a reading for the current budget (e.g. just after a settings change), estimate
			// the next request from the context snapshot the same way the reading does.
			next: reading?.estimated ?? (measured || replaced ? estimateRequestTokens(ctx, snapshot.effectiveMessages) : undefined),
			observed: reading ? (reading.observedStale ? undefined : reading.observed) : sessionObservedStale ? undefined : sessionObserved?.tokens,
			budget: resolved?.budget,
			budgetSource: resolved?.source,
			raw: snapshot ? Math.round(snapshot.rawTokens * factor) : undefined,
			sent: snapshot ? Math.round(snapshot.effectiveTokens * factor) : undefined,
		};
	}

	/** Footer: `clm 346k / 1.0m · r2` (calibrated estimate of the next request against the budget). */
	function clmFooterText(ctx: ExtensionContext): string {
		if (!state.enabled) return `clm off · r${state.revision}`;
		const { next, observed, budget } = sizeFigures(ctx);
		const shown = next ?? observed;
		const size = shown === undefined ? "" : ` ${formatTokens(shown)}${budget ? ` / ${formatTokens(budget)}` : ""}`;
		return `clm${size} · r${state.revision}`;
	}

	function settingsSummary(ctx: ExtensionContext): string {
		const changed = changedSettings(baseSettings, settings);
		if (changed.length === 0) return "settings: defaults";
		return `settings: ${changed.map((key) => {
			const item = CLM_SETTINGS.find((candidate) => candidate.key === key)!;
			return `${item.label.toLowerCase()} ${item.format(settings, { modelWindow: ctx.model?.contextWindow })}`;
		}).join(" · ")}`;
	}

	function warnings(): string[] {
		const lines: string[] = [];
		if (settingsWarning) lines.push(`⚠ ${settingsWarning}`);
		if (steeringError) lines.push(`⚠ steering document not loaded: ${steeringError}`);
		if (state.lastOutcome?.kind === "rejected") lines.push(`⚠ last edit rejected: ${state.lastOutcome.message}`);
		return lines;
	}

	/** `/clm status`: three lines — size against budget, edits, settings — plus any warnings. */
	function shortStatus(ctx: ExtensionContext): string {
		const { next, observed, budget, raw, sent } = sizeFigures(ctx);
		const of = (tokens: number) => `${budget ? ` of ${formatTokens(budget)} budget (${Math.round((tokens / budget) * 100)}%)` : ""}`;
		const size = next !== undefined
			? `next request ~${formatTokens(next)}${of(next)}`
			: observed !== undefined
				? `last request ${formatTokens(observed)}${of(observed)}, provider count`
				: `${budget ? `budget ${formatTokens(budget)} · ` : ""}no request measured yet`;
		const head = !state.enabled
			? `CLM off · r${state.revision} · the model sees the raw transcript (/clm on)`
			: `CLM on · r${state.revision} · ${size}`;
		const saved = raw && sent !== undefined && raw > sent ? ` (−${Math.round(((raw - sent) / raw) * 100)}%)` : "";
		const outcome = state.lastOutcome
			? ` · last ${state.lastOutcome.kind === "applied" ? "edit" : state.lastOutcome.kind} ${new Date(state.lastOutcome.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
			: " · no edits yet";
		const messages = raw !== undefined && sent !== undefined ? `messages ~${formatTokens(sent)} sent of ~${formatTokens(raw)} raw${saved}` : "no messages yet";
		return [head, `${messages}${outcome}`, `${settingsSummary(ctx)} · /clm for the panel`, ...warnings()].join("\n");
	}

	/** Grouped details: the text form of the panel's settings page. */
	function settingsDetails(ctx: ExtensionContext): string[] {
		const { next, observed, budget } = sizeFigures(ctx);
		const window = ctx.model?.contextWindow;
		const limit = (() => {
			const resolved = resolveBudget(budgetPolicy, window);
			return resolved ? overflowGuardLimit(resolved.budget, resolved.reserve, window) : undefined;
		})();
		const active = activeContinuityAnnotations(annotations).length;
		const archived = annotations.filter((annotation) => annotation.retention === "archive" && annotation.resolvedAt === undefined).length;
		return [
			`Size      ${[
				next !== undefined ? `next request ~${formatTokens(next)}${budget ? ` of ${formatTokens(budget)}` : ""}` : budget ? `budget ${formatTokens(budget)}` : undefined,
				observed !== undefined ? `last request ${formatTokens(observed)} (provider count)` : undefined,
				next === undefined ? "next request not measured yet" : undefined,
			].filter(Boolean).join(" · ")}`,
			calibrator.sampleCount === 0
				? `          estimate not calibrated yet (characters ÷ 4 until the provider reports a size)`
				: `          estimate ×${calibrator.factor.toFixed(2)}, calibrated from ${calibrator.sampleCount} provider count${calibrator.sampleCount === 1 ? "" : "s"}`,
			`Guard     ${overflowGuard.mode === "off" ? "off" : `withholds the oldest tool results above ${limit === undefined ? "?" : formatTokens(limit)}`}${nativeCompaction === "on" ? "" : nativeCompaction === "off" ? " · Pi's automatic compaction off" : overflowGuard.mode === "off" ? "" : " · Pi's automatic compaction paused"}`,
			// The steering hash identifies an experiment arm exactly (matches `sha256sum`).
			...(steering ? [`Prompt    steering ${steering.name} (sha256sum ${steering.hash}…) · ${steering.path}`] : []),
			`Files     mirror ${store ? shortPath(store.filePath) : "unavailable"} (full path: /clm path)`,
			`          annotations ${annotations.length === 0 ? "none" : `${active} continuity/pin · ${archived} archive · ${annotations.length} total`}${maxTokensLifts > 0 ? ` · max_tokens clamp lifted on ${maxTokensLifts} request${maxTokensLifts === 1 ? "" : "s"}` : ""}`,
			...warnings(),
		];
	}

	function settingsText(ctx: ExtensionContext): string {
		const rows = [
			`CLM editing: ${state.enabled ? "on" : "off"}`,
			...CLM_SETTINGS.map((item) => `${item.label.padEnd(18)} ${item.format(settings, { modelWindow: ctx.model?.contextWindow })}${changedSettings(baseSettings, settings).includes(item.key) ? "  (changed)" : ""}`),
		];
		return [...settingsDetails(ctx), "", ...rows, "", `Change with /clm config <${CLM_SETTING_COMMAND_KEYS.join("|")}> <value>, or /clm config reset.`].join("\n");
	}

	function settingsController(ctx: ExtensionCommandContext): ViewerSettingsController {
		return {
			items: () => [
				{
					id: "editing",
					label: "CLM editing",
					value: state.enabled ? "on" : "off",
					choices: ["on", "off"],
					description: "Off: the model sees the raw transcript and the mirror is not offered. Same as /clm on | off.",
				},
				...CLM_SETTINGS.map((item) => {
					const value = item.format(settings, { modelWindow: ctx.model?.contextWindow });
					const choices = item.choices && !item.choices.includes(value) ? [value, ...item.choices] : item.choices;
					return {
						id: item.key,
						label: changedSettings(baseSettings, settings).includes(item.key) ? `${item.label} •` : item.label,
						value,
						description: `${item.description} Default: ${item.format(baseSettings, { modelWindow: ctx.model?.contextWindow })}.`,
						...(choices ? { choices } : {}),
						...(item.placeholder ? { placeholder: item.placeholder } : {}),
					};
				}),
				{
					id: "reset",
					label: "Reset to defaults",
					value: Object.keys(settingsOverrides).length === 0 ? "nothing changed" : `${Object.keys(settingsOverrides).length} changed`,
					choices: Object.keys(settingsOverrides).length === 0 ? undefined : [`${Object.keys(settingsOverrides).length} changed`, "reset now"],
					description: "Drop this session's changes; the environment defaults apply again.",
				},
			],
			apply: (id, value) => {
				try {
					if (id === "editing") {
						setEnabled(value === "on", ctx);
					} else if (id === "reset") {
						if (value === "reset now") resetSettings(ctx);
					} else {
						// Cycled labels like "10k chars" parse like typed values.
						changeSetting(id, value.replace(/ chars.*$/, ""), ctx);
					}
					return undefined;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
			summary: () => settingsDetails(ctx),
		};
	}

	function setEnabled(enabled: boolean, ctx: ExtensionContext): void {
		if (enabled === state.enabled) return;
		if (enabled) {
			persistOutcome({ ...state, enabled: true, event: { kind: "enabled", at: new Date().toISOString() } });
		} else {
			persistOutcome({ ...state, enabled: false, event: { kind: "disabled", at: new Date().toISOString() } });
			lifecycleEpoch++;
			turnBaseline = undefined;
			currentContextView = undefined;
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_KEY,
			editingMode === "clm" ? clmFooterText(ctx) : outcomeText(state, observedUsage, currentContextView),
		);
	}

	/** Record the provider-reported size of the first request served by a new revision. */
	function captureObservedUsage(ctx: ExtensionContext): void {
		if (awaitObservationForRevision === undefined) return;
		if (awaitObservationForRevision !== state.revision) {
			awaitObservationForRevision = undefined;
			return;
		}
		const usage = ctx.getContextUsage?.();
		if (!usage || usage.tokens === null || usage.percent === null) return;
		observedUsage = { revision: state.revision, tokens: usage.tokens, percent: usage.percent };
		awaitObservationForRevision = undefined;
		updateStatus(ctx);
	}

	function rememberCheckpoint(checkpoint: ProjectionCheckpoint | undefined): void {
		if (!checkpoint) return;
		checkpointHistory = [
			...checkpointHistory.filter((candidate) => candidate.revision !== checkpoint.revision),
			checkpoint,
		].sort((left, right) => left.revision - right.revision);
	}

	function persist(nextState: typeof state): void {
		pi.appendEntry(LIVE_CONTEXT_STATE, nextState);
		state = nextState;
		rememberCheckpoint(state.checkpoint);
	}

	/** Persistence must succeed before activating even a slim state transition. */
	function persistOutcome(nextState: typeof state): void {
		pi.appendEntry(LIVE_CONTEXT_STATE, toOutcomeEntry(nextState));
		state = nextState;
	}

	async function replaceStore(ctx: ExtensionContext): Promise<void> {
		await store?.cleanup().catch(() => undefined);
		store = undefined;
		try {
			store = await MirrorStore.create(ctx.sessionManager.getSessionId());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pendingNotice = `[LIVE CONTEXT] Could not initialize the private mirror: ${message}`;
			ctx.ui.notify(pendingNotice, "error");
		}
	}

	function restore(ctx: ExtensionContext): void {
		lifecycleEpoch++;
		const branch = ctx.sessionManager.getBranch() as ContinuitySessionEntryLike[];
		state = reconstructLiveContextState(branch);
		checkpointHistory = reconstructLiveContextHistory(branch)
			.flatMap((snapshot) => snapshot.checkpoint ? [snapshot.checkpoint] : [])
			.filter((checkpoint, index, checkpoints) =>
				checkpoints.findIndex((candidate) => candidate.revision === checkpoint.revision) === index,
			)
			.sort((left, right) => left.revision - right.revision);
		annotations = reconstructLiveContextAnnotations(branch);
		restoreSettings(branch);
		turnBaseline = undefined;
		currentContextView = undefined;
		observedUsage = undefined;
		awaitObservationForRevision = undefined;
		invalidationStreak = 0;
		compositionWarned = false;
		revivalFailedAt = undefined;
		continuitySize.reset();
		budgetTracker.reset();
		lastBudgetReading = undefined;
		projectionReplaced = false;
		calibrator.reset();
		updateStatus(ctx);
	}

	function queueOutcomeNotice(message: string): void {
		pendingNotice = `[LIVE CONTEXT] ${message}`;
	}

	/**
	 * The branch begins at an entry whose parent never reached the session file: Pi keeps an
	 * entry it failed to write (e.g. on a full disk), and later entries name it as their parent,
	 * so on resume the rebuilt history stops there and everything before it is missing.
	 */
	function branchLostEntries(ctx: ExtensionContext): boolean {
		const parentId = ctx.sessionManager.getBranch()[0]?.parentId;
		return typeof parentId === "string" &&
			typeof ctx.sessionManager.getEntry === "function" &&
			ctx.sessionManager.getEntry(parentId) === undefined;
	}

	function findHistoricalRecovery(ctx: ExtensionContext, rawMessages: LiveContextMessage[]): {
		target: ProjectionCheckpoint;
		recovery: Extract<ProjectionRecovery, { valid: true }>;
	} | undefined {
		if (state.checkpoint || state.lastOutcome?.kind !== "reset" || revivalFailedAt === state.revision) return undefined;
		// Resets may carry a description after the reason. A shorter history is revived only
		// when the session file lost entries; otherwise it was shortened on purpose.
		const mismatch = state.lastOutcome.message.startsWith(PROJECTION_PREFIX_MISMATCH_REASON);
		const lostHistory = branchLostEntries(ctx);
		if (!mismatch && !(lostHistory && state.lastOutcome.message.startsWith(PROJECTION_SHORTER_REASON))) return undefined;

		const newestFirst = [...checkpointHistory].sort((left, right) => right.revision - left.revision);
		for (const target of newestFirst) {
			const recovery = recoverProjectionFromRetryErrors(rawMessages, target, checkpointHistory);
			if (recovery.valid && recovery.removedErrorCount > 0) return { target, recovery };
		}
		// Only the checkpoint the reset replaced is revived by its edit boundary.
		const newest = newestFirst[0];
		const recovery = newest ? recoverProjectionAtEditBoundary(rawMessages, newest, { lostHistory }) : undefined;
		if (newest && recovery?.valid) return { target: newest, recovery };
		revivalFailedAt = state.revision;
		return undefined;
	}

	function rebaseRecoveredProjection(
		rawMessages: LiveContextMessage[],
		target: ProjectionCheckpoint,
		recovery: Extract<ProjectionRecovery, { valid: true }>,
	): void {
		const revision = state.revision + 1;
		const at = new Date().toISOString();
		const beforeTokens = estimateLiveContextTokens(selectContextVisibleMessages(rawMessages));
		const afterTokens = estimateLiveContextTokens(selectContextVisibleMessages(recovery.messages));
		const anchor = recovery.anchorRevision === undefined
			? "the session start"
			: `revision ${recovery.anchorRevision}`;
		const message = recovery.unverified === "lost-history"
			? `Recovered projection revision ${target.revision} after resume, unverified: the session file lost entries` +
				` before this branch (a write failed, e.g. on a full disk), so the rebuilt history lacks part of its source;` +
				` its edit's reply is message ${recovery.boundary} of the rebuilt history; rebased as revision ${revision}.`
			: recovery.boundary !== undefined
			? `Recovered projection revision ${target.revision} after resume${recovery.unverified ? ", unverified" : ""}:` +
				` its source ends at message ${recovery.boundary} of the rebuilt history` +
				(recovery.removedErrorCount > 0
					? `, which keeps ${recovery.removedErrorCount} failed response(s) the live conversation had dropped`
					: "") +
				(recovery.unverified === "extension-messages"
					? " (the prefix holds extension messages, which Pi timestamps differently live and in the session file)"
					: "") +
				`; rebased as revision ${revision}.`
			: `Recovered projection revision ${target.revision} after resume by reconciling` +
				` ${recovery.removedErrorCount} persisted retry error response(s) after ${anchor};` +
				` rebased as revision ${revision}.`;
		const checkpoint = createProjectionCheckpoint({
			revision,
			sourceMessages: rawMessages,
			projectedMessages: recovery.messages,
			beforeEstimate: beforeTokens,
			afterEstimate: afterTokens,
			estimateUnit: "tokens",
			createdAt: at,
		});
		persist({
			version: 1,
			enabled: state.enabled,
			revision,
			checkpoint,
			lastOutcome: {
				kind: "applied",
				message,
				beforeEstimate: beforeTokens,
				afterEstimate: afterTokens,
				estimateUnit: "tokens",
				at,
			},
		});
		awaitObservationForRevision = revision;
		queueOutcomeNotice(message);
	}

	function pressureNotice(ctx: ExtensionContext): string | undefined {
		const percent = ctx.getContextUsage?.()?.percent;
		const tier = pressure.observe(percent);
		if (tier === undefined || percent === null || percent === undefined) return undefined;
		return pressureNoticeText(percent, tier, store?.filePath);
	}

	/**
	 * CLM-mode reminder: absolute tokens against a configurable budget. The estimate covers
	 * the request about to be sent (system prompt + effective messages); the observed value is
	 * Pi's provider-reported size of the previous request. Both are reported, neither is
	 * relabelled as the other.
	 */
	function budgetNotice(
		ctx: ExtensionContext,
		rawMessages: LiveContextMessage[],
		modelEffectiveMessages: LiveContextMessage[],
		knownNotices: readonly string[],
	): string | undefined {
		const resolved = resolveBudget(budgetPolicy, ctx.model?.contextWindow);
		if (!resolved) {
			lastBudgetReading = undefined;
			return undefined;
		}
		const observed = lastProviderReportedTokens(rawMessages);
		// An observation is stale when the request it measured was answered inside the raw
		// prefix the active revision replaced: that context no longer exists. Deriving this
		// from positions (not from in-memory flags) keeps it correct after resume and /tree.
		const observedStale =
			observed !== undefined && state.checkpoint !== undefined && observed.index < state.checkpoint.sourceMessageCount;
		const reading: BudgetReading = {
			...resolved,
			estimated: estimateRequestTokens(ctx, modelEffectiveMessages, knownNotices),
			estimateExcludes: "tool schemas and provider framing",
			calibration: calibrator.factor,
			observed: observed?.tokens,
			observedStale,
		};
		lastBudgetReading = reading;
		projectionReplaced = false;
		const tier = budgetTracker.observe(reading, budgetTiers(budgetPolicy, reading.budget, reading.reserve));
		if (!tier) return undefined;
		return budgetNoticeText(reading, tier, store?.filePath);
	}

	function continuitySizeNotice(message: LiveContextMessage | undefined): string | undefined {
		const tokens = message ? estimateLiveContextTokens([message]) : 0;
		if (!continuitySize.observe(tokens)) return undefined;
		return (
			`[LIVE CONTEXT] Active pin/continuity annotations add about ${tokens} estimated tokens` +
			` to every model call (warning threshold ${CONTINUITY_SIZE_WARNING_TOKENS}) and sit outside` +
			" projection shrink accounting. Resolve completed annotations and prefer archive for recall-only sources."
		);
	}

	function replaceAnnotation(annotation: LiveContextAnnotation): void {
		pi.appendEntry(LIVE_CONTEXT_ANNOTATION, annotation);
		const index = annotations.findIndex((candidate) => candidate.id === annotation.id);
		if (index < 0) annotations = [...annotations, annotation];
		else annotations = annotations.map((candidate, candidateIndex) =>
			candidateIndex === index ? annotation : candidate,
		);
	}

	function continuityMessage(ctx: ExtensionContext, effectiveMessages: LiveContextMessage[]): LiveContextMessage | undefined {
		const content = formatContinuityMessage({
			annotations,
			entries: ctx.sessionManager.getEntries() as ContinuitySessionEntryLike[],
			effectiveMessages,
		});
		if (!content) return undefined;
		return {
			role: "custom",
			customType: CONTINUITY_MESSAGE_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		};
	}

	function withManagedContinuity(
		effectiveMessages: LiveContextMessage[],
		managedContinuity: LiveContextMessage | undefined,
	): LiveContextMessage[] {
		if (!managedContinuity) return effectiveMessages;
		// Leading continuity preserves the serialized request prefix as conversation
		// turns are appended, provided the annotation snapshot remains unchanged.
		return editingMode === "clm"
			? [managedContinuity, ...effectiveMessages]
			: [...effectiveMessages, managedContinuity];
	}

	pi.on("resources_discover", () => ({
		skillPaths: editingMode === "clm" ? [] : [join(EXTENSION_DIR, "skills")],
	}));

	pi.registerTool({
		name: "live_context_annotate",
		label: "Live Context Annotate",
		description:
			"Create, resolve, or list branch-local continuity annotations. Create uses a current mirror block ID or active Pi entry ID. pin keeps a bounded exact textual source visible; continuity keeps a durable reason/next-action pointer; archive is recall-only.",
		promptSnippet: "Create, resolve, or list durable annotations for exact context sources",
		promptGuidelines: [
			"Use live_context_annotate before compacting an exact source that future work must preserve; choose pin only when its exact text must remain visible, continuity for a visible obligation and recall pointer, or archive for recall-only provenance.",
			...(editingMode === "clm" ? [] : ["A live_context_annotate call does not justify broad compression: keep LIVE_CONTEXT.md edits surgical and preserve complete user/assistant exchanges by default."]),
		],
		parameters: AnnotationParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const branch = ctx.sessionManager.getBranch() as ContinuitySessionEntryLike[];
			annotations = reconstructLiveContextAnnotations(branch);
			if (params.action === "list") {
				const display = annotations.slice(-50);
				const lines = display.map((annotation) => {
					const status = annotation.resolvedAt ? `resolved ${annotation.resolvedAt}` : "active";
					return `[${annotation.id}] ${annotation.retention} · ${status} · ${annotation.title}\n  source ${annotation.source.entryId} · next: ${annotation.futureAction}`;
				});
				if (annotations.length > display.length) lines.unshift(`${annotations.length - display.length} older annotations omitted.`);
				return {
					content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No live-context annotations on this branch." }],
					details: { annotations: display, total: annotations.length },
				};
			}

			if (params.action === "resolve") {
				const id = requiredToolText(params.id, "id");
				const existing = annotations.find((annotation) => annotation.id === id);
				if (!existing) throw new Error(`Annotation ${id} is not available on the active branch.`);
				if (existing.resolvedAt) throw new Error(`Annotation ${id} is already resolved.`);
				const resolved = resolveAnnotation(existing, params.resolution?.replace(/\s+/g, " ").trim());
				replaceAnnotation(resolved);
				return {
					content: [{ type: "text", text: `Resolved ${resolved.id}: ${resolved.title}` }],
					details: { annotation: resolved },
				};
			}

			const sourceInput = requiredToolText(params.source, "source");
			const title = requiredToolText(params.title, "title");
			const reason = requiredToolText(params.reason, "reason");
			const futureAction = requiredToolText(params.futureAction, "futureAction");
			const retention = params.retention as LiveContextRetention | undefined;
			if (!retention) throw new Error("retention is required.");

			let sourceEntry = findEntryById(branch, sourceInput);
			let sourceMessage = messageFromSessionEntry(sourceEntry);
			if (!sourceMessage) {
				const block = turnBaseline?.snapshot.blocks.find((candidate) => candidate.id === sourceInput);
				if (!block) {
					throw new Error(
						`Source ${sourceInput} is neither an active-branch Pi entry nor a block in the current live-context mirror.`,
					);
				}
				sourceMessage = block.source;
				sourceEntry = findSourceEntry(branch, sourceMessage);
			}
			if (!sourceEntry || typeof sourceEntry.id !== "string" || !sourceMessage) {
				throw new Error("The selected mirror block does not map to a durable Pi session entry.");
			}
			if (retention === "pin") {
				const sourceTokens = estimateLiveContextTokens([sourceMessage]);
				if (sourceTokens > MAX_PIN_SOURCE_TOKENS) {
					throw new Error(
						`The source is about ${sourceTokens} tokens; pin is limited to ${MAX_PIN_SOURCE_TOKENS}. Use continuity or archive instead.`,
					);
				}
			}
			const annotation = createAnnotation({
				existingIds: annotations.map((candidate) => candidate.id),
				source: {
					sessionId: ctx.sessionManager.getSessionId(),
					entryId: sourceEntry.id,
					revision: state.revision,
					contentHash: sourceContentHash(sourceMessage),
					role: sourceMessage.role,
				},
				title,
				reason,
				futureAction,
				retention,
			});
			replaceAnnotation(annotation);
			return {
				content: [{
					type: "text",
					text: `Created ${annotation.retention} annotation ${annotation.id} for ${annotation.source.role} entry ${annotation.source.entryId}.`,
				}],
				details: { annotation },
			};
		},
	});

	pi.registerTool({
		name: "live_context_recall",
		label: "Live Context Recall",
		description: `Recall the exact textual source for a branch-local annotation by ID. Output is bounded to ${MIN_RECALL_TOKENS}-${MAX_RECALL_TOKENS} estimated tokens (default ${DEFAULT_RECALL_TOKENS}) and validated against the durable Pi entry's content hash.`,
		promptSnippet: "Recall a bounded exact source from a durable live-context annotation",
		promptGuidelines: [
			"Use live_context_recall only when an active continuity pointer or archived source is needed; request the smallest useful maxTokens bound.",
		],
		parameters: RecallParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const branchAnnotations = reconstructLiveContextAnnotations(
				ctx.sessionManager.getBranch() as ContinuitySessionEntryLike[],
			);
			const annotation = branchAnnotations.find((candidate) => candidate.id === params.id);
			if (!annotation) throw new Error(`Annotation ${params.id} is not available on the active branch.`);
			const entries = ctx.sessionManager.getEntries() as ContinuitySessionEntryLike[];
			const entry = findEntryById(entries, annotation.source.entryId);
			const source = validateAnnotationSource(annotation, entry);
			const recalled = formatRecall({
				annotation,
				source,
				maxTokens: params.maxTokens ?? DEFAULT_RECALL_TOKENS,
				estimateTokens: estimateTextTokens,
			});
			return {
				content: [{ type: "text", text: recalled.text }],
				details: {
					annotationId: annotation.id,
					source: annotation.source,
					truncated: recalled.truncated,
					totalTokens: recalled.totalTokens,
					returnedTokens: recalled.returnedTokens,
				},
			};
		},
	});

	pi.registerCommand(commandName, {
		description:
			editingMode === "clm"
				? "Open the CLM panel (overview · input · edits · settings); or status, about, config [<setting> <value> | reset], on, off, reset, path"
				: "Inspect or control live context: status, on, off, reset, path",
		getArgumentCompletions(prefix: string) {
			const words = editingMode === "clm"
				? [
					...CLM_VIEW_TABS,
					"status",
					"about",
					"config",
					...CLM_SETTING_COMMAND_KEYS.map((key) => `config ${key}`),
					"config reset",
					"on",
					"off",
					"reset",
					"path",
				]
				: ["status", "on", "off", "reset", "path"];
			return words
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => handleCommand(args, ctx),
	});

	if (editingMode === "clm") {
		// A top-level command so Pi's completion shows it beside its own /compact.
		pi.registerCommand(`${commandName}-compact`, {
			description:
				"Ask the model to compact its own live context now; text after the command is passed along as instructions. (Pi's /compact summarizes the transcript and resets CLM instead.)",
			handler: async (args, ctx) => compactCommand(args, ctx),
		});
	}

	/**
	 * `/clm-compact [instructions]`: send the (configurable) compaction prompt as a user
	 * message. The model does the editing; its edit is validated and committed at turn end
	 * like any other.
	 */
	async function compactCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (compactPending) {
			ctx.ui.notify("A /clm-compact is already waiting for the current run to finish.", "info");
			return;
		}
		let template: string;
		try {
			template = loadCompactPrompt(settings.compactPrompt);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return;
		}
		compactPending = true;
		try {
			// Measure once the agent is idle, so the size in the prompt is the one the model sees.
			if (!ctx.isIdle()) ctx.ui.notify("The model will compact its context when the current run finishes.", "info");
			const epoch = lifecycleEpoch;
			await ctx.waitForIdle();
			// A branch switch, reset, reload or /clm off while waiting: that is a different context.
			if (epoch !== lifecycleEpoch) {
				ctx.ui.notify("The live context changed while /clm-compact was waiting, so nothing was sent. Run it again if you still want it.", "warning");
				return;
			}
			const activeStore = store;
			if (!state.enabled || !activeStore) {
				ctx.ui.notify(
					!state.enabled
						? "CLM is off, so there is no live context to compact. Turn it on with /clm on."
						: "The live-context mirror is unavailable, so the model cannot edit its context.",
					"warning",
				);
				return;
			}
			const { next, observed, budget } = sizeFigures(ctx);
			// No usable measurement (e.g. just after resume): estimate the context that would be sent.
			const effective = next === undefined && observed === undefined ? contextSnapshot(ctx).effectiveMessages : undefined;
			if (effective?.length === 0) {
				ctx.ui.notify("Nothing to compact yet: the context is empty.", "warning");
				return;
			}
			const current = next ?? observed ?? estimateRequestTokens(ctx, effective ?? []);
			const prompt = buildCompactPrompt(template, { mirror: activeStore.filePath, current, budget, instructions: args });
			try {
				pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			} catch (error) {
				ctx.ui.notify(`/clm-compact was not sent: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			ctx.ui.notify(`Asked the model to compact its context (now about ${formatTokens(current)} tokens).`, "info");
		} finally {
			compactPending = false;
		}
	}

	/**
	 * The exact context-hook snapshot when there is one: checkpoints anchor to that message
	 * space, which may differ from the raw session after earlier context handlers. Before
	 * the hook has run (e.g. just after resume), reconstruct its conversation-only message
	 * space from the session: newer Pi stores prompt/tool system messages outside this hook.
	 */
	function contextSnapshot(ctx: ExtensionContext): CurrentContextView & { rawMessages: LiveContextMessage[] } {
		const captured = currentContextView;
		if (captured?.rawMessages) return { ...captured, rawMessages: captured.rawMessages };
		const sessionRawMessages = asLiveMessages(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		).filter((message) => message.role !== "system");
		const sessionProjection = state.enabled ? applyProjection(sessionRawMessages, state.checkpoint) : undefined;
		const visibleRaw = selectContextVisibleMessages(sessionRawMessages);
		const effective = selectContextVisibleMessages(
			sessionProjection?.valid ? sessionProjection.messages : sessionRawMessages,
		);
		const suffix = sessionProjection?.valid
			? selectContextVisibleMessages(sessionProjection.suffix)
			: [];
		const rawTokens = estimateLiveContextTokens(visibleRaw);
		const managedContinuity = continuityMessage(ctx, effective);
		const modelEffective = withManagedContinuity(effective, managedContinuity);
		return {
			rawMessageCount: sessionRawMessages.length,
			rawMessages: [...sessionRawMessages],
			effectiveMessages: [...modelEffective],
			suffixMessageCount: suffix.length,
			rawTokens,
			effectiveTokens: sameMessageSequence(visibleRaw, modelEffective)
				? rawTokens
				: estimateLiveContextTokens(modelEffective),
			capturedAt: new Date().toISOString(),
		};
	}

	/** Open the panel (CLM) or viewer (conservative) on `tab`; outside the TUI, print that page. */
	async function openViewer(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (editingMode === "clm" && args.trim() === "settings" && contextMode(ctx) !== "tui") {
			ctx.ui.notify(settingsText(ctx), "info");
			return;
		}
		const current = contextSnapshot(ctx);
		const rawMessages = current.rawMessages;
		const branch = ctx.sessionManager.getBranch();
		const lastMessageTimestamp = [...branch]
			.reverse()
			.find((entry) => entry.type === "message")?.timestamp;
		const model = buildLiveContextViewModel({
			state,
			entries: branch,
			snapshotStale: Boolean(
				typeof lastMessageTimestamp === "string" && lastMessageTimestamp > current.capturedAt,
			),
			tree: ctx.sessionManager.getTree(),
			leafId: ctx.sessionManager.getLeafId(),
			mirrorPath: store?.filePath,
			current,
			rawMessages,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			mode: contextMode(ctx),
			...(editingMode === "clm"
				? { budget: resolveBudget(budgetPolicy, ctx.model?.contextWindow)?.budget }
				: {}),
		});
		await showLiveContextViewer(
			ctx,
			model,
			args,
			editingMode === "clm"
				? { tabs: CLM_VIEW_TABS, commandName, settings: settingsController(ctx) }
				: { commandName: `${commandName}-view` },
		);
	}

	// CLM mode has one entry point: `/clm` opens the panel. Conservative mode keeps its viewer command.
	if (editingMode !== "clm") {
		pi.registerCommand(`${commandName}-view`, {
			description: "Open the live-context projection viewer",
			getArgumentCompletions(prefix: string) {
				return LIVE_CONTEXT_VIEW_TABS
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value }));
			},
			handler: async (args, ctx) => openViewer(args, ctx),
		});
	}

	async function configCommand(words: string[], ctx: ExtensionCommandContext): Promise<void> {
		const [key, ...valueWords] = words;
		if (!key) {
			await openViewer("settings", ctx);
			return;
		}
		if (key.toLowerCase() === "reset") {
			try {
				resetSettings(ctx);
				ctx.ui.notify("CLM settings reset to the defaults.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			return;
		}
		const descriptor = settingDescriptor(key);
		if (!descriptor) {
			ctx.ui.notify(`Unknown setting "${key}". Settings: ${CLM_SETTING_COMMAND_KEYS.join(", ")}.`, "warning");
			return;
		}
		if (valueWords.length === 0) {
			ctx.ui.notify(
				`${descriptor.label}: ${descriptor.format(settings, { modelWindow: ctx.model?.contextWindow })} — ${descriptor.description}`,
				"info",
			);
			return;
		}
		try {
			ctx.ui.notify(`CLM ${changeSetting(key, valueWords.join(" "), ctx)}.`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	}

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		const words = args.trim().split(/\s+/).filter(Boolean);
		if (editingMode === "clm") {
			// Values keep their case (steering paths); actions and setting names do not.
			const [first = "", ...rest] = words;
			const verb = first.toLowerCase();
			if (verb === "" || (CLM_VIEW_TABS as readonly string[]).includes(verb)) {
				await openViewer(verb || "overview", ctx);
				return;
			}
			if (verb === "status") {
				ctx.ui.notify(shortStatus(ctx), "info");
				return;
			}
			if (verb === "about") {
				showBanner(ctx, "about");
				return;
			}
			if (verb === "config") {
				await configCommand(rest, ctx);
				return;
			}
			if (verb === "budget") {
				await configCommand(["budget", ...rest], ctx);
				return;
			}
		}
		const [actionWord = "status"] = words.map((word) => word.toLowerCase());
		const action = actionWord;
		switch (action) {
			case "status": {
				// Conservative mode; CLM mode answers `/clm status` above.
				const active = activeContinuityAnnotations(annotations).length;
				const archived = annotations.filter(
					(annotation) => annotation.retention === "archive" && annotation.resolvedAt === undefined,
				).length;
				ctx.ui.notify(
					`${statusDetails(state, store?.filePath, observedUsage, currentContextView)}\nannotations: ${active} active continuity/pin · ${archived} active archive · ${annotations.length} total`,
					"info",
				);
				return;
			}
			case "path":
				ctx.ui.notify(store?.filePath ?? "Live-context mirror is unavailable.", store ? "info" : "warning");
				return;
			case "on":
				persistOutcome({ ...state, enabled: true, event: { kind: "enabled", at: new Date().toISOString() } });
				updateStatus(ctx);
				ctx.ui.notify("Live context enabled.", "info");
				return;
			case "off":
				persistOutcome({ ...state, enabled: false, event: { kind: "disabled", at: new Date().toISOString() } });
				lifecycleEpoch++;
				turnBaseline = undefined;
				currentContextView = undefined;
				updateStatus(ctx);
				ctx.ui.notify("Live context disabled. Raw Pi context will be used.", "info");
				return;
			case "reset":
				persist(resetProjectionState(state, "Projection reset by user."));
				lifecycleEpoch++;
				turnBaseline = undefined;
				currentContextView = undefined;
				lastBudgetReading = undefined;
				projectionReplaced = true;
				updateStatus(ctx);
				ctx.ui.notify("Live-context projection reset. Raw Pi context will be used.", "info");
				return;
			default:
				break;
		}
		ctx.ui.notify(
			editingMode === "clm"
				? `Usage: /${commandName} [${CLM_VIEW_TABS.join("|")}|status|config [<setting> <value>|reset]|on|off|reset|path]`
				: `Usage: /${commandName} [status|on|off|reset|path]`,
			"warning",
		);
	}

	const bannerEnabled = editingMode === "clm" && options.banner?.enabled === true;

	/** A host that can show a header: the TUI (print/RPC hosts, and older Pi, cannot). */
	function canShowHeader(ctx: ExtensionContext): boolean {
		return contextMode(ctx) === "tui" && ctx.hasUI && typeof ctx.ui.setHeader === "function";
	}

	/** Put the banner in Pi's header for this session; where that is impossible, `about` prints it. */
	function showBanner(ctx: ExtensionContext, reason: "first-run" | "about"): void {
		if (!canShowHeader(ctx)) {
			if (reason === "about") ctx.ui.notify(bannerLines().join("\n"), "info");
			return;
		}
		ctx.ui.setHeader((_tui, theme) => bannerHeader(theme));
	}

	function showBannerIfFirstRun(ctx: ExtensionContext): void {
		if (!bannerEnabled || !canShowHeader(ctx)) return;
		if (claimFirstRun(options.banner?.markerPath ?? bannerMarkerPath(getAgentDir()))) showBanner(ctx, "first-run");
	}

	pi.on("session_start", async (_event, ctx) => {
		pressure.reset();
		budgetTracker.reset();
		mirrorMutationSeen = false;
		restore(ctx);
		if (settingsWarning) ctx.ui.notify(`pi-clm: ${settingsWarning}`, "warning");
		if (steeringError) ctx.ui.notify(`pi-clm: steering document not loaded: ${steeringError}`, "warning");
		await replaceStore(ctx);
		updateStatus(ctx);
		showBannerIfFirstRun(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || !store) return;
		const sections = [systemGuidance(store.filePath, editingMode)];
		if (steering) sections.push(steeringPromptSection(steering));
		const guidance = sections.join("\n\n");
		const options = event.systemPromptOptions as typeof event.systemPromptOptions & {
			sections?: Record<string, string>;
		};
		// A whole-prompt return freezes a forced snapshot on newer Pi, hiding later additions.
		if (options?.sections) {
			options.sections.live_context_management = guidance;
			return;
		}
		// Older Pi exposes read-only options and composes string returns instead.
		return { systemPrompt: [event.systemPrompt, guidance].join("\n\n") };
	});

	pi.on("context", async (event, ctx) => {
		const rawMessages = asLiveMessages(event.messages);
		if (!state.enabled) {
			turnBaseline = undefined;
			continuitySize.observe(0);
			return;
		}
		if (!store) {
			turnBaseline = undefined;
			const managedContinuity = continuityMessage(ctx, rawMessages);
			const output = [...withManagedContinuity(rawMessages, managedContinuity)];
			const sizeNotice = continuitySizeNotice(managedContinuity);
			if (sizeNotice) {
				output.push({
					role: "custom",
					customType: NOTICE_TYPE,
					content: sizeNotice,
					display: false,
					timestamp: Date.now(),
				});
			}
			return output.length === rawMessages.length ? undefined : { messages: asAgentMessages(output) };
		}

		let effectiveMessages = rawMessages;
		let suffixMessages: LiveContextMessage[] = [];
		let projection = applyProjection(rawMessages, state.checkpoint);
		let recovered = false;

		if (!projection.valid && state.checkpoint) {
			const target = state.checkpoint;
			const retry = recoverProjectionFromRetryErrors(rawMessages, target, checkpointHistory);
			const recovery = retry.valid ? retry : recoverProjectionAtEditBoundary(rawMessages, target, { lostHistory: branchLostEntries(ctx) });
			if (recovery.valid) {
				rebaseRecoveredProjection(rawMessages, target, recovery);
				projection = recovery;
				recovered = true;
			} else {
				// Say what differs, so a reset can be diagnosed from the session alone.
				projection = { ...projection, reason: `${projection.reason} ${recovery.reason}` };
			}
		} else if (!state.checkpoint) {
			const historical = findHistoricalRecovery(ctx, rawMessages);
			if (historical) {
				rebaseRecoveredProjection(rawMessages, historical.target, historical.recovery);
				projection = historical.recovery;
				recovered = true;
			}
		}

		if (projection.valid) {
			effectiveMessages = projection.messages;
			suffixMessages = projection.suffix;
			if (state.checkpoint || recovered) {
				invalidationStreak = 0;
				compositionWarned = false;
			}
		} else {
			invalidationStreak += 1;
			persist(resetProjectionState(state, projection.reason));
			let notice = `Discarded a stale projection: ${projection.reason}`;
			if (invalidationStreak >= 2) {
				notice +=
					" Consecutive projections were invalidated before use, so further mirror edits" +
					" will keep being discarded until the raw context prefix is stable again.";
				if (!compositionWarned) {
					compositionWarned = true;
					ctx.ui.notify(compositionWarningText(), "warning");
				}
			}
			queueOutcomeNotice(notice);
		}
		const visibleRawMessages = selectContextVisibleMessages(rawMessages);
		effectiveMessages = selectContextVisibleMessages(effectiveMessages);
		if (editingMode === "clm") effectiveMessages = capObservations(effectiveMessages, observationCap);
		pendingOverflowNotice = undefined;
		// Learn from the provider's count of the previous request before estimating this one.
		if (editingMode === "clm") calibrator.observe(lastProviderReportedTokens(rawMessages));
		if (editingMode === "clm" && overflowGuard.mode === "withhold") {
			const resolved = resolveBudget(budgetPolicy, ctx.model?.contextWindow);
			if (resolved) {
				const limit = overflowGuardLimit(resolved.budget, resolved.reserve, ctx.model?.contextWindow);
				const fixedTokens = calibrator.apply(
					estimateTextTokens(ctx.getSystemPrompt?.() ?? "") + (pendingNotice ? estimateTextTokens(pendingNotice) : 0),
				);
				const guarded = applyOverflowGuard(effectiveMessages, {
					limit,
					fixedTokens,
					estimate: (messages) => calibrator.apply(estimateLiveContextTokens(messages)),
					saveDirectory: store ? join(store.directory, "withheld") : undefined,
					// Only the raw suffix after the accepted projection is withholdable; the
					// model's own accepted context is respected.
					protectBefore: state.checkpoint
						? Math.max(0, effectiveMessages.length - selectContextVisibleMessages(suffixMessages).length)
						: 0,
				});
				if (guarded.withheld.length > 0) {
					effectiveMessages = guarded.messages;
					pendingOverflowNotice = overflowNoticeText(guarded, limit);
				}
			}
		}
		const visibleSuffixMessages = selectContextVisibleMessages(suffixMessages);
		const rawTokens = estimateLiveContextTokens(visibleRawMessages);
		const projectionTokens = sameMessageSequence(visibleRawMessages, effectiveMessages)
			? rawTokens
			: estimateLiveContextTokens(effectiveMessages);
		const managedContinuity = continuityMessage(ctx, effectiveMessages);
		const modelEffectiveMessages = withManagedContinuity(effectiveMessages, managedContinuity);
		currentContextView = {
			rawMessageCount: rawMessages.length,
			rawMessages: [...rawMessages],
			effectiveMessages: [...modelEffectiveMessages],
			suffixMessageCount: visibleSuffixMessages.length,
			rawTokens,
			effectiveTokens: managedContinuity
				? estimateLiveContextTokens(modelEffectiveMessages)
				: projectionTokens,
			capturedAt: new Date().toISOString(),
		};
		updateStatus(ctx);

		// Extension-managed continuity stays outside the editable projection so
		// mirror compression cannot silently remove an active obligation or exact pin.
		const snapshot = renderContextDocument(effectiveMessages, {
			revision: state.revision,
			...(editingMode === "clm"
				? {
					protectedIndexes: new Set<number>(),
					// Nonce stays constant until the next accepted edit: header ids read on
					// one call remain valid on the next.
					documentSeed: `${ctx.sessionManager.getSessionId()}:${state.checkpoint?.sourceDigest ?? "raw"}`,
				}
				: {}),
		});
		try {
			await store.write(snapshot.text);
			turnBaseline = {
				rawMessages: [...rawMessages],
				effectiveMessages: [...effectiveMessages],
				snapshot,
			};
		} catch (error) {
			turnBaseline = undefined;
			const message = error instanceof Error ? error.message : String(error);
			queueOutcomeNotice(`Mirror refresh failed: ${message}`);
			ctx.ui.notify(pendingNotice ?? message, "error");
		}

		const output = [...modelEffectiveMessages];
		const outcomeNotice = pendingNotice;
		const sizeNotice = continuitySizeNotice(managedContinuity);
		const overflowNotice = pendingOverflowNotice;
		const notices = [
			outcomeNotice,
			overflowNotice,
			editingMode === "clm"
				? budgetNotice(ctx, rawMessages, modelEffectiveMessages, [outcomeNotice, overflowNotice, sizeNotice].filter((n): n is string => Boolean(n)))
				: pressureNotice(ctx),
			sizeNotice,
		]
			.filter((notice): notice is string => Boolean(notice));
		pendingNotice = undefined;
		for (const notice of notices) {
			output.push({
				role: "custom",
				customType: NOTICE_TYPE,
				content: notice,
				display: false,
				timestamp: Date.now(),
			});
		}
		if (editingMode === "clm") {
			calibrator.record(
				estimateTextTokens(ctx.getSystemPrompt?.() ?? "") + estimateLiveContextTokens(output),
				rawMessages.length,
			);
		}
		return { messages: asAgentMessages(output) };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (editingMode !== "clm" || nativeCompaction === "on" || event.reason === "manual") return undefined;
		if (nativeCompaction === "off") {
			queueOutcomeNotice(
				`Pi's automatic compaction (${event.reason}) was cancelled: pi-clm manages this context. Edit the mirror to free space.`,
			);
			ctx.ui.notify(`pi-clm: cancelled Pi's ${event.reason} compaction (PI_CLM_NATIVE_COMPACTION=off).`, "info");
			return { cancel: true };
		}
		// auto: Pi measures the raw transcript, which CLM never shrinks, and its summary keeps
		// ~20k recent raw tokens — on a small window that re-admits more than the projection
		// held and discards the model's edits. While pi-clm has a budget to enforce, the
		// overflow guard is the substitute for threshold compaction; only overflow recovery
		// (after a provider-side failure) is left to Pi as the last resort.
		if (event.reason !== "threshold") return undefined;
		const resolved = resolveBudget(budgetPolicy, ctx.model?.contextWindow);
		if (!resolved || overflowGuard.mode === "off") return undefined;
		const effective = currentContextView
			? calibrator.apply(estimateTextTokens(ctx.getSystemPrompt?.() ?? "") + currentContextView.effectiveTokens)
			: undefined;
		ctx.ui.notify(
			`pi-clm: cancelled Pi's threshold compaction (raw-history based); the effective context is ~${effective?.toLocaleString("en-US") ?? "?"} tokens and the overflow guard enforces ${overflowGuardLimit(resolved.budget, resolved.reserve, ctx.model?.contextWindow).toLocaleString("en-US")}.`,
			"info",
		);
		return { cancel: true };
	});

	pi.on("turn_start", () => {
		mirrorMutationSeen = false;
		toolCallsThisTurn = 0;
	});

	pi.on("tool_call", (event, ctx) => {
		if (oneToolPerTurn && state.enabled) {
			toolCallsThisTurn += 1;
			if (toolCallsThisTurn > 1) {
				return {
					block: true,
					reason:
						`pi-clm paper mode allows exactly one tool call per turn; this ${event.toolName} call (#${toolCallsThisTurn} in the turn) was not executed. ` +
						"Issue it again on its own in your next turn.",
				};
			}
		}
		if (!state.enabled || !store || editingMode === "clm") return;
		if (classifyMirrorToolCall(event.toolName, event.input, ctx.cwd, store.filePath) !== "write") return;
		if (mirrorMutationSeen) {
			return {
				block: true,
				reason: "Live context allows one mirror write per assistant turn. Batch the context edit into one command.",
			};
		}
		mirrorMutationSeen = true;
	});

	/**
	 * Pi clamps the request's max output tokens to `window − estimate(raw agent state) − 4096`
	 * (floor 1). That estimate is taken over the *raw* transcript, not the projection this
	 * extension actually sends, so after a big raw turn Pi can hand the model a 1-token answer
	 * even though the provider received a request that fits comfortably. Re-derive the room
	 * from the calibrated effective estimate and lift the clamp when Pi set it lower.
	 */
	pi.on("before_provider_request", (event, ctx) => {
		if (editingMode !== "clm" || !state.enabled) return undefined;
		const payload = event.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const window = ctx.model?.contextWindow;
		const modelMax = ctx.model?.maxTokens;
		if (!window || window <= 0 || !modelMax || modelMax <= 0 || !lastBudgetReading) return undefined;
		const room = window - lastBudgetReading.estimated - 4096;
		const desired = Math.min(modelMax, room);
		if (desired <= 1) return undefined;
		const record = payload as Record<string, unknown>;
		let changed = false;
		const patched: Record<string, unknown> = { ...record };
		for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
			const current = record[key];
			if (typeof current === "number" && current < desired) {
				patched[key] = desired;
				changed = true;
			}
		}
		if (!changed) return undefined;
		maxTokensLifts += 1;
		return patched;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!sizeTrailer || !state.enabled) return undefined;
		const resolved = resolveBudget(budgetPolicy, ctx.model?.contextWindow);
		if (!resolved) return undefined;
		const content = Array.isArray(event.content) ? [...event.content] : [];
		const resultTokens = calibrator.apply(
			content.reduce<number>((total, part) => total + (part && typeof part === "object" && (part as { type?: string }).type === "text" ? estimateTextTokens(String((part as { text?: unknown }).text ?? "")) : 0), 0),
		);
		const approx = (lastBudgetReading?.estimated ?? 0) + resultTokens;
		const trailer = `\n[context: ~${approx.toLocaleString("en-US")} of ${resolved.budget.toLocaleString("en-US")} tokens after this result]`;
		const lastText = [...content].reverse().find((part) => part && typeof part === "object" && (part as { type?: string }).type === "text") as { type: "text"; text: string } | undefined;
		if (lastText) {
			const index = content.lastIndexOf(lastText);
			content[index] = { ...lastText, text: `${lastText.text}${trailer}` };
		} else {
			content.push({ type: "text", text: trailer.trim() });
		}
		return { content };
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!state.enabled || !store) return;
		captureObservedUsage(ctx);
		if (!turnBaseline) return;
		const baseline = turnBaseline;
		const activeStore = store;
		const epoch = lifecycleEpoch;
		turnBaseline = undefined;

		let editedText: string | undefined;
		try {
			editedText = await activeStore.read();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			queueOutcomeNotice(`Mirror read failed: ${message}`);
			return;
		}
		// A tree move/reset/shutdown during async I/O invalidates the captured draft,
		// even when the newly selected branch happens to have the same revision number.
		if (epoch !== lifecycleEpoch || activeStore !== store || !state.enabled || baseline.snapshot.revision !== state.revision) return;
		if (editedText === undefined || editedText.trim() === baseline.snapshot.text.trim()) return;

		// Pi's provider-independent token estimator is injected as the single acceptance
		// and reporting metric; the core's default character estimate stays for callers
		// that do not provide one.
		const result = applyContextDocument(editedText, baseline.snapshot, {
			editingMode,
			estimate: estimateLiveContextTokens,
			estimateUnit: "tokens",
		});
		const at = new Date().toISOString();
		const beforeTokens = result.beforeEstimate;
		const afterTokens = result.afterEstimate;
		if (!result.accepted) {
			const rejectionMessage = result.reason ?? "Context edit rejected.";
			persistOutcome({
				...state,
				event: undefined,
				lastOutcome: {
					kind: "rejected",
					message: rejectionMessage,
					beforeEstimate: beforeTokens,
					afterEstimate: afterTokens,
					estimateUnit: "tokens",
					at,
				},
			});
			queueOutcomeNotice(`Edit rejected: ${rejectionMessage}`);
			updateStatus(ctx);
			return;
		}

		const revision = state.revision + 1;
		const appliedMessage = `Applied revision ${revision}; estimated tokens ${beforeTokens}→${afterTokens}.`;
		let checkpoint;
		try {
			checkpoint = createProjectionCheckpoint({
				revision,
				sourceMessages: baseline.rawMessages,
				projectedMessages: result.messages,
				beforeEstimate: beforeTokens,
				afterEstimate: afterTokens,
				estimateUnit: "tokens",
				createdAt: at,
				editTrace: result.editTrace,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const rejectionMessage = `Projection is not serializable: ${message}`;
			persistOutcome({
				...state,
				event: undefined,
				lastOutcome: {
					kind: "rejected",
					message: rejectionMessage,
					beforeEstimate: beforeTokens,
					afterEstimate: afterTokens,
					estimateUnit: "tokens",
					at,
				},
			});
			queueOutcomeNotice(`Edit rejected: ${rejectionMessage}`);
			updateStatus(ctx);
			return;
		}
		const nextState: typeof state = {
			version: 1,
			enabled: state.enabled,
			revision,
			checkpoint,
			lastOutcome: {
				kind: "applied",
				message: appliedMessage,
				beforeEstimate: beforeTokens,
				afterEstimate: afterTokens,
				estimateUnit: "tokens",
				at,
			},
		};
		try {
			persist(nextState);
		} catch {
			queueOutcomeNotice("Edit was not activated because checkpoint persistence failed. Previous context remains active.");
			ctx.ui.notify("Live-context checkpoint persistence failed; previous revision retained.", "error");
			return;
		}
		const managedContinuity = continuityMessage(ctx, result.messages);
		const modelEffectiveMessages = withManagedContinuity(result.messages, managedContinuity);
		currentContextView = {
			rawMessageCount: baseline.rawMessages.length,
			rawMessages: [...baseline.rawMessages],
			effectiveMessages: [...modelEffectiveMessages],
			suffixMessageCount: 0,
			rawTokens: estimateLiveContextTokens(selectContextVisibleMessages(baseline.rawMessages)),
			effectiveTokens: managedContinuity
				? estimateLiveContextTokens(modelEffectiveMessages)
				: afterTokens,
			capturedAt: at,
		};
		awaitObservationForRevision = revision;
		const restored = result.diagnostics.length > 0 ? ` ${result.diagnostics.join(" ")}` : "";
		queueOutcomeNotice(`${appliedMessage}${restored}`);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		queueOutcomeNotice(`Restored live-context state for the selected branch (revision ${state.revision}).`);
	});

	pi.on("session_compact", async (_event, ctx) => {
		persist(resetProjectionState(state, "Projection reset after native Pi compaction."));
		lifecycleEpoch++;
		turnBaseline = undefined;
		currentContextView = undefined;
		lastBudgetReading = undefined;
		projectionReplaced = true;
		queueOutcomeNotice("Native Pi compaction became the new raw context baseline.");
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleEpoch++;
		turnBaseline = undefined;
		currentContextView = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await store?.cleanup().catch(() => undefined);
		store = undefined;
	});
}

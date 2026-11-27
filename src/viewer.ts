import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	estimateTokens,
	type ExtensionCommandContext,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Input,
	matchesKey,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { canonicalMessage, digestMessages, renderMessage } from "./context-document.ts";
import {
	diffLines,
	type DiffStyle,
	limitRows,
	MIN_SIDE_BY_SIDE_WIDTH,
	renderSideBySide,
	renderUnified,
	sideBySideRows,
	type SideBySideRow,
} from "./diff.ts";
import { formatFlops } from "./flops.ts";
import { selectContextVisibleMessages, selectProtectedMessageIndexes } from "./policy.ts";
import { contextMode, formatCount } from "./presentation.ts";
import { applyProjection, type ProjectionCheckpoint } from "./projection.ts";
import { isLiveContextState, type LiveContextState, type SessionEntryLike } from "./state.ts";
import {
	buildContextTimeline,
	formatMarkerRow,
	formatTimelineReport,
	bucketIndexOf,
	formatClockTime,
	formatMarkerCompact,
	formatTokenCount,
	layoutTimeline,
	renderTimelineChart,
	availableTimelineZooms,
	formatBucketSpan,
	type TimelineMarker,
	type TimelineZoom,
	type ContextTimeline,
} from "./timeline.ts";
import type { ContextEditSourceKind, ContextEditTrace, LiveContextMessage } from "./types.ts";

export const LIVE_CONTEXT_VIEW_TABS = ["overview", "edit", "projection", "tree", "history", "agents"] as const;
/**
 * CLM panel (`/clm`): four pages. `overview` is the context-size timeline with its
 * compaction points; `input` is the current effective context with the savings bar;
 * `edits` is the per-revision diff; `settings` shows sizes and edits the CLM settings.
 * The conservative-mode tree/history/agents tabs are not offered.
 */
export const CLM_VIEW_TABS = ["overview", "input", "edits", "settings"] as const;

/** One editable row of the panel's settings page. */
export interface ViewerSettingItem {
	id: string;
	label: string;
	value: string;
	description?: string;
	/** Enter/Space cycles through these. */
	choices?: string[];
	/** Without choices, Enter asks for text with this placeholder. */
	placeholder?: string;
}

/** What the settings page needs from the extension: live rows, a setter, and the size summary. */
export interface ViewerSettingsController {
	items(): ViewerSettingItem[];
	/** Apply a change; returns an error message when it was rejected. */
	apply(id: string, value: string): string | undefined;
	/** Read-only lines above the list (sizes, guard, files). */
	summary(): string[];
}
/**
 * `timeline` remains a standalone tab id for hosts that want it beside the conservative tabs.
 * CLM ids: `overview` = timeline + compaction points, `input` = the current effective
 * context (the `projection` page plus the savings bar), `edits` = the `edit` page.
 */
export type LiveContextViewTab = (typeof LIVE_CONTEXT_VIEW_TABS)[number] | (typeof CLM_VIEW_TABS)[number] | "timeline";

/** Map a tab id to the page implementation that renders it. */
function pageOf(tab: LiveContextViewTab): "overview" | "edit" | "projection" | "tree" | "history" | "agents" | "timeline" | "input" | "settings" {
	if (tab === "edits") return "edit";
	return tab;
}

export interface CurrentContextView {
	rawMessageCount: number;
	rawMessages?: LiveContextMessage[];
	effectiveMessages: LiveContextMessage[];
	suffixMessageCount: number;
	rawTokens: number;
	effectiveTokens: number;
	capturedAt: string;
}

export interface LiveContextRuntimeView {
	kind: "standalone" | "coordinator" | "teammate";
	sessionId: string;
	sessionFile?: string;
	mode: string;
	teammateName?: string;
	parentSessionId?: string;
}

export interface LiveContextHistoryView {
	revision: number;
	event: "applied" | "rejected" | "reset" | "enabled" | "disabled" | "checkpoint";
	message: string;
	beforeEstimate?: number;
	afterEstimate?: number;
	/** Viewer history is normalized to tokens. Legacy character values are never relabeled. */
	estimateUnit?: "tokens";
	estimateSource?: "recorded" | "recomputed";
	estimateNote?: string;
	at?: string;
}

export interface LiveContextMessageView {
	index: number;
	role: string;
	tokens: number;
	protected: boolean;
	preview: string;
}

export interface LiveContextEditView {
	kind: ContextEditSourceKind | "added";
	sourceIndex?: number;
	outputIndex?: number;
	beforeRole?: string;
	afterRole?: string;
	beforeTokens?: number;
	afterTokens?: number;
	beforePreview?: string;
	afterPreview?: string;
	beforeDetail?: string;
	afterDetail?: string;
	/**
	 * Full rendered text used for the side-by-side diff (the diff itself bounds what it
	 * shows). Computed lazily; falls back to the detail fields when absent.
	 */
	beforeText?: string;
	afterText?: string;
}

export interface LiveContextEditRevisionView {
	revision: number;
	sourceRevision: number;
	createdAt?: string;
	beforeTokens?: number;
	afterTokens?: number;
	edits: LiveContextEditView[];
	traceSource: "recorded" | "reconstructed" | "unavailable";
}

export interface LiveContextTreeRow {
	entryId: string;
	prefix: string;
	active: boolean;
	head: boolean;
	kind: "turn" | "live-context" | "summary" | "context-note";
	text: string;
	status: string;
	details: string[];
}

export interface LiveContextViewModel {
	enabled: boolean;
	revision: number;
	mirrorPath?: string;
	beforeEstimate: number;
	afterEstimate: number;
	savingsEstimate: number;
	estimateUnit: "characters" | "tokens";
	savingsPercent: number;
	rawMessageCount: number;
	effectiveMessageCount: number;
	suffixMessageCount: number;
	capturedAt?: string;
	snapshotStale: boolean;
	checkpointCreatedAt?: string;
	lastOutcome?: LiveContextState["lastOutcome"];
	messages: LiveContextMessageView[];
	/** Latest accepted edit, retained for report/API compatibility. */
	edits: LiveContextEditView[];
	editTraceSource: "recorded" | "reconstructed" | "unavailable";
	editRevisions: LiveContextEditRevisionView[];
	tree: LiveContextTreeRow[];
	treeHiddenEntryCount: number;
	history: LiveContextHistoryView[];
	runtime: LiveContextRuntimeView;
	/** Provider-reported context size per request plus accepted/rejected edit markers. */
	timeline: ContextTimeline;
	/** Configured CLM budget in tokens, drawn on the timeline when present. */
	budget?: number;
}

export interface SessionTreeNodeLike {
	entry: SessionEntry;
	children: SessionTreeNodeLike[];
	label?: string;
	labelTimestamp?: string;
}

export interface BuildLiveContextViewOptions {
	state: LiveContextState;
	entries: SessionEntryLike[];
	/** True when raw session entries newer than the snapshot's capture time exist. */
	snapshotStale?: boolean;
	tree?: SessionTreeNodeLike[];
	leafId?: string | null;
	mirrorPath?: string;
	current?: CurrentContextView;
	rawMessages?: LiveContextMessage[];
	sessionId: string;
	sessionFile?: string;
	mode: string;
	env?: NodeJS.ProcessEnv;
	previewCharacters?: number;
	/** CLM budget in tokens for the timeline chart. */
	budget?: number;
}

function compactPreview(message: LiveContextMessage, maxCharacters: number): string {
	const compact = renderMessage(message).replace(/\s+/g, " ").trim() || "(empty)";
	return compact.length <= maxCharacters ? compact : `${compact.slice(0, Math.max(1, maxCharacters - 1))}…`;
}

function messageTokens(message: LiveContextMessage): number {
	return estimateTokens(message as unknown as AgentMessage);
}

function runtimeView(options: BuildLiveContextViewOptions): LiveContextRuntimeView {
	const env = options.env ?? process.env;
	const isTeammate = env.PI_TEAM_MATE_SUBPROCESS === "1";
	const isCoordinator = env.PI_TEAM_MATE_COORDINATOR === "1";
	return {
		kind: isTeammate ? "teammate" : isCoordinator ? "coordinator" : "standalone",
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		mode: options.mode,
		teammateName: isTeammate ? env.PI_TEAM_MATE_TEAMMATE_NAME : undefined,
		parentSessionId: isTeammate ? env.PI_TEAM_MATE_PARENT_SESSION_ID : undefined,
	};
}

interface StateRecord {
	state: LiveContextState;
	entryIndex: number;
}

interface CheckpointAnalysis {
	checkpoint: ProjectionCheckpoint;
	sourceRevision: number;
	beforeTokens?: number;
	afterTokens: number;
	edits: LiveContextEditView[];
	traceSource: LiveContextEditRevisionView["traceSource"];
}

function stateRecords(entries: SessionEntryLike[]): StateRecord[] {
	return entries.flatMap((entry, entryIndex) =>
		entry.type === "custom" && entry.customType === "live-context-state" && isLiveContextState(entry.data)
			? [{ state: entry.data, entryIndex }]
			: [],
	);
}

function isCompleteSessionEntry(entry: SessionEntryLike): entry is SessionEntryLike & SessionEntry {
	return (
		typeof (entry as { id?: unknown }).id === "string" &&
		((entry as { parentId?: unknown }).parentId === null || typeof (entry as { parentId?: unknown }).parentId === "string") &&
		typeof (entry as { timestamp?: unknown }).timestamp === "string"
	);
}

function messagesAtState(options: BuildLiveContextViewOptions, record: StateRecord): LiveContextMessage[] | undefined {
	if (!options.entries.every(isCompleteSessionEntry)) return undefined;
	const entry = options.entries[record.entryIndex];
	if (!entry || !isCompleteSessionEntry(entry)) return undefined;
	try {
		return buildSessionContext(options.entries as SessionEntry[], entry.id).messages as unknown as LiveContextMessage[];
	} catch {
		return undefined;
	}
}

function rawSourceForCheckpoint(
	options: BuildLiveContextViewOptions,
	record: StateRecord,
	checkpoint: ProjectionCheckpoint,
): LiveContextMessage[] | undefined {
	const candidates = [
		messagesAtState(options, record),
		options.current?.rawMessages,
		options.rawMessages,
	].filter((messages): messages is LiveContextMessage[] => Boolean(messages));
	for (const messages of candidates) {
		if (messages.length < checkpoint.sourceMessageCount) continue;
		const source = messages.slice(0, checkpoint.sourceMessageCount);
		if (digestMessages(source) === checkpoint.sourceDigest) return source;
	}
	return undefined;
}

function lineageScore(
	before: LiveContextMessage,
	after: LiveContextMessage,
	beforeCanonical: string,
	afterCanonical: string,
): number {
	if (beforeCanonical === afterCanonical) return 1_000;
	if (typeof before.timestamp === "number" && before.timestamp === after.timestamp) {
		return before.role === after.role ? 100 : 80;
	}
	return 0;
}

/** Reconstruct provenance for checkpoints created before edit traces were persisted. */
function reconstructEditTrace(
	before: LiveContextMessage[],
	after: LiveContextMessage[],
	sourceRevision: number,
): ContextEditTrace {
	const beforeCanonical = before.map(canonicalMessage);
	const afterCanonical = after.map(canonicalMessage);
	const scores = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
	for (let left = before.length - 1; left >= 0; left--) {
		for (let right = after.length - 1; right >= 0; right--) {
			const matchScore = lineageScore(before[left], after[right], beforeCanonical[left], afterCanonical[right]);
			const match = matchScore > 0 ? matchScore + scores[left + 1][right + 1] : -1;
			scores[left][right] = Math.max(match, scores[left + 1][right], scores[left][right + 1]);
		}
	}

	const matched = new Map<number, number>();
	const matchedOutputs = new Set<number>();
	let left = 0;
	let right = 0;
	while (left < before.length && right < after.length) {
		const matchScore = lineageScore(before[left], after[right], beforeCanonical[left], afterCanonical[right]);
		const match = matchScore > 0 ? matchScore + scores[left + 1][right + 1] : -1;
		if (match >= scores[left + 1][right] && match >= scores[left][right + 1]) {
			matched.set(left, right);
			matchedOutputs.add(right);
			left++;
			right++;
		} else if (scores[left + 1][right] >= scores[left][right + 1]) {
			left++;
		} else {
			right++;
		}
	}

	return {
		version: 1,
		sourceRevision,
		sourceMessageCount: before.length,
		outputMessageCount: after.length,
		sources: before.map((message, sourceIndex) => {
			const outputIndex = matched.get(sourceIndex);
			if (outputIndex === undefined) return { sourceIndex, kind: "removed" as const };
			return {
				sourceIndex,
				outputIndex,
				kind: beforeCanonical[sourceIndex] === afterCanonical[outputIndex] ? "kept" as const : "edited" as const,
			};
		}),
		additions: after.flatMap((_message, outputIndex) =>
			matchedOutputs.has(outputIndex) ? [] : [{ outputIndex, kind: "added" as const }],
		),
	};
}

function previousProjection(
	records: StateRecord[],
	recordIndex: number,
	sourceRevision?: number,
): ProjectionCheckpoint | undefined {
	for (let index = recordIndex - 1; index >= 0; index--) {
		const prior = records[index].state;
		if (sourceRevision !== undefined && prior.revision !== sourceRevision) continue;
		if (!prior.checkpoint) continue;
		return prior.checkpoint;
	}
	return undefined;
}

function expandedMessageDetail(message: LiveContextMessage, maxCharacters = 2_000): string {
	const rendered = renderMessage(message).trim() || "(empty)";
	return rendered.length <= maxCharacters ? rendered : `${rendered.slice(0, maxCharacters - 1)}…`;
}

/**
 * Diff rows shown per message before an explicit "preview truncated" row. The diff is
 * always computed on the full text, so a change anywhere is found and nothing identical
 * is claimed; only the display is bounded.
 */
const EDITED_DIFF_MAX_ROWS = 400;
const ONE_SIDED_DIFF_MAX_ROWS = 60;

function diffText(message: LiveContextMessage): string {
	return renderMessage(message);
}

/** Adds enumerable, cached getters so full-text diffs are only rendered for rows someone expands. */
function withLazyDiffText(
	view: LiveContextEditView,
	source: LiveContextMessage | undefined,
	output: LiveContextMessage | undefined,
): LiveContextEditView {
	const define = (key: "beforeText" | "afterText", message: LiveContextMessage | undefined) => {
		if (!message) return;
		let cached: string | undefined;
		Object.defineProperty(view, key, {
			enumerable: true,
			configurable: true,
			get: () => (cached ??= diffText(message)),
		});
	};
	define("beforeText", source);
	define("afterText", output);
	return view;
}

function buildEditViews(
	before: LiveContextMessage[],
	after: LiveContextMessage[],
	trace: ContextEditTrace,
): LiveContextEditView[] {
	const edits: LiveContextEditView[] = trace.sources.map((item) => {
		const source = before[item.sourceIndex];
		const output = item.outputIndex === undefined ? undefined : after[item.outputIndex];
		return withLazyDiffText({
			kind: item.kind,
			sourceIndex: item.sourceIndex + 1,
			outputIndex: item.outputIndex === undefined ? undefined : item.outputIndex + 1,
			beforeRole: source?.role,
			afterRole: output?.role,
			beforeTokens: source ? messageTokens(source) : undefined,
			afterTokens: output ? messageTokens(output) : undefined,
			beforePreview: source ? compactPreview(source, 220) : undefined,
			afterPreview: output ? compactPreview(output, 220) : undefined,
			beforeDetail: source ? expandedMessageDetail(source) : undefined,
			afterDetail: output ? expandedMessageDetail(output) : undefined,
		}, source, output);
	});
	for (const addition of trace.additions) {
		const output = after[addition.outputIndex];
		edits.push(withLazyDiffText({
			kind: "added",
			outputIndex: addition.outputIndex + 1,
			afterRole: output?.role,
			afterTokens: output ? messageTokens(output) : undefined,
			afterPreview: output ? compactPreview(output, 220) : undefined,
			afterDetail: output ? expandedMessageDetail(output) : undefined,
		}, undefined, output));
	}
	return edits;
}

function analyzeCheckpoint(
	options: BuildLiveContextViewOptions,
	records: StateRecord[],
	recordIndex: number,
): CheckpointAnalysis {
	const record = records[recordIndex];
	const checkpoint = record.state.checkpoint!;
	const previous = previousProjection(records, recordIndex, checkpoint.editTrace?.sourceRevision);
	const sourceRevision = checkpoint.editTrace?.sourceRevision ?? records[recordIndex - 1]?.state.revision ?? 0;
	const afterTokens = checkpoint.projectedMessages.reduce((total, message) => total + messageTokens(message), 0);
	const rawSource = rawSourceForCheckpoint(options, record, checkpoint);
	if (!rawSource) {
		return { checkpoint, sourceRevision, afterTokens, edits: [], traceSource: "unavailable" };
	}
	const baseline = applyProjection(rawSource, previous);
	if (!baseline.valid) {
		return { checkpoint, sourceRevision, afterTokens, edits: [], traceSource: "unavailable" };
	}
	const before = selectContextVisibleMessages(baseline.messages);
	const beforeTokens = before.reduce((total, message) => total + messageTokens(message), 0);
	const trace = checkpoint.editTrace ?? reconstructEditTrace(before, checkpoint.projectedMessages, sourceRevision);
	if (
		trace.sourceMessageCount !== before.length ||
		trace.outputMessageCount !== checkpoint.projectedMessages.length
	) {
		return { checkpoint, sourceRevision, beforeTokens, afterTokens, edits: [], traceSource: "unavailable" };
	}
	return {
		checkpoint,
		sourceRevision,
		beforeTokens,
		afterTokens,
		edits: buildEditViews(before, checkpoint.projectedMessages, trace),
		traceSource: checkpoint.editTrace ? "recorded" : "reconstructed",
	};
}

function revisionData(options: BuildLiveContextViewOptions): {
	records: StateRecord[];
	analyses: Map<number, CheckpointAnalysis>;
	revisions: LiveContextEditRevisionView[];
} {
	const records = stateRecords(options.entries);
	if (options.state.checkpoint && !records.some(({ state }) => state.checkpoint?.revision === options.state.checkpoint?.revision)) {
		records.push({ state: options.state, entryIndex: -1 });
	}
	const analyses = new Map<number, CheckpointAnalysis>();
	const revisions: LiveContextEditRevisionView[] = [];
	for (let index = 0; index < records.length; index++) {
		const checkpoint = records[index].state.checkpoint;
		if (!checkpoint || analyses.has(checkpoint.revision)) continue;
		const analysis = analyzeCheckpoint(options, records, index);
		analyses.set(checkpoint.revision, analysis);
		revisions.push({
			revision: checkpoint.revision,
			sourceRevision: analysis.sourceRevision,
			createdAt: checkpoint.createdAt,
			beforeTokens: analysis.beforeTokens,
			afterTokens: analysis.afterTokens,
			edits: analysis.edits,
			traceSource: analysis.traceSource,
		});
	}
	return { records, analyses, revisions };
}

function tokenFields(
	beforeEstimate: number,
	afterEstimate: number,
	estimateSource: LiveContextHistoryView["estimateSource"],
): Pick<LiveContextHistoryView, "beforeEstimate" | "afterEstimate" | "estimateUnit" | "estimateSource"> {
	return { beforeEstimate, afterEstimate, estimateUnit: "tokens", estimateSource };
}

function checkpointTokenFields(
	checkpoint: ProjectionCheckpoint,
	analysis: CheckpointAnalysis | undefined,
): Partial<LiveContextHistoryView> {
	if (checkpoint.estimateUnit === "tokens") {
		return tokenFields(checkpoint.beforeEstimate, checkpoint.afterEstimate, "recorded");
	}
	if (analysis?.beforeTokens !== undefined) {
		return tokenFields(analysis.beforeTokens, analysis.afterTokens, "recomputed");
	}
	return {
		afterEstimate: analysis?.afterTokens ?? checkpoint.projectedMessages.reduce((sum, message) => sum + messageTokens(message), 0),
		estimateUnit: "tokens",
		estimateSource: "recomputed",
		estimateNote: "raw token estimate unavailable for this legacy checkpoint",
	};
}

function historyView(
	records: StateRecord[],
	analyses: Map<number, CheckpointAnalysis>,
): LiveContextHistoryView[] {
	return records.map(({ state }, index) => {
		const previous = records[index - 1]?.state;
		if (state.event) {
			return {
				revision: state.revision,
				event: state.event.kind,
				message: state.event.kind === "enabled" ? "Projection enabled." : "Projection disabled.",
				at: state.event.at,
			};
		}
		if (previous && previous.enabled !== state.enabled) {
			return {
				revision: state.revision,
				event: state.enabled ? "enabled" : "disabled",
				message: state.enabled ? "Projection enabled." : "Projection disabled.",
			};
		}
		if (state.lastOutcome) {
			const outcome = state.lastOutcome;
			let estimates: Partial<LiveContextHistoryView> = {};
			if (
				outcome.estimateUnit === "tokens" &&
				outcome.beforeEstimate !== undefined &&
				outcome.afterEstimate !== undefined
			) {
				estimates = tokenFields(outcome.beforeEstimate, outcome.afterEstimate, "recorded");
			} else if (outcome.kind === "applied" && state.checkpoint?.revision === state.revision) {
				estimates = checkpointTokenFields(state.checkpoint, analyses.get(state.revision));
			} else if (outcome.beforeEstimate !== undefined || outcome.afterEstimate !== undefined) {
				estimates = { estimateNote: "legacy character estimate omitted; token estimate unavailable" };
			}
			return {
				revision: state.revision,
				event: outcome.kind,
				message: outcome.message,
				...estimates,
				at: outcome.at,
			};
		}
		if (!state.enabled) {
			return { revision: state.revision, event: "disabled", message: "Projection disabled." };
		}
		if (state.checkpoint) {
			return {
				revision: state.revision,
				event: "checkpoint",
				message: "Projection checkpoint persisted.",
				...checkpointTokenFields(state.checkpoint, analyses.get(state.checkpoint.revision)),
				at: state.checkpoint.createdAt,
			};
		}
		return { revision: state.revision, event: "enabled", message: "Projection enabled." };
	});
}

interface ConversationTreeNode {
	entry: SessionEntry;
	segmentEntries: SessionEntry[];
	children: ConversationTreeNode[];
}

function isConversationTreeEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return (entry.message as unknown as LiveContextMessage).role === "user";
	if (entry.type === "custom" && entry.customType === "live-context-state") return isLiveContextState(entry.data);
	return entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message";
}

function roleSummary(entries: SessionEntry[]): string {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = (entry.message as unknown as LiveContextMessage).role;
		counts.set(role, (counts.get(role) ?? 0) + 1);
	}
	return [...counts.entries()].map(([role, count]) => `${count} ${role}`).join(" · ") || "no model messages";
}

function foldedTreeEntryDetail(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message as unknown as LiveContextMessage;
		return `${message.role}:\n${expandedMessageDetail(message, 800)}`;
	}
	if (entry.type === "model_change") return `model change: ${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return `thinking level: ${entry.thinkingLevel}`;
	if (entry.type === "label") return `label: ${entry.label ?? "cleared"} · target ${entry.targetId}`;
	if (entry.type === "session_info") return `session name: ${entry.name ?? "cleared"}`;
	if (entry.type === "custom") return `extension state: ${entry.customType}`;
	return `${entry.type} · entry ${entry.id}`;
}

function foldedTreeDetails(entries: SessionEntry[], limit = 8): string[] {
	const folded = entries.slice(1);
	const details = folded.slice(0, limit).map(foldedTreeEntryDetail);
	if (folded.length > limit) details.push(`… ${folded.length - limit} more folded entries`);
	return details;
}

type ProjectionVisibility = "kept" | "rewritten" | "omitted";

/**
 * Match the active raw path to the effective context once. The previous tree renderer
 * repeated full-message serialization for every raw/effective pair in every turn,
 * making large sessions quadratic and causing multi-second overlay stalls.
 */
function buildProjectionVisibility(
	activePath: SessionEntry[],
	effectiveMessages: LiveContextMessage[],
): Map<string, ProjectionVisibility> {
	const visibility = new Map<string, ProjectionVisibility>();
	const effectiveCanonical = effectiveMessages.map(canonicalMessage);
	const exactQueues = new Map<string, number[]>();
	for (let index = effectiveCanonical.length - 1; index >= 0; index--) {
		const canonical = effectiveCanonical[index];
		exactQueues.set(canonical, [...(exactQueues.get(canonical) ?? []), index]);
	}
	const remaining = new Set(effectiveMessages.map((_message, index) => index));
	const unmatchedRaw: Array<{ entry: Extract<SessionEntry, { type: "message" }>; message: LiveContextMessage }> = [];

	for (const entry of activePath) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as LiveContextMessage;
		const queue = exactQueues.get(canonicalMessage(message));
		const outputIndex = queue?.pop();
		if (outputIndex !== undefined) {
			remaining.delete(outputIndex);
			visibility.set(entry.id, "kept");
		} else {
			unmatchedRaw.push({ entry, message });
		}
	}

	const lineageQueues = new Map<string, number[]>();
	const noteQueues = new Map<number, number[]>();
	for (const outputIndex of [...remaining].sort((left, right) => right - left)) {
		const message = effectiveMessages[outputIndex];
		if (typeof message.timestamp !== "number") continue;
		const key = `${message.role}\u0000${message.timestamp}`;
		lineageQueues.set(key, [...(lineageQueues.get(key) ?? []), outputIndex]);
		if (message.role === "custom" && message.customType === "live-context-projection") {
			noteQueues.set(message.timestamp, [...(noteQueues.get(message.timestamp) ?? []), outputIndex]);
		}
	}
	const popLive = (queue: number[] | undefined): number | undefined => {
		while (queue && queue.length > 0) {
			const outputIndex = queue.pop()!;
			if (remaining.has(outputIndex)) return outputIndex;
		}
		return undefined;
	};
	for (const { entry, message } of unmatchedRaw) {
		if (typeof message.timestamp === "number") {
			// An edited user or assistant message keeps its role; every other rewritten or
			// orphaned message becomes a live-context-projection note that preserves the
			// source timestamp, so that role change to "custom" still counts as rewritten.
			const outputIndex =
				popLive(lineageQueues.get(`${message.role}\u0000${message.timestamp}`)) ??
				(message.role === "custom" ? undefined : popLive(noteQueues.get(message.timestamp)));
			if (outputIndex !== undefined) {
				remaining.delete(outputIndex);
				visibility.set(entry.id, "rewritten");
				continue;
			}
		}
		visibility.set(entry.id, "omitted");
	}
	return visibility;
}

function projectionStats(
	entries: SessionEntry[],
	visibility: Map<string, ProjectionVisibility>,
): { total: number; kept: number; rewritten: number; omitted: number } {
	const kinds = entries.flatMap((entry) => entry.type === "message" ? [visibility.get(entry.id) ?? "omitted"] : []);
	const kept = kinds.filter((kind) => kind === "kept").length;
	const rewritten = kinds.filter((kind) => kind === "rewritten").length;
	return { total: kinds.length, kept, rewritten, omitted: kinds.length - kept - rewritten };
}

function checkpointSize(
	state: LiveContextState,
	analyses: Map<number, CheckpointAnalysis>,
): { label: string; note?: string } {
	const checkpoint = state.checkpoint;
	if (!checkpoint) return { label: "" };
	const fields = checkpointTokenFields(checkpoint, analyses.get(checkpoint.revision));
	if (fields.beforeEstimate !== undefined && fields.afterEstimate !== undefined) {
		return {
			label: `${formatCount(fields.beforeEstimate)}→${formatCount(fields.afterEstimate)} tok`,
			note: fields.estimateSource === "recomputed" ? "token sizes recomputed from the historical projection" : undefined,
		};
	}
	if (fields.afterEstimate !== undefined) {
		return { label: `?→${formatCount(fields.afterEstimate)} tok`, note: fields.estimateNote };
	}
	return { label: "token size unavailable", note: fields.estimateNote };
}

function treeDisplay(
	node: ConversationTreeNode,
	turnNumber: number | undefined,
	active: boolean,
	currentStateEntryId: string | undefined,
	currentLiveState: LiveContextState,
	projectionVisibility: Map<string, ProjectionVisibility>,
	activeEntryIds: Set<string>,
	analyses: Map<number, CheckpointAnalysis>,
): Pick<LiveContextTreeRow, "kind" | "text" | "status" | "details"> {
	const entry = node.entry;
	const timestamp = `Recorded ${formatTime(entry.timestamp)} · entry ${entry.id}`;
	if (entry.type === "message") {
		const message = entry.message as unknown as LiveContextMessage;
		const segmentEntries = active
			? node.segmentEntries.filter((item) => activeEntryIds.has(item.id))
			: node.segmentEntries;
		const messages = segmentEntries.filter((item) => item.type === "message");
		const stats = projectionStats(segmentEntries, projectionVisibility);
		const rawTokens = messages.reduce(
			(total, item) => total + messageTokens((item as Extract<SessionEntry, { type: "message" }>).message as unknown as LiveContextMessage),
			0,
		);
		const visible = stats.kept + stats.rewritten;
		const status = !active
			? "inactive"
			: stats.total === 0
				? "raw turn"
				: visible === stats.total
					? stats.rewritten > 0 ? `${stats.rewritten} rewritten` : "all effective"
					: visible === 0 ? "omitted" : `${visible}/${stats.total} effective`;
		const foldedDetails = foldedTreeDetails(segmentEntries);
		return {
			kind: "turn",
			text: `T${turnNumber ?? "?"} · user · ${compactPreview(message, 128)}`,
			status,
			details: [
				`Raw user message:\n${expandedMessageDetail(message)}`,
				`Raw turn: ${stats.total} messages · ${formatCount(rawTokens)} tokens · ${roleSummary(segmentEntries)}`,
				active
					? `Effective now: ${visible} of ${stats.total} raw messages from this turn are in the model's current context (${stats.kept} unchanged · ${stats.rewritten} rewritten · ${stats.omitted} omitted).`
					: "This turn belongs to an inactive raw branch and is not in the current model context.",
				...(foldedDetails.length > 0 ? [`Folded assistant/tool work (${segmentEntries.length - 1} entries):`, ...foldedDetails] : []),
				timestamp,
			],
		};
	}
	if (entry.type === "custom" && entry.customType === "live-context-state" && isLiveContextState(entry.data)) {
		const persistedState = entry.data;
		const current = entry.id === currentStateEntryId;
		// Slim outcome entries omit the checkpoint payload. The current branch state has
		// already reconstructed that checkpoint from the preceding acceptance entry.
		const state = current ? currentLiveState : persistedState;
		const outcome = !state.enabled
			? "disabled"
			: state.event?.kind ?? state.lastOutcome?.kind ?? (state.checkpoint ? "checkpoint" : "enabled");
		const size = checkpointSize(state, analyses);
		const inherited =
			active &&
			Boolean(state.checkpoint) &&
			state.checkpoint?.revision === currentLiveState.checkpoint?.revision;
		const status = current
			? state.enabled ? "current projection" : "current · projection off"
			: inherited
				? "inherited checkpoint"
				: active && state.checkpoint ? "superseded checkpoint" : active ? "state history" : "inactive";
		return {
			kind: "live-context",
			text: `Live context r${state.revision} · ${outcome}${size.label ? ` · ${size.label}` : ""}`,
			status,
			details: [
				`Projection is ${state.enabled ? "enabled" : "disabled"} at this raw tree node.`,
				...(state.checkpoint
					? [`Checkpoint replaces a ${state.checkpoint.sourceMessageCount}-message raw prefix with ${state.checkpoint.projectedMessages.length} projected messages.`]
					: ["No projection checkpoint is attached to this state."]),
				...(size.note ? [size.note] : []),
				...(state.lastOutcome && !state.event ? [`Outcome: ${state.lastOutcome.message}`] : []),
				timestamp,
			],
		};
	}
	if (entry.type === "compaction") {
		return {
			kind: "summary",
			text: `Pi compaction · ${formatCount(entry.tokensBefore)} raw tokens summarized`,
			status: active ? "active boundary" : "inactive",
			details: [
				`Pi replaced older raw context with a native compaction summary; kept entries start at ${entry.firstKeptEntryId}.`,
				timestamp,
			],
		};
	}
	if (entry.type === "branch_summary") {
		return {
			kind: "summary",
			text: `Branch summary · ${entry.summary.replace(/\s+/g, " ").trim().slice(0, 140)}`,
			status: active ? "active raw context" : "inactive",
			details: [entry.summary, `Summarizes abandoned branch ending at ${entry.fromId}.`, timestamp],
		};
	}
	const note = entry as Extract<SessionEntry, { type: "custom_message" }>;
	const message = { role: "custom", content: note.content } as LiveContextMessage;
	return {
		kind: "context-note",
		text: `${note.customType} · ${compactPreview(message, 140)}`,
		status: active ? "active raw note" : "inactive",
		details: [expandedMessageDetail(message), timestamp],
	};
}

function treeRows(
	options: BuildLiveContextViewOptions,
	effectiveMessages: LiveContextMessage[],
	analyses: Map<number, CheckpointAnalysis>,
): { rows: LiveContextTreeRow[]; hiddenCount: number } {
	const tree = options.tree;
	if (!tree) return { rows: [], hiddenCount: 0 };
	const byId = new Map<string, SessionEntry>();
	const pending = [...tree];
	while (pending.length > 0) {
		const node = pending.pop()!;
		byId.set(node.entry.id, node.entry);
		pending.push(...node.children);
	}
	const activeIds = new Set<string>();
	const activePath: SessionEntry[] = [];
	let cursor = options.leafId ?? null;
	while (cursor) {
		const entry = byId.get(cursor);
		if (!entry) break;
		activeIds.add(cursor);
		activePath.push(entry);
		cursor = entry.parentId ?? null;
	}
	activePath.reverse();
	const projectionVisibility = buildProjectionVisibility(activePath, effectiveMessages);

	const roots: ConversationTreeNode[] = [];
	let hiddenCount = 0;
	const visit = (source: SessionTreeNodeLike, parent: ConversationTreeNode | undefined): void => {
		let nextParent = parent;
		if (isConversationTreeEntry(source.entry)) {
			const aggregate: ConversationTreeNode = {
				entry: source.entry,
				segmentEntries: [source.entry],
				children: [],
			};
			if (parent) parent.children.push(aggregate);
			else roots.push(aggregate);
			nextParent = aggregate;
		} else {
			hiddenCount++;
			parent?.segmentEntries.push(source.entry);
		}
		for (const child of source.children) visit(child, nextParent);
	};
	for (const root of tree) visit(root, undefined);

	const visibleIds = new Set<string>();
	const collectVisible = [...roots];
	while (collectVisible.length > 0) {
		const node = collectVisible.pop()!;
		visibleIds.add(node.entry.id);
		collectVisible.push(...node.children);
	}
	let visibleHeadId: string | undefined;
	cursor = options.leafId ?? null;
	while (cursor) {
		if (visibleIds.has(cursor)) {
			visibleHeadId = cursor;
			break;
		}
		cursor = byId.get(cursor)?.parentId ?? null;
	}
	let currentStateEntryId: string | undefined;
	cursor = options.leafId ?? null;
	while (cursor) {
		const entry = byId.get(cursor);
		if (entry?.type === "custom" && entry.customType === "live-context-state" && isLiveContextState(entry.data)) {
			currentStateEntryId = entry.id;
			break;
		}
		cursor = entry?.parentId ?? null;
	}

	const turnNumbers = new Map<string, number>();
	let nextTurn = 1;
	const numberPending = [...roots];
	while (numberPending.length > 0) {
		const node = numberPending.shift()!;
		if (node.entry.type === "message") turnNumbers.set(node.entry.id, nextTurn++);
		numberPending.unshift(...node.children);
	}

	// Indentation grows only at branch points. A conversation is usually a linear chain,
	// and one indent level per turn pushed long sessions off the right edge; an only
	// child therefore continues at its parent's column with no connector.
	type Work = { node: ConversationTreeNode; prefixGuides: boolean[]; connector: string; childGuides: boolean[] };
	const sortedRoots = [...roots].sort((left, right) => Number(activeIds.has(right.entry.id)) - Number(activeIds.has(left.entry.id)));
	const multipleRoots = sortedRoots.length > 1;
	const stack: Work[] = [];
	for (let index = sortedRoots.length - 1; index >= 0; index--) {
		const isLast = index === sortedRoots.length - 1;
		stack.push({
			node: sortedRoots[index],
			prefixGuides: [],
			connector: multipleRoots ? (isLast ? "└─ " : "├─ ") : "",
			childGuides: multipleRoots ? [!isLast] : [],
		});
	}
	const rows: LiveContextTreeRow[] = [];
	while (stack.length > 0) {
		const work = stack.pop()!;
		const active = activeIds.has(work.node.entry.id);
		const prefix = work.prefixGuides.map((show) => show ? "│  " : "   ").join("") + work.connector;
		const display = treeDisplay(
			work.node,
			turnNumbers.get(work.node.entry.id),
			active,
			currentStateEntryId,
			options.state,
			projectionVisibility,
			activeIds,
			analyses,
		);
		rows.push({
			entryId: work.node.entry.id,
			prefix,
			active,
			head: work.node.entry.id === visibleHeadId,
			...display,
		});
		const children = [...work.node.children].sort(
			(left, right) => Number(activeIds.has(right.entry.id)) - Number(activeIds.has(left.entry.id)),
		);
		const branching = children.length > 1;
		for (let index = children.length - 1; index >= 0; index--) {
			const isLast = index === children.length - 1;
			stack.push({
				node: children[index],
				prefixGuides: work.childGuides,
				connector: branching ? (isLast ? "└─ " : "├─ ") : "",
				childGuides: branching ? [...work.childGuides, !isLast] : work.childGuides,
			});
		}
	}
	return { rows, hiddenCount };
}

function lazy<T>(compute: () => T): () => T {
	let value: T;
	let resolved = false;
	return () => {
		if (!resolved) {
			value = compute();
			resolved = true;
		}
		return value;
	};
}

/**
 * The summary fields are computed eagerly; per-tab data (messages, revisions, tree,
 * history) is materialized on first property access and memoized. The text report and
 * the overview tab therefore stay cheap on long branches.
 */
export function buildLiveContextViewModel(options: BuildLiveContextViewOptions): LiveContextViewModel {
	const checkpoint = options.state.checkpoint;
	const effectiveMessages = options.current?.effectiveMessages ?? checkpoint?.projectedMessages ?? [];
	const revisionsLazy = lazy(() => revisionData(options));
	const latestRevisionLazy = lazy(() => {
		const revisions = revisionsLazy().revisions;
		return checkpoint
			? revisions.find((revision) => revision.revision === checkpoint.revision)
			: revisions.at(-1);
	});
	const treeLazy = lazy(() => treeRows(options, effectiveMessages, revisionsLazy().analyses));
	const historyLazy = lazy(() => historyView(revisionsLazy().records, revisionsLazy().analyses));
	const timelineLazy = lazy(() => buildContextTimeline(options.entries));
	const previewCharacters = Math.max(40, options.previewCharacters ?? 180);
	const messagesLazy = lazy(() => {
		const protectedIndexes = selectProtectedMessageIndexes(effectiveMessages);
		return effectiveMessages.map((message, index) => ({
			index: index + 1,
			role: message.role,
			tokens: messageTokens(message),
			protected: protectedIndexes.has(index),
			preview: compactPreview(message, previewCharacters),
		}));
	});
	const estimateUnit = options.current ? "tokens" : checkpoint ? checkpoint.estimateUnit ?? "characters" : "tokens";
	const fallbackEstimate = lazy(() => effectiveMessages.reduce((total, message) => total + messageTokens(message), 0));
	const beforeEstimate = options.current?.rawTokens ?? checkpoint?.beforeEstimate ?? fallbackEstimate();
	const afterEstimate = options.current?.effectiveTokens ?? checkpoint?.afterEstimate ?? beforeEstimate;
	const savingsEstimate = Math.max(0, beforeEstimate - afterEstimate);

	return {
		enabled: options.state.enabled,
		revision: options.state.revision,
		mirrorPath: options.mirrorPath,
		beforeEstimate,
		afterEstimate,
		savingsEstimate,
		estimateUnit,
		savingsPercent: beforeEstimate > 0 ? (savingsEstimate / beforeEstimate) * 100 : 0,
		rawMessageCount: options.current?.rawMessageCount ?? checkpoint?.sourceMessageCount ?? effectiveMessages.length,
		effectiveMessageCount: effectiveMessages.length,
		suffixMessageCount: options.current?.suffixMessageCount ?? 0,
		capturedAt: options.current?.capturedAt,
		snapshotStale: options.snapshotStale ?? false,
		checkpointCreatedAt: checkpoint?.createdAt,
		lastOutcome: options.state.lastOutcome,
		get messages() {
			return messagesLazy();
		},
		get edits() {
			return latestRevisionLazy()?.edits ?? [];
		},
		get editTraceSource() {
			return latestRevisionLazy()?.traceSource ?? "unavailable";
		},
		get editRevisions() {
			return revisionsLazy().revisions;
		},
		get tree() {
			return treeLazy().rows;
		},
		get treeHiddenEntryCount() {
			return treeLazy().hiddenCount;
		},
		get history() {
			return historyLazy();
		},
		runtime: runtimeView(options),
		get timeline() {
			return timelineLazy();
		},
		budget: options.budget,
	};
}

function formatTime(value: string | undefined): string {
	if (!value) return "unknown";
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function formatLiveContextReport(model: LiveContextViewModel): string {
	const state = model.enabled ? (model.revision > 0 ? "projected" : "raw") : "disabled";
	const lines = [
		`Live context · ${state} · revision ${model.revision}`,
		`${model.estimateUnit}: ${model.beforeEstimate} -> ${model.afterEstimate} (${model.savingsEstimate} saved, ${model.savingsPercent.toFixed(1)}%)`,
		`messages: ${model.rawMessageCount} raw -> ${model.effectiveMessageCount} effective (${model.suffixMessageCount} raw suffix)`,
		`runtime: ${model.runtime.kind} · ${model.runtime.mode} · session ${model.runtime.sessionId}`,
	];
	if (model.snapshotStale) lines.push("note: newer raw messages were recorded after this snapshot");
	if (model.lastOutcome) lines.push(`${model.lastOutcome.kind}: ${model.lastOutcome.message}`);
	if (model.mirrorPath) lines.push(`mirror: ${model.mirrorPath}`);
	return lines.join("\n");
}

/** Text report for one page; used outside the TUI (print/JSON/RPC modes). */
export function formatViewerPageReport(model: LiveContextViewModel, tab: LiveContextViewTab, width = 72): string {
	const page = pageOf(tab);
	const header = formatLiveContextReport(model);
	if (page === "overview" || page === "timeline") {
		return `${header}\n\n${formatTimelineReport(model.timeline, width, model.budget)}`;
	}
	if (page === "input" || page === "projection") {
		const rows = model.messages.length === 0
			? ["(no model-visible context snapshot captured yet)"]
			: model.messages.map((message) => `#${message.index} ${message.role} ${formatCount(message.tokens)} tok · ${message.preview}`);
		return `${header}\n\ncurrent input (${model.effectiveMessageCount} messages):\n${rows.join("\n")}`;
	}
	if (page === "edit") {
		if (model.editRevisions.length === 0) return `${header}\n\nno accepted context edits on this branch`;
		const rows = model.editRevisions.map((revision) => {
			const counts = new Map<string, number>();
			for (const edit of revision.edits) counts.set(edit.kind, (counts.get(edit.kind) ?? 0) + 1);
			const summary = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
			const size = revision.beforeTokens !== undefined && revision.afterTokens !== undefined
				? `${formatCount(revision.beforeTokens)}→${formatCount(revision.afterTokens)} tok`
				: "size not recorded";
			return `r${revision.revision} (from r${revision.sourceRevision}) · ${size} · ${summary || "no trace"} · ${revision.traceSource}`;
		});
		return `${header}\n\nedits:\n${rows.join("\n")}`;
	}
	return header;
}

function parseInitialTab(value: string, tabs: readonly LiveContextViewTab[]): LiveContextViewTab | undefined {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return "overview";
	return tabs.find((tab) => tab === normalized);
}

export interface ShowLiveContextViewerOptions {
	/** Tab set to offer; defaults to the conservative-mode six. */
	tabs?: readonly LiveContextViewTab[];
	/** Command name for the usage hint. */
	commandName?: string;
	/** Enables the `settings` page. */
	settings?: ViewerSettingsController;
}

export async function showLiveContextViewer(
	ctx: ExtensionCommandContext,
	model: LiveContextViewModel,
	requestedTab = "",
	options: ShowLiveContextViewerOptions = {},
): Promise<void> {
	const tabs = options.tabs ?? LIVE_CONTEXT_VIEW_TABS;
	const initialTab = parseInitialTab(requestedTab, tabs);
	if (!initialTab) {
		ctx.ui.notify(`Usage: /${options.commandName ?? "live-context-view"} [${tabs.join("|")}]`, "warning");
		return;
	}
	if (contextMode(ctx) !== "tui") {
		ctx.ui.notify(formatViewerPageReport(model, initialTab), "info");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new LiveContextViewer(tui, theme, model, initialTab, done, tabs, options.settings),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				minWidth: 52,
				maxHeight: "85%",
				margin: 1,
			},
		},
	);
}

function eventGlyph(event: LiveContextHistoryView["event"]): string {
	if (event === "applied" || event === "checkpoint" || event === "enabled") return "✓";
	if (event === "rejected") return "!";
	if (event === "reset") return "↺";
	return "○";
}

const TREE_ROW_START_LINE = 4;
const TREE_DETAIL_PANEL_MAX_HEIGHT = 10;

/** How zooms are named to users: the whole history fitted, one column per request, per user turn. */
const TIMELINE_ZOOM_LABELS: Record<TimelineZoom, string> = { fit: "all", requests: "detail", turns: "turns" };

/** Color of context-edit events in the overview chart and list (blue in Pi's built-in themes). */
const EDIT_COLOR = "mdLink" as const;

/**
 * The groups (a list row plus any expanded details) to show within `budget` lines: the
 * selected group always, then neighbours alternately after and before it, with a one-line
 * "⋯ N earlier/later" marker for whatever is cut off at either end.
 */
export function windowAroundSelection(
	groups: readonly (readonly string[])[],
	selected: number,
	budget: number,
	more: (count: number, where: "earlier" | "later") => string,
): string[] {
	const total = groups.reduce((sum, group) => sum + group.length, 0);
	if (total <= budget || groups.length === 0) return groups.flat();
	const pick = Math.max(0, Math.min(groups.length - 1, selected));
	let start = pick;
	let end = pick + 1;
	let used = groups[pick]!.length;
	const markers = (from: number, to: number) => (from > 0 ? 1 : 0) + (to < groups.length ? 1 : 0);
	for (let grew = true; grew;) {
		grew = false;
		if (end < groups.length && used + groups[end]!.length + markers(start, end + 1) <= budget) {
			used += groups[end]!.length;
			end++;
			grew = true;
		}
		if (start > 0 && used + groups[start - 1]!.length + markers(start - 1, end) <= budget) {
			used += groups[start - 1]!.length;
			start--;
			grew = true;
		}
	}
	return [
		...(start > 0 ? [more(start, "earlier")] : []),
		...groups.slice(start, end).flat(),
		...(end < groups.length ? [more(groups.length - end, "later")] : []),
	];
}

export class LiveContextViewer implements Component {
	private tabIndex: number;
	private scroll = 0;
	private editRevisionIndex: number | undefined;
	private editSelection = 0;
	/** Physical start lines of edit rows, refreshed by editLines on every render. */
	private editRowPhysicalStarts: number[] = [];
	private editPagePhysicalLength = 0;
	/** Set when a row expands; the next render scrolls its diff into view once positions are known. */
	private revealSelectedEdit = false;
	private readonly expandedEdits = new Set<string>();
	/** Diff rows per edit key; rendering is repeated on every Pi redraw, diffing is not. */
	private readonly editDiffs = new Map<string, SideBySideRow[]>();
	/**
	 * Laid-out (already wrapped) row headers and expanded bodies per edit key and width.
	 * Pi redraws the overlay on every stream update; with "expand all" on a large revision,
	 * re-measuring every line each time made the viewer lag.
	 */
	private readonly editLayouts = new Map<string, string[]>();
	private editLayoutWidth = 0;
	private treeSelection: number | undefined;
	private expandedTreeRowId: string | undefined;
	/**
	 * Selected stop on the timeline: an index into `timeline.markers`, or
	 * `markers.length` for "now" (the latest request). Resolved on first use to "now", so
	 * the chart opens on the current position rather than the oldest compaction point.
	 */
	private timelineSelection: number | undefined;
	/**
	 * `z` cycles fit (whole branch, the default) → requests (one column per request, panning)
	 * → turns (one column per user turn); `requests` is skipped when fit already shows one
	 * request per column.
	 */
	private timelineZoom: TimelineZoom = "fit";
	/** Width of the last timeline render, so `z` knows which zooms differ at this size. */
	private timelineWidth = 80;
	private readonly tabs: readonly LiveContextViewTab[];
	/** CLM layout: the overview page hosts the timeline and the effective context. */
	private readonly clmLayout: boolean;
	private settingsList: SettingsList | undefined;
	/** Rows the settings list was built to show; it is rebuilt when a different number fits. */
	private settingsListRows = 0;
	private settingsSubmenuOpen = false;
	private settingsMessage: { text: string; warning: boolean } | undefined;
	/** Page line to keep on screen: the selected setting, or the open text prompt's input. */
	private settingsFocusLine = 0;
	/** `settingsFocusLine` at the last render, to tell a moved selection from a scroll. */
	private settingsScrolledFocus: number | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly model: LiveContextViewModel,
		initialTab: LiveContextViewTab,
		private readonly done: () => void,
		tabs: readonly LiveContextViewTab[] = LIVE_CONTEXT_VIEW_TABS,
		private readonly settings?: ViewerSettingsController,
	) {
		// The settings page needs a controller; without one (e.g. a read-only host) it is not offered.
		this.tabs = settings ? tabs : tabs.filter((tab) => tab !== "settings");
		this.clmLayout = tabs.includes("input");
		this.tabIndex = Math.max(0, tabs.indexOf(initialTab));
		if (initialTab === "tree") this.scroll = this.treeSelectionScroll();
	}

	/** Tab state resolves on first use so opening one tab does not build the others. */
	private resolveEditRevisionIndex(): number {
		this.editRevisionIndex ??= Math.max(0, this.model.editRevisions.length - 1);
		return this.editRevisionIndex;
	}

	private resolveTreeSelection(): number {
		if (this.treeSelection === undefined) {
			const headIndex = this.model.tree.findIndex((row) => row.head);
			this.treeSelection = headIndex >= 0 ? headIndex : Math.max(0, this.model.tree.findIndex((row) => row.active));
		}
		return this.treeSelection;
	}

	handleInput(data: string): void {
		if (this.currentPage() === "settings" && this.handleSettingsInput(data)) {
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const tab = this.currentPage();
		const timelineKeys = tab === "timeline" || (this.clmLayout && tab === "overview");
		if (timelineKeys && (matchesKey(data, "enter") || matchesKey(data, "return"))) {
			this.openSelectedTimelineMarker();
		} else if (timelineKeys && (matchesKey(data, "right") || matchesKey(data, "]"))) {
			this.moveTimelineSelection(1);
		} else if (timelineKeys && (matchesKey(data, "left") || matchesKey(data, "["))) {
			this.moveTimelineSelection(-1);
		} else if (timelineKeys && data === "z") {
			const zooms = availableTimelineZooms(this.model.timeline, this.timelineWidth);
			this.timelineZoom = zooms[(zooms.indexOf(this.effectiveTimelineZoom()) + 1) % zooms.length]!;
		} else if (tab === "edit" && (matchesKey(data, "right") || matchesKey(data, "]"))) {
			this.moveEditRevision(1);
		} else if (tab === "edit" && (matchesKey(data, "left") || matchesKey(data, "["))) {
			this.moveEditRevision(-1);
		} else if (matchesKey(data, "tab")) {
			this.activateTab((this.tabIndex + 1) % this.tabs.length);
		} else if (matchesKey(data, "shift+tab")) {
			this.activateTab((this.tabIndex - 1 + this.tabs.length) % this.tabs.length);
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space") || data === " ") {
			this.toggleSelectedDetail();
		} else if (tab === "edit" && data === "a") {
			this.toggleAllEdits();
		} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.moveSelection(1);
		} else if (matchesKey(data, "pageUp")) {
			if (tab === "tree" || tab === "edit") this.moveSelection(-Math.max(1, this.pageViewportHeight() - 2));
			else this.scroll = Math.max(0, this.scroll - this.pageViewportHeight());
		} else if (matchesKey(data, "pageDown")) {
			if (tab === "tree" || tab === "edit") this.moveSelection(Math.max(1, this.pageViewportHeight() - 2));
			else this.scroll += this.pageViewportHeight();
		} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.jumpSelection(false);
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.jumpSelection(true);
		} else if (/^\d$/.test(data)) {
			const tabIndex = Number(data) - 1;
			if (tabIndex >= 0 && tabIndex < this.tabs.length) this.activateTab(tabIndex);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const frameWidth = Math.max(4, width);
		const innerWidth = Math.max(1, frameWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const page = this.pageLines(contentWidth);
		if (this.revealSelectedEdit && this.currentPage() === "edit") this.ensureEditSelectionVisible();
		this.revealSelectedEdit = false;
		const viewport = this.pageViewportHeight();
		const maxScroll = Math.max(0, page.length - viewport);
		if (this.currentPage() === "settings") this.scroll = this.settingsScroll(page.length, viewport);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = page.slice(this.scroll, this.scroll + viewport);
		while (visible.length < viewport) visible.push("");
		const detailPanel = this.currentPage() === "tree" ? this.treeDetailPanel(contentWidth) : [];

		const border = (value: string) => this.theme.fg("border", value);
		const row = (value: string) => {
			const clipped = truncateToWidth(value, innerWidth, "");
			return border("│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + border("│");
		};
		const title = truncateToWidth(` Live Context Viewer · r${this.model.revision} `, innerWidth, "");
		const titleWidth = visibleWidth(title);
		const left = Math.max(0, Math.floor((innerWidth - titleWidth) / 2));
		const right = Math.max(0, innerWidth - titleWidth - left);
		const tabs = this.tabs.map((tab, index) => {
			const label = `${index + 1}:${tab}`;
			return index === this.tabIndex
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", ` ${label} `);
		}).join(" ");
		const position = page.length > viewport ? `lines ${this.scroll + 1}-${Math.min(page.length, this.scroll + viewport)}/${page.length}` : "";

		return [
			border(`╭${"─".repeat(left)}`) + this.theme.fg("accent", this.theme.bold(title)) + border(`${"─".repeat(right)}╮`),
			row(` ${tabs}`),
			border(`├${"─".repeat(innerWidth)}┤`),
			...visible.map((line) => row(` ${line}`)),
			...detailPanel.map((line) => row(` ${line}`)),
			border(`├${"─".repeat(innerWidth)}┤`),
			row(` ${this.theme.fg("dim", `${this.helpText()}${position ? ` · ${position}` : ""}`)}`),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {
		// Laid-out edit rows hold styled strings; diff rows themselves are theme-independent.
		this.editLayouts.clear();
	}

	private activateTab(index: number): void {
		this.tabIndex = index;
		this.scroll = this.currentPage() === "tree" ? this.treeSelectionScroll() : 0;
		this.settingsScrolledFocus = undefined; // re-entering settings shows the selection with its description
	}

	private treeSelectionScroll(): number {
		const selectedLine = TREE_ROW_START_LINE + this.resolveTreeSelection();
		return Math.max(0, selectedLine - Math.floor(this.pageViewportHeight() * 0.65));
	}

	private ensureTreeSelectionVisible(): void {
		const selectedLine = TREE_ROW_START_LINE + this.resolveTreeSelection();
		if (selectedLine < this.scroll) this.scroll = selectedLine;
		if (selectedLine >= this.scroll + this.pageViewportHeight()) {
			this.scroll = Math.max(0, selectedLine - this.pageViewportHeight() + 1);
		}
	}

	/**
	 * ↓/↑ (and PageDown/PageUp) first scroll through the selected row's expanded diff when it
	 * extends past the viewport, then move to the next/previous row, so long diffs stay readable.
	 */
	private scrollWithinExpandedEdit(delta: number): boolean {
		if (!this.expandedEdits.has(this.editKey(this.editSelection))) return false;
		const start = this.editRowPhysicalStarts[this.editSelection];
		if (start === undefined) return false;
		const end = this.editRowPhysicalStarts[this.editSelection + 1] ?? this.editPagePhysicalLength;
		const viewport = this.pageViewportHeight();
		if (delta > 0 && end > this.scroll + viewport) {
			this.scroll += Math.min(delta, end - (this.scroll + viewport));
			return true;
		}
		if (delta < 0 && start < this.scroll) {
			this.scroll -= Math.min(-delta, this.scroll - start);
			return true;
		}
		return false;
	}

	private ensureEditSelectionVisible(): void {
		const viewport = this.pageViewportHeight();
		const selectedLine = this.editRowPhysicalStarts[this.editSelection] ?? 5 + this.editSelection;
		// Show as much of the selected row (header plus any expanded diff) as fits, header first.
		const rowEnd = this.editRowPhysicalStarts[this.editSelection + 1]
			?? (this.editPagePhysicalLength > selectedLine ? this.editPagePhysicalLength : selectedLine + 1);
		if (selectedLine < this.scroll) this.scroll = selectedLine;
		else if (rowEnd > this.scroll + viewport) this.scroll = Math.min(selectedLine, rowEnd - viewport);
	}

	private currentEditRevision(): LiveContextEditRevisionView | undefined {
		return this.model.editRevisions[this.resolveEditRevisionIndex()];
	}

	private editKey(index: number): string {
		return `${this.currentEditRevision()?.revision ?? 0}:${index}`;
	}

	private moveEditRevision(delta: number): void {
		if (this.model.editRevisions.length === 0) return;
		this.editRevisionIndex = Math.max(0, Math.min(this.model.editRevisions.length - 1, this.resolveEditRevisionIndex() + delta));
		this.editSelection = 0;
		this.scroll = 0;
	}

	private resolveTimelineSelection(): number {
		const now = this.model.timeline.markers.length;
		this.timelineSelection = Math.max(0, Math.min(now, this.timelineSelection ?? now));
		return this.timelineSelection;
	}

	private timelineAtNow(): boolean {
		return this.resolveTimelineSelection() === this.model.timeline.markers.length;
	}

	/** ← → step through compaction points; the last stop after the newest point is "now". */
	private moveTimelineSelection(delta: number): void {
		const now = this.model.timeline.markers.length;
		this.timelineSelection = Math.max(0, Math.min(now, this.resolveTimelineSelection() + delta));
	}

	private moveSelection(delta: number): void {
		if (this.currentPage() === "timeline" || (this.clmLayout && this.currentPage() === "overview")) {
			this.moveTimelineSelection(delta);
			return;
		}
		if (this.currentPage() === "edit") {
			// An explicit move wins over a pending reveal from the last Enter.
			this.revealSelectedEdit = false;
			if (this.scrollWithinExpandedEdit(delta)) return;
			const count = this.currentEditRevision()?.edits.length ?? 0;
			if (count > 0) this.editSelection = Math.max(0, Math.min(count - 1, this.editSelection + delta));
			this.ensureEditSelectionVisible();
			return;
		}
		if (this.currentPage() === "tree") {
			if (this.model.tree.length > 0) {
				this.treeSelection = Math.max(0, Math.min(this.model.tree.length - 1, this.resolveTreeSelection() + delta));
			}
			this.expandedTreeRowId = undefined;
			this.ensureTreeSelectionVisible();
			return;
		}
		this.scroll = Math.max(0, this.scroll + delta);
	}

	private jumpSelection(toEnd: boolean): void {
		if (this.currentPage() === "timeline" || (this.clmLayout && this.currentPage() === "overview")) {
			this.timelineSelection = toEnd ? this.model.timeline.markers.length : 0;
			return;
		}
		if (this.currentPage() === "tree") {
			this.treeSelection = toEnd ? Math.max(0, this.model.tree.length - 1) : 0;
			this.expandedTreeRowId = undefined;
			this.scroll = this.treeSelectionScroll();
			return;
		}
		if (this.currentPage() === "edit") {
			this.revealSelectedEdit = false;
			this.editSelection = toEnd ? Math.max(0, (this.currentEditRevision()?.edits.length ?? 1) - 1) : 0;
			// End means the end of the page (the bottom of the last row's diff), start the top.
			this.scroll = toEnd ? Number.MAX_SAFE_INTEGER : 0;
			return;
		}
		this.scroll = toEnd ? Number.MAX_SAFE_INTEGER : 0;
	}

	private toggleSelectedDetail(): void {
		if (this.currentPage() === "edit") {
			if (!this.currentEditRevision()?.edits[this.editSelection]) return;
			const key = this.editKey(this.editSelection);
			if (this.expandedEdits.has(key)) this.expandedEdits.delete(key);
			else {
				this.expandedEdits.add(key);
				this.revealSelectedEdit = true;
			}
			return;
		}
		if (this.currentPage() === "tree") {
			const row = this.model.tree[this.resolveTreeSelection()];
			if (!row) return;
			this.expandedTreeRowId = this.expandedTreeRowId === row.entryId ? undefined : row.entryId;
			this.ensureTreeSelectionVisible();
		}
	}

	private toggleAllEdits(): void {
		const revision = this.currentEditRevision();
		if (!revision) return;
		const keys = revision.edits.map((_edit, index) => this.editKey(index));
		const collapse = keys.length > 0 && keys.every((key) => this.expandedEdits.has(key));
		for (const key of keys) {
			if (collapse) this.expandedEdits.delete(key);
			else this.expandedEdits.add(key);
		}
	}

	private helpText(): string {
		const tabKeys = `1–${this.tabs.length} or Tab`;
		if (this.currentPage() === "timeline") {
			return `← → select · z zoom: ${TIMELINE_ZOOM_LABELS[this.effectiveTimelineZoom()]} · Enter open · Tab pages · q close`;
		}
		if (this.clmLayout && this.currentPage() === "overview") {
			return `← → select · z zoom: ${TIMELINE_ZOOM_LABELS[this.effectiveTimelineZoom()]} · Enter open · Tab pages · q close`;
		}
		if (this.currentPage() === "settings") {
			return `↑ ↓ select · Enter change · Tab pages · q close`;
		}
		if (this.currentPage() === "edit") {
			return `${tabKeys}: tabs · ← →: revisions · ↑ ↓: select · Enter: diff · a: diff all · q: close`;
		}
		if (this.currentPage() === "tree") {
			return `${tabKeys}: tabs · ↑ ↓: select · Enter or Space: details · q: close`;
		}
		return `${tabKeys}: tabs · ↑ ↓ or j k: scroll · g G: ends · q: close`;
	}

	private viewportHeight(): number {
		// Keep overlays compact. A near-full-height viewer is redrawn whenever the
		// underlying Pi stream updates and caused visible flicker in active sessions.
		return Math.max(8, Math.min(26, Math.floor(this.tui.terminal.rows * 0.62)));
	}

	private treeDetailPanelHeight(): number {
		return Math.min(TREE_DETAIL_PANEL_MAX_HEIGHT, Math.max(4, this.viewportHeight() - 4));
	}

	private pageViewportHeight(): number {
		return this.currentPage() === "tree"
			? this.viewportHeight() - this.treeDetailPanelHeight()
			: this.viewportHeight();
	}

	private pageLines(width: number): string[] {
		const tab = this.currentPage();
		const logical = tab === "overview"
			? (this.clmLayout ? this.clmOverviewLines(width) : this.overviewLines(width))
			: tab === "input"
				? this.inputLines(width)
			: tab === "settings"
				? this.settingsLines(width)
			: tab === "edit"
				? this.editLines(width)
				: tab === "projection"
					? this.projectionLines()
					: tab === "tree"
						? this.treeLines(width)
						: tab === "history"
							? this.historyLines()
							: tab === "timeline"
								? this.timelineLines(width)
								: this.agentLines();
		// The edit page lays out (and caches) its own physical lines so row positions are exact.
		if (tab === "edit") return logical;
		return logical.flatMap((line) => line ? wrapTextWithAnsi(line, width) : [""]);
	}

	private currentTab(): LiveContextViewTab {
		return this.tabs[this.tabIndex] ?? "overview";
	}

	private currentPage(): ReturnType<typeof pageOf> {
		return pageOf(this.currentTab());
	}

	private overviewLines(width: number): string[] {
		const model = this.model;
		const status = !model.enabled ? "disabled" : model.revision === 0 ? "raw" : "projected";
		const barWidth = Math.max(10, Math.min(48, width - 18));
		const usedFraction = model.beforeEstimate > 0 ? model.afterEstimate / model.beforeEstimate : 1;
		const used = Math.max(0, Math.min(barWidth, Math.round(barWidth * usedFraction)));
		const bar = this.theme.fg("accent", "█".repeat(used)) + this.theme.fg("dim", "░".repeat(barWidth - used));
		const outcomeColor = model.lastOutcome?.kind === "rejected" ? "warning" : model.lastOutcome?.kind === "applied" ? "success" : "muted";
		return [
			this.theme.fg("accent", this.theme.bold(`Projection ${status}`)),
			"",
			`${bar} ${model.savingsPercent.toFixed(1)}% removed`,
			`${model.estimateUnit === "tokens" ? "Tokens      " : "Characters  "} ${formatCount(model.beforeEstimate)} raw → ${formatCount(model.afterEstimate)} effective`,
			`Saved        ${formatCount(model.savingsEstimate)} estimated ${model.estimateUnit}`,
			`Messages     ${model.rawMessageCount} raw → ${model.effectiveMessageCount} effective`,
			`Raw suffix   ${model.suffixMessageCount} message${model.suffixMessageCount === 1 ? "" : "s"} after checkpoint`,
			`Revision     ${model.revision}`,
			`Captured     ${formatTime(model.capturedAt ?? model.checkpointCreatedAt)}`,
			...(model.snapshotStale
				? [this.theme.fg("warning", "Newer raw messages were recorded after this snapshot; the next model call includes them.")]
				: []),
			"",
			model.lastOutcome
				? this.theme.fg(outcomeColor, `${model.lastOutcome.kind.toUpperCase()}: ${model.lastOutcome.message}`)
				: this.theme.fg("muted", "No projection edit has been recorded yet."),
			"",
			this.theme.fg("muted", "Pi's raw JSONL transcript remains append-only. This view describes only the model-visible projection."),
			...(model.mirrorPath ? [this.theme.fg("dim", `Mirror: ${model.mirrorPath}`)] : []),
		];
	}

	/** CLM overview: the context-size timeline and its compaction points. */
	private clmOverviewLines(width: number): string[] {
		const model = this.model;
		// Only say something above the chart when it is not the normal state; the title
		// already carries the revision and the list below carries every outcome.
		const notice = !model.enabled
			? this.theme.fg("warning", "Projection off: the model sees the raw transcript (/clm on).")
			: model.lastOutcome?.kind === "rejected"
				? this.theme.fg("warning", `Last edit rejected: ${model.lastOutcome.message}`)
				: undefined;
		const above = notice ? [notice, ""].flatMap((line) => line ? wrapTextWithAnsi(line, width) : [""]) : [];
		return [...above, ...this.timelineLines(width, above.length)];
	}

	/** CLM input page: savings bar, size/message counts, and the current effective context. */
	private inputLines(width: number): string[] {
		const model = this.model;
		const barWidth = Math.max(10, Math.min(48, width - 18));
		const usedFraction = model.beforeEstimate > 0 ? model.afterEstimate / model.beforeEstimate : 1;
		const used = Math.max(0, Math.min(barWidth, Math.round(barWidth * usedFraction)));
		const bar = this.theme.fg("accent", "█".repeat(used)) + this.theme.fg("dim", "░".repeat(barWidth - used));
		const projection = model.messages.length === 0
			? [this.theme.fg("muted", "No model-visible context snapshot has been captured yet.")]
			: model.messages.map((message) =>
				`${this.theme.fg("dim", `#${message.index}`)} ${this.theme.fg("accent", message.role)} ${this.theme.fg("muted", `${formatCount(message.tokens)} tok`)} · ${message.preview}`);
		return [
			this.theme.fg("accent", this.theme.bold("Current input")) + this.theme.fg("muted", " · what the next model request will contain"),
			"",
			`${bar} ${model.savingsPercent.toFixed(1)}% removed`,
			`${model.estimateUnit === "tokens" ? "Tokens      " : "Characters  "} ${formatCount(model.beforeEstimate)} raw → ${formatCount(model.afterEstimate)} effective`,
			`Messages     ${model.rawMessageCount} raw → ${model.effectiveMessageCount} effective · ${model.suffixMessageCount} after the last edit`,
			`Captured     ${formatTime(model.capturedAt ?? model.checkpointCreatedAt)}`,
			...(model.snapshotStale ? [this.theme.fg("warning", "Newer raw messages exist; the next model call includes them.")] : []),
			"",
			...projection,
			...(model.mirrorPath ? ["", this.theme.fg("dim", `Mirror: ${model.mirrorPath}`)] : []),
		];
	}

	private diffStyle(): DiffStyle {
		const theme = this.theme;
		return {
			context: (text) => theme.fg("toolDiffContext", text),
			removed: (text) => theme.fg("toolDiffRemoved", text),
			added: (text) => theme.fg("toolDiffAdded", text),
			emphasis: (text) => typeof theme.inverse === "function" ? theme.inverse(text) : text,
			lineNumber: (text) => theme.fg("dim", text),
			muted: (text) => theme.fg("muted", text),
			title: (text) => theme.fg("accent", text),
		};
	}

	private editDiffRows(key: string, edit: LiveContextEditView): SideBySideRow[] {
		let rows = this.editDiffs.get(key);
		if (!rows) {
			const before = edit.kind === "added" ? "" : edit.beforeText ?? edit.beforeDetail ?? "";
			const after = edit.kind === "removed" ? "" : edit.afterText ?? edit.afterDetail ?? "";
			// One-sided blocks show a shorter preview so "expand all" on a big revision stays cheap.
			const maxRows = edit.kind === "removed" || edit.kind === "added" ? ONE_SIDED_DIFF_MAX_ROWS : EDITED_DIFF_MAX_ROWS;
			rows = limitRows(sideBySideRows(diffLines(before, after)), maxRows);
			this.editDiffs.set(key, rows);
		}
		return rows;
	}

	private cachedLayout(key: string, build: () => string[]): string[] {
		let lines = this.editLayouts.get(key);
		if (!lines) {
			lines = build();
			this.editLayouts.set(key, lines);
		}
		return lines;
	}

	/** Physical lines of an expanded row: one column for kept/restored, a diff otherwise. */
	private editBodyLines(key: string, edit: LiveContextEditView, width: number): string[] {
		return this.cachedLayout(`body:${key}@${width}`, () => {
			const wrap = (line: string) => line ? wrapTextWithAnsi(line, width) : [""];
			if (edit.kind === "kept" || edit.kind === "restored") {
				// Identical on both sides: one column.
				if (edit.beforeDetail === undefined) return [];
				const label = `${edit.kind === "kept" ? "content" : "restored original"} · ${formatCount(edit.beforeTokens ?? 0)} tok`;
				return [
					`    ${this.theme.fg(edit.kind === "kept" ? "muted" : "warning", label)}`,
					...edit.beforeDetail.split(/\r?\n/).map((detail) => `      ${this.theme.fg("dim", detail || " ")}`),
				].flatMap(wrap);
			}
			return this.layoutEditDiff(key, edit, width).flatMap((line) => visibleWidth(line) <= width ? [line] : wrap(line));
		});
	}

	private layoutEditDiff(key: string, edit: LiveContextEditView, width: number): string[] {
		const indent = "    ";
		const available = Math.max(1, width - indent.length);
		const rows = this.editDiffRows(key, edit);
		if (rows.length === 0) {
			const note = edit.beforeRole !== edit.afterRole
				? `no text change · role ${edit.beforeRole ?? "?"} → ${edit.afterRole ?? "?"}`
				: "no text change (full text compared; message structure only)";
			return [`${indent}${this.theme.fg("muted", note)}`];
		}
		const describe = (label: string, index: number | undefined, role: string | undefined, tokens: number | undefined) =>
			index === undefined && tokens === undefined
				? `${label} · —`
				: `${label}${index === undefined ? "" : ` · #${index}`}${role ? ` ${role}` : ""} · ${formatCount(tokens ?? 0)} tok`;
		const options = {
			leftTitle: describe("before", edit.sourceIndex, edit.beforeRole, edit.beforeTokens),
			rightTitle: describe("after", edit.outputIndex, edit.afterRole, edit.afterTokens),
			leftPlaceholder: "(new block)",
			rightPlaceholder: "(removed from the next request)",
		};
		const rendered = available >= MIN_SIDE_BY_SIDE_WIDTH
			? renderSideBySide(rows, available, this.diffStyle(), options)
			: renderUnified(rows, available, this.diffStyle(), options);
		return rendered.map((line) => `${indent}${line}`);
	}

	private editLines(width: number): string[] {
		if (this.model.editRevisions.length === 0) {
			this.editRowPhysicalStarts = [];
			return [
				this.theme.fg("muted", "No accepted live-context compression is available on this branch."),
				this.theme.fg("dim", "Open the viewer after an accepted mirror edit so its checkpoint can be validated."),
			].flatMap((line) => wrapTextWithAnsi(line, width));
		}
		const revision = this.currentEditRevision()!;
		const revisionTabs = this.model.editRevisions.map((item, index) => {
			const label = `r${item.revision}`;
			return index === this.resolveEditRevisionIndex()
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", ` ${label} `);
		}).join(" ");
		const sourceLabel = revision.traceSource === "recorded"
			? "exact recorded provenance"
			: revision.traceSource === "reconstructed"
				? "reconstructed legacy provenance"
				: "provenance unavailable (raw source could not be validated)";
		const size = revision.beforeTokens === undefined
			? `?→${formatCount(revision.afterTokens ?? 0)} tokens`
			: `${formatCount(revision.beforeTokens)}→${formatCount(revision.afterTokens ?? 0)} tokens`;
		const header = [
			this.theme.fg("accent", this.theme.bold("Live-context compression runs")),
			`Runs  ← ${revisionTabs} →   ${this.resolveEditRevisionIndex() + 1}/${this.model.editRevisions.length}`,
			this.theme.fg("muted", `r${revision.revision} from r${revision.sourceRevision} · ${size} · ${sourceLabel}`),
			this.theme.fg("dim", "= kept · ~ rewritten · − removed · + added · ↺ restored · Enter: side-by-side diff · a: all"),
			"",
		];
		if (width !== this.editLayoutWidth) {
			// Layouts are per width; drop the old ones on resize instead of accumulating them.
			this.editLayouts.clear();
			this.editLayoutWidth = width;
		}
		const wrap = (line: string) => line ? wrapTextWithAnsi(line, width) : [""];
		const lines = header.flatMap(wrap);
		this.editRowPhysicalStarts = [];
		if (revision.edits.length === 0) {
			lines.push(...wrap(this.theme.fg("warning", "This revision is persisted, but its per-message provenance is unavailable.")));
			this.editPagePhysicalLength = lines.length;
			return lines;
		}
		for (const [index, edit] of revision.edits.entries()) {
			this.editRowPhysicalStarts.push(lines.length);
			const key = this.editKey(index);
			const selected = index === this.editSelection;
			const expanded = this.expandedEdits.has(key);
			for (const line of this.editRowHeader(key, edit, selected, expanded, width)) lines.push(line);
			if (!expanded) continue;
			for (const line of this.editBodyLines(key, edit, width)) lines.push(line);
		}
		this.editPagePhysicalLength = lines.length;
		return lines;
	}

	private editRowHeader(key: string, edit: LiveContextEditView, selected: boolean, expanded: boolean, width: number): string[] {
		return this.cachedLayout(`head:${key}@${width}:${selected ? 1 : 0}${expanded ? 1 : 0}`, () => {
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const fold = expanded ? "▾" : "▸";
			const source = edit.sourceIndex === undefined ? "" : `#${edit.sourceIndex}`;
			const destination = edit.outputIndex === undefined ? "" : `→#${edit.outputIndex}`;
			const role = edit.beforeRole ?? edit.afterRole ?? "message";
			const size = edit.beforeTokens === undefined
				? `${formatCount(edit.afterTokens ?? 0)} tok`
				: edit.afterTokens === undefined
					? `${formatCount(edit.beforeTokens)} tok`
					: `${formatCount(edit.beforeTokens)}→${formatCount(edit.afterTokens)} tok`;
			const glyph = edit.kind === "kept"
				? "="
				: edit.kind === "removed"
					? "−"
					: edit.kind === "added"
						? "+"
						: edit.kind === "restored" ? "↺" : "~";
			const color = edit.kind === "removed"
				? "error"
				: edit.kind === "added"
					? "success"
					: edit.kind === "restored" ? "warning" : edit.kind === "kept" ? "muted" : "accent";
			return wrapTextWithAnsi(`${marker} ${fold} ${this.theme.fg(color, `${glyph} ${source}${destination ? ` ${destination}` : ""} ${role} · ${edit.kind} · ${size}`)}`, width);
		});
	}

	private projectionLines(): string[] {
		if (this.model.messages.length === 0) {
			return [this.theme.fg("muted", "No model-visible context snapshot has been captured yet.")];
		}
		return [
			this.theme.fg("accent", this.theme.bold("Current effective messages")),
			this.theme.fg("muted", "Protected labels are recomputed for this effective view; checkpoint source protection remains enforced separately."),
			"",
			...this.model.messages.map((message) => {
				const marker = message.protected ? this.theme.fg("warning", " protected") : "";
				return `${this.theme.fg("dim", `#${message.index}`)} ${this.theme.fg("accent", message.role)}${marker} ${this.theme.fg("muted", `${formatCount(message.tokens)} tokens`)} · ${message.preview}`;
			}),
		];
	}

	private treeDetailLines(row: LiveContextTreeRow): string[] {
		const items = [`Status: ${row.status}`, ...row.details];
		return items.flatMap((detail, index) => {
			const last = index === items.length - 1;
			const parts = detail.split(/\r?\n/);
			return parts.map((part, partIndex) => {
				const connector = partIndex === 0 ? (last ? "└─" : "├─") : (last ? "  " : "│ ");
				return this.theme.fg("dim", `${connector} ${part || " "}`);
			});
		});
	}

	private treeDetailPanel(width: number): string[] {
		const row = this.model.tree[this.resolveTreeSelection()];
		const expanded = Boolean(row && this.expandedTreeRowId === row.entryId);
		const title = row
			? `Details · ${row.text}${expanded ? "" : " · collapsed"}`
			: "Details";
		const lines = [
			this.theme.fg("accent", truncateToWidth(title, width, "…")),
			...(expanded && row
				? this.treeDetailLines(row)
				: [this.theme.fg("dim", "Press Enter or Space to show the selected row's details.")]),
		].map((line) => truncateToWidth(line, width, "…"));
		const height = this.treeDetailPanelHeight();
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	private treeLines(width: number): string[] {
		if (this.model.tree.length === 0) {
			return [this.theme.fg("muted", "The Pi conversation tree is unavailable in this mode.")];
		}
		const singleLine = (value: string) => truncateToWidth(value, width, "…");
		const lines = [
			singleLine(this.theme.fg("accent", this.theme.bold("Conversation tree"))),
			singleLine(this.theme.fg("dim", "● active · ← raw head · ◆ live-context state · ◇ inherited · ✓ effective · ~ changed · − omitted · N/M: turn messages still in model context")),
			singleLine(this.theme.fg("muted", `${this.model.treeHiddenEntryCount} assistant/tool/bookkeeping entries folded · Enter expands the selected row`)),
			"",
		];
		for (const [index, row] of this.model.tree.entries()) {
			const selected = index === this.resolveTreeSelection();
			const expanded = this.expandedTreeRowId === row.entryId;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const fold = expanded ? "▾" : "▸";
			const active = row.active ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
			const head = row.head ? this.theme.fg("accent", "←") : " ";
			const state = row.kind === "live-context"
				? this.theme.fg("warning", row.status === "inherited checkpoint" ? "◇" : "◆")
				: " ";
			const statusGlyph = row.kind !== "turn"
				? ""
				: row.status === "all effective"
					? "✓ "
					: row.status === "omitted"
						? "− "
						: row.status === "inactive" || row.status === "raw turn" ? "" : "~ ";
			const color = selected
				? "accent"
				: row.kind === "live-context"
					? "warning"
					: row.kind === "summary"
						? "accent"
						: row.active ? "text" : "muted";
			const badge = this.theme.fg("muted", `[${statusGlyph}${row.status}]`);
			lines.push(singleLine(`${marker}${fold} ${active}${head}${state} ${this.theme.fg("dim", row.prefix)}${this.theme.fg(color, row.text)} ${badge}`));
		}
		lines.push(
			"",
			singleLine(this.theme.fg("warning", "⚠ Branch summaries still use abandoned raw context; choose “No summary” for now.")),
		);
		return lines;
	}

	private historyLines(): string[] {
		if (this.model.history.length === 0) {
			return [this.theme.fg("muted", "No persisted live-context events on this branch.")];
		}
		return [
			this.theme.fg("accent", this.theme.bold("Branch-local revision history · token-normalized")),
			this.theme.fg("muted", "Legacy checkpoint sizes are recomputed from historical messages; character counts are never relabeled as tokens."),
			"",
			...this.model.history.flatMap((event) => {
				const color = event.event === "rejected" ? "warning" : event.event === "applied" ? "success" : "muted";
				const size = event.beforeEstimate !== undefined && event.afterEstimate !== undefined
					? ` · ${formatCount(event.beforeEstimate)}→${formatCount(event.afterEstimate)} tok`
					: event.afterEstimate !== undefined
						? ` · ?→${formatCount(event.afterEstimate)} tok`
						: "";
				const source = event.estimateSource === "recomputed" ? " · recomputed" : "";
				return [
					this.theme.fg(color, `${eventGlyph(event.event)} r${event.revision} ${event.event}${size}${source}`),
					`  ${event.message}${event.at ? ` · ${formatTime(event.at)}` : ""}`,
					...(event.estimateNote ? [`  ${this.theme.fg("dim", event.estimateNote)}`] : []),
				];
			}),
		];
	}

	/**
	 * Switch to the edit tab positioned on the revision the selected marker produced; at
	 * "now", open the page showing what the next request contains.
	 */
	private openSelectedTimelineMarker(): void {
		if (this.timelineAtNow()) {
			const inputIndex = this.tabs.findIndex((tab) => pageOf(tab) === "input" || pageOf(tab) === "projection");
			if (inputIndex >= 0) this.activateTab(inputIndex);
			return;
		}
		const marker = this.model.timeline.markers[this.resolveTimelineSelection()];
		if (!marker || marker.kind !== "applied") return;
		const editIndex = this.tabs.findIndex((tab) => pageOf(tab) === "edit");
		const revisionIndex = this.model.editRevisions.findIndex((revision) => revision.revision === marker.revision);
		if (editIndex < 0 || revisionIndex < 0) return;
		this.editRevisionIndex = revisionIndex;
		this.editSelection = 0;
		this.activateTab(editIndex);
	}

	/**
	 * Settings page keys: an open text prompt gets everything; otherwise ↑ ↓ Enter Space go
	 * to the list and the rest (Tab, digits, q, Esc) stay panel keys. Returns true if handled.
	 */
	private handleSettingsInput(data: string): boolean {
		const list = this.ensureSettingsList();
		if (!list) return false;
		if (this.settingsSubmenuOpen) {
			list.handleInput(data);
			return true;
		}
		const toList = matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "return") || data === " ";
		const vimKey = data === "k" ? "\u001b[A" : data === "j" ? "\u001b[B" : undefined;
		if (!toList && !vimKey) return false;
		this.settingsMessage = undefined;
		list.handleInput(vimKey ?? data);
		return true;
	}

	private settingsListTheme(): SettingsListTheme {
		return {
			label: (text, selected) => (selected ? this.theme.fg("accent", text) : text),
			value: (text, selected) => (selected ? this.theme.bold(this.theme.fg("accent", text)) : this.theme.fg("muted", text)),
			description: (text) => this.theme.fg("dim", text),
			cursor: this.theme.fg("accent", "› "),
			hint: (text) => this.theme.fg("dim", text),
		};
	}

	/**
	 * Built on first use and rebuilt after each change, so values, markers and choices stay
	 * live, and when `rows` (how many settings fit) changes. A rebuild keeps the selection.
	 */
	private ensureSettingsList(selectId?: string, rows?: number): SettingsList | undefined {
		if (!this.settings) return undefined;
		const refit = rows !== undefined && rows !== this.settingsListRows && !this.settingsSubmenuOpen;
		if (this.settingsList && selectId === undefined && !refit) return this.settingsList;
		const keep = selectId ?? (this.settingsList ? this.selectedSettingId(this.settingsList) : undefined);
		const items: SettingItem[] = this.settings.items().map((item) => ({
			id: item.id,
			label: item.label,
			currentValue: item.value,
			...(item.description ? { description: item.description } : {}),
			...(item.choices ? { values: item.choices } : {}),
			...(!item.choices && item.placeholder
				? { submenu: (current: string, done: (value?: string) => void) => this.settingsPrompt(item, current, done) }
				: {}),
		}));
		if (rows !== undefined) this.settingsListRows = rows;
		this.settingsList = new SettingsList(
			items,
			Math.max(1, Math.min(items.length, this.settingsListRows || items.length)),
			this.settingsListTheme(),
			(id, value) => this.changeSetting(id, value),
			() => this.done(),
		);
		if (keep) this.settingsList.selectItem(keep);
		return this.settingsList;
	}

	/** The selected setting's id, read from the list's rendering (the list keeps its index private). */
	private selectedSettingId(list: SettingsList): string | undefined {
		const cursor = this.settingsListTheme().cursor;
		const row = list.render(1_000).find((line) => line.startsWith(cursor));
		if (!row) return undefined;
		const text = stripTerminalSequences(row.slice(cursor.length));
		// Longest label first, so "Budget •" is not mistaken for "Budget".
		return [...(this.settings?.items() ?? [])]
			.sort((left, right) => right.label.length - left.label.length)
			.find((item) => text.startsWith(item.label))?.id;
	}

	/**
	 * How many settings fit on screen with everything else on the page, all measured as
	 * wrapped at `width`: `used` lines above and below the list, plus what the list adds under
	 * its rows (its position, the longest description, the key hint). At least three rows so
	 * the selection keeps its neighbours; below that the page scrolls (see `settingsScroll`).
	 */
	private fitSettingsRows(width: number, used: number): number {
		const items = this.settings?.items() ?? [];
		const description = Math.max(0, ...items.map((item) => (item.description ? wrapTextWithAnsi(item.description, Math.max(1, width - 4)).length : 0)));
		const below = (description > 0 ? 1 + description : 0) + 2; // blank + description, blank + hint
		const space = this.pageViewportHeight() - used - below;
		if (items.length <= space) return items.length;
		return Math.max(Math.min(3, items.length), space - 1); // the list adds a "(n/N)" line when it scrolls
	}

	/**
	 * Settings page scroll. When the page is taller than the viewport, show its bottom (the
	 * list, the selected setting's description, any message) whenever the selection moves;
	 * PageUp/PageDown can bring the summary back, but the selected setting never leaves the screen.
	 */
	private settingsScroll(pageLength: number, viewport: number): number {
		const focus = this.settingsFocusLine;
		const moved = focus !== this.settingsScrolledFocus;
		this.settingsScrolledFocus = focus;
		const wanted = moved ? pageLength - viewport : this.scroll;
		return Math.max(0, Math.max(focus - viewport + 1, Math.min(focus, wanted)));
	}

	private changeSetting(id: string, value: string): void {
		const error = this.settings?.apply(id, value);
		const item = this.settings?.items().find((candidate) => candidate.id === id);
		this.settingsMessage = error
			? { text: error, warning: true }
			: { text: `${item?.label.replace(/ •$/, "") ?? id}: ${item?.value ?? value}`, warning: false };
		// Rebuild after the list finishes its own update (it assigns currentValue after onChange),
		// so a rejected change shows the value actually in effect.
		queueMicrotask(() => {
			this.ensureSettingsList(id);
			this.tui.requestRender();
		});
	}

	/** Text prompt for settings without fixed choices (budget, reserve). */
	private settingsPrompt(item: ViewerSettingItem, current: string, done: (value?: string) => void): Component {
		this.settingsSubmenuOpen = true;
		const input = new Input({ placeholder: item.placeholder });
		// Start from the current number with the cursor at the end, ready to edit or replace.
		const initial = /^\d/.test(current) ? current.replace(/ .*$/, "") : "";
		for (const character of initial) input.handleInput(character);
		const finish = (value?: string) => {
			this.settingsSubmenuOpen = false;
			done(value === undefined || value.trim() === "" ? undefined : value.trim());
		};
		input.onSubmit = (value) => finish(value);
		input.onEscape = () => finish(undefined);
		input.focused = true;
		return {
			render: (width: number) => [
				this.theme.fg("accent", item.label.replace(/ •$/, "")) + this.theme.fg("muted", ` · currently ${current}`),
				...input.render(width),
				this.theme.fg("dim", `Enter to apply · Esc to cancel${item.placeholder ? ` · e.g. ${item.placeholder}` : ""}`),
			],
			invalidate: () => input.invalidate(),
			handleInput: (data: string) => input.handleInput(data),
		};
	}

	private settingsLines(width: number): string[] {
		if (!this.settings) return [this.theme.fg("muted", "Settings are not available here.")];
		// Wrapped here, so line counts are what the screen shows.
		const wrap = (line: string) => (line ? wrapTextWithAnsi(line, width) : [""]);
		const header = [
			this.theme.fg("accent", this.theme.bold("Settings")) + this.theme.fg("muted", " · changes apply now and are saved in this session"),
			...this.settings.summary().map((line) => this.theme.fg("dim", line)),
			"",
		].flatMap(wrap);
		const message = this.settingsMessage
			? wrap(this.theme.fg(
				this.settingsMessage.warning ? "warning" : "success",
				`${this.settingsMessage.warning ? "⚠" : "✓"} ${this.settingsMessage.text}`,
			))
			: [];
		const list = this.ensureSettingsList(undefined, this.fitSettingsRows(width, header.length + message.length))!;
		const body = list.render(width);
		const cursor = this.settingsListTheme().cursor;
		// The prompt's input is its second line; otherwise the row with the cursor.
		this.settingsFocusLine = header.length + (this.settingsSubmenuOpen ? 1 : Math.max(0, body.findIndex((line) => line.startsWith(cursor))));
		return [...header, ...body, ...message];
	}

	/** The chosen zoom, or the default when it is not offered at this width. */
	private effectiveTimelineZoom(): TimelineZoom {
		const zooms = availableTimelineZooms(this.model.timeline, this.timelineWidth);
		return zooms.includes(this.timelineZoom) ? this.timelineZoom : zooms[0]!;
	}

	private timelineLines(width: number, reservedAbove = 0): string[] {
		const timeline = this.model.timeline;
		this.timelineWidth = width;
		const zoom = this.effectiveTimelineZoom();
		// Compact: the chart is a sparkline-style overview, the list below carries the detail.
		const chartHeight = Math.max(4, Math.min(6, this.pageViewportHeight() - 8));
		const selection = this.resolveTimelineSelection();
		const atNow = selection === timeline.markers.length;
		const newestPoint = timeline.points.length - 1;
		const focusPoint = atNow ? Math.max(0, newestPoint) : timeline.markers[selection]?.afterPoint;
		const chartOptions = { width, zoom, focusPoint };
		const chart = renderTimelineChart(timeline, {
			...chartOptions,
			height: chartHeight,
			budget: this.model.budget,
			selectedMarker: atNow ? undefined : selection,
			selectedPoint: atNow && newestPoint >= 0 ? newestPoint : undefined,
			style: {
				// Grey context, blue edits, white selection; yellow is reserved for the budget.
				// Theme names (not raw ANSI) so light and custom themes keep working; mdLink is
				// the one blue that is consistent across Pi's built-in themes.
				bar: (text) => this.theme.fg("muted", text),
				editBar: (text) => this.theme.fg(EDIT_COLOR, text),
				marker: (text) => this.theme.fg(EDIT_COLOR, text),
				budget: (text) => this.theme.fg("warning", text),
				axis: (text) => this.theme.fg("dim", text),
				selected: (text) => this.theme.bold(this.theme.fg("text", text)),
				selectedMarker: (text) => this.theme.bold(this.theme.fg(EDIT_COLOR, text)),
				landmark: (text) => this.theme.fg("dim", text),
			},
		});
		const latest = timeline.points.at(-1);
		const summary = [
			`${timeline.points.length} requests`,
			latest ? `now ${formatCount(latest.tokens)}` : undefined,
			latest ? `peak ${formatCount(timeline.peakTokens)}` : undefined,
			this.model.budget !== undefined ? `budget ${formatCount(this.model.budget)}` : undefined,
			timeline.flops && timeline.flops.flops !== null
				? `${formatFlops(timeline.flops.flops)} prefix-reuse`
				: undefined,
		].filter(Boolean).join(" · ");
		// Physical lines throughout, so the list budget below is exact.
		const wrap = (line: string) => line ? wrapTextWithAnsi(line, width) : [""];
		const head = [
			// One title for every zoom; the x label and the help bar say how columns map.
			this.theme.fg("accent", this.theme.bold("Context size")) + this.theme.fg("muted", ` · ${summary}`),
			...chart,
			"",
		].flatMap(wrap);
		// Rows are collapsed (▸); the selected row expands (▾) with its details, like the edits page.
		// Details wrap under their own indent rather than back to the left edge.
		const details = () => this.timelineRowDetails(chartOptions, atNow ? undefined : timeline.markers[selection], focusPoint)
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 6)))
			.map((line) => this.theme.fg("dim", `      ${line}`));
		const groups: string[][] = timeline.markers.map((marker, index) => {
			const selected = index === selection;
			const color = marker.kind === "applied" ? EDIT_COLOR : marker.kind === "rejected" ? "warning" : "muted";
			const row = `${selected ? "› ▾" : "  ▸"} ${formatMarkerCompact(marker)}`;
			return [...wrap(selected ? this.theme.bold(this.theme.fg(color, row)) : this.theme.fg(color, row)), ...(selected ? details() : [])];
		});
		const nowTime = formatClockTime(latest?.at) ?? "--:--";
		// Same columns as the marker rows: label, clock time, size under the "before" column.
		const nowRow = `${atNow ? "› ▾" : "  ▸"} now ${nowTime}  ${latest ? formatTokenCount(latest.tokens).padStart(5) : "no completed requests yet"}`;
		groups.push([...wrap(atNow ? this.theme.bold(this.theme.fg("text", nowRow)) : this.theme.fg("muted", nowRow)), ...(atNow ? details() : [])]);
		// The chart stays put; the list shows a window around the selected row so the
		// selection and its details are always on screen, however many edits there are.
		const budget = this.pageViewportHeight() - reservedAbove - head.length;
		const more = (count: number, where: "earlier" | "later") => this.theme.fg("dim", `    ⋯ ${count} ${where}`);
		return [...head, ...windowAroundSelection(groups, selection, budget, more)];
	}

	/**
	 * Details of the selected list row: where an edit happened and what it changed, what the
	 * highlighted chart column covers in fit/turns zoom, and what Enter opens.
	 */
	private timelineRowDetails(
		chartOptions: { width: number; zoom: TimelineZoom; focusPoint: number | undefined },
		marker: TimelineMarker | undefined,
		focusPoint: number | undefined,
	): string[] {
		const timeline = this.model.timeline;
		const layout = timeline.points.length > 0 ? layoutTimeline(timeline, chartOptions) : undefined;
		const bucket = layout?.buckets[bucketIndexOf(layout, focusPoint)];
		const bucketed = chartOptions.zoom !== "requests" && bucket !== undefined && bucket.first !== bucket.last;
		// A bucketed column only adds its time period (and how many edits share it); sizes are
		// on the chart and in the row.
		const shared = bucketed && bucket.edits.length > 1 ? `${bucket.edits.length} edits in this column` : undefined;
		const period = bucketed ? formatBucketSpan(timeline, bucket) : undefined;
		const span = [period, shared].filter(Boolean).join(" · ") || undefined;
		const lines: string[] = [];
		if (marker) {
			const parts = [
				marker.afterPoint >= 0
					? `after request ${timeline.points[marker.afterPoint]?.request ?? marker.afterPoint + 1}`
					: "before the first request",
			];
			const revision = marker.kind === "applied"
				? this.model.editRevisions.find((candidate) => candidate.revision === marker.revision)
				: undefined;
			if (revision) {
				const counts = new Map<string, number>();
				for (const edit of revision.edits) counts.set(edit.kind, (counts.get(edit.kind) ?? 0) + 1);
				parts.push(...["edited", "normalized", "removed", "restored", "added", "kept"]
					.filter((kind) => counts.has(kind))
					.map((kind) => `${counts.get(kind)} ${kind}`));
			}
			lines.push(parts.join(" · "));
			if (span) lines.push(span);
			if (revision) lines.push("Enter: before/after in edits");
		} else {
			if (span) lines.push(span);
			lines.push("Enter: current input");
		}
		return lines;
	}

	private agentLines(): string[] {
		const runtime = this.model.runtime;
		return [
			this.theme.fg("accent", this.theme.bold("Current agent runtime")),
			"",
			`Role          ${runtime.kind}`,
			`Mode          ${runtime.mode}`,
			`Session       ${runtime.sessionId}`,
			`Revision      ${this.model.revision}`,
			`Projection    ${this.model.enabled ? "enabled" : "disabled"}`,
			`Messages      ${this.model.rawMessageCount} raw → ${this.model.effectiveMessageCount} effective`,
			...(runtime.teammateName ? [`Teammate      ${runtime.teammateName}`] : []),
			...(runtime.parentSessionId ? [`Parent        ${runtime.parentSessionId}`] : []),
			...(runtime.sessionFile ? [`Transcript    ${runtime.sessionFile}`] : []),
			"",
			this.theme.fg("dim", "Team role detection is best-effort from the current team-mode environment contract."),
		];
	}
}

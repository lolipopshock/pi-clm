/**
 * Overflow guard: keep the next request under the budget when the model has not.
 *
 * Reminders arrive at request boundaries, but one assistant turn with many parallel tool
 * calls can add tens of thousands of tokens at once. When the estimated request exceeds
 * the guard limit, tool results are *withheld* from the effective context, oldest first —
 * each replaced by a short note giving the tool, call id, size, and a file holding the
 * full text — until the estimate fits or nothing withholdable is left.
 *
 * Properties:
 * - transcript-only: raw history is untouched and no tool is ever re-executed;
 * - oldest first, tool results only; user, assistant and note blocks are never touched.
 *   Oldest first matters: the result the model just asked for (often a re-read of a
 *   withheld file) must stay visible, otherwise withholding turns into a loop;
 * - deterministic and cached per source message, so repeated context calls agree;
 * - the withheld note is an ordinary block in the mirror: the model can shorten, delete,
 *   or replace it, and can re-read the saved file with offset/limit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveContextMessage } from "./types.ts";

export interface OverflowGuardPolicy {
	mode: "withhold" | "off";
}

export const DEFAULT_OVERFLOW_GUARD: OverflowGuardPolicy = { mode: "withhold" };

export function overflowGuardFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<OverflowGuardPolicy> {
	const raw = env.PI_CLM_OVERFLOW?.trim();
	if (!raw) return {};
	if (raw === "off" || raw === "withhold") return { mode: raw };
	throw new Error(`PI_CLM_OVERFLOW must be "withhold" or "off", got ${raw}`);
}

export function resolveOverflowGuard(overrides: Partial<OverflowGuardPolicy> | undefined): OverflowGuardPolicy {
	return { ...DEFAULT_OVERFLOW_GUARD, ...(overrides ?? {}) };
}

/**
 * The limit the guard enforces. Two ceilings apply: the configured budget minus the
 * generation reserve, and — when the model window is known — the window minus Pi's own
 * 4,096-token safety margin minus the reserve, because Pi clamps `max_tokens` to
 * `window − estimate − 4096` and a request past that point gets a 1-token answer.
 */
export function overflowGuardLimit(budget: number, reserve: number, contextWindow: number | undefined): number {
	const fromBudget = budget - reserve;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return fromBudget;
	return Math.min(fromBudget, contextWindow - 4096 - reserve);
}

export interface WithheldRecord {
	message: LiveContextMessage;
	toolCallId: string;
	toolName: string;
	/** Calibrated estimate; moves between requests as the calibration is re-fit. */
	tokens: number;
	/** Characters ÷ 4 of the withheld text: depends on the text alone, so it is safe to print in the note. */
	noteTokens: number;
	file?: string;
}

export interface OverflowGuardResult {
	messages: LiveContextMessage[];
	withheld: WithheldRecord[];
	/** Estimated tokens of the returned messages (same estimator as the caller). */
	estimated: number;
}

interface TextPart {
	type: "text";
	text: string;
}

function toolResultText(message: LiveContextMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextPart => Boolean(part) && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Short by design: notes accumulate, so each costs as little context as possible.
 *
 * The text must be the same on every request for the same withheld result. Notes replace
 * the oldest tool results, so a note that changes invalidates the provider's prefix cache
 * for everything after it. Print nothing here that depends on the calibration, the
 * request size, or the limit.
 */
export function withheldNoteText(record: Omit<WithheldRecord, "message">, _estimated: number, _limit: number): string {
	const where = record.file ? ` Full text: ${record.file}` : " Full text remains in the session history.";
	return `[pi-clm overflow guard] ${record.toolName}#${record.toolCallId} (~${record.noteTokens.toLocaleString("en-US")} tok) withheld over budget.${where}`;
}

const withheldCache = new WeakMap<LiveContextMessage, LiveContextMessage>();
const savedFiles = new WeakMap<LiveContextMessage, string>();

export interface ApplyOverflowGuardOptions {
	limit: number;
	/** Estimated tokens of everything outside `messages` (system prompt, notices). */
	fixedTokens: number;
	estimate: (messages: LiveContextMessage[]) => number;
	/** Directory for saved outputs; omitted → nothing is written, notes point at history only. */
	saveDirectory?: string;
	/** Only messages at or after this index are candidates (the raw suffix after the last accepted edit); default 0. */
	protectBefore?: number;
}

/**
 * Withhold tool results, oldest first, until `fixedTokens + estimate(messages) <= limit`.
 * Returns the same array when nothing needed to change.
 */
export function applyOverflowGuard(messages: LiveContextMessage[], options: ApplyOverflowGuardOptions): OverflowGuardResult {
	let current = messages;
	let estimated = options.fixedTokens + options.estimate(current);
	const withheld: WithheldRecord[] = [];
	if (estimated <= options.limit) return { messages, withheld, estimated };

	const candidates: number[] = [];
	for (let index = options.protectBefore ?? 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "toolResult") continue;
		if (withheldCache.get(message) === message) continue; // already a note
		const text = toolResultText(message);
		if (text.startsWith("[pi-clm overflow guard]")) continue;
		candidates.push(index);
	}
	if (candidates.length === 0) return { messages, withheld, estimated };

	const output = [...messages];
	for (const index of candidates) {
		const source = output[index]!;
		const tokens = options.estimate([source]);
		let file = savedFiles.get(source);
		if (!file && options.saveDirectory) {
			try {
				mkdirSync(options.saveDirectory, { recursive: true, mode: 0o700 });
				const safeId = String(source.toolCallId ?? `idx${index}`).replace(/[^A-Za-z0-9_-]/g, "_");
				file = join(options.saveDirectory, `${safeId}.txt`);
				writeFileSync(file, toolResultText(source), { mode: 0o600 });
				savedFiles.set(source, file);
			} catch {
				file = undefined;
			}
		}
		const record: WithheldRecord = {
			message: source,
			toolCallId: String(source.toolCallId ?? "unknown"),
			toolName: String(source.toolName ?? "tool"),
			tokens,
			noteTokens: Math.ceil(toolResultText(source).length / 4),
			file,
		};
		let note = withheldCache.get(source);
		if (!note) {
			note = {
				...source,
				content: [{ type: "text", text: withheldNoteText(record, estimated, options.limit) }],
			};
			withheldCache.set(source, note);
			withheldCache.set(note, note);
		}
		output[index] = note;
		withheld.push(record);
		current = output;
		estimated = options.fixedTokens + options.estimate(current);
		if (estimated <= options.limit) break;
	}
	return { messages: current, withheld, estimated };
}

export function overflowNoticeText(result: OverflowGuardResult, limit: number): string {
	const count = result.withheld.length;
	const files = result.withheld.filter((record) => record.file).length;
	const list = result.withheld
		.map((record) => `${record.toolName}#${record.toolCallId} (~${record.tokens.toLocaleString("en-US")} tok)`)
		.join(", ");
	const fits = result.estimated <= limit;
	return (
		`[CLM BUDGET] Overflow guard: the request would have exceeded the limit of ${limit.toLocaleString("en-US")} tokens, so ${count} tool result${count === 1 ? "" : "s"} ` +
		`${count === 1 ? "was" : "were"} withheld from your context and replaced by notes${files > 0 ? " with file paths" : ""}: ${list}. ` +
		`Estimated request is now ${result.estimated.toLocaleString("en-US")} tokens${fits ? "" : " and still over the limit; edit your context now"}. ` +
		"Nothing was re-run; the full outputs are in the files named in the notes and in the session history. " +
		"Free space in your context (see Editable context) and re-read only what you need, e.g. with offset/limit."
	);
}

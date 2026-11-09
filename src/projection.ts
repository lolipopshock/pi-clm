import { createHash, type Hash } from "node:crypto";

import { canonicalMessage, digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const PROJECTION_PREFIX_MISMATCH_REASON =
	"Raw context prefix no longer matches the projection checkpoint.";
export const PROJECTION_SHORTER_REASON = "Raw context is shorter than the projection source prefix.";

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	sourceMessageCount: number;
	sourceDigest: string;
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	/** Older checkpoints omitted this field and stored character estimates. */
	estimateUnit?: "characters" | "tokens";
	createdAt: string;
	/** Provenance for the accepted edit that produced projectedMessages. */
	editTrace?: ContextEditTrace;
}

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

export type ProjectionRecovery =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			removedErrorCount: number;
			anchorRevision?: number;
			/** Set by edit-boundary recovery: where the source prefix ends in the rebuilt history. */
			boundary?: number;
			/** Why the source prefix could not be verified, when the projection was placed anyway. */
			unverified?: "extension-messages" | "lost-history";
	  }
	| {
			valid: false;
			reason: string;
	  };

function isPersistedRetryError(message: LiveContextMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error";
}

/** Bounds on the dropped-failure search, which runs once per resume that needs it. */
const DROPPED_FAILURE_SEARCH = { maxTries: 2_000, maxBytes: 1 << 30 };

/**
 * Which `count` failed responses in `prefix` the live conversation lacked, proven by making
 * the prefix hash to `digest` without them. Pi drops a failed response from its live
 * conversation when it retries it, also when a new prompt cancels the retry, but a resume
 * rebuilds the live conversation from the file, failures included; so the transcript alone
 * cannot say which failures a checkpoint lacks, but its digest can. Later failures are tried
 * first, as the likeliest to postdate the last resume; the search is bounded.
 */
export function findDroppedFailures(
	prefix: LiveContextMessage[],
	count: number,
	digest: string,
	limits = DROPPED_FAILURE_SEARCH,
): { dropped?: number[]; failures: number; exhausted: boolean } {
	const failures = prefix.flatMap((message, index) => isPersistedRetryError(message) ? [index] : []);
	if (count < 1 || count > failures.length) return { failures: failures.length, exhausted: false };
	const lines = prefix.map((message) => `${canonicalMessage(message)}\n`);
	// bytesAfter[i]: bytes hashed from message i to the end; hashed[i]: state before message i.
	const bytesAfter: number[] = new Array(lines.length + 1).fill(0);
	for (let index = lines.length - 1; index >= 0; index--) bytesAfter[index] = bytesAfter[index + 1]! + lines[index]!.length;
	const hashed = new Map<number, Hash>();
	const running = createHash("sha256");
	for (const [index, line] of lines.entries()) {
		if (index === failures[hashed.size]) hashed.set(index, running.copy());
		running.update(line);
	}

	const latestFirst = [...failures].reverse();
	let tries = 0;
	let bytes = 0;
	const choose = (start: number, chosen: number[]): number[] | undefined | "exhausted" => {
		if (chosen.length === count) {
			const drop = [...chosen].sort((left, right) => left - right);
			const first = drop[0]!;
			if (++tries > limits.maxTries || (bytes += bytesAfter[first + 1]!) > limits.maxBytes) return "exhausted";
			const hash = hashed.get(first)!.copy();
			const skip = new Set(drop);
			for (let index = first + 1; index < lines.length; index++) if (!skip.has(index)) hash.update(lines[index]!);
			return hash.digest("hex") === digest ? drop : undefined;
		}
		for (let next = start; next <= latestFirst.length - (count - chosen.length); next++) {
			const found = choose(next + 1, [...chosen, latestFirst[next]!]);
			if (found) return found;
		}
		return undefined;
	};
	const found = choose(0, []);
	return found === "exhausted"
		? { failures: failures.length, exhausted: true }
		: { dropped: found, failures: failures.length, exhausted: false };
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: LiveContextMessage[];
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit?: "characters" | "tokens";
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceDigest: digestMessages(options.sourceMessages),
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
		editTrace: options.editTrace,
	};

	// Fail at creation time rather than writing an unserializable custom session entry.
	JSON.stringify(checkpoint);
	return checkpoint;
}

/**
 * Replace the checkpoint's raw source prefix and retain every raw message appended after
 * it. A mismatch fails closed and returns the untouched raw context.
 */
export function applyProjection(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) {
		return { valid: true, messages: [...rawMessages], suffix: [] };
	}
	if (checkpoint.version !== 1) {
		return { valid: false, messages: [...rawMessages], reason: `Unsupported projection version: ${checkpoint.version}.` };
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: PROJECTION_SHORTER_REASON,
		};
	}

	const sourcePrefix = rawMessages.slice(0, checkpoint.sourceMessageCount);
	if (digestMessages(sourcePrefix) !== checkpoint.sourceDigest) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: PROJECTION_PREFIX_MISMATCH_REASON,
		};
	}

	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return {
		valid: true,
		messages: [...checkpoint.projectedMessages, ...suffix],
		suffix,
	};
}

/**
 * Pi persists failed assistant responses in JSONL before automatic retry, while its live
 * agent state removes those responses before retrying. A checkpoint accepted later in
 * that process therefore anchors to a prefix without the failed responses. On resume,
 * SessionManager reconstructs them and the otherwise unchanged prefix no longer hashes.
 *
 * Recover only when deleting assistant error responses after a cryptographically matching
 * older checkpoint (or from the beginning) makes the target checkpoint match exactly.
 * No user, successful assistant, or tool message is ever ignored by this compatibility
 * path. The caller should immediately rebase a recovered projection onto the resumed raw
 * transcript so future turns use the normal exact-prefix path again.
 */
export function recoverProjectionFromRetryErrors(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
	history: ProjectionCheckpoint[] = [],
): ProjectionRecovery {
	const direct = applyProjection(rawMessages, checkpoint);
	if (direct.valid) {
		return {
			...direct,
			removedErrorCount: 0,
		};
	}

	const candidates: Array<{ sourceMessageCount: number; sourceDigest?: string; revision?: number }> = [
		...history
			.filter((candidate) =>
				candidate.revision < checkpoint.revision &&
				candidate.sourceMessageCount <= checkpoint.sourceMessageCount &&
				rawMessages.length >= candidate.sourceMessageCount,
			)
			.sort((left, right) => right.sourceMessageCount - left.sourceMessageCount)
			.map((anchor) => ({
				sourceMessageCount: anchor.sourceMessageCount,
				sourceDigest: anchor.sourceDigest,
				revision: anchor.revision,
			})),
		{ sourceMessageCount: 0 },
	];
	const seenCounts = new Set<number>();

	for (const anchor of candidates) {
		if (seenCounts.has(anchor.sourceMessageCount)) continue;
		seenCounts.add(anchor.sourceMessageCount);
		const prefix = rawMessages.slice(0, anchor.sourceMessageCount);
		if (anchor.sourceDigest && digestMessages(prefix) !== anchor.sourceDigest) continue;
		const retainedSourceTail: LiveContextMessage[] = [];
		let cursor = anchor.sourceMessageCount;
		let removedErrorCount = 0;
		while (
			prefix.length + retainedSourceTail.length < checkpoint.sourceMessageCount &&
			cursor < rawMessages.length
		) {
			const message = rawMessages[cursor++];
			if (isPersistedRetryError(message)) removedErrorCount += 1;
			else retainedSourceTail.push(message);
		}
		if (removedErrorCount === 0) continue;

		// Only reconcile the target's source prefix. Later error responses are ordinary
		// suffix history and must not be silently removed by checkpoint recovery.
		const candidateMessages = [...prefix, ...retainedSourceTail, ...rawMessages.slice(cursor)];
		const recovered = applyProjection(candidateMessages, checkpoint);
		if (!recovered.valid) continue;
		return {
			...recovered,
			removedErrorCount,
			anchorRevision: anchor.revision,
		};
	}

	return {
		valid: false,
		reason: direct.reason,
	};
}

/**
 * Recover a checkpoint whose source prefix no longer hashes after resume by locating where
 * that prefix ends, instead of requiring every message before it to be byte-identical.
 *
 * Pi's live conversation and the history it rebuilds from the session file differ in a
 * known way: Pi drops a failed response from the live conversation when it retries it (also
 * when a new prompt cancels the retry), but the file keeps it; the final failure after the
 * last retry stays in both, and so does every failure from before an earlier resume. A
 * checkpoint written after such retries records fewer source messages, and a different
 * digest, than the rebuilt history holds. `recoverProjectionFromRetryErrors` strips every
 * failure after an anchor, including ones Pi kept, so it can give up.
 *
 * The prefix ends where the reply to its request begins: for an accepted edit (written at
 * turn end, with an edit trace) that is the last assistant reply at or before the
 * checkpoint's time; for a rebased checkpoint (written during a request) it is the first
 * reply after it. That boundary is accepted when removing some of the failed responses before
 * it reproduces the checkpoint's digest exactly (`findDroppedFailures`).
 *
 * Two known differences make the digest uncheckable, and the boundary is then accepted
 * unverified. An extension's custom message is stamped `Date.now()` in the live conversation
 * but gets its session entry's own, possibly later, time in the file, so a prefix holding one
 * may never hash as it did live: there the boundary is accepted when its extra messages could
 * all be failed responses. And `lostHistory` says the session file is missing entries before
 * this branch (a write failed, e.g. on a full disk, and later entries name the lost one as
 * their parent), so the rebuilt history lacks part of the source: the projection is placed at
 * its preferred boundary, being the model's own view of the lost history, where the
 * alternative is the incomplete raw history, which can still be far over any budget.
 * Otherwise the history changed and this fails closed, describing the difference.
 */
export function recoverProjectionAtEditBoundary(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
	options: { lostHistory?: boolean } = {},
): ProjectionRecovery {
	const created = Date.parse(checkpoint.createdAt);
	if (!Number.isFinite(created)) return { valid: false, reason: "The checkpoint has no usable creation time." };
	let lastReplyAtOrBefore = -1;
	let firstReplyAfter = -1;
	for (const [index, message] of rawMessages.entries()) {
		if (message.role !== "assistant" || typeof message.timestamp !== "number") continue;
		if (message.timestamp <= created) lastReplyAtOrBefore = index;
		else if (firstReplyAfter < 0) firstReplyAfter = index;
	}
	if (firstReplyAfter < 0) firstReplyAfter = rawMessages.length;
	const candidates = checkpoint.editTrace ? [lastReplyAtOrBefore, firstReplyAfter] : [firstReplyAfter, lastReplyAtOrBefore];
	const expected = checkpoint.sourceMessageCount;
	const placed = (boundary: number, removedErrorCount: number, unverified?: "extension-messages" | "lost-history"): ProjectionRecovery => {
		const suffix = rawMessages.slice(boundary);
		return { valid: true, messages: [...checkpoint.projectedMessages, ...suffix], suffix, removedErrorCount, boundary, ...(unverified ? { unverified } : {}) };
	};
	let unverifiable: { boundary: number; extra: number } | undefined;
	// Describe the candidate that came closest, so the reason points at the likely difference.
	let description: { text: string; distance: number } | undefined;
	for (const boundary of candidates) {
		if (boundary < 0) continue;
		const extra = boundary - expected;
		// Failed responses the live conversation lacked are the one benign difference in count,
		// and the digest shows which ones they are; any other difference is a changed history.
		const search = extra > 0 ? findDroppedFailures(rawMessages.slice(0, boundary), extra, checkpoint.sourceDigest) : undefined;
		if (search?.dropped) return placed(boundary, extra);
		if (search && !unverifiable && extra <= search.failures && rawMessages.slice(0, boundary).some((message) => message.role === "custom")) {
			unverifiable = { boundary, extra };
		}
		const distance = extra < 0 ? -extra : Math.max(0, extra - (search?.failures ?? 0));
		if (description && description.distance <= distance) continue;
		description = {
			distance,
			text:
				`The edit's request starts after message ${boundary} of the rebuilt history, but the checkpoint recorded ` +
				`${expected} source messages` +
				(extra < 0
					? ` (${-extra} more than the history holds there).`
					: extra === 0
						? "; the counts agree, so a message before that point changed."
						: `; the history holds ${extra} more, and removing failed responses (${search!.failures} before that point) ` +
							`does not reproduce the checkpoint${search!.exhausted ? " within the search limit" : ""}.`),
		};
	}
	const preferred = candidates[0]!;
	if (options.lostHistory) {
		if (preferred >= 0) return placed(preferred, 0, "lost-history");
	} else if (unverifiable) {
		return placed(unverifiable.boundary, unverifiable.extra, "extension-messages");
	}
	return { valid: false, reason: description?.text ?? "No reply to the edit's request was found in the rebuilt history." };
}

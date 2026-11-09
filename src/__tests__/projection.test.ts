import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { digestMessages } from "../context-document.ts";
import {
	applyProjection,
	createProjectionCheckpoint,
	findDroppedFailures,
	recoverProjectionAtEditBoundary,
	recoverProjectionFromRetryErrors,
} from "../projection.ts";
import {
	LIVE_CONTEXT_STATE,
	initialLiveContextState,
	reconstructLiveContextState,
	resetProjectionState,
	toOutcomeEntry,
} from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "task", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "large investigation" }], timestamp: 2 },
	{ role: "user", content: "tool output".repeat(100), timestamp: 3 },
];
const projected: LiveContextMessage[] = [
	raw[0],
	{ role: "custom", customType: "live-context-projection", content: "Investigation summary", display: false, timestamp: 2 },
];

function checkpoint(revision = 1) {
	return createProjectionCheckpoint({
		revision,
		sourceMessages: raw,
		projectedMessages: projected,
		beforeEstimate: 1_200,
		afterEstimate: 30,
		createdAt: "2026-08-29T00:00:00.000Z",
	});
}

describe("projection rebasing", () => {
	test("replaces the source prefix and appends the raw suffix", () => {
		const suffix = [
			{ role: "assistant", content: [{ type: "text", text: "new turn" }], timestamp: 4 },
			{ role: "user", content: "new result", timestamp: 5 },
		];
		const result = applyProjection([...raw, ...suffix], checkpoint());
		assert.equal(result.valid, true);
		if (!result.valid) return;
		assert.deepEqual(result.messages, [...projected, ...suffix]);
		assert.deepEqual(result.suffix, suffix);
	});

	test("fails closed when the raw prefix changed", () => {
		const changed = raw.map((message) => ({ ...message }));
		changed[1] = { ...changed[1], content: "changed outside projection" };
		const result = applyProjection(changed, checkpoint());
		assert.equal(result.valid, false);
		assert.deepEqual(result.messages, changed);
		assert.match(result.valid ? "" : result.reason, /no longer matches/);
	});

	test("fails closed when the raw context is shorter than the anchor", () => {
		const result = applyProjection(raw.slice(0, 1), checkpoint());
		assert.equal(result.valid, false);
		assert.match(result.valid ? "" : result.reason, /shorter/);
	});

	test("no checkpoint returns a defensive top-level copy", () => {
		const result = applyProjection(raw, undefined);
		assert.equal(result.valid, true);
		assert.notEqual(result.messages, raw);
		assert.deepEqual(result.messages, raw);
	});

	test("checkpoint creation verifies JSON serialization", () => {
		const created = checkpoint();
		assert.doesNotThrow(() => JSON.stringify(created));
		assert.equal(created.sourceDigest, digestMessages(raw));
	});

	test("canonical message digests ignore object key order", () => {
		const left = [{ role: "user", content: "x", timestamp: 1 }];
		const right = [{ timestamp: 1, content: "x", role: "user" }];
		assert.equal(digestMessages(left), digestMessages(right));
	});

	test("recovers retry errors persisted by Pi but removed from its live agent state", () => {
		const anchorSource: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{ role: "assistant", content: "initial answer", stopReason: "stop", timestamp: 2 },
		];
		const anchor = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: anchorSource,
			projectedMessages: anchorSource,
			beforeEstimate: 20,
			afterEstimate: 20,
		});
		const successfulRetry: LiveContextMessage = {
			role: "assistant",
			content: "retry succeeded",
			stopReason: "stop",
			timestamp: 4,
		};
		const targetSource = [...anchorSource, successfulRetry];
		const targetProjection: LiveContextMessage[] = [
			anchorSource[0],
			{ role: "custom", content: "work completed", timestamp: 4 },
		];
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: targetSource,
			projectedMessages: targetProjection,
			beforeEstimate: 30,
			afterEstimate: 10,
		});
		const persistedRetryError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fetch failed",
			timestamp: 3,
		};
		const laterError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "later terminal error",
			timestamp: 4.5,
		};
		const suffix: LiveContextMessage = { role: "user", content: "next task", timestamp: 5 };
		const resumedRaw = [...anchorSource, persistedRetryError, successfulRetry, laterError, suffix];

		assert.equal(applyProjection(resumedRaw, target).valid, false);
		const recovered = recoverProjectionFromRetryErrors(resumedRaw, target, [anchor, target]);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.removedErrorCount, 1);
		assert.equal(recovered.anchorRevision, 1);
		assert.deepEqual(recovered.messages, [...targetProjection, laterError, suffix]);
		assert.deepEqual(recovered.suffix, [laterError, suffix]);
	});

	test("retry recovery never ignores a changed non-error message", () => {
		const anchor = checkpoint(1);
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: [...raw, { role: "assistant", content: "success", stopReason: "stop", timestamp: 4 }],
			projectedMessages: projected,
			beforeEstimate: 1_300,
			afterEstimate: 30,
		});
		const resumed = [
			...raw,
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed", timestamp: 3.5 },
			{ role: "assistant", content: "different success", stopReason: "stop", timestamp: 4 },
		];
		const recovered = recoverProjectionFromRetryErrors(resumed, target, [anchor, target]);
		assert.equal(recovered.valid, false);
	});
});

describe("edit-boundary recovery", () => {
	const at = (seconds: number) => 1_790_000_000_000 + seconds * 1_000;
	const user = (seconds: number, text: string): LiveContextMessage => ({ role: "user", content: text, timestamp: at(seconds) });
	const reply = (seconds: number, text: string, stopReason = "stop"): LiveContextMessage => ({ role: "assistant", content: text, stopReason, timestamp: at(seconds) });
	const failure = (seconds: number): LiveContextMessage => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited", timestamp: at(seconds) });
	const trace = { version: 1 as const, sourceRevision: 0, sourceMessageCount: 0, outputMessageCount: 0, sources: [], additions: [] };

	// Four 429s: Pi dropped the three it retried from its live conversation and kept the final one.
	const rebuilt = [
		user(1, "task"), reply(2, "first answer"), user(10, "next step"),
		failure(11), failure(13), failure(17), failure(25),
		user(100, "please compact your context"), reply(101, "editing the mirror", "toolUse"),
		{ role: "toolResult", content: "mirror written", toolCallId: "call-1", timestamp: at(102) },
	];
	const live = [rebuilt[0]!, rebuilt[1]!, rebuilt[2]!, rebuilt[6]!, rebuilt[7]!];
	const projected = [rebuilt[0]!, { role: "custom", customType: "notes", content: "summary of the work so far", timestamp: at(2) }];
	const edit = createProjectionCheckpoint({
		revision: 4,
		sourceMessages: live,
		projectedMessages: projected,
		beforeEstimate: 400,
		afterEstimate: 40,
		createdAt: new Date(at(103)).toISOString(),
		editTrace: trace,
	});

	test("finds where the edit's prefix ends when Pi dropped retried failures but kept the final one", () => {
		assert.equal(applyProjection(rebuilt, edit).valid, false);
		assert.equal(recoverProjectionFromRetryErrors(rebuilt, edit, [edit]).valid, false, "stripping every failure removes the one Pi kept");
		const recovered = recoverProjectionAtEditBoundary(rebuilt, edit);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.boundary, 8);
		assert.equal(recovered.removedErrorCount, 3);
		assert.deepEqual(recovered.suffix, rebuilt.slice(8));
		assert.deepEqual(recovered.messages, [...projected, ...rebuilt.slice(8)]);
	});

	test("a rebased checkpoint (no edit trace) ends before the next reply", () => {
		const resumed = [user(1, "task"), failure(2), reply(3, "retry succeeded"), user(10, "next"), reply(30, "answer")];
		const rebased = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: [resumed[0]!, resumed[2]!, resumed[3]!],
			projectedMessages: [resumed[0]!, resumed[3]!],
			beforeEstimate: 30,
			afterEstimate: 20,
			createdAt: new Date(at(20)).toISOString(),
		});
		const recovered = recoverProjectionAtEditBoundary(resumed, rebased);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.boundary, 4);
		assert.deepEqual(recovered.suffix, [resumed[4]]);
	});

	test("removes only the failures the live conversation lacked, proven by the digest", () => {
		// The 429s at 2 and 3 predate an earlier resume, which put them back in the live
		// conversation. Since then Pi retried the failure at 11 and a new prompt cancelled the
		// retry of the one at 14: those two are missing live.
		const resumed: LiveContextMessage[] = [
			user(1, "task"), failure(2), failure(3), reply(4, "answer after two retries"),
			user(10, "next"), failure(11), reply(12, "retry succeeded", "toolUse"),
			{ role: "toolResult", content: "ok", toolCallId: "call-2", timestamp: at(13) },
			failure(14), user(20, "a new prompt cancels the retry"),
			user(30, "please compact"), reply(31, "editing the mirror", "toolUse"),
			{ role: "toolResult", content: "mirror written", toolCallId: "call-3", timestamp: at(32) },
		];
		const live = resumed.filter((_, index) => index !== 5 && index !== 8).slice(0, 9);
		const checkpoint = createProjectionCheckpoint({
			revision: 9,
			sourceMessages: live,
			projectedMessages: projected,
			beforeEstimate: 400,
			afterEstimate: 40,
			createdAt: new Date(at(33)).toISOString(),
			editTrace: trace,
		});
		assert.deepEqual(findDroppedFailures(resumed.slice(0, 11), 2, checkpoint.sourceDigest).dropped, [5, 8]);
		const recovered = recoverProjectionAtEditBoundary(resumed, checkpoint);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.boundary, 11);
		assert.equal(recovered.removedErrorCount, 2);
		assert.deepEqual(recovered.messages, [...projected, ...resumed.slice(11)]);
	});

	test("as many extra failures as retried ones are not enough when a message changed", () => {
		const changed = rebuilt.map((message) => ({ ...message }));
		changed[2] = { ...changed[2]!, content: "next step, edited outside pi-clm" };
		const recovered = recoverProjectionAtEditBoundary(changed, edit);
		assert.equal(recovered.valid, false);
		assert.match(recovered.valid ? "" : recovered.reason, /holds 3 more, and removing failed responses \(4 before that point\) does not reproduce the checkpoint\./);
	});

	test("a prefix holding extension messages, whose live time Pi does not keep, is placed unverified", () => {
		// Pi stamps a custom message Date.now() live, and its session entry's own time in the file.
		const notice = (lateMs: number): LiveContextMessage => ({ role: "custom", customType: "agent-hub-connect-progress", content: "[Agent Hub] connected", display: true, timestamp: at(5) + lateMs });
		const withNotice = [...rebuilt.slice(0, 2), notice(1), ...rebuilt.slice(2)];
		const checkpoint = createProjectionCheckpoint({
			revision: 5,
			sourceMessages: [...live.slice(0, 2), notice(0), ...live.slice(2)],
			projectedMessages: projected,
			beforeEstimate: 400,
			afterEstimate: 40,
			createdAt: new Date(at(103)).toISOString(),
			editTrace: trace,
		});
		assert.equal(findDroppedFailures(withNotice.slice(0, 9), 3, checkpoint.sourceDigest).dropped, undefined, "no digest can match");
		const recovered = recoverProjectionAtEditBoundary(withNotice, checkpoint);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.unverified, "extension-messages");
		assert.equal(recovered.boundary, 9);
		assert.equal(recovered.removedErrorCount, 3);
		assert.deepEqual(recovered.messages, [...projected, ...withNotice.slice(9)]);
		// More extra messages than failed responses still fail closed.
		const moreUsers = [...withNotice.slice(0, 3), user(6, "one"), user(7, "two"), user(8, "three"), user(9, "four"), user(9.5, "five"), ...withNotice.slice(3)];
		assert.equal(recoverProjectionAtEditBoundary(moreUsers, checkpoint).valid, false);
	});

	test("the dropped-failure search is bounded", () => {
		const prefix = rebuilt.slice(0, 8);
		assert.deepEqual(findDroppedFailures(prefix, 3, edit.sourceDigest).dropped, [3, 4, 5]);
		// Latest first, the first try also drops the final failure, which Pi kept: one try is not enough.
		const bounded = findDroppedFailures(prefix, 3, edit.sourceDigest, { maxTries: 1, maxBytes: 1 << 30 });
		assert.equal(bounded.dropped, undefined);
		assert.equal(bounded.exhausted, true);
		assert.equal(findDroppedFailures(prefix, 3, edit.sourceDigest, { maxTries: 100, maxBytes: 10 }).exhausted, true);
	});

	test("with entries lost from the session file, the projection is placed at its edit's reply unverified", () => {
		// The file lost the start of the history: the rebuilt branch begins at "next step".
		const truncated = rebuilt.slice(2);
		assert.equal(recoverProjectionAtEditBoundary(truncated, edit).valid, false, "unverifiable without the caller's evidence");
		const recovered = recoverProjectionAtEditBoundary(truncated, edit, { lostHistory: true });
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.unverified, "lost-history");
		assert.equal(recovered.boundary, 6);
		assert.deepEqual(recovered.messages, [...projected, ...truncated.slice(6)]);
		assert.equal(recoverProjectionAtEditBoundary([], edit, { lostHistory: true }).valid, false, "no reply to place it at");
	});

	test("fails closed, saying why, when the difference is not failed responses", () => {
		const extraUser = [...rebuilt.slice(0, 3), user(12, "a message the edit never saw"), ...rebuilt.slice(6)];
		const notFailures = recoverProjectionAtEditBoundary(extraUser, edit);
		assert.equal(notFailures.valid, false);
		assert.match(notFailures.valid ? "" : notFailures.reason, /holds 1 more, and removing failed responses \(1 before that point\) does not reproduce the checkpoint\./);

		const changed = [...live.map((message) => ({ ...message })), ...rebuilt.slice(8)];
		changed[1] = { ...changed[1]!, content: "edited outside pi-clm" };
		const sameCount = recoverProjectionAtEditBoundary(changed, edit);
		assert.equal(sameCount.valid, false);
		assert.match(sameCount.valid ? "" : sameCount.reason, /counts agree, so a message before that point changed/);
	});
});

describe("branch-local state reconstruction", () => {
	test("latest valid state on the supplied branch wins", () => {
		const first = { ...initialLiveContextState(), enabled: false };
		const latest = { ...initialLiveContextState(), revision: 2, checkpoint: checkpoint(2) };
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: first },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: { invalid: true } },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: latest },
		]);
		assert.deepEqual(reconstructed, latest);
	});

	test("another branch without an entry starts clean", () => {
		assert.deepEqual(reconstructLiveContextState([{ type: "message" }]), initialLiveContextState());
	});

	test("checkpoint-neutral outcome entries keep the active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const rejected = toOutcomeEntry({
			...applied,
			lastOutcome: { kind: "rejected", message: "edit grew", at: "2026-08-29T00:00:00.000Z" },
		});
		assert.equal("checkpoint" in rejected, false);
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: rejected },
		]);
		assert.equal(reconstructed.lastOutcome?.kind, "rejected");
		assert.deepEqual(reconstructed.checkpoint, applied.checkpoint);
	});

	test("a persisted reset after an acceptance leaves no active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const reset = resetProjectionState(applied, "native compaction", "2026-08-29T00:00:00.000Z");
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: reset },
		]);
		assert.equal(reconstructed.revision, 2);
		assert.equal(reconstructed.checkpoint, undefined);
	});

	test("reset clears the checkpoint and advances the revision", () => {
		const state = { ...initialLiveContextState(), revision: 4, checkpoint: checkpoint(4) };
		const reset = resetProjectionState(state, "native compaction", "2026-08-29T00:00:00.000Z");
		assert.equal(reset.revision, 5);
		assert.equal(reset.checkpoint, undefined);
		assert.equal(reset.lastOutcome?.kind, "reset");
	});
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { applyOverflowGuard, overflowGuardFromEnv, overflowGuardLimit, overflowNoticeText } from "../overflow.ts";
import type { LiveContextMessage } from "../types.ts";

const estimate = (messages: LiveContextMessage[]) =>
	messages.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.content ?? "").length / 4), 0);
const tool = (id: string, chars: number): LiveContextMessage => ({
	role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 1,
	content: [{ type: "text", text: "x".repeat(chars) }],
});
const user: LiveContextMessage = { role: "user", content: "task", timestamp: 0 };

describe("overflow guard", () => {
	test("limit is the tighter of budget−reserve and window−4096−reserve", () => {
		assert.equal(overflowGuardLimit(28_000, 2048, undefined), 25_952);
		assert.equal(overflowGuardLimit(28_000, 2048, 32_768), Math.min(25_952, 32_768 - 4096 - 2048));
		assert.equal(overflowGuardLimit(100_000, 2048, 32_768), 26_624);
		assert.deepEqual(overflowGuardFromEnv({}), {});
		assert.deepEqual(overflowGuardFromEnv({ PI_CLM_OVERFLOW: "off" }), { mode: "off" });
		assert.throws(() => overflowGuardFromEnv({ PI_CLM_OVERFLOW: "maybe" }), /withhold/);
	});
	test("does nothing under the limit; withholds oldest tool results first until it fits", () => {
		const messages = [user, tool("a", 4000), tool("b", 4000), tool("c", 4000)];
		const under = applyOverflowGuard(messages, { limit: 10_000, fixedTokens: 0, estimate });
		assert.equal(under.messages, messages);
		assert.equal(under.withheld.length, 0);
		const over = applyOverflowGuard(messages, { limit: 1_100, fixedTokens: 0, estimate });
		assert.deepEqual(over.withheld.map((w) => w.toolCallId), ["a", "b"]);
		assert.equal(over.messages[3], messages[3], "newest result (what the model just asked for) kept");
		assert.match(JSON.stringify(over.messages[1]!.content), /overflow guard\] read#a \(~1,00\d tok\) withheld over budget/);
		assert.ok(JSON.stringify(over.messages[1]!.content).length < 200, "notes stay short");
		assert.ok(over.estimated <= 1_100);
		assert.equal(over.messages[1]!.role, "toolResult", "note keeps the toolResult role so tool-call pairing stays legal");
		assert.equal(over.messages[1]!.toolCallId, "a");
	});
	test("respects protectBefore, is idempotent, and saves the full text to a file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-clm-overflow-"));
		const messages = [user, tool("old", 4000), tool("new", 4000)];
		const result = applyOverflowGuard(messages, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir, protectBefore: 2 });
		assert.deepEqual(result.withheld.map((w) => w.toolCallId), ["new"], "the protected prefix is never withheld");
		assert.ok(result.estimated <= 1_200);
		assert.equal(result.messages[1], messages[1]);
		const file = result.withheld[0]!.file!;
		assert.ok(existsSync(file));
		assert.equal(readFileSync(file, "utf8"), "x".repeat(4000));
		assert.match(JSON.stringify(result.messages[2]!.content), new RegExp(file.replace(/[/\\]/g, "\\$&")));
		const again = applyOverflowGuard(messages, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir, protectBefore: 2 });
		assert.equal(again.messages[2], result.messages[2], "same note object across calls");
		// A note is never withheld again.
		const stacked = applyOverflowGuard(result.messages, { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		assert.deepEqual(stacked.withheld.map((w) => w.toolCallId), ["old"]);
	});
	test("re-reading a withheld file does not loop: the fresh result survives, an older one goes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-clm-overflow-loop-"));
		const first = [user, tool("a", 4000), tool("b", 4000)];
		const r1 = applyOverflowGuard(first, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir });
		assert.deepEqual(r1.withheld.map((w) => w.toolCallId), ["a"]);
		// Model re-reads a's file; that result is now the newest.
		const reread = tool("a-again", 4000);
		const second = [...r1.messages, reread];
		const r2 = applyOverflowGuard(second, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir });
		assert.deepEqual(r2.withheld.map((w) => w.toolCallId), ["b"]);
		assert.equal(r2.messages[3], reread, "the re-read stays visible");
	});
	test("note text for a tool call is identical across context builds with different calibration", () => {
		// Pi hands the extension fresh message objects on every request, and the calibration
		// factor is re-fit between requests. Neither may change a note: it sits early in the
		// request, so a changed note invalidates the provider's prefix cache after it.
		const messages = [user, tool("a", 4000), tool("b", 4000), tool("c", 4000)];
		const build = (factor: number) => {
			const calibrated = (ms: LiveContextMessage[]) => Math.ceil(estimate(ms) * factor);
			const result = applyOverflowGuard(structuredClone(messages), { limit: 1_100, fixedTokens: 0, estimate: calibrated });
			return result.messages.slice(1, 3).map((m) => JSON.stringify(m.content));
		};
		const first = build(1.3);
		const second = build(1.27);
		assert.match(first[0]!, /overflow guard\] read#a /);
		assert.match(first[1]!, /overflow guard\] read#b /);
		assert.deepEqual(second, first);
	});
	test("notice names the results, the limit and whether it now fits", () => {
		const messages = [user, tool("a", 4000)];
		const result = applyOverflowGuard(messages, { limit: 500, fixedTokens: 100, estimate });
		const text = overflowNoticeText(result, 500);
		assert.match(text, /^\[CLM BUDGET\] Overflow guard: .*limit of 500 tokens, so 1 tool result was withheld/);
		assert.match(text, /read#a \(~1,00\d tok\)/);
		assert.match(text, /Nothing was re-run/);
		assert.doesNotMatch(text, /still over/);
		const stillOver = applyOverflowGuard([user, tool("b", 4000), { role: "user", content: "y".repeat(10_000), timestamp: 2 }], { limit: 500, fixedTokens: 0, estimate });
		assert.match(overflowNoticeText(stillOver, 500), /still over the limit; edit your context now/);
	});
});

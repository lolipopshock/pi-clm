import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FLOPS_PRESETS,
	flopsConfigFromEnv,
	formatFlops,
	PrefixReuseMeter,
	promptUnits,
	requestFlops,
	resolveFlopsConstants,
	type FlopsConstants,
	type FlopsRequestRecord,
} from "../flops.ts";

const Q27: FlopsConstants = { ...FLOPS_PRESETS["27b"]!, source: "27b" };

const close = (actual: number, expected: number, relative = 5e-3) =>
	assert.ok(Math.abs(actual - expected) <= relative * expected, `${actual} not within ${relative} of ${expected}`);

test("27b constants and the per-turn formula reproduce the paper's worked example", () => {
	// Appendix example: C_token = 48.70e9, C_attn = 3.93e5; P = 20,000, G = 500.
	close(Q27.perToken, 48.70e9);
	close(Q27.perAttentionPair, 3.93e5);
	close(requestFlops(Q27, { prompt: 20_000, reused: 18_000, output: 500 }).total, 1.41e14);
	close(requestFlops(Q27, { prompt: 20_000, reused: 10_000, output: 500 }).total, 5.74e14);
	close(requestFlops(Q27, { prompt: 20_000, reused: 0, output: 500 }).total, 10.81e14);
	const split = requestFlops(Q27, { prompt: 1000, reused: 400, output: 10 });
	assert.equal(split.linear, Q27.perToken * 610);
	assert.equal(split.attention, Q27.perAttentionPair * ((1000 ** 2 - 400 ** 2) / 2 + 10 * 1000 + 50));
	assert.equal(split.total, split.linear + split.attention);
	// A reused count above the prompt (template overhead) is clamped.
	assert.equal(requestFlops(Q27, { prompt: 100, reused: 120, output: 0 }).total, 0);
});

const user = { role: "user", content: "question" };
const call = (n: number) => ({ role: "assistant", content: `step ${n}`, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "search", arguments: "{}" } }] });
const result = (n: number) => ({ role: "tool", tool_call_id: `c${n}`, content: `result ${n} `.repeat(50) });
const payload = (messages: unknown[]) => ({ model: "m", messages, tools: [{ type: "function", function: { name: "search" } }], stream: true });

function run(meter: PrefixReuseMeter, messages: unknown[], usage: { input: number; cacheRead?: number; output: number }, constants: FlopsConstants | null = Q27) {
	meter.observeRequest(payload(messages));
	return meter.observeResponse(usage, { model: "qwen3.6-27b", constants: constants ?? undefined })!;
}

test("append-only turns reuse exactly the previous prompt; the server cache count is recorded, not used", () => {
	const meter = new PrefixReuseMeter();
	const first = run(meter, [user], { input: 1000, output: 50 });
	assert.deepEqual([first.promptTokens, first.reusedPrefixTokens, first.newPromptTokens, first.reusedUnits, first.units], [1000, 0, 1000, 0, 2]);
	assert.equal(first.prefixOf, null);
	// The server reports 600 cached tokens; the idealised count reuses the whole previous prompt.
	const second = run(meter, [user, call(1), result(1)], { input: 1200, cacheRead: 600, output: 40 });
	assert.deepEqual([second.reusedPrefixTokens, second.newPromptTokens, second.reusedUnits, second.prefixOf], [1000, 800, 2, 1]);
	assert.equal(second.serverCachedTokens, 600);
	assert.equal(second.flops, requestFlops(Q27, { prompt: 1800, reused: 1000, output: 40 }).total);
	assert.equal(second.cumulative.flops, first.flops! + second.flops!);
	assert.deepEqual(
		[second.cumulative.requests, second.cumulative.promptTokens, second.cumulative.reusedPrefixTokens, second.cumulative.newPromptTokens, second.cumulative.outputTokens],
		[2, 2800, 1000, 1800, 90],
	);
	// Only the second response carried a cache count.
	assert.equal(first.serverCachedTokens, undefined);
	assert.deepEqual([second.cumulative.serverCachedTokens, second.cumulative.serverCachedReported], [600, 1]);
	// Weights of one request sum to its prompt size.
	assert.equal(second.newUnits.reduce((sum, [, weight]) => sum + weight, 0), 800);
});

test("an edit in the middle re-prefills from the edited message onward", () => {
	const meter = new PrefixReuseMeter();
	run(meter, [user], { input: 1000, output: 0 });
	run(meter, [user, call(1), result(1)], { input: 1800, output: 0 });
	const third = run(meter, [user, call(1), result(1), call(2), result(2)], { input: 2600, output: 0 });
	assert.equal(third.reusedPrefixTokens, 1800);
	// The model rewrites result 1 into a note: everything from that message on is new again.
	const edited = run(meter, [user, call(1), { role: "user", content: "note: result 1 was irrelevant" }, call(2), result(2)], { input: 2000, output: 0 });
	assert.equal(edited.reusedUnits, 3); // header, user, call 1
	assert.equal(edited.prefixOf, 2);
	const call1Weight = 1800 - 1000 - (meter as unknown as { weights: Map<string, number> }).weights.get(promptUnits(payload([result(1)])).keys[1]!)!;
	assert.equal(edited.reusedPrefixTokens, 1000 + call1Weight);
	assert.equal(edited.newPromptTokens, 2000 - edited.reusedPrefixTokens);
	// Returning to a previously seen prefix reuses it again, as a prefix cache would.
	const back = run(meter, [user, call(1), result(1), call(2), result(2), call(3)], { input: 2700, output: 0 });
	assert.equal(back.reusedPrefixTokens, 2600);
	assert.equal(back.prefixOf, 3);
});

test("a changed tool list or system prompt invalidates the whole prefix", () => {
	const meter = new PrefixReuseMeter();
	run(meter, [user], { input: 1000, output: 0 });
	meter.observeRequest({ ...payload([user, call(1)]), tools: [] });
	assert.equal(meter.observeResponse({ input: 1100, output: 0 }, { constants: Q27 })!.reusedPrefixTokens, 0);
});

test("responses without a prompt count are not accounted; unknown models keep tokens without FLOPs", () => {
	const meter = new PrefixReuseMeter();
	meter.observeRequest(payload([user]));
	assert.equal(meter.observeResponse({ output: 0 }, { constants: Q27 }), undefined);
	assert.equal(meter.observeResponse({ input: 5, output: 0 }, { constants: Q27 }), undefined); // no pending request
	assert.equal(meter.unmeasuredResponses, 2);
	const record = run(meter, [user], { input: 900, output: 10 }, null);
	assert.deepEqual([record.flops, record.linearFlops, record.attentionFlops, record.constants], [null, null, null, null]);
	assert.equal(record.cumulative.requestsWithoutFlops, 1);
	assert.equal(record.cumulative.promptTokens, 900);
	assert.equal(meter.summary("t").unmeasuredResponses, 2);
});

test("restoring from persisted records continues the same accounting", () => {
	const live = new PrefixReuseMeter();
	const records: FlopsRequestRecord[] = [
		run(live, [user], { input: 1000, output: 5 }),
		run(live, [user, call(1), result(1)], { input: 1800, output: 5 }),
		run(live, [user, call(1), { role: "user", content: "note" }], { input: 1300, output: 5 }),
	];
	const restored = new PrefixReuseMeter();
	restored.restore(JSON.parse(JSON.stringify(records)));
	assert.deepEqual(restored.totals, live.totals);
	const next = [user, call(1), result(1), call(2)];
	const a = run(live, next, { input: 1900, output: 5 });
	const b = run(restored, next, { input: 1900, output: 5 });
	assert.deepEqual(b, a);
	assert.equal(b.reusedPrefixTokens, 1800);
});

test("prompt units: header fields then one unit per message; unknown payloads are one unit", () => {
	assert.equal(promptUnits(payload([user, call(1)])).keys.length, 3);
	assert.equal(promptUnits({ messages: [user] }).keys.length, 1);
	assert.equal(promptUnits({ system: "s", messages: [user] }).keys.length, 2);
	assert.equal(promptUnits({ instructions: "s", input: [user, user] }).keys.length, 3);
	assert.equal(promptUnits({ prompt: "raw" }).keys.length, 1);
	// Sampling fields are not part of the prompt.
	assert.deepEqual(promptUnits({ ...payload([user]), temperature: 0.7 }).keys, promptUnits(payload([user])).keys);
});

test("constants: explicit values, presets, and the auto rule for Qwen3.5+ model ids", () => {
	assert.equal(resolveFlopsConstants({ model: "auto" }, "qwen36-27b")?.source, "27b");
	assert.equal(resolveFlopsConstants({ model: "auto" }, "Qwen/Qwen3.8-27B")?.source, "27b");
	assert.equal(resolveFlopsConstants({ model: "auto" }, "qwen3.5-9b")?.source, "9b");
	assert.equal(resolveFlopsConstants({ model: "auto" }, "Qwen/Qwen3-8B"), undefined);
	assert.equal(resolveFlopsConstants({ model: "auto" }, "gemma-3-27b"), undefined);
	assert.equal(resolveFlopsConstants({ model: "auto" }, undefined), undefined);
	assert.equal(resolveFlopsConstants({ model: "9b" }, "anything")?.perToken, FLOPS_PRESETS["9b"]!.perToken);
	assert.deepEqual(resolveFlopsConstants({ model: "auto", perToken: 2e9, perAttentionPair: 1e4 }, "x"), { perToken: 2e9, perAttentionPair: 1e4, source: "env" });
	assert.equal(resolveFlopsConstants({ model: "off", perToken: 2e9, perAttentionPair: 1e4 }, "qwen3.6-27b"), undefined);
});

test("environment parsing rejects malformed values", () => {
	assert.deepEqual(flopsConfigFromEnv({}), {});
	assert.deepEqual(flopsConfigFromEnv({ PI_CLM_FLOPS_MODEL: "27B" }), { model: "27b" });
	assert.deepEqual(flopsConfigFromEnv({ PI_CLM_FLOPS_PER_TOKEN: "1e9", PI_CLM_FLOPS_PER_PAIR: "4096" }), { perToken: 1e9, perAttentionPair: 4096 });
	assert.throws(() => flopsConfigFromEnv({ PI_CLM_FLOPS_MODEL: "70b" }), /PI_CLM_FLOPS_MODEL/);
	assert.throws(() => flopsConfigFromEnv({ PI_CLM_FLOPS_PER_TOKEN: "1e9" }), /set together/);
	assert.throws(() => flopsConfigFromEnv({ PI_CLM_FLOPS_PER_TOKEN: "-1", PI_CLM_FLOPS_PER_PAIR: "1" }), /positive/);
});

test("formatting", () => {
	assert.equal(formatFlops(1.194e15), "1.19 PFLOP");
	assert.equal(formatFlops(845e12), "845 TFLOP");
	assert.equal(formatFlops(12.5e15), "12.5 PFLOP");
	assert.equal(formatFlops(10), "10 FLOP");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { promptTokens } from "../usage.ts";

test("prompt counts include both cache counters but exclude generated output and total", () => {
	const prompt = { input: 100, cacheRead: 200, cacheWrite: 50 };
	assert.equal(promptTokens({ ...prompt, output: 5, totalTokens: 355 }), 350);
	assert.equal(promptTokens({ ...prompt, output: 10_000, totalTokens: 10_350 }), 350);
});

test("explicit zero prompt counters do not fall back to an output-only total", () => {
	assert.equal(promptTokens({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1000, totalTokens: 1000 }), 0);
	assert.equal(promptTokens({ cacheRead: 200, output: 1000 }), 200);
	assert.equal(promptTokens(undefined), 0);
	assert.equal(promptTokens({}), 0);
});

test("total-only records subtract output when known and never produce negative prompt size", () => {
	assert.equal(promptTokens({ totalTokens: 1000 }), 1000);
	assert.equal(promptTokens({ totalTokens: 1000, output: 200 }), 800);
	assert.equal(promptTokens({ totalTokens: 100, output: 200 }), 0);
});

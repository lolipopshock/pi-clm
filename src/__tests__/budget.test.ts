import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	BudgetTracker,
	EstimateCalibrator,
	budgetNoticeText,
	budgetPolicyFromEnv,
	budgetSummaryLine,
	budgetTiers,
	governingTokens,
	resolveBudget,
	resolveBudgetPolicy,
	type BudgetReading,
} from "../budget.ts";

const policy = resolveBudgetPolicy({ contextBudget: 32_000 });
const tiers = budgetTiers(policy, 32_000, 2048);
const reading = (estimated: number, observed?: number): BudgetReading => ({
	budget: 32_000,
	reserve: 2048,
	estimated,
	observed,
	source: "config",
});

describe("budget policy resolution", () => {
	test("defaults follow the paper: 2048 reserve, 50/75/90% plus budget-reserve", () => {
		assert.deepEqual(
			tiers.map((tier) => [tier.label, tier.tokens]),
			[["50%", 16_000], ["75%", 24_000], ["90%", 28_800], ["budget-reserve", 29_952]],
		);
	});
	test("configured budget wins over the model window; model window is the fallback", () => {
		assert.deepEqual(resolveBudget(policy, 272_000), { budget: 32_000, reserve: 2048, source: "config" });
		assert.deepEqual(resolveBudget(resolveBudgetPolicy(undefined), 272_000), { budget: 272_000, reserve: 2048, source: "model-window" });
		assert.equal(resolveBudget(resolveBudgetPolicy(undefined), undefined), undefined);
		assert.equal(resolveBudget(resolveBudgetPolicy(undefined), 0), undefined);
	});
	test("a percentage of the model window resolves to floor(window × percent / 100)", () => {
		const percent = resolveBudgetPolicy({ contextBudgetPercent: 80 });
		assert.deepEqual(resolveBudget(percent, 100_000), { budget: 80_000, reserve: 2048, source: "config", budgetPercent: 80 });
		assert.deepEqual(resolveBudget(percent, 272_000), { budget: 217_600, reserve: 2048, source: "config", budgetPercent: 80 });
		assert.deepEqual(resolveBudget(resolveBudgetPolicy({ contextBudgetPercent: 25 }), 100_000), {
			budget: 25_000,
			reserve: 2048,
			source: "config",
			budgetPercent: 25,
		});
	});
	test("a percentage needs a known window; without one there is no fixed budget", () => {
		const percent = resolveBudgetPolicy({ contextBudgetPercent: 80 });
		assert.equal(resolveBudget(percent, undefined), undefined);
		assert.equal(resolveBudget(percent, 0), undefined);
	});
	test("a percentage is mutually exclusive with a token budget and must be in (0, 100]", () => {
		assert.throws(() => resolveBudgetPolicy({ contextBudget: 32_000, contextBudgetPercent: 80 }), /mutually exclusive/);
		assert.throws(() => resolveBudgetPolicy({ contextBudgetPercent: 0 }), /\(0, 100\]/);
		assert.throws(() => resolveBudgetPolicy({ contextBudgetPercent: 100.5 }), /\(0, 100\]/);
		assert.throws(() => resolveBudgetPolicy({ contextBudgetPercent: -5 }), /\(0, 100\]/);
	});
	test("reserve is clamped to the budget and colliding tiers are deduplicated", () => {
		const tiny = resolveBudgetPolicy({ contextBudget: 1000, reserve: 5000, remindAtFractions: [0.5] });
		const resolved = resolveBudget(tiny, undefined)!;
		assert.equal(resolved.reserve, 1000);
		assert.deepEqual(budgetTiers(tiny, resolved.budget, resolved.reserve).map((t) => t.label), ["50%"]);
		const same = resolveBudgetPolicy({ contextBudget: 1000, reserve: 100, remindAtFractions: [0.9] });
		assert.deepEqual(budgetTiers(same, 1000, 100).map((t) => t.label), ["budget-reserve"]);
	});
	test("rejects nonsensical configuration", () => {
		assert.throws(() => resolveBudgetPolicy({ contextBudget: 0 }), /positive/);
		assert.throws(() => resolveBudgetPolicy({ reserve: -1 }), /nonnegative/);
		assert.throws(() => resolveBudgetPolicy({ remindAtFractions: [1.5] }), /\(0, 1\)/);
	});
	test("environment overrides parse numbers, percentages, fraction lists, and off", () => {
		assert.deepEqual(budgetPolicyFromEnv({ PI_CLM_BUDGET: "16000", PI_CLM_RESERVE: "1024", PI_CLM_REMIND_AT: "0.25, 0.9" }), {
			contextBudget: 16_000,
			reserve: 1024,
			remindAtFractions: [0.25, 0.9],
		});
		assert.deepEqual(budgetPolicyFromEnv({ PI_CLM_BUDGET: "80%" }), { contextBudgetPercent: 80 });
		assert.deepEqual(budgetPolicyFromEnv({ PI_CLM_BUDGET: " 12.5% " }), { contextBudgetPercent: 12.5 });
		assert.deepEqual(budgetPolicyFromEnv({ PI_CLM_REMIND_AT: "off" }), { remindAtFractions: [], remindAtReserve: false });
		assert.deepEqual(budgetPolicyFromEnv({}), {});
		assert.throws(() => resolveBudgetPolicy(budgetPolicyFromEnv({ PI_CLM_BUDGET: "lots" })), /positive/);
		assert.throws(() => budgetPolicyFromEnv({ PI_CLM_BUDGET: "nope%" }), /PI_CLM_BUDGET/);
	});
});

describe("budget tracker", () => {
	test("fires the highest newly crossed tier once and re-arms after dropping below it", () => {
		const tracker = new BudgetTracker();
		assert.equal(tracker.observe(reading(10_000), tiers), undefined);
		assert.equal(tracker.observe(reading(16_500), tiers)?.label, "50%");
		assert.equal(tracker.observe(reading(17_000), tiers), undefined);
		assert.equal(tracker.observe(reading(29_000), tiers)?.label, "90%");
		assert.equal(tracker.observe(reading(30_000), tiers)?.label, "budget-reserve");
		assert.equal(tracker.observe(reading(31_000), tiers), undefined);
		// A large edit brings usage down; tiers re-arm.
		assert.equal(tracker.observe(reading(4_000), tiers), undefined);
		assert.equal(tracker.observe(reading(16_500), tiers)?.label, "50%");
	});
	test("the larger of estimated and observed governs", () => {
		const tracker = new BudgetTracker();
		assert.equal(governingTokens(reading(1_000, 20_000)), 20_000);
		assert.equal(tracker.observe(reading(1_000, 20_000), tiers)?.label, "50%");
		assert.equal(tracker.observe(reading(25_000, 20_000), tiers)?.label, "75%");
	});
	test("a stale observation (taken before the last accepted edit) never governs", () => {
		const tracker = new BudgetTracker();
		assert.equal(governingTokens({ estimated: 1_000, observed: 30_000, observedStale: true }), 1_000);
		assert.equal(tracker.observe({ ...reading(1_000, 30_000), observedStale: true }, tiers), undefined);
		assert.match(budgetSummaryLine({ ...reading(1_000, 30_000), observedStale: true }), /30,000 \(before the last accepted edit\)/);
		assert.match(budgetNoticeText({ ...reading(17_000, 30_000), observedStale: true }, tiers[0]!, undefined), /before your last accepted edit/);
	});
	test("changing the tier set (e.g. /clm budget) resets fired state", () => {
		const tracker = new BudgetTracker();
		assert.equal(tracker.observe(reading(20_000), tiers)?.label, "50%");
		const smaller = budgetTiers(policy, 24_000, 2048);
		assert.equal(tracker.observe({ ...reading(20_000), budget: 24_000 }, smaller)?.label, "75%");
	});
	test("reset clears fired tiers", () => {
		const tracker = new BudgetTracker();
		tracker.observe(reading(20_000), tiers);
		tracker.reset();
		assert.equal(tracker.observe(reading(20_000), tiers)?.label, "50%");
	});
});

describe("budget text", () => {
	test("notice labels estimated and observed separately and states the budget and remaining tokens", () => {
		const text = budgetNoticeText(reading(17_000, 16_200), tiers[0]!, "/tmp/m/LIVE_CONTEXT.md");
		assert.match(text, /^\[CLM BUDGET\] Context crossed 50% of a 32,000-token budget/);
		assert.match(text, /estimated 17,000 tokens for the next request/);
		assert.match(text, /provider reported 16,200 for the previous one/);
		assert.match(text, /15,000 tokens remain/);
		assert.match(text, /final reminder comes at 29,952 tokens/);
		assert.match(text, /\/tmp\/m\/LIVE_CONTEXT\.md/);
	});
	test("summary line names a percentage budget as configured against the model window", () => {
		const text = budgetSummaryLine({ ...reading(10_000), budget: 80_000, budgetPercent: 80 });
		assert.match(text, /budget 80,000 tok \(configured \(80% of model window\), reserve 2,048\)/);
	});
	test("notice says when the observed size is unknown instead of implying a measurement", () => {
		const text = budgetNoticeText(reading(17_000), tiers[0]!, undefined);
		assert.match(text, /provider-reported size of the previous request unknown/);
		assert.match(text, /the context mirror/);
	});
	test("reserve notice is imperative and names the reserve", () => {
		const text = budgetNoticeText(reading(30_500, 30_100), tiers[3]!, "/m");
		assert.match(text, /^\[CLM BUDGET\] Context is at 30,500 of a 32,000-token budget/);
		assert.match(text, /Only 1,500 tokens remain/);
		assert.match(text, /2,048-token generation reserve/);
		assert.match(text, /Edit \/m now/);
	});
	test("summary line separates the three numbers and names the budget source", () => {
		assert.equal(
			budgetSummaryLine(reading(12_345, 11_900)),
			"budget 32,000 tok (configured, reserve 2,048) · estimated next request 12,345 · observed previous request 11,900",
		);
		assert.match(budgetSummaryLine({ ...reading(1), source: "model-window" }), /model window/);
		assert.match(budgetSummaryLine(reading(1)), /observed previous request: unknown/);
	});
});

describe("estimate calibrator", () => {
	test("learns an undercount factor from provider counts, only for the request it recorded", () => {
		const c = new EstimateCalibrator();
		assert.equal(c.factor, 1);
		c.record(10_000, 5);
		// A message that predates the recorded request is not its measurement.
		assert.equal(c.observe({ tokens: 25_000, index: 4 }), 1);
		assert.equal(c.observe({ tokens: 25_000, index: 5 }), 2.5);
		assert.equal(c.sampleCount, 1);
		assert.equal(c.apply(1_000), 2_500);
		// Second sample is smoothed, never below 1, capped at 4.
		c.record(10_000, 9);
		assert.equal(c.observe({ tokens: 5_000, index: 9 }), 1.5);
		c.record(1, 12);
		assert.equal(c.observe({ tokens: 1_000_000, index: 12 }), 4);
		c.reset();
		assert.equal(c.factor, 1);
		assert.equal(c.apply(1_000), 1_000);
	});
	test("without a pending record or observation the factor stays put", () => {
		const c = new EstimateCalibrator();
		assert.equal(c.observe(undefined), 1);
		assert.equal(c.observe({ tokens: 100, index: 0 }), 1);
		c.record(0, 0);
		assert.equal(c.observe({ tokens: 100, index: 0 }), 1);
	});
	test("notice and status show the calibration when it is above 1", () => {
		const text = budgetNoticeText({ ...reading(17_000, 16_000), calibration: 1.83 }, tiers[0]!, undefined);
		assert.match(text, /estimated 17,000 tokens for the next request \(calibrated ×1\.83 from provider counts\); the provider/);
		assert.doesNotMatch(budgetNoticeText({ ...reading(17_000), calibration: 1 }, tiers[0]!, undefined), /calibrated/);
		assert.match(budgetSummaryLine({ ...reading(1_000), calibration: 2 }), /estimated next request 1,000 \(×2\.00 calibrated\)/);
	});
});

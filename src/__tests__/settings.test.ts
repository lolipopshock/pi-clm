import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	applyOverrides,
	CLM_SETTINGS,
	defaultClmSettings,
	sanitizeOverrides,
	settingDescriptor,
} from "../settings.ts";

describe("CLM settings", () => {
	test("every panel choice, once applied, shows as a listed choice (so cycling moves on)", () => {
		const base = defaultClmSettings({});
		for (const descriptor of CLM_SETTINGS) {
			for (const choice of descriptor.choices ?? []) {
				const applied = applyOverrides(base, descriptor.parse(choice, "/bundled/house-brief.md"));
				assert.ok(
					descriptor.choices!.includes(descriptor.format(applied, {})),
					`${descriptor.label}: "${choice}" shows as "${descriptor.format(applied, {})}"`,
				);
			}
		}
	});

	test("stored overrides keep well-formed values and drop the rest", () => {
		assert.deepEqual(
			sanitizeOverrides({
				budget: 200_000,
				reserve: 0,
				reminders: [0.5, 0.9],
				guard: "off",
				cap: null,
				steering: "brief.md",
				oneTool: true,
			}),
			{ overrides: { budget: 200_000, reserve: 0, reminders: [0.5, 0.9], guard: "off", cap: null, steering: "brief.md", oneTool: true }, ignored: [] },
		);
		assert.deepEqual(
			sanitizeOverrides({ reminders: "50/75", budget: -1, cap: 50, compaction: "sometimes", trailer: "yes", compactTarget: 0.5, capHead: 1 }),
			{ overrides: { capHead: 1 }, ignored: ["reminders", "budget", "cap", "compaction", "trailer", "compactTarget"] },
		);
		assert.deepEqual(sanitizeOverrides(null), { overrides: {}, ignored: [] });
		assert.deepEqual(sanitizeOverrides(["budget"]), { overrides: {}, ignored: ["overrides"] });
		// A percentage budget is a well-formed stored override; nonsense values drop.
		assert.deepEqual(sanitizeOverrides({ budgetPercent: 80 }), { overrides: { budgetPercent: 80 }, ignored: [] });
		assert.deepEqual(sanitizeOverrides({ budgetPercent: 0 }), { overrides: {}, ignored: ["budgetPercent"] });
		assert.deepEqual(sanitizeOverrides({ budgetPercent: 100.5 }), { overrides: {}, ignored: ["budgetPercent"] });
	});

	test("budget parses tokens, percentages, and unsetting; one kind clears the other", () => {
		const descriptor = settingDescriptor("budget")!;
		const base = defaultClmSettings({});
		const tokens = applyOverrides(base, descriptor.parse("200k", ""));
		assert.equal(tokens.budget, 200_000);
		assert.equal(tokens.budgetPercent, undefined);
		assert.equal(descriptor.format(tokens, { modelWindow: 272_000 }), "200k");

		const percent = applyOverrides(base, descriptor.parse("80%", ""));
		assert.equal(percent.budget, undefined);
		assert.equal(percent.budgetPercent, 80);
		assert.equal(descriptor.format(percent, { modelWindow: 100_000 }), "80% of window (80k)");

		// A bare number stays tokens (backwards compatible); only a trailing % means percent.
		const bare = applyOverrides(base, descriptor.parse("80", ""));
		assert.equal(bare.budget, 80);
		assert.equal(bare.budgetPercent, undefined);

		// "window" unsets both, reverting to the model window.
		const window_ = applyOverrides(percent, descriptor.parse("window", ""));
		assert.equal(window_.budget, undefined);
		assert.equal(window_.budgetPercent, undefined);
		assert.equal(descriptor.format(window_, { modelWindow: 272_000 }), "model window (272k)");

		assert.throws(() => descriptor.parse("0%", ""), /\(0, 100\]/);
		assert.throws(() => descriptor.parse("150%", ""), /\(0, 100\]/);
	});

	test("env percentage becomes the default budget setting", () => {
		const settings = defaultClmSettings({ budget: { contextBudgetPercent: 80 } });
		assert.equal(settings.budgetPercent, 80);
		assert.equal(settings.budget, undefined);
	});
});

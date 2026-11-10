import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { clmOptions } from "../../index.ts";
import { resolveBudgetPolicy } from "../budget.ts";
import { clmSettingsFilePath, loadClmSettingsFile } from "../settings-file.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-clm-settings-file-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const path = join(dir, "settings.json");
const BUNDLED = "/package/steering/house-brief.md";

function write(content: unknown): string {
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
	return path;
}

/** The defaults of a file that is used in full. */
function load(content: unknown) {
	const { defaults, warning } = loadClmSettingsFile(write(content), BUNDLED);
	assert.equal(warning, undefined);
	return defaults;
}

describe("settings file", () => {
	test("lives in the extension's directory under the agent directory", () => {
		assert.equal(clmSettingsFilePath("/agent"), join("/agent", "pi-clm", "settings.json"));
	});

	test("a missing file sets nothing", () => {
		assert.deepEqual(loadClmSettingsFile(join(dir, "absent.json"), BUNDLED), { defaults: {} });
	});

	test("takes the names and values of /clm config", () => {
		const defaults = load({
			budget: "200k",
			reserve: "4k",
			reminders: "75/90%",
			guard: "off",
			compaction: "on",
			cap: "10k:0.5",
			steering: "house",
			"one-tool": "on",
			trailer: "on",
			"compact-prompt": "/prompts/team.md",
		});
		assert.deepEqual(defaults, {
			budget: { contextBudget: 200_000, reserve: 4000, remindAtFractions: [0.75, 0.9] },
			overflow: { mode: "off" },
			nativeCompaction: "on",
			observationCap: { maxCharacters: 10_000, headFraction: 0.5 },
			steeringPath: BUNDLED,
			oneToolPerTurn: true,
			sizeTrailer: true,
			compactPromptPath: "/prompts/team.md",
		});
	});

	test("accepts JSON numbers and booleans, and the values that mean unset", () => {
		assert.deepEqual(load({ budget: 200000, reserve: 1024, "one-tool": true, trailer: false }), {
			budget: { contextBudget: 200_000, reserve: 1024 },
			oneToolPerTurn: true,
			sizeTrailer: false,
		});
		assert.deepEqual(load({ budget: "window", cap: "off", steering: "none", "compact-prompt": "default" }), {});
	});

	test("reminders off also turns off the reminder at budget − reserve", () => {
		assert.deepEqual(load({ reminders: "off" }), { budget: { remindAtFractions: [], remindAtReserve: false } });
	});

	test("resolves ~ and paths relative to the file", () => {
		const defaults = load({ steering: "~/briefs/mine.md", "compact-prompt": "compact.md" });
		assert.equal(defaults.steeringPath, join(homedir(), "briefs", "mine.md"));
		assert.equal(defaults.compactPromptPath, join(dir, "compact.md"));
		assert.ok(load({ steering: "~\\briefs\\mine.md" }).steeringPath?.startsWith(homedir()), "~\\ as written on Windows");
	});

	test("reads a file saved with a byte order mark", () => {
		assert.deepEqual(load(`\uFEFF${JSON.stringify({ budget: "200k" })}`), { budget: { contextBudget: 200_000 } });
	});

	test("a file that cannot be read as settings is ignored, with a warning naming it", () => {
		for (const [content, pattern] of [["{ budget: ", /not valid JSON/], [["budget"], /expected a JSON object/], ["", /not valid JSON/]] as const) {
			const { defaults, warning } = loadClmSettingsFile(write(content), BUNDLED);
			assert.deepEqual(defaults, {});
			assert.ok(warning?.startsWith(`settings file ignored (${path}): `), warning);
			assert.match(warning ?? "", pattern);
		}
		// Present but unreadable (here: a directory) is reported too, not mistaken for absent.
		assert.match(loadClmSettingsFile(dir, BUNDLED).warning!, /settings file ignored .*EISDIR/);
	});

	test("a setting that cannot be used is skipped with a warning, and the rest applies", () => {
		const skips = (entry: Record<string, unknown>, pattern: RegExp) => {
			const { defaults, warning } = loadClmSettingsFile(write({ ...entry, reserve: "4k" }), BUNDLED);
			assert.deepEqual(defaults, { budget: { reserve: 4000 } }, JSON.stringify(entry));
			assert.ok(warning?.startsWith(`settings file (${path}): ignored `), warning);
			assert.match(warning ?? "", pattern);
		};
		skips({ budgte: "200k" }, /ignored unknown setting "budgte"\. Settings: budget, reserve,/);
		skips({ budget: "lots" }, /budget: expected a number of tokens/);
		skips({ budget: 0 }, /budget: 0 is out of range/);
		skips({ cap: "100" }, /cap: observation cap must be at least 200/);
		skips({ reminders: [0.5, 0.9] }, /reminders must be a string, number or boolean/);
		skips({ steering: null }, /steering must be a string, number or boolean/);
		skips({ budgte: 1, guard: "maybe" }, /unknown setting "budgte"; guard: .*\. Settings: /);
	});
});

describe("settings file and environment", () => {
	const file = () => write({
		budget: "200k",
		reserve: "4k",
		reminders: "off",
		guard: "off",
		compaction: "off",
		cap: "10k:0.5",
		steering: "/briefs/mine.md",
		"one-tool": "on",
		trailer: "on",
		"compact-prompt": "/prompts/team.md",
	});

	test("without a file the options are the environment's, as before", () => {
		assert.deepEqual(clmOptions({ PI_CLM_BUDGET: "16000", PI_CLM_STEERING: "/env.md" }, join(dir, "absent.json")), {
			editingMode: "clm",
			budget: { contextBudget: 16_000 },
			observationCap: {},
			steeringPath: "/env.md",
			overflow: {},
			nativeCompaction: undefined,
			estimateFactor: undefined,
			oneToolPerTurn: false,
			sizeTrailer: false,
			compactPromptPath: undefined,
			settingsFileWarning: undefined,
			banner: { enabled: true },
		});
	});

	test("the file sets the defaults when the environment is silent", () => {
		const options = clmOptions({}, file());
		assert.deepEqual(resolveBudgetPolicy(options.budget), { contextBudget: 200_000, reserve: 4000, remindAtFractions: [], remindAtReserve: false });
		assert.deepEqual(options.observationCap, { maxCharacters: 10_000, headFraction: 0.5 });
		assert.deepEqual(options.overflow, { mode: "off" });
		assert.equal(options.nativeCompaction, "off");
		assert.equal(options.steeringPath, "/briefs/mine.md");
		assert.equal(options.oneToolPerTurn, true);
		assert.equal(options.sizeTrailer, true);
		assert.equal(options.compactPromptPath, "/prompts/team.md");
		assert.equal(options.settingsFileWarning, undefined);
	});

	test("what the file could not supply is reported, and the environment still applies", () => {
		const options = clmOptions({ PI_CLM_RESERVE: "1024" }, write({ budgte: "200k", cap: "10k" }));
		assert.match(options.settingsFileWarning!, /unknown setting "budgte"/);
		assert.deepEqual(options.budget, { reserve: 1024 });
		assert.deepEqual(options.observationCap, { maxCharacters: 10_000 });
	});

	test("an environment variable overrides the file's value, including to turn it off", () => {
		const options = clmOptions({
			PI_CLM_BUDGET: "50000",
			PI_CLM_REMIND_AT: "0.5",
			PI_CLM_OVERFLOW: "withhold",
			PI_CLM_NATIVE_COMPACTION: "auto",
			PI_CLM_OBSERVATION_CAP: "off",
			PI_CLM_STEERING: "none",
			PI_CLM_ONE_TOOL_PER_TURN: "0",
			PI_CLM_SIZE_TRAILER: "off",
			PI_CLM_COMPACT_PROMPT: "default",
		}, file());
		// The reserve has no variable set, so the file's stays; the reminder at budget − reserve is back on.
		assert.deepEqual(resolveBudgetPolicy(options.budget), { contextBudget: 50_000, reserve: 4000, remindAtFractions: [0.5], remindAtReserve: true });
		assert.deepEqual(options.observationCap, {});
		assert.deepEqual(options.overflow, { mode: "withhold" });
		assert.equal(options.nativeCompaction, "auto");
		assert.equal(options.steeringPath, undefined);
		assert.equal(options.oneToolPerTurn, false);
		assert.equal(options.sizeTrailer, false);
		assert.equal(options.compactPromptPath, undefined);
	});
});

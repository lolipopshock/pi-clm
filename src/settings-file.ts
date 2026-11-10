/**
 * The settings file: `<agent dir>/pi-clm/settings.json`, a JSON object whose names and
 * values are those of `/clm config`, e.g. `{ "budget": "200k", "reminders": "75/90%" }`.
 *
 * It holds defaults for every session. It is read once, when the extension loads, so an
 * edit applies on the next `/reload`; an environment variable overrides its value (see
 * `index.ts`), and session overrides apply on top of both.
 *
 * A hand-edited file must never stop Pi from starting: whatever cannot be used is skipped
 * and reported as a warning, and the rest applies.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { LiveContextExtensionOptions } from "./index.ts";
import { CLM_SETTING_COMMAND_KEYS, sanitizeOverrides, settingDescriptor, type ClmSettingsOverrides } from "./settings.ts";

export type ClmFileDefaults = Pick<
	LiveContextExtensionOptions,
	"budget" | "observationCap" | "steeringPath" | "overflow" | "nativeCompaction" | "oneToolPerTurn" | "sizeTrailer" | "compactPromptPath"
>;

export interface ClmSettingsFile {
	defaults: ClmFileDefaults;
	/** What was skipped and why, naming the file; undefined when all of it was used. */
	warning?: string;
}

export function clmSettingsFilePath(agentDir: string): string {
	return join(agentDir, "pi-clm", "settings.json");
}

/** The defaults in the file at `path`. A missing file sets nothing, without a warning. */
export function loadClmSettingsFile(path: string, bundledSteering: string): ClmSettingsFile {
	let raw: unknown;
	try {
		// Some Windows editors save UTF-8 with a byte order mark, which JSON.parse rejects.
		raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { defaults: {} };
		const message = error instanceof Error ? error.message : String(error);
		return { defaults: {}, warning: `settings file ignored (${path}): ${error instanceof SyntaxError ? `not valid JSON (${message})` : message}` };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { defaults: {}, warning: `settings file ignored (${path}): expected a JSON object of settings` };
	}

	const set: ClmSettingsOverrides = {};
	const skipped: string[] = [];
	let unknown = false;
	for (const [name, value] of Object.entries(raw)) {
		const descriptor = settingDescriptor(name);
		if (!descriptor) {
			unknown = true;
			skipped.push(`unknown setting "${name}"`);
		} else if (!["string", "number", "boolean"].includes(typeof value)) {
			skipped.push(`${name} must be a string, number or boolean`);
		} else {
			try {
				const parsed = descriptor.parse(String(value), bundledSteering);
				if (sanitizeOverrides(parsed).ignored.length > 0) throw new Error(`${String(value)} is out of range`);
				Object.assign(set, parsed);
			} catch (error) {
				skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	const warning = skipped.length === 0
		? undefined
		: `settings file (${path}): ignored ${skipped.join("; ")}${unknown ? `. Settings: ${CLM_SETTING_COMMAND_KEYS.join(", ")}` : ""}`;

	// A file read from any working directory: `~` is the home directory, other relative paths start at the file.
	const at = (value: string) => resolve(dirname(path), value.replace(/^~(?=$|[\\/])/, homedir()));
	const defaults: ClmFileDefaults = {};
	const budget: NonNullable<ClmFileDefaults["budget"]> = {};
	if (typeof set.budget === "number") budget.contextBudget = set.budget;
	if (typeof set.reserve === "number") budget.reserve = set.reserve;
	if (set.reminders) {
		budget.remindAtFractions = set.reminders;
		// As PI_CLM_REMIND_AT=off does: no reminders means none at budget − reserve either.
		if (set.reminders.length === 0) budget.remindAtReserve = false;
	}
	if (Object.keys(budget).length > 0) defaults.budget = budget;
	if (typeof set.cap === "number") {
		defaults.observationCap = { maxCharacters: set.cap, ...(typeof set.capHead === "number" ? { headFraction: set.capHead } : {}) };
	}
	if (set.guard) defaults.overflow = { mode: set.guard };
	if (set.compaction) defaults.nativeCompaction = set.compaction;
	if (set.steering) defaults.steeringPath = at(set.steering);
	if (typeof set.oneTool === "boolean") defaults.oneToolPerTurn = set.oneTool;
	if (typeof set.trailer === "boolean") defaults.sizeTrailer = set.trailer;
	if (set.compactPrompt) defaults.compactPromptPath = at(set.compactPrompt);
	return { defaults, warning };
}

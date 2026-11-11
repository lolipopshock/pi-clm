/**
 * CLM settings: one table of the knobs the plugin exposes, their defaults (from the
 * environment at load, see `index.ts`), per-session overrides made from the panel or
 * `/clm config`, and how each is shown and parsed.
 *
 * Overrides are saved as a session entry (`pi-clm-settings`), so they are branch-local
 * and survive resume and `/reload` like the projection itself; environment variables
 * remain the defaults for new sessions.
 */

import { basename } from "node:path";

import { DEFAULT_BUDGET_POLICY } from "./budget.ts";
import { DEFAULT_OBSERVATION_CAP } from "./observation.ts";

export const CLM_SETTINGS_ENTRY = "pi-clm-settings";

export interface ClmSettings {
	/** Context budget in tokens; undefined follows the model window. */
	budget?: number;
	/**
	 * Context budget as a percentage (0, 100] of the model's context window, e.g. 80 means
	 * 80% of the window. Mutually exclusive with `budget`: setting one unsets the other, and
	 * the effective budget is floor(window × percent / 100) when the window is known.
	 */
	budgetPercent?: number;
	reserve: number;
	/** Reminder fractions of the budget; empty disables reminders (including the reserve one). */
	reminders: number[];
	guard: "withhold" | "off";
	compaction: "auto" | "off" | "on";
	/** Characters kept per tool result; undefined disables the cap. */
	cap?: number;
	capHead: number;
	/** Steering document path; undefined is protocol only. */
	steering?: string;
	oneTool: boolean;
	trailer: boolean;
	/** `/clm-compact` prompt template path; undefined uses the built-in prompt. */
	compactPrompt?: string;
}

export type ClmSettingKey = keyof Omit<ClmSettings, "capHead">;

/** Stored overrides. `null` means "explicitly unset" for optional settings (e.g. budget → model window). */
export type ClmSettingsOverrides = { [K in keyof ClmSettings]?: ClmSettings[K] | null };

export interface ClmSettingsEntry {
	version: 1;
	overrides: ClmSettingsOverrides;
}

export function defaultClmSettings(input: {
	budget?: { contextBudget?: number; contextBudgetPercent?: number; reserve?: number; remindAtFractions?: readonly number[] };
	overflow?: { mode?: "withhold" | "off" };
	nativeCompaction?: "auto" | "off" | "on";
	observationCap?: { maxCharacters?: number; headFraction?: number };
	steeringPath?: string;
	oneToolPerTurn?: boolean;
	sizeTrailer?: boolean;
	compactPromptPath?: string;
}): ClmSettings {
	return {
		budget: input.budget?.contextBudget,
		budgetPercent: input.budget?.contextBudgetPercent,
		reserve: input.budget?.reserve ?? DEFAULT_BUDGET_POLICY.reserve,
		reminders: [...(input.budget?.remindAtFractions ?? DEFAULT_BUDGET_POLICY.remindAtFractions)],
		guard: input.overflow?.mode ?? "withhold",
		compaction: input.nativeCompaction ?? "auto",
		cap: input.observationCap?.maxCharacters,
		capHead: input.observationCap?.headFraction ?? DEFAULT_OBSERVATION_CAP.headFraction,
		steering: input.steeringPath,
		oneTool: input.oneToolPerTurn === true,
		trailer: input.sizeTrailer === true,
		compactPrompt: input.compactPromptPath,
	};
}

export function applyOverrides(base: ClmSettings, overrides: ClmSettingsOverrides): ClmSettings {
	const next: ClmSettings = { ...base, reminders: [...base.reminders] };
	for (const [key, value] of Object.entries(overrides) as [keyof ClmSettings, unknown][]) {
		if (value === undefined) continue;
		(next as unknown as Record<string, unknown>)[key] = value === null ? undefined : value;
	}
	return next;
}

export function isClmSettingsEntry(value: unknown): value is ClmSettingsEntry {
	return Boolean(value) && typeof value === "object" && (value as { version?: unknown }).version === 1 &&
		typeof (value as { overrides?: unknown }).overrides === "object";
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPath = (value: unknown) => value === null || (typeof value === "string" && value.trim() !== "");

/** What each stored override may hold; the same limits the budget, cap and guard resolvers enforce. */
const VALID_OVERRIDE: Record<keyof ClmSettings, (value: unknown) => boolean> = {
	budget: (value) => value === null || (isNumber(value) && value > 0),
	budgetPercent: (value) => value === null || (isNumber(value) && value > 0 && value <= 100),
	reserve: (value) => isNumber(value) && value >= 0,
	reminders: (value) => Array.isArray(value) && value.every((fraction) => isNumber(fraction) && fraction > 0 && fraction < 1),
	guard: (value) => value === "withhold" || value === "off",
	compaction: (value) => value === "auto" || value === "off" || value === "on",
	cap: (value) => value === null || (isNumber(value) && value >= 200),
	capHead: (value) => isNumber(value) && value > 0 && value <= 1,
	steering: isPath,
	oneTool: (value) => typeof value === "boolean",
	trailer: (value) => typeof value === "boolean",
	compactPrompt: isPath,
};

/**
 * The well-formed part of a stored override set, and the names of anything else (dropped).
 * A session entry from another version or a hand edit must not break session start.
 */
export function sanitizeOverrides(raw: unknown): { overrides: ClmSettingsOverrides; ignored: string[] } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { overrides: {}, ignored: raw == null ? [] : ["overrides"] };
	const overrides: Record<string, unknown> = {};
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (Object.hasOwn(VALID_OVERRIDE, key) && VALID_OVERRIDE[key as keyof ClmSettings](value)) overrides[key] = value;
		else ignored.push(key);
	}
	return { overrides: overrides as ClmSettingsOverrides, ignored };
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}m`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return String(value);
}

/** `200k`, `1.5m`, `200000`, `200_000`, `200,000`. */
export function parseTokenCount(text: string): number {
	const match = text.trim().toLowerCase().replace(/[_,]/g, "").match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) throw new Error(`expected a number of tokens like 200k, got "${text}"`);
	const value = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
	return Math.round(value);
}

function parseOnOff(text: string, name: string): boolean {
	const value = text.trim().toLowerCase();
	if (["on", "true", "1", "yes"].includes(value)) return true;
	if (["off", "false", "0", "no"].includes(value)) return false;
	throw new Error(`${name} must be on or off, got "${text}"`);
}

function formatReminders(fractions: readonly number[]): string {
	return fractions.length === 0 ? "off" : `${fractions.map((fraction) => Math.round(fraction * 100)).join("/")}%`;
}

function parseReminders(text: string): number[] {
	const value = text.trim().toLowerCase();
	if (value === "off" || value === "none") return [];
	const parts = value.replace(/%/g, "").split(/[\s,/]+/).filter(Boolean).map(Number);
	if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
		throw new Error(`reminders must be percentages like 50/75/90 or "off", got "${text}"`);
	}
	const fractions = parts.map((part) => (part > 1 ? part / 100 : part));
	if (fractions.some((fraction) => fraction <= 0 || fraction >= 1)) throw new Error("reminder percentages must be between 0 and 100");
	return [...new Set(fractions)].sort((left, right) => left - right);
}

function formatCap(settings: ClmSettings): string {
	if (settings.cap === undefined) return "off";
	const head = Math.round(settings.capHead * 100);
	return `${formatTokens(settings.cap)} chars${head === 80 ? "" : ` (${head}% head)`}`;
}

export interface ClmSettingDescriptor {
	key: ClmSettingKey;
	label: string;
	/** Shown under the list when selected: what it does, and its environment variable. */
	description: string;
	/** Cycle values offered in the panel; absent means the panel asks for text. */
	choices?: string[];
	/** Placeholder when the panel asks for text. */
	placeholder?: string;
	format(settings: ClmSettings, context: { modelWindow?: number }): string;
	/** Parse user text into the override for this key (null = unset / follow the default source). */
	parse(text: string, bundledSteering: string): ClmSettingsOverrides;
}

export const CLM_SETTINGS: readonly ClmSettingDescriptor[] = [
	{
		key: "budget",
		label: "Budget",
		description: "Token budget reminders and the overflow guard measure against. Type a number (200k), a percentage of the model window (80%), or \"window\" to follow the model. Env: PI_CLM_BUDGET.",
		placeholder: "200k, 80%, or window",
		format: (settings, { modelWindow }) => {
			if (settings.budgetPercent !== undefined) {
				const effective = modelWindow ? Math.floor((modelWindow * settings.budgetPercent) / 100) : undefined;
				return `${settings.budgetPercent}% of window${effective !== undefined ? ` (${formatTokens(effective)})` : ""}`;
			}
			if (settings.budget !== undefined) return formatTokens(settings.budget);
			return `model window${modelWindow ? ` (${formatTokens(modelWindow)})` : ""}`;
		},
		parse: (text) => {
			const value = text.trim().toLowerCase();
			if (["window", "model", "default", "off", ""].includes(value)) return { budget: null, budgetPercent: null };
			if (value.endsWith("%")) {
				const percent = Number(value.slice(0, -1).trim());
				if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
					throw new Error(`budget percent must be in (0, 100], got "${text}"`);
				}
				return { budget: null, budgetPercent: percent };
			}
			return { budget: parseTokenCount(value), budgetPercent: null };
		},
	},
	{
		key: "reserve",
		label: "Reserve",
		description: "Room kept below the budget for the model's reply; the final reminder fires at budget − reserve. Env: PI_CLM_RESERVE.",
		placeholder: "2048",
		format: (settings) => settings.reserve.toLocaleString("en-US"),
		parse: (text) => ({ reserve: parseTokenCount(text) }),
	},
	{
		key: "reminders",
		label: "Reminders",
		description: "Budget fractions at which a [CLM BUDGET] note is added to the model's context. Env: PI_CLM_REMIND_AT.",
		choices: ["50/75/90%", "75/90%", "90%", "off"],
		format: (settings) => formatReminders(settings.reminders),
		parse: (text) => ({ reminders: parseReminders(text) }),
	},
	{
		key: "guard",
		label: "Overflow guard",
		description: "Above budget − reserve, withhold the oldest tool results (full text saved to files) so the request fits. Env: PI_CLM_OVERFLOW.",
		choices: ["on", "off"],
		format: (settings) => (settings.guard === "withhold" ? "on" : "off"),
		parse: (text) => ({ guard: parseOnOff(text.replace(/^withhold$/i, "on"), "overflow guard") ? "withhold" : "off" }),
	},
	{
		key: "compaction",
		label: "Pi compaction",
		description: "auto: pause Pi's automatic compaction while the guard enforces the budget · off: always pause · on: Pi default. Manual /compact always works. Env: PI_CLM_NATIVE_COMPACTION.",
		choices: ["auto", "off", "on"],
		format: (settings) => settings.compaction,
		parse: (text) => {
			const value = text.trim().toLowerCase();
			if (value !== "auto" && value !== "off" && value !== "on") throw new Error(`Pi compaction must be auto, off or on, got "${text}"`);
			return { compaction: value };
		},
	},
	{
		key: "cap",
		label: "Observation cap",
		description: "Keep at most this many characters of each tool result in the context (head + tail). The paper used 10k (5k + 5k: \"10k:0.5\"). Env: PI_CLM_OBSERVATION_CAP.",
		// Written as formatCap shows them, so the panel's cycle finds the current value.
		choices: ["off", "5k chars", "10k chars", "20k chars", "50k chars"],
		format: formatCap,
		parse: (text) => {
			const value = text.trim().toLowerCase();
			if (value === "off" || value === "0") return { cap: null };
			const [chars, head] = value.replace(/\s*chars?$/, "").split(":");
			const cap = parseTokenCount(chars ?? "");
			if (cap < 200) throw new Error("observation cap must be at least 200 characters");
			if (head === undefined) return { cap };
			const capHead = Number(head);
			if (!(capHead > 0 && capHead <= 1)) throw new Error(`head fraction must be in (0, 1], got "${head}"`);
			return { cap, capHead };
		},
	},
	{
		key: "steering",
		label: "Steering",
		description: "Markdown guidance appended to the system prompt (changing it re-reads the whole prompt once). \"house\" is the bundled brief; any path works. Env: PI_CLM_STEERING.",
		choices: ["none", "house-brief.md"],
		placeholder: "path/to/brief.md, house, or none",
		format: (settings) => (settings.steering ? basename(settings.steering) : "none"),
		parse: (text, bundled) => {
			const value = text.trim();
			if (["none", "off", ""].includes(value.toLowerCase())) return { steering: null };
			if (["house", "house-brief", "house-brief.md"].includes(value.toLowerCase())) return { steering: bundled };
			return { steering: value };
		},
	},
	{
		key: "oneTool",
		label: "One tool per turn",
		description: "Paper-harness parity: block every tool call after the first in an assistant turn. Env: PI_CLM_ONE_TOOL_PER_TURN.",
		choices: ["off", "on"],
		format: (settings) => (settings.oneTool ? "on" : "off"),
		parse: (text) => ({ oneTool: parseOnOff(text, "one tool per turn") }),
	},
	{
		key: "trailer",
		label: "Size trailer",
		description: "Paper-harness parity: append \"[context: ~N of B tokens]\" to every tool result. Env: PI_CLM_SIZE_TRAILER.",
		choices: ["off", "on"],
		format: (settings) => (settings.trailer ? "on" : "off"),
		parse: (text) => ({ trailer: parseOnOff(text, "size trailer") }),
	},
	{
		key: "compactPrompt",
		label: "Compact prompt",
		description: "Markdown template /clm-compact sends instead of the built-in prompt; may use {{mirror}} {{current}} {{budget}} {{instructions}}. Type a path, or \"default\" for the built-in prompt. Env: PI_CLM_COMPACT_PROMPT.",
		// A text prompt, not a cycle: a custom path is not recoverable once cycled away.
		placeholder: "path/to/prompt.md, or default",
		format: (settings) => (settings.compactPrompt ? basename(settings.compactPrompt) : "default"),
		parse: (text) => {
			const value = text.trim();
			if (["default", "none", "off", ""].includes(value.toLowerCase())) return { compactPrompt: null };
			return { compactPrompt: value };
		},
	},
];

const ALIASES: Record<string, ClmSettingKey> = {
	budget: "budget",
	reserve: "reserve",
	reminders: "reminders",
	remind: "reminders",
	guard: "guard",
	overflow: "guard",
	compaction: "compaction",
	cap: "cap",
	observation: "cap",
	steering: "steering",
	"one-tool": "oneTool",
	onetool: "oneTool",
	trailer: "trailer",
	"size-trailer": "trailer",
	"compact-prompt": "compactPrompt",
};

/** Keys users type in `/clm config <key> <value>`. */
export const CLM_SETTING_COMMAND_KEYS = [
	"budget", "reserve", "reminders", "guard", "compaction", "cap", "steering", "one-tool", "trailer", "compact-prompt",
] as const;

export function settingDescriptor(name: string): ClmSettingDescriptor | undefined {
	const key = ALIASES[name.trim().toLowerCase()] ?? (CLM_SETTINGS.some((item) => item.key === name) ? (name as ClmSettingKey) : undefined);
	return key ? CLM_SETTINGS.find((item) => item.key === key) : undefined;
}

/** Keys whose effective value differs from the default. */
export function changedSettings(base: ClmSettings, effective: ClmSettings): ClmSettingKey[] {
	return CLM_SETTINGS.filter((item) => {
		const before = item.format(base, {});
		const after = item.format(effective, {});
		return before !== after || (item.key === "steering" && base.steering !== effective.steering);
	}).map((item) => item.key);
}

/**
 * Budget and reminder policy for CLM mode.
 *
 * Two measurements are deliberately kept apart and always labelled:
 *
 * - `estimated`: the harness's provider-independent estimate of the *next* request
 *   (system prompt + effective messages + notices). Available before every call.
 * - `observed`: the provider-reported input size of the *previous* request, as Pi
 *   exposes it through `ctx.getContextUsage()`. Authoritative but one call late.
 *
 * Reminder tiers fire on whichever of the two is larger, so an underestimating
 * estimator cannot silence a reminder the provider already justified. The text always
 * states both numbers and the budget so the model has absolute length awareness rather
 * than only a percentage.
 *
 * This module never rolls back turns and never re-executes tools; it only decides when
 * to speak and what to say.
 */

export interface BudgetPolicyConfig {
	/**
	 * Context budget in tokens the reminders are measured against. Advisory: requests are
	 * never blocked or rolled back. Defaults to the model context window when omitted.
	 */
	contextBudget?: number;
	/**
	 * Context budget as a percentage (0, 100] of the model's context window: the effective
	 * budget is `floor(window × percent / 100)`. Mutually exclusive with `contextBudget` and
	 * only resolvable when the window is known; without a window the budget falls back to
	 * "follow the window" (no fixed budget).
	 */
	contextBudgetPercent?: number;
	/** Generation headroom reserved below the budget. The final reminder fires at budget - reserve. */
	reserve: number;
	/** Fractions of the budget at which escalating reminders fire (0 < f < 1), ascending. */
	remindAtFractions: readonly number[];
	/** Whether to fire the final "budget - reserve" reminder. */
	remindAtReserve: boolean;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicyConfig = {
	reserve: 2048,
	remindAtFractions: [0.5, 0.75, 0.9],
	remindAtReserve: true,
};

export interface BudgetReading {
	/** Effective budget in tokens (config or model window). */
	budget: number;
	reserve: number;
	/** Harness estimate of the next request in tokens (system prompt, messages, notices). */
	estimated: number;
	/** What the estimate knowingly leaves out, named in the notice so the gap is not misread. */
	estimateExcludes?: string;
	/** Calibration factor applied to the raw character estimate (1 = none). */
	calibration?: number;
	/** Provider-reported tokens of the previous request, when known. */
	observed?: number;
	/**
	 * True when a context edit was accepted after the observed request, so `observed`
	 * describes a context that no longer exists. A stale observation is still shown but
	 * never governs reminders, otherwise a successful compaction would trigger a reminder.
	 */
	observedStale?: boolean;
	/** Where `budget` came from, for status text. */
	source: "config" | "model-window";
	/** The percentage of the model window the budget was derived from, when configured that way. */
	budgetPercent?: number;
}

/** A reminder threshold in absolute tokens plus a stable label for re-arming. */
export interface BudgetTier {
	label: string;
	tokens: number;
}

export function resolveBudgetPolicy(overrides: Partial<BudgetPolicyConfig> | undefined): BudgetPolicyConfig {
	const merged: BudgetPolicyConfig = { ...DEFAULT_BUDGET_POLICY, ...(overrides ?? {}) };
	if (merged.contextBudget !== undefined && (!Number.isFinite(merged.contextBudget) || merged.contextBudget <= 0)) {
		throw new Error(`contextBudget must be a positive number of tokens, got ${String(merged.contextBudget)}`);
	}
	if (merged.contextBudgetPercent !== undefined && (!Number.isFinite(merged.contextBudgetPercent) || merged.contextBudgetPercent <= 0 || merged.contextBudgetPercent > 100)) {
		throw new Error(`contextBudgetPercent must be in (0, 100], got ${String(merged.contextBudgetPercent)}`);
	}
	if (merged.contextBudget !== undefined && merged.contextBudgetPercent !== undefined) {
		throw new Error("contextBudget and contextBudgetPercent are mutually exclusive; set only one");
	}
	if (!Number.isFinite(merged.reserve) || merged.reserve < 0) {
		throw new Error(`reserve must be a nonnegative number of tokens, got ${String(merged.reserve)}`);
	}
	const fractions = [...merged.remindAtFractions];
	for (const fraction of fractions) {
		if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
			throw new Error(`remindAtFractions entries must be in (0, 1), got ${String(fraction)}`);
		}
	}
	fractions.sort((left, right) => left - right);
	return { ...merged, remindAtFractions: fractions };
}

/** Read `PI_CLM_BUDGET` / `PI_CLM_RESERVE` / `PI_CLM_REMIND_AT` (comma-separated fractions). */
/** Optional prior for the estimator calibration, e.g. 1.5 for data that tokenizes densely. */
export function estimateFactorFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.PI_CLM_ESTIMATE_FACTOR?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 1 || value > 4) throw new Error(`PI_CLM_ESTIMATE_FACTOR must be between 1 and 4, got ${raw}`);
	return value;
}

/**
 * `PI_CLM_BUDGET` may be a whole number of tokens (`200000`, matching `contextBudget`) or a
 * percentage of the model's context window (`80%`, matching `contextBudgetPercent`).
 */
export function budgetPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<BudgetPolicyConfig> {
	const overrides: Partial<BudgetPolicyConfig> = {};
	const budget = env.PI_CLM_BUDGET?.trim();
	if (budget) {
		if (budget.endsWith("%")) overrides.contextBudgetPercent = Number(budget.slice(0, -1).trim());
		else overrides.contextBudget = Number(budget);
	}
	if (overrides.contextBudgetPercent !== undefined && !Number.isFinite(overrides.contextBudgetPercent)) {
		// resolveBudgetPolicy would report the same value; fail fast with the raw text.
		throw new Error(`PI_CLM_BUDGET percent must be a number followed by %, got ${budget}`);
	}
	const reserve = env.PI_CLM_RESERVE?.trim();
	if (reserve) overrides.reserve = Number(reserve);
	const remind = env.PI_CLM_REMIND_AT?.trim();
	if (remind !== undefined && remind !== "") {
		if (remind === "off" || remind === "none") {
			overrides.remindAtFractions = [];
			overrides.remindAtReserve = false;
		} else {
			overrides.remindAtFractions = remind.split(",").map((part) => Number(part.trim()));
		}
	}
	return overrides;
}

export function resolveBudget(
	policy: BudgetPolicyConfig,
	modelContextWindow: number | undefined,
): Pick<BudgetReading, "budget" | "reserve" | "source" | "budgetPercent"> | undefined {
	if (policy.contextBudgetPercent !== undefined) {
		// A percentage needs a window to mean anything; without one there is no fixed budget,
		// exactly like "follow the model window".
		if (modelContextWindow !== undefined && Number.isFinite(modelContextWindow) && modelContextWindow > 0) {
			const budget = Math.max(1, Math.floor((modelContextWindow * policy.contextBudgetPercent) / 100));
			return {
				budget,
				reserve: Math.min(policy.reserve, budget),
				source: "config",
				budgetPercent: policy.contextBudgetPercent,
			};
		}
		return undefined;
	}
	if (policy.contextBudget !== undefined) {
		return { budget: policy.contextBudget, reserve: Math.min(policy.reserve, policy.contextBudget), source: "config" };
	}
	if (modelContextWindow !== undefined && Number.isFinite(modelContextWindow) && modelContextWindow > 0) {
		return { budget: modelContextWindow, reserve: Math.min(policy.reserve, modelContextWindow), source: "model-window" };
	}
	return undefined;
}

export function budgetTiers(policy: BudgetPolicyConfig, budget: number, reserve: number): BudgetTier[] {
	const tiers: BudgetTier[] = policy.remindAtFractions.map((fraction) => ({
		label: `${Math.round(fraction * 100)}%`,
		tokens: Math.floor(budget * fraction),
	}));
	if (policy.remindAtReserve && reserve > 0 && budget - reserve > 0) {
		tiers.push({ label: "budget-reserve", tokens: budget - reserve });
	}
	tiers.sort((left, right) => left.tokens - right.tokens);
	// Drop tiers that collapse onto the same token count; keep the more urgent label.
	return tiers.filter((tier, index) => index === tiers.length - 1 || tier.tokens !== tiers[index + 1]!.tokens);
}

/** The value reminders are judged against: the larger of the two labelled measurements. */
export function governingTokens(reading: Pick<BudgetReading, "estimated" | "observed" | "observedStale">): number {
	if (reading.observedStale) return reading.estimated;
	return Math.max(reading.estimated, reading.observed ?? 0);
}

/**
 * Escalating, re-arming tier tracker over absolute token thresholds. Mirrors the
 * behaviour of the percentage-based PressureTracker but speaks in tokens against a
 * configurable budget, and re-derives tiers when the budget changes.
 */
export class BudgetTracker {
	private fired = new Set<string>();
	private tierKey = "";

	reset(): void {
		this.fired.clear();
	}

	/** Returns the highest newly crossed tier, or undefined when nothing new fired. */
	observe(reading: BudgetReading, tiers: readonly BudgetTier[]): BudgetTier | undefined {
		const key = tiers.map((tier) => `${tier.label}:${tier.tokens}`).join("|");
		if (key !== this.tierKey) {
			this.tierKey = key;
			this.fired.clear();
		}
		const tokens = governingTokens(reading);
		this.fired = new Set([...this.fired].filter((label) => {
			const tier = tiers.find((candidate) => candidate.label === label);
			return tier !== undefined && tokens >= tier.tokens;
		}));
		const crossed = tiers.filter((tier) => tokens >= tier.tokens && !this.fired.has(tier.label));
		if (crossed.length === 0) return undefined;
		const top = crossed[crossed.length - 1]!;
		for (const tier of tiers) if (tier.tokens <= top.tokens) this.fired.add(tier.label);
		return top;
	}
}

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

/** One line for status/footer: `budget 32,000 tok (config) · est 12,345 · obs 11,900`. */
export function budgetSummaryLine(reading: BudgetReading): string {
	const origin =
		reading.source === "config"
			? reading.budgetPercent !== undefined
				? `configured (${reading.budgetPercent}% of model window)`
				: "configured"
			: "model window";
	const parts = [
		`budget ${formatTokens(reading.budget)} tok (${origin}, reserve ${formatTokens(reading.reserve)})`,
		`estimated next request ${formatTokens(reading.estimated)}${reading.calibration !== undefined && reading.calibration > 1.005 ? ` (×${reading.calibration.toFixed(2)} calibrated)` : ""}`,
	];
	parts.push(
		reading.observed === undefined
			? "observed previous request: unknown"
			: `observed previous request ${formatTokens(reading.observed)}${reading.observedStale ? " (before the last accepted edit)" : ""}`,
	);
	return parts.join(" · ");
}

/** The model-facing reminder. Always states both measurements, the budget, and what happens at overflow. */
export function budgetNoticeText(reading: BudgetReading, tier: BudgetTier, mirrorPath: string | undefined): string {
	const governing = governingTokens(reading);
	const remaining = Math.max(0, reading.budget - governing);
	const where = mirrorPath ?? "the context mirror";
	const calibrated = reading.calibration !== undefined && reading.calibration > 1.005 ? ` (calibrated ×${reading.calibration.toFixed(2)} from provider counts)` : "";
	const excludes = `${calibrated}${reading.estimateExcludes ? `, excluding ${reading.estimateExcludes}` : ""}`;
	const measurement =
		reading.observed === undefined
			? `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; provider-reported size of the previous request unknown`
			: `estimated ${formatTokens(reading.estimated)} tokens for the next request${excludes}; the provider reported ${formatTokens(reading.observed)} for the previous one${reading.observedStale ? ", before your last accepted edit" : ""}`;
	if (tier.label === "budget-reserve") {
		return (
			`[CLM BUDGET] Context is at ${formatTokens(governing)} of a ${formatTokens(reading.budget)}-token budget ` +
			`(${measurement}). Only ${formatTokens(remaining)} tokens remain, which is inside the ${formatTokens(reading.reserve)}-token generation reserve. ` +
			`Edit ${where} now to free space. The budget is a target, not enforced: the request will still be sent and may overflow the provider's actual window.`
		);
	}
	return (
		`[CLM BUDGET] Context crossed ${tier.label} of a ${formatTokens(reading.budget)}-token budget: ${measurement}. ` +
		`${formatTokens(remaining)} tokens remain. You may reorganize ${where} at any time; the final reminder comes at ${formatTokens(reading.budget - reading.reserve)} tokens.`
	);
}


/**
 * Runtime calibration of the character-based estimator against the provider's own counts.
 *
 * chars/4 is a poor model for many inputs (random strings, code, non-English text tokenize
 * at 2–3 chars per token). Each request we send has an estimate; when the provider reports
 * the actual size of that request, the ratio updates a factor that scales future estimates.
 * The factor never drops below 1 (we only correct undercounting) and is capped to avoid
 * runaway from a single odd sample.
 */
export class EstimateCalibrator {
	private pending: { estimate: number; rawCount: number } | undefined;
	private current = 1;
	private samples = 0;

	constructor(private readonly options: { min?: number; max?: number; smoothing?: number; initial?: number } = {}) {
		this.current = Math.min(options.max ?? 4, Math.max(options.min ?? 1, options.initial ?? 1));
	}

	get factor(): number {
		return this.current;
	}

	get sampleCount(): number {
		return this.samples;
	}

	reset(): void {
		this.pending = undefined;
		this.current = Math.min(this.options.max ?? 4, Math.max(this.options.min ?? 1, this.options.initial ?? 1));
		this.samples = 0;
	}

	/** Remember the raw (uncalibrated) estimate of the request about to be sent. */
	record(estimate: number, rawCount: number): void {
		if (estimate > 0) this.pending = { estimate, rawCount };
	}

	/**
	 * Feed the newest provider-reported request size. `index` is the position of the
	 * reporting assistant message in the raw transcript; only a message appended after the
	 * recorded request counts as its measurement.
	 */
	observe(observed: { tokens: number; index: number } | undefined): number {
		if (!observed || !this.pending || observed.index < this.pending.rawCount) return this.current;
		const sample = observed.tokens / this.pending.estimate;
		this.pending = undefined;
		if (!Number.isFinite(sample) || sample <= 0) return this.current;
		const min = this.options.min ?? 1;
		const max = this.options.max ?? 4;
		const smoothing = this.options.smoothing ?? 0.5;
		const next = this.samples === 0 ? sample : this.current * (1 - smoothing) + sample * smoothing;
		this.current = Math.min(max, Math.max(min, next));
		this.samples += 1;
		return this.current;
	}

	apply(estimate: number): number {
		return Math.ceil(estimate * this.current);
	}
}

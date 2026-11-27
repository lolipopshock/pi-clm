/**
 * Prefix-reuse FLOPs: the inference compute a server with prefix caching spends on a
 * rollout, as defined in Context Language Models (arXiv:2609.37725, Appendix "Prefix-Reuse
 * FLOPs Computation") and implemented in the research codebase
 * (facebookresearch/context-language-models, clm/clm_harness/flops_metrics/kv_cache_flops.py).
 *
 * At request t the prompt holds P_t tokens and the model generates G_t; R_t prompt tokens are
 * served from a reused prefix and U_t = P_t − R_t are prefilled. The turn costs
 *
 *   F_t = C_token·(U_t + G_t) + C_attn·[(P_t² − R_t²)/2 + G_t·P_t + G_t²/2]
 *
 * with C_token the per-token cost of the linear layers and C_attn the cost per
 * query–key pair of the full-attention layers. The rollout's cost is Σ F_t.
 *
 * R_t comes from two sources, both recorded for every request:
 *
 * - **server cached tokens** — the provider's own count of prompt tokens served from its
 *   prefix cache (`prompt_tokens_details.cached_tokens`, Pi's `usage.cacheRead`). The research
 *   code uses this first whenever every step reports it.
 * - **prefix match** — the longest run of leading prompt units (tool definitions and system
 *   fields, then each message) that also led an earlier request of this session, mirroring
 *   the research code's fallback at message granularity. Always available.
 *
 * The headline follows the research code's priority: the server count when every request so
 * far reported it, else the prefix match (`PI_CLM_FLOPS_SOURCE` can force either). Pi's
 * OpenAI-compatible providers turn a missing cache count into 0, so in `auto` the server
 * count is trusted only once some request reported a positive value; a server that never
 * reports cache hits would otherwise look like a run without any reuse.
 *
 * Prefix-match token weights. P_t and G_t are the provider's counts. Weights live on the
 * trie of unit paths: a request's matched path weighs what earlier requests were charged for
 * it, and the new nodes share U_t in proportion to their serialized length. The weights along
 * a request's path therefore sum to its P_t (unless the matched part alone exceeds P_t, when
 * R_t is clamped to P_t), and an append-only turn reuses exactly the previous prompt. Only the
 * split of one request's new tokens between its new messages is approximate.
 *
 * Accounting only: nothing here changes a request.
 */

import { createHash } from "node:crypto";

import { promptTokens } from "./usage.ts";

export const PREFIX_REUSE_FLOPS_ENTRY = "pi-clm-flops";
export const PREFIX_REUSE_FLOPS_SUMMARY_ENTRY = "pi-clm-flops-summary";

/** Per-token and per-attention-pair FLOP constants of one model. */
export interface FlopsConstants {
	/** C_token: FLOPs per processed token of the linear layers (2 × non-embedding parameters). */
	perToken: number;
	/** C_attn: FLOPs per query–key pair of the full-attention layers (4 × layers × heads × head dim). */
	perAttentionPair: number;
	/** Where the constants came from: a preset name, or "env". */
	source: string;
}

/**
 * Presets, the constants of the research codebase (`N_BODY_PARAMS`, `ATTN_GEOMETRY`).
 * `27b`: Qwen3.5/3.6-27B and later 27B models of the same architecture (64 layers, 16 of
 * them full attention with 24 heads of dimension 256): 2 × 24.3532e9 and 4 × 16 × 6144.
 * `9b`: Qwen3.5-9B (8 full-attention layers, 16 × 256): 2 × 6.9196e9 and 4 × 8 × 4096.
 */
export const FLOPS_PRESETS: Readonly<Record<string, Omit<FlopsConstants, "source">>> = {
	"27b": { perToken: 2 * 24.3532e9, perAttentionPair: 4 * 16 * 6144 },
	"9b": { perToken: 2 * 6.9196e9, perAttentionPair: 4 * 8 * 4096 },
};

export type FlopsSourceMode = "auto" | "server" | "prefix";
export type FlopsSource = "server-cached-tokens" | "prefix-match";

export interface FlopsConfig {
	/** `auto` picks a preset from the model id; `off` disables the accounting. */
	model: "auto" | "off" | keyof typeof FLOPS_PRESETS;
	/** Explicit constants; take precedence over any preset. Both must be set together. */
	perToken?: number;
	perAttentionPair?: number;
	/** Which reused-prefix count the headline uses; both are always recorded. */
	source: FlopsSourceMode;
}

export const DEFAULT_FLOPS_CONFIG: FlopsConfig = { model: "auto", source: "auto" };

/**
 * `PI_CLM_FLOPS_MODEL` (auto | 27b | 9b | off), `PI_CLM_FLOPS_PER_TOKEN`, `PI_CLM_FLOPS_PER_PAIR`,
 * `PI_CLM_FLOPS_SOURCE` (auto | server | prefix).
 */
export function flopsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<FlopsConfig> {
	const config: Partial<FlopsConfig> = {};
	const model = env.PI_CLM_FLOPS_MODEL?.trim().toLowerCase();
	if (model) {
		if (model !== "auto" && model !== "off" && !Object.hasOwn(FLOPS_PRESETS, model)) {
			throw new Error(`PI_CLM_FLOPS_MODEL must be auto, off or one of ${Object.keys(FLOPS_PRESETS).join(", ")}, got ${model}`);
		}
		config.model = model as FlopsConfig["model"];
	}
	const source = env.PI_CLM_FLOPS_SOURCE?.trim().toLowerCase();
	if (source) {
		if (source !== "auto" && source !== "server" && source !== "prefix") {
			throw new Error(`PI_CLM_FLOPS_SOURCE must be auto, server or prefix, got ${source}`);
		}
		config.source = source;
	}
	const number = (name: string): number | undefined => {
		const raw = env[name]?.trim();
		if (!raw) return undefined;
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
		return value;
	};
	const perToken = number("PI_CLM_FLOPS_PER_TOKEN");
	const perAttentionPair = number("PI_CLM_FLOPS_PER_PAIR");
	if ((perToken === undefined) !== (perAttentionPair === undefined)) {
		throw new Error("PI_CLM_FLOPS_PER_TOKEN and PI_CLM_FLOPS_PER_PAIR must be set together");
	}
	if (perToken !== undefined) config.perToken = perToken;
	if (perAttentionPair !== undefined) config.perAttentionPair = perAttentionPair;
	return config;
}

/**
 * Default rule: explicit constants, else the named preset, else (`auto`) the preset whose
 * size appears in a Qwen3.5-or-later model id (`qwen3.6-27b`, `Qwen/Qwen3.8-27B`,
 * `qwen35-9b`). Any other model has no constants: tokens are still counted, FLOPs are not.
 */
export function resolveFlopsConstants(config: Pick<FlopsConfig, "model" | "perToken" | "perAttentionPair">, modelId: string | undefined): FlopsConstants | undefined {
	if (config.model === "off") return undefined;
	if (config.perToken !== undefined && config.perAttentionPair !== undefined) {
		return { perToken: config.perToken, perAttentionPair: config.perAttentionPair, source: "env" };
	}
	if (config.model !== "auto") return { ...FLOPS_PRESETS[config.model]!, source: config.model };
	const id = modelId ?? "";
	if (!/qwen-?3(?:\.[5-9]|[5-9])/i.test(id)) return undefined;
	for (const size of Object.keys(FLOPS_PRESETS)) {
		if (new RegExp(`(?:^|[^0-9.])${size}(?:$|[^a-z0-9])`, "i").test(id)) return { ...FLOPS_PRESETS[size]!, source: size };
	}
	return undefined;
}

export interface FlopsBreakdown {
	linear: number;
	attention: number;
	total: number;
}

/** F_t for one request; see the module comment. */
export function requestFlops(
	constants: Pick<FlopsConstants, "perToken" | "perAttentionPair">,
	tokens: { prompt: number; reused: number; output: number },
): FlopsBreakdown {
	const P = tokens.prompt;
	const R = Math.max(0, Math.min(tokens.reused, P));
	const G = tokens.output;
	const linear = constants.perToken * (P - R + G);
	const attention = constants.perAttentionPair * ((P * P - R * R) / 2 + G * P + (G * G) / 2);
	return { linear, attention, total: linear + attention };
}

/** Running totals of a branch. FLOPs fields are null when no request had model constants. */
export interface FlopsTotals {
	requests: number;
	promptTokens: number;
	outputTokens: number;
	/** Prefix match: reused and newly prefilled prompt tokens, and Σ F_t. */
	prefixReusedTokens: number;
	prefixNewTokens: number;
	prefixMatchFlops: number;
	prefixMatchLinearFlops: number;
	prefixMatchAttentionFlops: number;
	/** Server cached tokens and Σ F_t from them; null once a request reported no count. */
	serverCachedTokens: number | null;
	serverCachedFlops: number | null;
	serverCachedLinearFlops: number | null;
	serverCachedAttentionFlops: number | null;
	/** Requests whose provider reported a positive cache count (see `auto` in the module comment). */
	serverPositiveRequests: number;
	/** Requests counted without constants (unknown model); their FLOPs are not in the sums. */
	requestsWithoutFlops: number;
	/** Headline: the source chosen by `PI_CLM_FLOPS_SOURCE` and its Σ F_t (null when unavailable). */
	source: FlopsSource;
	flops: number | null;
}

export function emptyFlopsTotals(): FlopsTotals {
	return {
		requests: 0, promptTokens: 0, outputTokens: 0,
		prefixReusedTokens: 0, prefixNewTokens: 0, prefixMatchFlops: 0, prefixMatchLinearFlops: 0, prefixMatchAttentionFlops: 0,
		serverCachedTokens: 0, serverCachedFlops: 0, serverCachedLinearFlops: 0, serverCachedAttentionFlops: 0,
		serverPositiveRequests: 0, requestsWithoutFlops: 0, source: "prefix-match", flops: 0,
	};
}

/** The headline source and value for a set of totals. */
export function headlineFlops(totals: FlopsTotals, mode: FlopsSourceMode): { source: FlopsSource; flops: number | null } {
	const useServer = mode === "server" ||
		(mode === "auto" && totals.serverCachedFlops !== null && totals.serverPositiveRequests > 0);
	const source: FlopsSource = useServer ? "server-cached-tokens" : "prefix-match";
	if (totals.requests > 0 && totals.requestsWithoutFlops === totals.requests) return { source, flops: null };
	return { source, flops: useServer ? totals.serverCachedFlops : totals.prefixMatchFlops };
}

/** One request, as persisted in a `pi-clm-flops` session entry. */
export interface FlopsRequestRecord {
	version: 1;
	/** 1-based request number on this branch. */
	request: number;
	/** Response time (the assistant message's timestamp), ISO. */
	at?: string;
	model?: string;
	promptTokens: number;
	outputTokens: number;
	/** Prompt units: tool definitions (when sent) + messages. */
	units: number;
	reusedUnits: number;
	/** Prefix match: reused / new prompt tokens and F_t. */
	prefixMatch: { reusedTokens: number; newTokens: number; flops: FlopsBreakdown | null };
	/** Server cached tokens and F_t from them; null when the response carried no count. */
	serverCached: { cachedTokens: number; newTokens: number; flops: FlopsBreakdown | null } | null;
	/** Headline F_t of this request, from the run's current headline source. */
	source: FlopsSource;
	flops: number | null;
	constants: FlopsConstants | null;
	cumulative: FlopsTotals;
	/** The earlier request whose leading units were reused, for rebuilding after resume. */
	prefixOf: number | null;
	/** Keys and token weights of the trie nodes this request added (its units after the match). */
	newUnits: [string, number][];
}

export interface FlopsSummaryRecord {
	version: 1;
	metric: "prefix-reuse FLOPs";
	at: string;
	/** Headline source and value (also in `totals`). */
	source: FlopsSource;
	flops: number | null;
	totals: FlopsTotals;
	constants: FlopsConstants | null;
	/** Assistant responses that reported no prompt usage (failed or aborted requests); not counted. */
	unmeasuredResponses: number;
}

interface TrieNode {
	children: Map<string, TrieNode>;
	/** Token weight of the unit that ends at this node, for this exact path. */
	weight: number;
	/** A request whose prompt contains the path to this node as its leading units. */
	request: number;
}

interface PendingRequest {
	keys: string[];
	sizes: number[];
}

function unitKey(value: unknown): { key: string; size: number } {
	const text = JSON.stringify(value) ?? "";
	return { key: createHash("sha256").update(text).digest("hex").slice(0, 24), size: Math.max(1, text.length) };
}

const HEADER_FIELDS = ["system", "instructions", "systemInstruction", "tools", "tool_config", "toolConfig"] as const;
const MESSAGE_FIELDS = ["messages", "input", "contents"] as const;

/**
 * Prompt units of a provider payload, in prompt order: one unit for everything rendered
 * before the conversation (system fields and tool definitions, when present outside the
 * messages), then one per message. A payload without a recognised message list is one unit.
 */
export function promptUnits(payload: unknown): { keys: string[]; sizes: number[] } {
	const keys: string[] = [];
	const sizes: number[] = [];
	const add = (value: unknown) => {
		const unit = unitKey(value);
		keys.push(unit.key);
		sizes.push(unit.size);
	};
	if (!payload || typeof payload !== "object") {
		add(payload);
		return { keys, sizes };
	}
	const record = payload as Record<string, unknown>;
	const messagesField = MESSAGE_FIELDS.find((field) => Array.isArray(record[field]));
	if (!messagesField) {
		add(payload);
		return { keys, sizes };
	}
	const header = Object.fromEntries(HEADER_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
	if (Object.keys(header).length > 0) add(header);
	for (const message of record[messagesField] as unknown[]) add(message);
	return { keys, sizes };
}

export interface ResponseUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

/**
 * Session meter: observe each provider payload, then the usage of its response; returns
 * the record to persist. Restorable from the records on a branch.
 */
export class PrefixReuseMeter {
	private root: TrieNode = { children: new Map(), weight: 0, request: 0 };
	private unitsByRequest = new Map<number, string[]>();
	private pending: PendingRequest | undefined;
	totals: FlopsTotals = emptyFlopsTotals();
	lastConstants: FlopsConstants | null = null;
	unmeasuredResponses = 0;

	constructor(private readonly mode: FlopsSourceMode = "auto") {}

	reset(): void {
		this.root = { children: new Map(), weight: 0, request: 0 };
		this.unitsByRequest.clear();
		this.pending = undefined;
		this.totals = emptyFlopsTotals();
		this.lastConstants = null;
		this.unmeasuredResponses = 0;
	}

	/** Rebuild from the `pi-clm-flops` records of the active branch, in order. */
	restore(records: readonly FlopsRequestRecord[]): void {
		this.reset();
		for (const record of records) {
			let base = record.prefixOf ? (this.unitsByRequest.get(record.prefixOf) ?? []).slice(0, record.reusedUnits) : [];
			if (base.length !== record.reusedUnits) base = []; // prefix source missing: keep totals, drop that reuse history
			let node = this.root;
			for (const key of base) node = node.children.get(key) ?? node;
			if (base.length === record.reusedUnits) {
				for (const [key, weight] of record.newUnits) node = this.child(node, key, weight, record.request);
				this.unitsByRequest.set(record.request, [...base, ...record.newUnits.map(([key]) => key)]);
			}
			this.totals = { ...record.cumulative };
			this.lastConstants = record.constants;
		}
	}

	/** Remember the payload of the request about to be sent. */
	observeRequest(payload: unknown): void {
		this.pending = promptUnits(payload);
	}

	/**
	 * Account the response to the pending request. Returns undefined (and counts the response
	 * as unmeasured) when the provider reported no prompt size.
	 */
	observeResponse(usage: ResponseUsage | undefined, details: { model?: string; at?: string; constants: FlopsConstants | undefined }): FlopsRequestRecord | undefined {
		const pending = this.pending;
		this.pending = undefined;
		const prompt = promptTokens(usage);
		if (!pending || prompt <= 0) {
			this.unmeasuredResponses += 1;
			return undefined;
		}
		const output = Math.max(0, usage?.output ?? 0);

		// Prefix match: walk the trie; matched nodes carry their weights.
		let node = this.root;
		let matchedUnits = 0;
		let matchedTokens = 0;
		for (const key of pending.keys) {
			const next = node.children.get(key);
			if (!next) break;
			node = next;
			matchedUnits += 1;
			matchedTokens += next.weight;
		}
		const prefixOf = node.request;
		const reused = Math.min(matchedTokens, prompt);
		const fresh = prompt - reused;
		// New nodes share the newly prefilled tokens in proportion to their serialized size.
		const newKeys = pending.keys.slice(matchedUnits);
		const newSizes = pending.sizes.slice(matchedUnits);
		const sizeTotal = newSizes.reduce((sum, size) => sum + size, 0);
		const request = this.totals.requests + 1;
		const newUnits: [string, number][] = [];
		let assigned = 0;
		newKeys.forEach((key, index) => {
			const weight = index === newKeys.length - 1 ? fresh - assigned : Math.round((fresh * newSizes[index]!) / sizeTotal);
			assigned += weight;
			node = this.child(node, key, weight, request);
			newUnits.push([key, weight]);
		});
		this.unitsByRequest.set(request, [...pending.keys]);

		const constants = details.constants ?? null;
		const cached = typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? Math.max(0, Math.min(usage.cacheRead, prompt)) : undefined;
		const prefixCost = constants ? requestFlops(constants, { prompt, reused, output }) : null;
		const serverCost = constants && cached !== undefined ? requestFlops(constants, { prompt, reused: cached, output }) : null;
		const before = this.totals;
		const serverValid = before.serverCachedFlops !== null && cached !== undefined;
		const add = (total: number | null, part: number | undefined) => (total === null || !serverValid ? null : total + (part ?? 0));
		const totals: FlopsTotals = {
			requests: request,
			promptTokens: before.promptTokens + prompt,
			outputTokens: before.outputTokens + output,
			prefixReusedTokens: before.prefixReusedTokens + reused,
			prefixNewTokens: before.prefixNewTokens + fresh,
			prefixMatchFlops: before.prefixMatchFlops + (prefixCost?.total ?? 0),
			prefixMatchLinearFlops: before.prefixMatchLinearFlops + (prefixCost?.linear ?? 0),
			prefixMatchAttentionFlops: before.prefixMatchAttentionFlops + (prefixCost?.attention ?? 0),
			serverCachedTokens: add(before.serverCachedTokens, cached),
			serverCachedFlops: add(before.serverCachedFlops, serverCost?.total),
			serverCachedLinearFlops: add(before.serverCachedLinearFlops, serverCost?.linear),
			serverCachedAttentionFlops: add(before.serverCachedAttentionFlops, serverCost?.attention),
			serverPositiveRequests: before.serverPositiveRequests + (cached !== undefined && cached > 0 ? 1 : 0),
			requestsWithoutFlops: before.requestsWithoutFlops + (constants ? 0 : 1),
			source: "prefix-match",
			flops: null,
		};
		Object.assign(totals, headlineFlops(totals, this.mode));
		this.totals = totals;
		if (constants) this.lastConstants = constants;
		const requestHeadline = totals.source === "server-cached-tokens" ? serverCost?.total : prefixCost?.total;
		return {
			version: 1,
			request,
			...(details.at ? { at: details.at } : {}),
			...(details.model ? { model: details.model } : {}),
			promptTokens: prompt,
			outputTokens: output,
			units: pending.keys.length,
			reusedUnits: matchedUnits,
			prefixMatch: { reusedTokens: reused, newTokens: fresh, flops: prefixCost },
			serverCached: cached === undefined ? null : { cachedTokens: cached, newTokens: prompt - cached, flops: serverCost },
			source: totals.source,
			flops: requestHeadline ?? null,
			constants,
			cumulative: { ...totals },
			prefixOf: matchedUnits > 0 ? prefixOf : null,
			newUnits,
		};
	}

	summary(at = new Date().toISOString()): FlopsSummaryRecord {
		return {
			version: 1,
			metric: "prefix-reuse FLOPs",
			at,
			source: this.totals.source,
			flops: this.totals.flops,
			totals: { ...this.totals },
			constants: this.lastConstants,
			unmeasuredResponses: this.unmeasuredResponses,
		};
	}

	private child(node: TrieNode, key: string, weight: number, request: number): TrieNode {
		let next = node.children.get(key);
		if (!next) {
			next = { children: new Map(), weight, request };
			node.children.set(key, next);
		}
		return next;
	}
}

export function isFlopsRequestRecord(value: unknown): value is FlopsRequestRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<FlopsRequestRecord>;
	return record.version === 1 && typeof record.request === "number" && typeof record.promptTokens === "number" &&
		Array.isArray(record.newUnits) && Boolean(record.cumulative) && typeof record.cumulative === "object" &&
		Boolean(record.prefixMatch) && typeof record.prefixMatch === "object";
}

/** `1.19 PFLOP`, `845 TFLOP`. */
export function formatFlops(value: number): string {
	const units: [number, string][] = [[1e18, "EFLOP"], [1e15, "PFLOP"], [1e12, "TFLOP"], [1e9, "GFLOP"]];
	for (const [scale, unit] of units) {
		if (value >= scale) {
			const scaled = value / scale;
			return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${unit}`;
		}
	}
	return `${Math.round(value)} FLOP`;
}

/**
 * Prefix-reuse FLOPs: the inference compute a server with prefix caching spends on a
 * rollout, as defined in Context Language Models (arXiv:2609.37725, Appendix "Prefix-Reuse
 * FLOPs Computation") and implemented in the research codebase
 * (facebookresearch/context-language-models, clm/clm_harness/flops_metrics/kv_cache_flops.py).
 *
 * At request t the prompt holds P_t tokens and the model generates G_t. The reused prefix
 * R_t is the longest run of leading prompt units (the tool definitions, then each message)
 * that also led the prompt of an earlier request in this session; only U_t = P_t − R_t
 * tokens are prefilled. An edit in the middle of the context therefore re-prefills
 * everything from the edited message onward. The turn costs
 *
 *   F_t = C_token·(U_t + G_t) + C_attn·[(P_t² − R_t²)/2 + G_t·P_t + G_t²/2]
 *
 * with C_token the per-token cost of the linear layers and C_attn the cost per
 * query–key pair of the full-attention layers. The rollout's cost is Σ F_t.
 *
 * The count is idealised: it does not depend on what a particular server actually kept in
 * its cache (eviction, block granularity). The server's own `cached_tokens`, when it reports
 * them, are recorded beside it for comparison and never used in the metric.
 *
 * Token weights. P_t and G_t are the provider's counts. Each prompt unit gets a token weight
 * the first time it appears: the unmatched units of a request share U_t in proportion to
 * their serialized length. A matched prefix then weighs exactly what the earlier requests
 * were charged for it, so an append-only turn reuses exactly the previous prompt and the
 * weights of a request always sum to its P_t. Only the split of a single request's new
 * tokens between its new messages is approximate.
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

export interface FlopsConfig {
	/** `auto` picks a preset from the model id; `off` disables the accounting. */
	model: "auto" | "off" | keyof typeof FLOPS_PRESETS;
	/** Explicit constants; take precedence over any preset. Both must be set together. */
	perToken?: number;
	perAttentionPair?: number;
}

export const DEFAULT_FLOPS_CONFIG: FlopsConfig = { model: "auto" };

/** `PI_CLM_FLOPS_MODEL` (auto | 27b | 9b | off), `PI_CLM_FLOPS_PER_TOKEN`, `PI_CLM_FLOPS_PER_PAIR`. */
export function flopsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<FlopsConfig> {
	const config: Partial<FlopsConfig> = {};
	const model = env.PI_CLM_FLOPS_MODEL?.trim().toLowerCase();
	if (model) {
		if (model !== "auto" && model !== "off" && !Object.hasOwn(FLOPS_PRESETS, model)) {
			throw new Error(`PI_CLM_FLOPS_MODEL must be auto, off or one of ${Object.keys(FLOPS_PRESETS).join(", ")}, got ${model}`);
		}
		config.model = model as FlopsConfig["model"];
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
export function resolveFlopsConstants(config: FlopsConfig, modelId: string | undefined): FlopsConstants | undefined {
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

/** F_t for one request; see the module comment. */
export function requestFlops(
	constants: Pick<FlopsConstants, "perToken" | "perAttentionPair">,
	tokens: { prompt: number; reused: number; output: number },
): { linear: number; attention: number; total: number } {
	const P = tokens.prompt;
	const R = Math.min(tokens.reused, P);
	const G = tokens.output;
	const linear = constants.perToken * (P - R + G);
	const attention = constants.perAttentionPair * ((P * P - R * R) / 2 + G * P + (G * G) / 2);
	return { linear, attention, total: linear + attention };
}

export interface FlopsTotals {
	requests: number;
	promptTokens: number;
	reusedPrefixTokens: number;
	newPromptTokens: number;
	outputTokens: number;
	/** Sum of the provider's reported cache hits (comparison only; not part of the metric). */
	serverCachedTokens: number;
	/** Requests whose provider reported a cache-hit count. */
	serverCachedReported: number;
	/** Σ F_t over requests that had constants. */
	flops: number;
	linearFlops: number;
	attentionFlops: number;
	/** Requests counted without constants (unknown model). */
	requestsWithoutFlops: number;
}

export function emptyFlopsTotals(): FlopsTotals {
	return {
		requests: 0, promptTokens: 0, reusedPrefixTokens: 0, newPromptTokens: 0, outputTokens: 0,
		serverCachedTokens: 0, serverCachedReported: 0, flops: 0, linearFlops: 0, attentionFlops: 0, requestsWithoutFlops: 0,
	};
}

/** One request, as persisted in a `pi-clm-flops` session entry. */
export interface FlopsRequestRecord {
	version: 1;
	/** 1-based request number on this branch. */
	request: number;
	/** Response time (the assistant message's timestamp), ISO. */
	at?: string;
	model?: string;
	/** Prompt units: tool definitions (when sent) + messages. */
	units: number;
	reusedUnits: number;
	promptTokens: number;
	reusedPrefixTokens: number;
	newPromptTokens: number;
	outputTokens: number;
	/** The provider's reported cache hits for this request, when reported. */
	serverCachedTokens?: number;
	/** F_t; null without constants. */
	flops: number | null;
	linearFlops: number | null;
	attentionFlops: number | null;
	constants: FlopsConstants | null;
	cumulative: FlopsTotals;
	/** The earlier request whose leading units were reused, for rebuilding after resume. */
	prefixOf: number | null;
	/** Unit keys and token weights first seen in this request. */
	newUnits: [string, number][];
}

export interface FlopsSummaryRecord {
	version: 1;
	metric: "prefix-reuse FLOPs";
	at: string;
	totals: FlopsTotals;
	constants: FlopsConstants | null;
	/** Assistant responses that reported no prompt usage (failed or aborted requests); not counted. */
	unmeasuredResponses: number;
}

interface TrieNode {
	children: Map<string, TrieNode>;
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
	private root: TrieNode = { children: new Map(), request: 0 };
	private weights = new Map<string, number>();
	private unitsByRequest = new Map<number, string[]>();
	private pending: PendingRequest | undefined;
	totals: FlopsTotals = emptyFlopsTotals();
	lastConstants: FlopsConstants | null = null;
	unmeasuredResponses = 0;

	reset(): void {
		this.root = { children: new Map(), request: 0 };
		this.weights.clear();
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
			const base = record.prefixOf ? (this.unitsByRequest.get(record.prefixOf) ?? []).slice(0, record.reusedUnits) : [];
			if (base.length !== record.reusedUnits) {
				// A record whose prefix source is missing (e.g. an older branch layout): keep totals, drop reuse history.
				this.root = { children: new Map(), request: 0 };
				this.unitsByRequest.clear();
			}
			for (const [key, weight] of record.newUnits) if (!this.weights.has(key)) this.weights.set(key, weight);
			const keys = [...base, ...record.newUnits.map(([key]) => key)];
			this.insert(keys, record.request);
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
		const { matchedUnits, reusedTokens, prefixOf } = this.match(pending.keys);
		const reused = Math.min(reusedTokens, prompt);
		const fresh = prompt - reused;

		// New units share the newly prefilled tokens in proportion to their serialized size.
		const newKeys = pending.keys.slice(matchedUnits);
		const newSizes = pending.sizes.slice(matchedUnits);
		const sizeTotal = newSizes.reduce((sum, size) => sum + size, 0);
		const newUnits: [string, number][] = [];
		let assigned = 0;
		newKeys.forEach((key, index) => {
			const weight = index === newKeys.length - 1 ? fresh - assigned : Math.round((fresh * newSizes[index]!) / sizeTotal);
			assigned += weight;
			if (!this.weights.has(key)) {
				this.weights.set(key, weight);
				newUnits.push([key, weight]);
			} else {
				newUnits.push([key, this.weights.get(key)!]);
			}
		});

		const request = this.totals.requests + 1;
		this.insert(pending.keys, request);
		const constants = details.constants ?? null;
		const cost = constants ? requestFlops(constants, { prompt, reused, output }) : undefined;
		const serverCached = usage?.cacheRead;
		const reported = typeof serverCached === "number";
		const totals: FlopsTotals = {
			requests: request,
			promptTokens: this.totals.promptTokens + prompt,
			reusedPrefixTokens: this.totals.reusedPrefixTokens + reused,
			newPromptTokens: this.totals.newPromptTokens + fresh,
			outputTokens: this.totals.outputTokens + output,
			serverCachedTokens: this.totals.serverCachedTokens + (reported ? serverCached : 0),
			serverCachedReported: this.totals.serverCachedReported + (reported ? 1 : 0),
			flops: this.totals.flops + (cost?.total ?? 0),
			linearFlops: this.totals.linearFlops + (cost?.linear ?? 0),
			attentionFlops: this.totals.attentionFlops + (cost?.attention ?? 0),
			requestsWithoutFlops: this.totals.requestsWithoutFlops + (cost ? 0 : 1),
		};
		this.totals = totals;
		if (constants) this.lastConstants = constants;
		return {
			version: 1,
			request,
			...(details.at ? { at: details.at } : {}),
			...(details.model ? { model: details.model } : {}),
			units: pending.keys.length,
			reusedUnits: matchedUnits,
			promptTokens: prompt,
			reusedPrefixTokens: reused,
			newPromptTokens: fresh,
			outputTokens: output,
			...(reported ? { serverCachedTokens: serverCached } : {}),
			flops: cost?.total ?? null,
			linearFlops: cost?.linear ?? null,
			attentionFlops: cost?.attention ?? null,
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
			totals: { ...this.totals },
			constants: this.lastConstants,
			unmeasuredResponses: this.unmeasuredResponses,
		};
	}

	private match(keys: readonly string[]): { matchedUnits: number; reusedTokens: number; prefixOf: number } {
		let node = this.root;
		let matchedUnits = 0;
		let reusedTokens = 0;
		for (const key of keys) {
			const next = node.children.get(key);
			if (!next) break;
			node = next;
			matchedUnits += 1;
			reusedTokens += this.weights.get(key) ?? 0;
		}
		return { matchedUnits, reusedTokens, prefixOf: node.request };
	}

	private insert(keys: readonly string[], request: number): void {
		this.unitsByRequest.set(request, [...keys]);
		let node = this.root;
		for (const key of keys) {
			let next = node.children.get(key);
			if (!next) {
				next = { children: new Map(), request };
				node.children.set(key, next);
			}
			node = next;
		}
	}
}

export function isFlopsRequestRecord(value: unknown): value is FlopsRequestRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<FlopsRequestRecord>;
	return record.version === 1 && typeof record.request === "number" && typeof record.promptTokens === "number" &&
		Array.isArray(record.newUnits) && Boolean(record.cumulative) && typeof record.cumulative === "object";
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

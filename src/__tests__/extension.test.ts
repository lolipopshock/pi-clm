import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { LIVE_CONTEXT_ANNOTATION, sourceContentHash } from "../continuity.ts";
import liveContextExtension from "../index.ts";
import clmExtension from "../../index.ts";
import { MirrorStore } from "../mirror-store.ts";
import {
	createProjectionCheckpoint,
	PROJECTION_PREFIX_MISMATCH_REASON,
	PROJECTION_SHORTER_REASON,
} from "../projection.ts";
import { LIVE_CONTEXT_STATE } from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

type Handler = (event: any, ctx: any) => any;

type Harness = {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, any>;
	tools: Map<string, any>;
	branch: any[];
	notifications: string[];
	statuses: Map<string, string | undefined>;
	/** `pi.sendUserMessage` calls. */
	sentUserMessages: Array<{ content: unknown; options?: unknown }>;
	ctx: any;
	setUsage(percent: number | undefined): void;
};

/** `/clm config` printed as text (as outside the TUI). */
async function clmSettingsText(harness: Harness): Promise<string> {
	const mode = harness.ctx.mode;
	harness.ctx.mode = "rpc";
	try {
		await harness.commands.get("clm").handler("config", harness.ctx);
	} finally {
		harness.ctx.mode = mode;
	}
	return harness.notifications.at(-1)!;
}

function createHarness(initialBranch: any[] = []): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const branch = initialBranch;
	let usagePercent: number | undefined;
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];

	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({
				type: "custom",
				id: `custom-${branch.length + 1}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sentUserMessages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: {
			getSessionId: () => "extension-test-session",
			getSessionFile: () => "/tmp/extension-test-session.jsonl",
			getBranch: () => [...branch],
			getEntries: () => [...branch],
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
			buildContextEntries: () => [],
			getTree: () => [],
			getLeafId: () => null,
		},
		waitForIdle: async () => {},
		isIdle: () => true,
		getContextUsage: () =>
			usagePercent === undefined
				? undefined
				: { tokens: Math.round(usagePercent * 1_000), contextWindow: 100_000, percent: usagePercent },
	};

	return {
		pi,
		handlers,
		commands,
		tools,
		branch,
		notifications,
		statuses,
		sentUserMessages,
		ctx,
		setUsage(percent: number | undefined) {
			usagePercent = percent;
		},
	};
}

async function emit(harness: Harness, name: string, event: any): Promise<any[]> {
	const results: any[] = [];
	for (const handler of harness.handlers.get(name) ?? []) {
		results.push(await handler(event, harness.ctx));
	}
	return results;
}

function rawConversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "Solve the task", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: `Old investigation\n${"large output\n".repeat(100)}` }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
	];
}

const continuityModel: Model<"openai-codex-responses"> = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "continuity-fixture",
	name: "Offline continuity fixture",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

/** Real Responses input serialization: request-local custom timestamps are not wire fields. */
function responsesInput(messages: LiveContextMessage[]): string[] {
	return convertResponsesMessages(
		continuityModel,
		{ messages: convertToLlm(messages as AgentMessage[]) } as Parameters<typeof convertResponsesMessages>[1],
		new Set(["openai-codex"]),
		{ includeSystemPrompt: false },
	).map((item) => JSON.stringify(item));
}

function compactSecondTurn(document: string): string {
	return document.replace(
		/(\[\[CTX_TURN document=[a-f0-9]{64} index=2 role=assistant[^\n]*\]\]\n)[\s\S]*$/,
		"$1Investigation complete: parser.ts is the only relevant file.",
	);
}

describe("live-context extension lifecycle", () => {
	test("applies a mirror edit as a non-destructive projection on the next context call", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });

		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base prompt",
			prompt: "task",
			systemPromptOptions: {},
		});
		const systemPrompt = before[0].systemPrompt as string;
		const pathMatch = systemPrompt.match(/mirrored at `([^`]+)`/);
		assert.ok(pathMatch);
		const mirrorPath = pathMatch[1];

		const raw = rawConversation();
		const firstContext = await emit(harness, "context", { type: "context", messages: raw });
		assert.deepEqual(firstContext[0].messages, raw);
		const mirror = await readFile(mirrorPath, "utf8");
		await writeFile(mirrorPath, compactSecondTurn(mirror), "utf8");

		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		const persisted = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(persisted.data.lastOutcome.kind, "applied");
		assert.equal(persisted.data.revision, 1);
		assert.equal(persisted.data.checkpoint.estimateUnit, "tokens");
		assert.equal(persisted.data.checkpoint.editTrace.sources[1].kind, "edited");

		const suffix = {
			role: "assistant",
			content: [{ type: "text", text: "New work after compaction" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 3,
		};
		const secondContext = await emit(harness, "context", {
			type: "context",
			messages: [...raw, suffix],
		});
		const visible = secondContext[0].messages as LiveContextMessage[];
		assert.equal(visible[0], raw[0]);
		assert.match(JSON.stringify(visible[1].content), /parser\.ts is the only relevant file/);
		assert.doesNotMatch(JSON.stringify(visible), /large output/);
		assert.equal(visible[2], suffix);
		assert.equal(visible.at(-1)?.customType, "live-context-notice");

		// The raw event input remains untouched and auditable.
		assert.match(JSON.stringify(raw), /large output/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
		await assert.rejects(readFile(mirrorPath, "utf8"));

		// A fresh extension instance reconstructs the checkpoint from the same branch.
		const resumed = createHarness(harness.branch);
		liveContextExtension(resumed.pi);
		await emit(resumed, "session_start", { type: "session_start", reason: "resume" });
		const resumedContext = await emit(resumed, "context", { type: "context", messages: [...raw, suffix] });
		assert.doesNotMatch(JSON.stringify(resumedContext[0].messages), /large output/);
		assert.match(JSON.stringify(resumedContext[0].messages), /New work after compaction/);
		await emit(resumed, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("uses estimated tokens for both acceptance and reporting", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "Task", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "abcd" }], timestamp: 2 },
			{ role: "user", content: "Continue", timestamp: 3 },
		];
		await emit(harness, "context", { type: "context", messages: raw });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		const mirror = await readFile(mirrorPath, "utf8");
		const edited = mirror.replace(/(\[\[CTX_TURN[^\n]*index=2[^\n]*\]\]\n)abcd/, "$1a");
		assert.notEqual(edited, mirror);
		await writeFile(mirrorPath, edited, "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const latest = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(latest.data.lastOutcome.kind, "rejected");
		assert.equal(latest.data.lastOutcome.estimateUnit, "tokens");
		assert.equal(latest.data.lastOutcome.beforeEstimate, latest.data.lastOutcome.afterEstimate);
		assert.match(latest.data.lastOutcome.message, /did not reduce.*estimated tokens/);
		assert.equal("checkpoint" in latest.data, false);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("a stale source prefix fails closed and persists a reset", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw = rawConversation();
		await emit(harness, "context", { type: "context", messages: raw });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const changedRaw = rawConversation();
		changedRaw[1] = { ...changedRaw[1], content: "externally changed raw history" };
		const result = await emit(harness, "context", { type: "context", messages: changedRaw });
		const visible = result[0].messages as LiveContextMessage[];
		assert.equal(visible[0], changedRaw[0]);
		assert.equal(visible[1], changedRaw[1]);
		assert.equal(visible.at(-1)?.customType, "live-context-notice");
		const latest = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(latest.data.checkpoint, undefined);
		assert.equal(latest.data.lastOutcome.kind, "reset");
		assert.ok(latest.data.lastOutcome.message.startsWith(`${PROJECTION_PREFIX_MISMATCH_REASON} `), "the reset says what differs");
		assert.match(latest.data.lastOutcome.message, /counts agree, so a message before that point changed/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("resume recovers checkpoints invalidated only by persisted auto-retry errors", async () => {
		const anchorSource: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{ role: "assistant", content: "initial answer", stopReason: "stop", timestamp: 2 },
		];
		const anchor = createProjectionCheckpoint({
			revision: 5,
			sourceMessages: anchorSource,
			projectedMessages: anchorSource,
			beforeEstimate: 20,
			afterEstimate: 20,
		});
		const successfulRetry: LiveContextMessage = {
			role: "assistant",
			content: "retry succeeded",
			stopReason: "stop",
			timestamp: 4,
		};
		const targetProjection: LiveContextMessage[] = [
			anchorSource[0],
			{ role: "custom", customType: "live-context-projection", content: "completed summary", timestamp: 4 },
		];
		const target = createProjectionCheckpoint({
			revision: 6,
			sourceMessages: [...anchorSource, successfulRetry],
			projectedMessages: targetProjection,
			beforeEstimate: 30,
			afterEstimate: 10,
		});
		const initialBranch = [
			{
				type: "custom",
				id: "anchor-state",
				parentId: null,
				customType: LIVE_CONTEXT_STATE,
				data: { version: 1, enabled: true, revision: 5, checkpoint: anchor },
			},
			{
				type: "custom",
				id: "target-state",
				parentId: "anchor-state",
				customType: LIVE_CONTEXT_STATE,
				data: { version: 1, enabled: true, revision: 6, checkpoint: target },
			},
			{
				type: "custom",
				id: "failed-resume-reset",
				parentId: "target-state",
				customType: LIVE_CONTEXT_STATE,
				data: {
					version: 1,
					enabled: true,
					revision: 7,
					lastOutcome: {
						kind: "reset",
						message: PROJECTION_PREFIX_MISMATCH_REASON,
						at: "2026-08-30T00:00:00.000Z",
					},
				},
			},
		];
		const harness = createHarness(initialBranch);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "resume" });
		const retryError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fetch failed",
			timestamp: 3,
		};
		const suffix: LiveContextMessage = { role: "user", content: "continue", timestamp: 5 };
		const resumedRaw = [...anchorSource, retryError, successfulRetry, suffix];
		const result = await emit(harness, "context", { type: "context", messages: resumedRaw });
		const visible = result[0].messages as LiveContextMessage[];

		assert.match(JSON.stringify(visible), /completed summary/);
		assert.match(JSON.stringify(visible), /continue/);
		assert.doesNotMatch(JSON.stringify(visible), /fetch failed/);
		const recovered = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data;
		assert.equal(recovered.revision, 8);
		assert.ok(recovered.checkpoint);
		assert.equal(recovered.lastOutcome.kind, "applied");
		assert.match(recovered.lastOutcome.message, /Recovered projection revision 6 after resume/);
		assert.match(JSON.stringify(visible), /Recovered projection revision 6 after resume/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("resume recovers a checkpoint whose prefix lost retried failures, also after a mismatch reset", async () => {
		const at = (seconds: number) => 1_790_000_000_000 + seconds * 1_000;
		const failure = (seconds: number): LiveContextMessage => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited", timestamp: at(seconds) });
		// As in a long session: three retried 429s Pi dropped live, the final one it kept, then the edit turn.
		const rebuilt: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: at(1) },
			{ role: "assistant", content: "first answer", stopReason: "stop", timestamp: at(2) },
			{ role: "user", content: "next step", timestamp: at(10) },
			failure(11), failure(13), failure(17), failure(25),
			{ role: "user", content: "please compact", timestamp: at(100) },
			{ role: "assistant", content: "editing the mirror", stopReason: "toolUse", timestamp: at(101) },
			{ role: "toolResult", content: "mirror written", toolCallId: "call-1", timestamp: at(102) },
			{ role: "user", content: "continue after resume", timestamp: at(500) },
		];
		const live = [rebuilt[0]!, rebuilt[1]!, rebuilt[2]!, rebuilt[6]!, rebuilt[7]!];
		const checkpoint = createProjectionCheckpoint({
			revision: 4,
			sourceMessages: live,
			projectedMessages: [rebuilt[0]!, { role: "custom", customType: "notes", content: "summary of the work so far", timestamp: at(2) }],
			beforeEstimate: 400,
			afterEstimate: 40,
			estimateUnit: "tokens",
			createdAt: new Date(at(103)).toISOString(),
			editTrace: { version: 1, sourceRevision: 3, sourceMessageCount: 5, outputMessageCount: 2, sources: [], additions: [] },
		});
		const checkpointEntry = { type: "custom", id: "edit-state", parentId: null, customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 4, checkpoint } };
		const mismatchReset = {
			type: "custom",
			id: "mismatch-reset",
			parentId: "edit-state",
			customType: LIVE_CONTEXT_STATE,
			data: {
				version: 1,
				enabled: true,
				revision: 5,
				lastOutcome: { kind: "reset", message: `${PROJECTION_PREFIX_MISMATCH_REASON} The edit's request starts after message 8 of the rebuilt history.`, at: "2026-11-08T17:30:32.000Z" },
			},
		};
		for (const [label, branch, revivedRevision] of [["active checkpoint", [checkpointEntry], 5], ["after a mismatch reset", [checkpointEntry, mismatchReset], 6]] as const) {
			const harness = createHarness([...branch]);
			liveContextExtension(harness.pi, { editingMode: "clm" });
			await emit(harness, "session_start", { type: "session_start", reason: "resume" });
			try {
				const result = await emit(harness, "context", { type: "context", messages: rebuilt });
				const visible = JSON.stringify(result[0].messages);
				assert.match(visible, /summary of the work so far/, label);
				assert.match(visible, /continue after resume/, label);
				assert.doesNotMatch(visible, /next step|429 rate limited/, `${label}: the replaced prefix stays out`);
				const recovered = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data;
				assert.equal(recovered.revision, revivedRevision, label);
				assert.equal(recovered.lastOutcome.kind, "applied", label);
				assert.match(recovered.lastOutcome.message, /Recovered projection revision 4 after resume: its source ends at message 8 of the rebuilt history, which keeps 3 failed response\(s\)/, label);
				// The rebased checkpoint matches the rebuilt history exactly from now on.
				const again = await emit(harness, "context", { type: "context", messages: rebuilt });
				assert.match(JSON.stringify(again[0].messages), /summary of the work so far/, label);
				assert.equal(harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data.revision, revivedRevision, `${label}: no further state`);
			} finally { await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }); }
		}
	});

	test("resume places a checkpoint at its edit's reply when the session file lost earlier entries, also after a reset", async () => {
		const at = (seconds: number) => 1_790_000_000_000 + seconds * 1_000;
		const full: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: at(1) },
			{ role: "assistant", content: "first answer", stopReason: "stop", timestamp: at(2) },
			{ role: "user", content: "next step", timestamp: at(10) },
			{ role: "assistant", content: "editing the mirror", stopReason: "toolUse", timestamp: at(20) },
			{ role: "toolResult", content: "mirror written", toolCallId: "call-1", timestamp: at(21) },
			{ role: "user", content: "continue after resume", timestamp: at(500) },
		];
		// The disk filled up: Pi kept an entry it could not write and later entries name it as
		// their parent, so the rebuilt branch starts at "next step".
		const rebuilt = full.slice(2);
		const checkpoint = createProjectionCheckpoint({
			revision: 7,
			sourceMessages: full.slice(0, 3),
			projectedMessages: [{ role: "custom", customType: "notes", content: "summary of the work so far", timestamp: at(2) }],
			beforeEstimate: 400,
			afterEstimate: 40,
			estimateUnit: "tokens",
			createdAt: new Date(at(22)).toISOString(),
			editTrace: { version: 1, sourceRevision: 6, sourceMessageCount: 3, outputMessageCount: 1, sources: [], additions: [] },
		});
		const edit = (parentId: string | null) => ({ type: "custom", id: "edit-state", parentId, customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 7, checkpoint } });
		const shorterReset = {
			type: "custom",
			id: "shorter-reset",
			parentId: "edit-state",
			customType: LIVE_CONTEXT_STATE,
			data: { version: 1, enabled: true, revision: 8, lastOutcome: { kind: "reset", message: PROJECTION_SHORTER_REASON, at: "2026-11-08T17:30:32.000Z" } },
		};
		const latestState = (harness: Harness) => harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data;
		for (const [label, branch, revivedRevision] of [
			["active checkpoint", [edit("never-written")], 8],
			["after a shorter-history reset", [edit("never-written"), shorterReset], 9],
		] as const) {
			const harness = createHarness([...branch]);
			liveContextExtension(harness.pi, { editingMode: "clm" });
			await emit(harness, "session_start", { type: "session_start", reason: "resume" });
			try {
				const result = await emit(harness, "context", { type: "context", messages: rebuilt });
				const visible = JSON.stringify(result[0].messages);
				assert.match(visible, /summary of the work so far/, label);
				assert.match(visible, /editing the mirror.*continue after resume/, label);
				assert.doesNotMatch(visible, /next step/, `${label}: the replaced prefix stays out`);
				const recovered = latestState(harness);
				assert.equal(recovered.revision, revivedRevision, label);
				assert.equal(recovered.lastOutcome.kind, "applied", label);
				assert.match(recovered.lastOutcome.message, /Recovered projection revision 7 after resume, unverified: the session file lost entries before this branch/, label);
			} finally { await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }); }
		}

		// The same history with nothing lost changed some other way: it still resets, once.
		const harness = createHarness([edit(null)]);
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { type: "session_start", reason: "resume" });
		try {
			await emit(harness, "context", { type: "context", messages: rebuilt });
			const reset = latestState(harness);
			assert.equal(reset.lastOutcome.kind, "reset");
			assert.match(reset.lastOutcome.message, /^Raw context prefix no longer matches the projection checkpoint\. The edit's request starts after message \d+ of the rebuilt history/);
			assert.doesNotMatch(reset.lastOutcome.message, /unverified/);
			await emit(harness, "context", { type: "context", messages: rebuilt });
			assert.equal(latestState(harness).revision, reset.revision, "the next request adds no state");
		} finally { await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }); }
	});

	test("a user-initiated reset is never revived by retry recovery", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw = rawConversation();
		await emit(harness, "context", { type: "context", messages: raw });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const command = harness.commands.get("live-context");
		await command.handler("reset", harness.ctx);
		const resetEntry = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(resetEntry.data.lastOutcome.message, "Projection reset by user.");
		const stateEntryCount = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).length;

		const retryError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fetch failed",
			timestamp: 1.5,
		};
		const resumedRaw = [raw[0], retryError, raw[1]];
		const result = await emit(harness, "context", { type: "context", messages: resumedRaw });
		const visible = result[0].messages as LiveContextMessage[];

		assert.match(JSON.stringify(visible), /large output/);
		assert.doesNotMatch(JSON.stringify(visible), /parser\.ts is the only relevant file/);
		assert.equal(
			harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).length,
			stateEntryCount,
		);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("commands toggle and reset state without deleting history", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const command = harness.commands.get("live-context");
		assert.ok(command);

		await command.handler("off", harness.ctx);
		assert.match(harness.statuses.get("live-context") ?? "", /off/);
		assert.equal(harness.branch.at(-1).data.event.kind, "disabled");
		await command.handler("on", harness.ctx);
		assert.equal(harness.branch.at(-1).data.event.kind, "enabled");
		await command.handler("reset", harness.ctx);
		const latest = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(latest.data.enabled, true);
		assert.equal(latest.data.checkpoint, undefined);
		assert.equal(latest.data.lastOutcome.kind, "reset");
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("a rejected edit records the outcome without re-persisting the checkpoint", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw = rawConversation();
		await emit(harness, "context", { type: "context", messages: raw });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const suffix: LiveContextMessage = {
			role: "assistant",
			content: [{ type: "text", text: "New work after compaction" }],
			stopReason: "stop",
			timestamp: 3,
		};
		await emit(harness, "context", { type: "context", messages: [...raw, suffix] });
		const grown = `${await readFile(mirrorPath, "utf8")}\nAppended detail that grows the projection.`;
		await writeFile(mirrorPath, grown, "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const latest = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(latest.data.lastOutcome.kind, "rejected");
		assert.equal("checkpoint" in latest.data, false);

		const resumed = createHarness(harness.branch);
		liveContextExtension(resumed.pi);
		await emit(resumed, "session_start", { type: "session_start", reason: "resume" });
		const resumedContext = await emit(resumed, "context", { type: "context", messages: [...raw, suffix] });
		assert.doesNotMatch(JSON.stringify(resumedContext[0].messages), /large output/);
		await emit(resumed, "session_shutdown", { type: "session_shutdown", reason: "quit" });
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("context-excluded bash executions stay out of the mirror and the projection", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "Solve the task", timestamp: 1 },
			{
				role: "bashExecution",
				command: "cat local-notes.txt",
				output: "excluded private output",
				excludeFromContext: true,
				timestamp: 2,
			},
			{ role: "bashExecution", command: "ls", output: "visible output", timestamp: 3 },
		];
		const result = await emit(harness, "context", { type: "context", messages: raw });
		const mirror = await readFile(mirrorPath, "utf8");
		assert.doesNotMatch(mirror, /excluded private output/);
		assert.match(mirror, /visible output/);
		assert.doesNotMatch(JSON.stringify(result[0].messages), /excluded private output/);
		assert.match(JSON.stringify(result[0].messages), /visible output/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("consecutive invalidations raise one composition warning", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];

		function variantConversation(tag: string): LiveContextMessage[] {
			const raw = rawConversation();
			raw[1] = {
				...raw[1],
				content: [{ type: "text", text: `Old investigation ${tag}\n${"large output\n".repeat(100)}` }],
			};
			return raw;
		}
		async function acceptEdit(messages: LiveContextMessage[]): Promise<void> {
			await emit(harness, "context", { type: "context", messages });
			await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
			await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		}
		const warnings = () => harness.notifications.filter((n) => /consecutive projections were invalidated/.test(n));

		await acceptEdit(variantConversation("a"));
		await acceptEdit(variantConversation("b"));
		assert.equal(warnings().length, 0);
		await acceptEdit(variantConversation("c"));
		assert.equal(warnings().length, 1);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("status reports observed usage for the active revision", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const before = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await emit(harness, "context", { type: "context", messages: rawConversation() });
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		assert.doesNotMatch(harness.statuses.get("live-context") ?? "", /obs/);

		harness.setUsage(31);
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		assert.match(harness.statuses.get("live-context") ?? "", /obs 31\.0k tok/);

		const command = harness.commands.get("live-context");
		await command.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /observed: 31\.0k tokens for revision 1 · Pi window estimate 31\.0%/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("live-context-view falls back to a display report outside the interactive TUI", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: rawConversation() });
		const command = harness.commands.get("live-context-view");
		assert.ok(command);
		// A display command must prefer the exact context-hook snapshot rather than a
		// newer raw-session message space and must not replace runtime state.
		harness.branch.push(
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-08-29T00:00:00.000Z", message: { role: "user", content: "one", timestamp: 1 } },
			{ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-29T00:00:01.000Z", message: { role: "user", content: "two", timestamp: 2 } },
			{ type: "message", id: "m3", parentId: "m2", timestamp: "2026-08-29T00:00:02.000Z", message: { role: "user", content: "session-only suffix", timestamp: 3 } },
		);
		harness.ctx.sessionManager.getLeafId = () => "m3";
		harness.ctx.mode = "print";
		let waitedForIdle = false;
		harness.ctx.waitForIdle = async () => {
			waitedForIdle = true;
		};
		await command.handler("overview", harness.ctx);
		assert.equal(waitedForIdle, false, "the read-only viewer should snapshot immediately");
		assert.match(harness.notifications.at(-1) ?? "", /Live context/);
		assert.match(harness.notifications.at(-1) ?? "", /messages: 2 raw -> 2 effective/);
		await command.handler("unknown", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /Usage: \/live-context-view/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("tree navigation restores only the checkpoint inherited by the selected branch", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw = rawConversation();
		await emit(harness, "context", { type: "context", messages: raw });
		const prompt = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(prompt[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		const checkpointEntry = harness.branch.at(-1);

		// A branch whose selected head predates the checkpoint uses raw Pi context.
		harness.branch.splice(0);
		await emit(harness, "session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "early" });
		const early = await emit(harness, "context", { type: "context", messages: raw });
		assert.match(JSON.stringify(early[0].messages), /large output/);

		// A branch descending from the checkpoint restores the projected prefix.
		harness.branch.push(checkpointEntry);
		await emit(harness, "session_tree", { type: "session_tree", oldLeafId: "early", newLeafId: "late" });
		const late = await emit(harness, "context", { type: "context", messages: raw });
		assert.doesNotMatch(JSON.stringify(late[0].messages), /large output/);
		assert.match(JSON.stringify(late[0].messages), /parser\.ts is the only relevant file/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("native Pi compaction resets the projection and becomes the new baseline", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const raw = rawConversation();
		await emit(harness, "context", { type: "context", messages: raw });
		const prompt = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(prompt[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await writeFile(mirrorPath, compactSecondTurn(await readFile(mirrorPath, "utf8")), "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		assert.ok(harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data.checkpoint);

		await emit(harness, "session_compact", { type: "session_compact", reason: "threshold" });
		const latest = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
		assert.equal(latest.data.checkpoint, undefined);
		assert.equal(latest.data.lastOutcome.kind, "reset");

		const compactedRaw: LiveContextMessage[] = [
			{ role: "compactionSummary", summary: "Native Pi summary", tokensBefore: 10_000, timestamp: 4 },
			{ role: "user", content: "Continue", timestamp: 5 },
		];
		const next = await emit(harness, "context", { type: "context", messages: compactedRaw });
		assert.equal(next[0].messages[0], compactedRaw[0]);
		assert.equal(next[0].messages[1], compactedRaw[1]);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("registers its skill, pressure nudges re-arm, and duplicate mirror mutations are blocked", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });

		const resources = await emit(harness, "resources_discover", {
			type: "resources_discover",
			cwd: process.cwd(),
			reason: "startup",
		});
		assert.match(resources[0].skillPaths[0], /src\/skills$/);

		harness.setUsage(80);
		const first = await emit(harness, "context", { type: "context", messages: rawConversation() });
		assert.equal(
			(first[0].messages as LiveContextMessage[]).filter((message) => message.customType === "live-context-notice").length,
			1,
		);
		const second = await emit(harness, "context", { type: "context", messages: rawConversation() });
		assert.equal(
			(second[0].messages as LiveContextMessage[]).filter((message) => message.customType === "live-context-notice").length,
			0,
		);
		harness.setUsage(40);
		await emit(harness, "context", { type: "context", messages: rawConversation() });
		harness.setUsage(80);
		const rearmed = await emit(harness, "context", { type: "context", messages: rawConversation() });
		assert.equal(
			(rearmed[0].messages as LiveContextMessage[]).filter((message) => message.customType === "live-context-notice").length,
			1,
		);

		const prompt = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(prompt[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await emit(harness, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		const firstMutation = await emit(harness, "tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "one",
			input: { path: mirrorPath, content: "one" },
		});
		assert.equal(firstMutation[0], undefined);
		const duplicateMutation = await emit(harness, "tool_call", {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "two",
			input: { path: mirrorPath, oldText: "one", newText: "two" },
		});
		assert.equal(duplicateMutation[0].block, true);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("warns once when aggregate model-visible continuity crosses its size threshold", async () => {
		const source: LiveContextMessage = { role: "user", content: "Source obligation", timestamp: 1 };
		const sourceEntry = {
			type: "message",
			id: "source-obligation",
			parentId: null,
			timestamp: "2026-08-30T00:00:00.000Z",
			message: source,
		};
		const annotationEntries = Array.from({ length: 100 }, (_, index) => ({
			type: "custom",
			id: `annotation-${index}`,
			parentId: index === 0 ? sourceEntry.id : `annotation-${index - 1}`,
			timestamp: new Date(index + 1).toISOString(),
			customType: LIVE_CONTEXT_ANNOTATION,
			data: {
				version: 1,
				id: `lc-${index.toString(16).padStart(12, "0")}`,
				source: {
					sessionId: "extension-test-session",
					entryId: sourceEntry.id,
					revision: 0,
					contentHash: sourceContentHash(source),
					role: "user",
				},
				title: `Obligation ${index}`,
				reason: Array.from({ length: 25 }, (_, word) => `reason-${index}-${word}`).join(" "),
				futureAction: Array.from({ length: 25 }, (_, word) => `action-${index}-${word}`).join(" "),
				retention: "continuity",
				createdAt: new Date(index + 1).toISOString(),
			},
		}));
		const harness = createHarness([sourceEntry, ...annotationEntries]);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });

		const first = await emit(harness, "context", { type: "context", messages: [source] });
		const firstNotices = (first[0].messages as LiveContextMessage[]).filter(
			(message) => message.customType === "live-context-notice",
		);
		assert.equal(firstNotices.length, 1);
		assert.match(String(firstNotices[0].content), /Active pin\/continuity annotations add about/);

		const second = await emit(harness, "context", { type: "context", messages: [source] });
		assert.equal(
			(second[0].messages as LiveContextMessage[]).filter(
				(message) => message.customType === "live-context-notice",
			).length,
			0,
		);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("preserves a continuity obligation across a revision and recalls its exact source", async () => {
		const exactRequest = "Build live-context-agent after the viewer and preserve this request exactly.";
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "Initial objective", timestamp: 1 },
			{ role: "assistant", content: "Initial analysis", timestamp: 2 },
			{ role: "user", content: exactRequest, timestamp: 3 },
			{ role: "assistant", content: `Long investigation\n${"stale detail\n".repeat(150)}`, timestamp: 4 },
			{ role: "user", content: "Continue with the current task", timestamp: 5 },
		];
		const branch = raw.map((message, index) => ({
			type: "message",
			id: `m${index + 1}`,
			parentId: index === 0 ? null : `m${index}`,
			timestamp: new Date(index * 1_000).toISOString(),
			message,
		}));
		const harness = createHarness(branch);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const prompt = await emit(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base",
			prompt: "task",
			systemPromptOptions: {},
		});
		const mirrorPath = String(prompt[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
		await emit(harness, "context", { type: "context", messages: raw });
		const mirror = await readFile(mirrorPath, "utf8");
		const sourceId = mirror.match(/\[\[CTX_TURN [^\n]* index=3 [^\n]* id=([^ ]+) /)?.[1];
		assert.ok(sourceId);

		const annotate = harness.tools.get("live_context_annotate");
		const recall = harness.tools.get("live_context_recall");
		assert.ok(annotate);
		assert.ok(recall);
		const created = await annotate.execute("annotate-1", {
			action: "create",
			source: sourceId,
			title: "Retain the live-context-agent follow-up",
			reason: "It is the next task after the viewer.",
			futureAction: "Recall it before implementing agent spawning.",
			retention: "continuity",
		}, undefined, undefined, harness.ctx);
		const annotationId = created.details.annotation.id as string;
		const persisted = harness.branch.find((entry) => entry.customType === LIVE_CONTEXT_ANNOTATION);
		assert.equal(persisted.data.source.entryId, "m3");

		const headerMatches = [...mirror.matchAll(/^\[\[CTX_TURN [^\n]+\]\]$/gm)];
		const sourceHeader = headerMatches.find((match) => match[0].includes(` id=${sourceId} `));
		assert.ok(sourceHeader?.index !== undefined);
		const followingHeader = headerMatches.find((match) => (match.index ?? -1) > sourceHeader.index!);
		assert.ok(followingHeader?.index !== undefined);
		let edited = mirror.slice(0, sourceHeader.index) + mirror.slice(followingHeader.index!);
		edited = edited.replace(
			/(\[\[CTX_TURN [^\n]* index=4 [^\n]*\]\]\n)[\s\S]*?(?=\n\n\[\[CTX_TURN )/,
			"$1Investigation complete; implementation remains deferred.",
		);
		await writeFile(mirrorPath, edited, "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });

		const projected = await emit(harness, "context", { type: "context", messages: raw });
		const projectedMessages = projected[0].messages as LiveContextMessage[];
		assert.doesNotMatch(JSON.stringify(projectedMessages), new RegExp(exactRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(JSON.stringify(projectedMessages), new RegExp(annotationId));
		assert.ok(projectedMessages.some((message) => message.customType === "live-context-continuity"));

		const recalled = await recall.execute(
			"recall-1",
			{ id: annotationId, maxTokens: 512 },
			undefined,
			undefined,
			harness.ctx,
		);
		assert.match(recalled.content[0].text, new RegExp(exactRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(recalled.details.source.entryId, "m3");
		assert.equal(recalled.details.truncated, false);

		const pinned = await annotate.execute("annotate-2", {
			action: "create",
			source: "m3",
			title: "Exact follow-up request",
			reason: "Verify explicit exact retention.",
			futureAction: "Resolve after this check.",
			retention: "pin",
		}, undefined, undefined, harness.ctx);
		const pinnedContext = await emit(harness, "context", { type: "context", messages: raw });
		assert.match(JSON.stringify(pinnedContext[0].messages), new RegExp(exactRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		await annotate.execute(
			"annotate-3",
			{ action: "resolve", id: pinned.details.annotation.id, resolution: "Pin behavior verified." },
			undefined,
			undefined,
			harness.ctx,
		);
		const afterResolve = await emit(harness, "context", { type: "context", messages: raw });
		assert.doesNotMatch(JSON.stringify(afterResolve[0].messages), new RegExp(exactRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});

describe("pi-clm continuity placement", () => {
	for (const editingMode of ["clm", "conservative"] as const) {
		for (const noStore of [false, true]) {
			test(`${editingMode}: continuity ordering ${noStore ? "without" : "with"} a mirror preserves conversation and tool pairs`, async (t) => {
				if (noStore) t.mock.method(MirrorStore, "create", async () => { throw new Error("mirror unavailable"); });
				const source: LiveContextMessage = { role: "user", content: "Keep the parser follow-up", timestamp: 1 };
				const harness = createHarness([{ type: "message", id: "m1", parentId: null, message: source }]);
				liveContextExtension(harness.pi, { editingMode });
				await emit(harness, "session_start", { reason: "startup" });
				try {
					await harness.tools.get("live_context_annotate").execute("annotate", {
						action: "create", source: "m1", title: "Parser follow-up", reason: "Still open",
						futureAction: "Verify the parser", retention: "continuity",
					}, undefined, undefined, harness.ctx);
					const first = (await emit(harness, "context", { messages: [source] }))[0].messages as LiveContextMessage[];
					assert.equal(first.length, 2, "no transient notices in the continuation fixture");
					const continuityIndex = editingMode === "clm" ? 0 : 1;
					assert.equal(first[continuityIndex].role, "custom");
					assert.equal(first[continuityIndex].customType, "live-context-continuity");
					assert.equal(first[continuityIndex].display, false);
					assert.equal(JSON.parse(responsesInput(first)[continuityIndex]).role, "user");
					assert.equal(first[editingMode === "clm" ? 1 : 0], source);

					const call: LiveContextMessage = {
						role: "assistant", api: continuityModel.api, provider: continuityModel.provider, model: continuityModel.id,
						content: [{ type: "toolCall", id: "call_parser|fc_parser", name: "read", arguments: { path: "parser.ts" } }],
						stopReason: "toolUse", timestamp: 2,
					};
					const result: LiveContextMessage = {
						role: "toolResult", toolCallId: "call_parser|fc_parser", toolName: "read",
						content: [{ type: "text", text: "Parser source" }], isError: false, timestamp: 3,
					};
					const second = (await emit(harness, "context", { messages: [source, call, result] }))[0].messages as LiveContextMessage[];
					assert.equal(second.length, 4);
					assert.deepEqual(second.filter((m) => m.customType !== "live-context-continuity"), [source, call, result]);
					assert.equal(second[editingMode === "clm" ? 1 : 0], source);
					assert.equal(second.indexOf(result), second.indexOf(call) + 1);
					assert.equal(second[second.indexOf(call)], call);
					assert.equal(second[second.indexOf(result)], result);
					// Pi's WS baseline is previous input + previous assistant output, not just input.
					const callOutput = responsesInput([call]).filter((item) => JSON.parse(item).type !== "function_call_output");
					const baseline = [...responsesInput(first), ...callOutput];
					assert.equal(JSON.stringify(responsesInput(second).slice(0, baseline.length)) === JSON.stringify(baseline), editingMode === "clm");
					const answer: LiveContextMessage = {
						...call, content: [{ type: "text", text: "Parser verified", textSignature: "msg_parser_verified" }],
						stopReason: "stop", timestamp: 4,
					};
					const third = (await emit(harness, "context", { messages: [source, call, result, answer, { role: "user", content: "Continue", timestamp: 5 }] }))[0].messages;
					const nextBaseline = [...responsesInput(second), ...responsesInput([answer])];
					assert.equal(JSON.stringify(responsesInput(third).slice(0, nextBaseline.length)) === JSON.stringify(nextBaseline), editingMode === "clm");
					if (!noStore) {
						const prompt = (await emit(harness, "before_agent_start", { systemPrompt: "base" }))[0].systemPrompt;
						const mirror = await readFile(prompt.match(/mirrored at `([^`]+)`/)[1], "utf8");
						assert.doesNotMatch(mirror, /LIVE CONTEXT CONTINUITY|live-context-continuity/);
					}
				} finally { await emit(harness, "session_shutdown", {}); }
			});
		}
	}

	test("CLM: annotation replacement, resolution and branch restore update the leading snapshot", async () => {
		const source: LiveContextMessage = { role: "user", content: "Source task", timestamp: 1 };
		const harness = createHarness([{ type: "message", id: "m1", parentId: null, message: source }]);
		harness.ctx.sessionManager.getLeafId = () => harness.branch.at(-1)?.id ?? null;
		harness.ctx.mode = "rpc";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const annotate = harness.tools.get("live_context_annotate");
			const created = await annotate.execute("create", {
				action: "create", source: "m1", title: "Original obligation", reason: "Open task",
				futureAction: "Finish it", retention: "continuity",
			}, undefined, undefined, harness.ctx);
			const originalBranch = [...harness.branch];
			const initial = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.match(initial[0].content, /Original obligation/);
			// Annotation updates are append-only snapshots with the same ID, not a new tool action.
			harness.pi.appendEntry(LIVE_CONTEXT_ANNOTATION, { ...created.details.annotation, title: "Updated obligation", futureAction: "Verify it" });
			await emit(harness, "session_tree", {});
			await harness.commands.get("clm").handler("input", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /current input \(2 messages\):\n#1 custom/);
			const updated = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.match(updated[0].content, /Updated obligation/);
			assert.doesNotMatch(updated[0].content, /Original obligation/);
			const stable = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.deepEqual(responsesInput(stable), responsesInput(updated.filter((m: LiveContextMessage) => m.customType !== "live-context-notice")));
			await annotate.execute("resolve", { action: "resolve", id: created.details.annotation.id, resolution: "Done" }, undefined, undefined, harness.ctx);
			const resolved = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.deepEqual(resolved, [source]);

			const resumed = createHarness([...harness.branch]);
			liveContextExtension(resumed.pi, { editingMode: "clm" });
			await emit(resumed, "session_start", { reason: "resume" });
			try { assert.deepEqual((await emit(resumed, "context", { messages: [source] }))[0].messages, [source]); }
			finally { await emit(resumed, "session_shutdown", {}); }

			harness.branch.splice(0, harness.branch.length, ...originalBranch);
			await emit(harness, "session_tree", {});
			const restored = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.equal(restored[0].customType, "live-context-continuity");
			assert.match(restored[0].content, /Original obligation/);
			assert.doesNotMatch(restored[0].content, /Updated obligation/);
			harness.branch.splice(1);
			await emit(harness, "session_tree", {});
			const early = (await emit(harness, "context", { messages: [source] }))[0].messages;
			assert.equal(early.some((m: LiveContextMessage) => m.customType === "live-context-continuity"), false);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: a mirror edit cannot erase a pin; checkpoint excludes continuity and subsequent input is stable", async () => {
		const raw = rawConversation();
		const harness = createHarness(raw.map((message, index) => ({ type: "message", id: `m${index + 1}`, parentId: index ? "m1" : null, message })));
		harness.ctx.mode = "rpc";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const prompt = (await emit(harness, "before_agent_start", { systemPrompt: "base" }))[0].systemPrompt;
			const path = prompt.match(/mirrored at `([^`]+)`/)[1];
			await harness.tools.get("live_context_annotate").execute("pin", {
				action: "create", source: "m1", title: "Keep the objective", reason: "Exact wording matters",
				futureAction: "Complete the objective", retention: "pin",
			}, undefined, undefined, harness.ctx);
			const before = (await emit(harness, "context", { messages: raw }))[0].messages;
			assert.match(before[0].content, /already present in the projected conversation/);
			const mirror = await readFile(path, "utf8");
			assert.doesNotMatch(mirror, /LIVE CONTEXT CONTINUITY|live-context-continuity/);
			await writeFile(path, mirror.replace("Solve the task", "Revised objective"));
			await emit(harness, "turn_end", {});
			const state = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1).data;
			assert.equal(state.lastOutcome.kind, "applied");
			assert.equal(state.checkpoint.sourceMessageCount, raw.length);
			assert.doesNotMatch(JSON.stringify(state.checkpoint), /LIVE CONTEXT CONTINUITY|live-context-continuity/);
			await harness.commands.get("clm").handler("input", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /current input \(3 messages\):\n#1 custom/);
			// Consume the unchanged, out-of-scope accepted-edit notice before checking continuation.
			await emit(harness, "context", { messages: raw });
			const edited = (await emit(harness, "context", { messages: raw }))[0].messages;
			assert.equal(edited.length, 3);
			assert.match(edited[0].content, /<live-context-pinned-source>[\s\S]*Solve the task/);
			assert.equal(edited[1].content, "Revised objective");
			assert.notEqual(edited[0].content, before[0].content, "pin source-presence change invalidates once");
			const answer: LiveContextMessage = {
				role: "assistant", api: continuityModel.api, provider: continuityModel.provider, model: continuityModel.id,
				content: [{ type: "text", text: "Ready", textSignature: "msg_ready" }], stopReason: "stop", timestamp: 3,
			};
			const next = (await emit(harness, "context", { messages: [...raw, answer, { role: "user", content: "Continue", timestamp: 4 }] }))[0].messages;
			const baseline = [...responsesInput(edited), ...responsesInput([answer])];
			assert.deepEqual(responsesInput(next).slice(0, baseline.length), baseline);
			const resumed = createHarness([...harness.branch]);
			resumed.ctx.sessionManager.getLeafId = () => resumed.branch.at(-1)?.id ?? null;
			resumed.ctx.mode = "rpc";
			liveContextExtension(resumed.pi, { editingMode: "clm" });
			await emit(resumed, "session_start", { reason: "resume" });
			try {
				await resumed.commands.get("clm").handler("input", resumed.ctx);
				assert.match(resumed.notifications.at(-1)!, /current input \(3 messages\):\n#1 custom/);
				assert.deepEqual(responsesInput((await emit(resumed, "context", { messages: raw }))[0].messages), responsesInput(edited));
			} finally { await emit(resumed, "session_shutdown", {}); }
		} finally { await emit(harness, "session_shutdown", {}); }
	});
});

describe("pi-clm entry point", () => {
	for (const mode of ["mixed", "all-stale"]) {
		void test(`CLM ${mode} mirror edit preserves raw input and delivers a truthful stale-header notice on the next context`, async () => {
			const harness = createHarness();
			clmExtension(harness.pi);
			await emit(harness, "session_start", { reason: "startup" });
			try {
				const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
				const pathMatch = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/);
				assert.ok(pathMatch, "CLM guidance supplies the real mirror path");
				const path = pathMatch[1];
				const raw: LiveContextMessage[] = [
					{ role: "user", content: "Keep the task.", timestamp: 1 },
					{ role: "assistant", content: "Current body.", timestamp: 2 },
					{ role: "assistant", content: "Stale body.", timestamp: 3 },
				];
				await emit(harness, "context", { messages: raw });
				const original = await readFile(path, "utf8");
				const headers = original.match(/^\[\[CTX_TURN [^\n]+\]\]$/gm);
				assert.ok(headers, "disk mirror contains current block headers");
				assert.equal(headers.length, 3);
				const staleHeaders = headers.map((header) => header.replace(/document=[a-f0-9]+ /, "document=00000000deadbeef "));
				const edited = mode === "mixed"
					? original.replace(headers[2], staleHeaders[2])
					: original.replace(/^\[\[CTX_TURN [^\n]+\]\]$/gm,
						(header) => header.replace(/document=[a-f0-9]+ /, "document=00000000deadbeef "));
				assert.notEqual(edited, original);
				await writeFile(path, edited, "utf8");
				await emit(harness, "turn_end", {});
				const persisted = harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1);
				assert.equal(persisted.data.lastOutcome.kind, "applied", "CLM checkpoint accepts the diagnostic-only edit");
				assert.equal(persisted.data.revision, 1);
				assert.ok(persisted.data.checkpoint);

				const next = await emit(harness, "context", { messages: raw });
				const visible: LiveContextMessage[] = next[0].messages;
				assert.equal(visible[0], raw[0]);
				assert.equal(visible.length, 3);
				if (mode === "mixed") {
					assert.deepEqual(visible[1].content, [
						{ type: "text", text: `Current body.\n\n${staleHeaders[2]}\nStale body.` },
					]);
					assert.equal(visible[1].timestamp, 2);
				} else {
					assert.equal(visible[1].customType, "live-context-projection");
					assert.equal(visible[1].content,
						`[context role=notes]\n${staleHeaders[0]}\nKeep the task.\n\n${staleHeaders[1]}\nCurrent body.\n\n${staleHeaders[2]}\nStale body.`);
				}
				assert.deepEqual(raw, [
					{ role: "user", content: "Keep the task.", timestamp: 1 },
					{ role: "assistant", content: "Current body.", timestamp: 2 },
					{ role: "assistant", content: "Stale body.", timestamp: 3 },
				]);
				const notice = visible.find((message) => message.customType === "live-context-notice");
				assert.ok(notice, "next context delivers an acceptance notice");
				const text = String(notice.content);
				assert.doesNotMatch(text, /not applied|earlier context revision/i,
					"consumer notice must not claim retained content was discarded or infer an earlier revision");
				assert.match(text, /Unrecognized stale-nonce header/,
					"consumer notice must include stale diagnostics for both accepted paths");
				assert.match(text, /text and following body/);
				assert.match(text, /message body.*notes/);
				assert.match(text, /copy.*current mirror/i);
				if (mode === "all-stale") {
					assert.match(text, /Accepted a headerless rewrite/);
				}
			} finally {
				await emit(harness, "session_shutdown", {});
			}
		});
	}

	test("failed persistence leaves the previous projection active", async () => {
		const harness = createHarness();
		clmExtension(harness.pi);
		await emit(harness, "session_start", {});
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const raw = rawConversation();
			await emit(harness, "context", { messages: raw });
			const original = await readFile(path, "utf8");
			await writeFile(path, original.replace("Solve the task", "not committed"));
			harness.pi.appendEntry = () => { throw new Error("simulated disk error"); };
			await emit(harness, "turn_end", {});
			const next = await emit(harness, "context", { messages: raw });
			assert.equal(next[0].messages[0].content, "Solve the task");
			assert.match(JSON.stringify(next[0].messages), /persistence failed/);
			assert.equal(harness.branch.length, 0);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("tree navigation during mirror read invalidates an equal-revision draft", async (t) => {
		const harness = createHarness();
		clmExtension(harness.pi);
		await emit(harness, "session_start", {});
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const raw = rawConversation();
			await emit(harness, "context", { messages: raw });
			const candidate = (await readFile(path, "utf8")).replace("Solve the task", "old branch draft");
			let finish!: (value: string) => void;
			const read = t.mock.method(MirrorStore.prototype, "read", () => new Promise<string>(resolve => { finish = resolve; }));
			const pending = emit(harness, "turn_end", {});
			await emit(harness, "session_tree", {});
			finish(candidate);
			await pending;
			read.mock.restore();
			assert.equal(harness.branch.length, 0);
			const next = await emit(harness, "context", { messages: raw });
			assert.equal(next[0].messages[0].content, "Solve the task");
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("registers clm commands, allows multiple writes, commits growth and restores on resume", async () => {
		const harness = createHarness();
		clmExtension(harness.pi);
		assert.ok(harness.commands.has("clm"));
		assert.equal(harness.commands.has("clm-view"), false, "one entry point: /clm opens the panel");
		assert.equal(harness.commands.has("live-context"), false);
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const resources = await emit(harness, "resources_discover", {});
			assert.deepEqual(resources[0].skillPaths, []);
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const raw = rawConversation();
			await emit(harness, "context", { messages: raw });
			const original = await readFile(path, "utf8");
			assert.doesNotMatch(original, /protected=true/);
			for (let i = 0; i < 2; i++) {
				const calls = await emit(harness, "tool_call", { toolName: "write", input: { path, content: "candidate" } });
				assert.ok(calls.every(result => !result?.block));
			}
			await writeFile(path, original.replace("Solve the task", "expanded task ".repeat(100)));
			await emit(harness, "turn_end", {});
			assert.equal(harness.branch.at(-1)?.data.lastOutcome.kind, "applied");
			const projected = await emit(harness, "context", { messages: raw });
			assert.equal(projected[0].messages[0].content, "expanded task ".repeat(100).trim());
			const resumed = createHarness([...harness.branch]);
			clmExtension(resumed.pi);
			await emit(resumed, "session_start", { reason: "resume" });
			try {
				const restored = await emit(resumed, "context", { messages: raw });
				assert.equal(restored[0].messages[0].content, projected[0].messages[0].content);
			} finally { await emit(resumed, "session_shutdown", {}); }
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM budget reminders state both measurements, fire once per tier, and skip stale observations", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 1000, reserve: 100, remindAtFractions: [0.5] } });
		harness.ctx.model = { contextWindow: 200_000 };
		harness.ctx.getSystemPrompt = () => "system";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const small: LiveContextMessage[] = [{ role: "user", content: "hi", timestamp: 1 }];
			const first = await emit(harness, "context", { messages: small });
			assert.equal(JSON.stringify(first[0]?.messages ?? small).includes("[CLM BUDGET]"), false);

			// A large assistant turn with provider usage above 50% of the configured budget.
			const raw: LiveContextMessage[] = [
				...small,
				{
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(40) }],
					api: "test", provider: "test", model: "test",
					usage: { input: 700, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 710, cost: { total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "next", timestamp: 3 },
			];
			const crossed = await emit(harness, "context", { messages: raw });
			const notice = crossed[0].messages.find((m: any) => typeof m.content === "string" && m.content.startsWith("[CLM BUDGET]"));
			assert.ok(notice, "expected a budget notice");
			assert.match(notice.content, /crossed 50% of a 1,000-token budget/);
			assert.match(notice.content, /the provider reported 700 for the previous one/);
			assert.match(notice.content, /estimated \d+ tokens for the next request/);
			// Same tier does not fire twice.
			const again = await emit(harness, "context", { messages: raw });
			assert.equal(again[0].messages.some((m: any) => typeof m.content === "string" && m.content.startsWith("[CLM BUDGET]")), false);

			// Compaction edit accepted: the old observation must not re-trigger the reminder.
			const document = await readFile(path, "utf8");
			await writeFile(path, document.replace("x".repeat(40), "compacted"));
			await emit(harness, "turn_end", {});
			const after = await emit(harness, "context", { messages: raw });
			assert.equal(after[0].messages.some((m: any) => typeof m.content === "string" && m.content.startsWith("[CLM BUDGET]")), false);

			const details = await clmSettingsText(harness);
			assert.match(details, /Budget +1k\n/);
			assert.match(details, /Reserve +100\n/);
			// The 700-token prompt observation predates the accepted edit: it is not shown as current.
			assert.match(details, /Size +next request ~\d+ of 1k\n/);
			assert.doesNotMatch(details, /last request 700/);

			await harness.commands.get("clm").handler("budget 500", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /CLM Budget: 500\./);
			await harness.commands.get("clm").handler("budget nonsense", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /expected a number of tokens/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM: an observation from before the active revision stays stale after resume and /tree", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 1000, reserve: 100, remindAtFractions: [0.5] } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{
				role: "assistant", content: [{ type: "text", text: "large".repeat(100) }], api: "test", provider: "test", model: "test",
				usage: { input: 600, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { total: 0 } }, stopReason: "stop", timestamp: 2,
			},
		];
		const budgetNotices = (result: any[]) => result[0].messages.filter((m: any) => typeof m.content === "string" && m.content.startsWith("[CLM BUDGET]"));
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			assert.equal(budgetNotices(await emit(harness, "context", { messages: raw })).length, 1, "600-token observation crosses 50% of 1000");
			const text = await readFile(path, "utf8");
			await writeFile(path, text.replace(/(\[\[CTX_TURN[^\n]+index=2[^\n]+\]\]\n)[\s\S]*$/, "$1tiny"));
			await emit(harness, "turn_end", {});
			assert.equal(budgetNotices(await emit(harness, "context", { messages: raw })).length, 0, "same runtime: stale observation ignored");

			const resumed = createHarness([...harness.branch]);
			liveContextExtension(resumed.pi, { editingMode: "clm", budget: { contextBudget: 1000, reserve: 100, remindAtFractions: [0.5] } });
			resumed.ctx.model = { contextWindow: 100_000 };
			resumed.ctx.getSystemPrompt = () => "";
			await emit(resumed, "session_start", { reason: "resume" });
			try {
				assert.equal(budgetNotices(await emit(resumed, "context", { messages: raw })).length, 0, "after resume: still stale");
				await emit(resumed, "session_tree", {});
				assert.equal(budgetNotices(await emit(resumed, "context", { messages: raw })).length, 0, "after /tree: still stale");
				// A new request answered after the revision is fresh and governs again.
				const grown: LiveContextMessage[] = [...raw, { ...raw[1], timestamp: 3, usage: { input: 700, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 700, cost: { total: 0 } } } as LiveContextMessage];
				const fresh = budgetNotices(await emit(resumed, "context", { messages: grown }));
				assert.equal(fresh.length, 1);
				assert.match(fresh[0].content, /provider reported 700 for the previous one\./);
				assert.match(fresh[0].content, /excluding tool schemas and provider framing/);
			} finally { await emit(resumed, "session_shutdown", {}); }
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: /clm budget takes effect immediately in status and the viewer model", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 1000, reserve: 100 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		harness.ctx.sessionManager.getLeafId = () => null;
		harness.ctx.sessionManager.getTree = () => [];
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await emit(harness, "context", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /of 1k budget/);
			await harness.commands.get("clm").handler("budget 500", harness.ctx);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /of 500 budget/);
			assert.doesNotMatch(harness.notifications.at(-1)!, /1k/);
			assert.match(harness.statuses.get("live-context") ?? "", /^clm \d+ \/ 500 · r0$/, "footer follows the new budget");
			harness.ctx.mode = "rpc";
			harness.branch.push({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 600 } } });
			await harness.commands.get("clm").handler("overview", harness.ctx);
			// 600-token peak with a 500 budget: the budget line is drawn (it would be off-scale at 1,000).
			const report = harness.notifications.at(-1)!;
			assert.match(report, /600 ┤/);
			assert.match(report, /┼/);
			assert.doesNotMatch(report, /above scale/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: non-TUI /clm reports the requested page", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm" });
		harness.ctx.mode = "rpc";
		harness.ctx.sessionManager.getLeafId = () => null;
		harness.ctx.sessionManager.getTree = () => [];
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const raw = rawConversation();
			await emit(harness, "context", { messages: raw });
			await harness.commands.get("clm").handler("", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /No completed requests on this branch yet|requests? 1/);
			await harness.commands.get("clm").handler("input", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /current input \(\d+ messages\):\n#1 user/);
			await harness.commands.get("clm").handler("edits", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /no accepted context edits on this branch/);
			await harness.commands.get("clm").handler("settings", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Budget +model window/);
			await harness.commands.get("clm").handler("tree", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Usage: \/clm \[overview\|input\|edits\|settings\|status\|config/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM: steering document reaches the system prompt and status; observation cap bounds tool results in the mirror", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-clm-ext-steering-"));
		const steeringPath = join(dir, "brief.md");
		writeFileSync(steeringPath, "Keep a tracker block at the top.");
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", steeringPath, observationCap: { maxCharacters: 400 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			assert.match(before[0].systemPrompt, /## Editable context[\s\S]*## Context-management guidance \(brief\.md\)\n\nKeep a tracker block at the top\./);
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const raw: LiveContextMessage[] = [
				{ role: "user", content: "read it", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], api: "t", provider: "t", model: "t", usage: { cost: { total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x".repeat(5000) }], isError: false, timestamp: 3 },
			];
			const result = await emit(harness, "context", { messages: raw });
			const sent = result[0].messages.find((m: any) => m.role === "toolResult");
			assert.ok(sent.content[0].text.length < 700, "tool result capped in the effective context");
			assert.match(sent.content[0].text, /observation cap: 400 of 5,000 characters shown/);
			const mirror = await readFile(path, "utf8");
			assert.match(mirror, /observation cap: 400 of 5,000/);
			assert.equal((raw[2]!.content as { text: string }[])[0]!.text.length, 5000, "raw message untouched");
			const details = await clmSettingsText(harness);
			assert.match(details, /steering brief\.md \(sha256sum [a-f0-9]{12}…\)/);
			assert.match(details, /Observation cap +400 chars/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: a missing steering document warns once and keeps the protocol-only prompt", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", steeringPath: "/nonexistent/steering.md" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			assert.match(harness.notifications.at(-1)!, /steering document not loaded/);
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			assert.doesNotMatch(before[0].systemPrompt, /Context-management guidance/);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /⚠ steering document not loaded/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM: overflow guard withholds the oldest tool results of the raw suffix and the mirror shows the notes", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 3000, reserve: 500, remindAtFractions: [] , remindAtReserve: false } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const before = await emit(harness, "before_agent_start", { systemPrompt: "" });
			const path = before[0].systemPrompt.match(/mirrored at `([^`]+)`/)[1];
			const big = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "z".repeat(8000) }], isError: false, timestamp: 3 }) as LiveContextMessage;
			const raw: LiveContextMessage[] = [
				{ role: "user", content: "read all", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }, { type: "toolCall", id: "c2", name: "read", arguments: {} }, { type: "toolCall", id: "c3", name: "read", arguments: {} }], api: "t", provider: "t", model: "t", usage: { cost: { total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				big("c1"), big("c2"), big("c3"),
			];
			const result = await emit(harness, "context", { messages: raw });
			const sent = result[0].messages;
			const tools = sent.filter((m: any) => m.role === "toolResult");
			assert.equal(tools.length, 3, "tool-call pairing intact");
			const notes = tools.filter((m: any) => JSON.stringify(m.content).includes("[pi-clm overflow guard]"));
			assert.ok(notes.length >= 2 && notes.length <= 3, `expected oldest results withheld, got ${notes.length}`);
			assert.ok(JSON.stringify(tools[2].content).includes("[pi-clm overflow guard]") === (notes.length === 3), "newest result is withheld last");
			const notice = sent.find((m: any) => typeof m.content === "string" && m.content.startsWith("[CLM BUDGET] Overflow guard"));
			assert.ok(notice, "overflow notice present");
			assert.match(notice.content, /withheld from your context/);
			const mirror = await readFile(path, "utf8");
			assert.match(mirror, /\[pi-clm overflow guard\] read#c1 \(~[\d,]+ tok\) withheld over budget/);
			assert.match(notice.content, /read#c1/);
			// Saved file path is under the mirror directory and holds the full text.
			const file = JSON.stringify(sent).match(/Full text: ([^\s"\\]+\.txt)/)?.[1];
			assert.ok(file, "note points at a saved file");
			assert.equal((await readFile(file!, "utf8")).length, 8000);
			// Raw history untouched.
			assert.equal((raw[4]!.content as { text: string }[])[0]!.text.length, 8000);
			assert.match(await clmSettingsText(harness), /Guard +withholds the oldest tool results above 2\.5k/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM: generated output does not inflate prompt calibration or cross a budget tier", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 1000, reserve: 100, remindAtFractions: [0.5] } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const raw: LiveContextMessage[] = [{ role: "user", content: "task ".repeat(240), timestamp: 1 }];
			await emit(harness, "context", { messages: raw });
			const answer = {
				role: "assistant", content: [{ type: "text", text: "ok" }], api: "t", provider: "t", model: "t",
				usage: { input: 100, cacheRead: 150, cacheWrite: 50, output: 2000, totalTokens: 2300, cost: { total: 0 } },
				stopReason: "stop", timestamp: 2,
			} as LiveContextMessage;
			const sent = (await emit(harness, "context", { messages: [...raw, answer] }))[0].messages;
			assert.equal(sent.some((m: any) => JSON.stringify(m.content).includes("[CLM BUDGET]")), false);
			assert.match(await clmSettingsText(harness), /estimate ×1\.00, calibrated from 1 provider count/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: provider counts calibrate the estimator and the guard withholds more; threshold compaction is cancelled while the context fits", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 6000, reserve: 1000, remindAtFractions: [], remindAtReserve: false } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const big = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "q".repeat(4000) }], isError: false, timestamp: 3 }) as LiveContextMessage;
			const call = (ids: string[]) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })), api: "t", provider: "t", model: "t", usage: { cost: { total: 0 } }, stopReason: "toolUse", timestamp: 2 }) as LiveContextMessage;
			// Turn 1: four 1k-token results, raw estimate ~4k < 5k limit → nothing withheld.
			const raw1: LiveContextMessage[] = [{ role: "user", content: "go", timestamp: 1 }, call(["a", "b", "c", "d"]), big("a"), big("b"), big("c"), big("d")];
			const first = await emit(harness, "context", { messages: raw1 });
			assert.equal(first[0].messages.filter((m: any) => JSON.stringify(m.content).includes("overflow guard")).length, 0);
			// The provider reports that request at 2.5× our estimate.
			const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "t", provider: "t", model: "t", usage: { input: 10_000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10_005, cost: { total: 0 } }, stopReason: "stop", timestamp: 4 } as LiveContextMessage;
			const raw2: LiveContextMessage[] = [...raw1, answer, { role: "user", content: "more", timestamp: 5 }];
			const second = await emit(harness, "context", { messages: raw2 });
			// Same content, now calibrated (~2.5×): ~10k > 5k limit → results are withheld.
			const withheld = second[0].messages.filter((m: any) => JSON.stringify(m.content).includes("[pi-clm overflow guard]")).length;
			assert.ok(withheld >= 2, `expected calibrated guard to withhold, got ${withheld}`);
			const details = await clmSettingsText(harness);
			assert.match(details, /estimate ×2\.\d\d, calibrated from 1 provider count\n/);
			assert.match(details, /Pi's automatic compaction paused/);
			assert.match(details, /Pi compaction +auto/);
			// Pi wants to compact on its raw-history threshold; the effective context fits → cancelled.
			const cancelled = await emit(harness, "session_before_compact", { reason: "threshold", willRetry: false, preparation: {}, branchEntries: [] });
			assert.deepEqual(cancelled[0], { cancel: true });
			assert.match(harness.notifications.at(-1)!, /cancelled Pi's threshold compaction/);
			// Manual and overflow compactions are left alone.
			assert.equal((await emit(harness, "session_before_compact", { reason: "manual", willRetry: false }))[0], undefined);
			assert.equal((await emit(harness, "session_before_compact", { reason: "overflow", willRetry: true }))[0], undefined);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: nativeCompaction=off cancels every automatic compaction but not /compact", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", nativeCompaction: "off" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			assert.deepEqual((await emit(harness, "session_before_compact", { reason: "overflow", willRetry: true }))[0], { cancel: true });
			assert.deepEqual((await emit(harness, "session_before_compact", { reason: "threshold", willRetry: false }))[0], { cancel: true });
			assert.equal((await emit(harness, "session_before_compact", { reason: "manual", willRetry: false }))[0], undefined);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM paper parity: one tool call per turn, size trailer on results, status labels", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 20_000 }, oneToolPerTurn: true, sizeTrailer: true });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await emit(harness, "turn_start", {});
			const first = await emit(harness, "tool_call", { toolName: "read", toolCallId: "c1", input: {} });
			assert.equal(first[0], undefined, "first call runs");
			const second = await emit(harness, "tool_call", { toolName: "bash", toolCallId: "c2", input: {} });
			assert.equal(second[0]?.block, true);
			assert.match(second[0].reason, /exactly one tool call per turn; this bash call \(#2 in the turn\)/);
			await emit(harness, "turn_start", {});
			assert.equal((await emit(harness, "tool_call", { toolName: "bash", toolCallId: "c3", input: {} }))[0], undefined, "counter resets per turn");

			await emit(harness, "context", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			const patched = await emit(harness, "tool_result", { toolName: "read", toolCallId: "c1", input: {}, content: [{ type: "text", text: "file body" }], isError: false });
			assert.match(patched[0].content[0].text, /^file body\n\[context: ~\d[\d,]* of 20,000 tokens after this result\]$/);
			const empty = await emit(harness, "tool_result", { toolName: "read", toolCallId: "c4", input: {}, content: [], isError: false });
			assert.match(empty[0].content[0].text, /^\[context: ~/);

			const details = await clmSettingsText(harness);
			assert.match(details, /One tool per turn +on/);
			assert.match(details, /Size trailer +on/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM settings: /clm config changes apply now, persist on the branch, survive resume, and reset", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 10_000 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await harness.commands.get("clm").handler("config budget 200k", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /CLM Budget: 200k\./);
			await harness.commands.get("clm").handler("config guard off", harness.ctx);
			await harness.commands.get("clm").handler("config steering house", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /CLM Steering: house-brief\.md\./);
			const before = await emit(harness, "before_agent_start", { systemPrompt: "base" });
			assert.match(before[0].systemPrompt, /## Context-management guidance \(house-brief\.md\)/, "steering applies without a restart");

			let details = await clmSettingsText(harness);
			assert.match(details, /Budget +200k {2}\(changed\)/);
			assert.match(details, /Overflow guard +off {2}\(changed\)/);
			assert.match(details, /Guard +off/);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /settings: budget 200k · overflow guard off · steering house-brief\.md/);

			// Stored as a branch-local session entry holding only the differences.
			const saved = harness.branch.filter((entry) => entry.customType === "pi-clm-settings").at(-1);
			assert.equal(saved.data.overrides.budget, 200_000);
			assert.equal(saved.data.overrides.guard, "off");
			assert.equal("reserve" in saved.data.overrides, false);

			// Setting a value back to its default drops the override.
			await harness.commands.get("clm").handler("config budget 10k", harness.ctx);
			assert.equal("budget" in harness.branch.filter((entry) => entry.customType === "pi-clm-settings").at(-1).data.overrides, false);

			await harness.commands.get("clm").handler("config budget lots", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /expected a number of tokens/);
			await harness.commands.get("clm").handler("config steering /nonexistent/brief.md", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /steering document not loaded/);
			assert.match(await clmSettingsText(harness), /Steering +house-brief\.md/, "a failed change keeps the previous value");
			await harness.commands.get("clm").handler("config colour blue", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Unknown setting "colour"/);
			await harness.commands.get("clm").handler("config cap", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Observation cap: off — Keep at most/);

			const resumed = createHarness([...harness.branch]);
			liveContextExtension(resumed.pi, { editingMode: "clm", budget: { contextBudget: 10_000 } });
			resumed.ctx.model = { contextWindow: 100_000 };
			resumed.ctx.getSystemPrompt = () => "";
			await emit(resumed, "session_start", { reason: "resume" });
			try {
				details = await clmSettingsText(resumed);
				assert.match(details, /Overflow guard +off {2}\(changed\)/, "overrides survive resume");
				assert.match(details, /Budget +10k\n/);
				await resumed.commands.get("clm").handler("config reset", resumed.ctx);
				assert.match(resumed.notifications.at(-1)!, /reset to the defaults/);
				details = await clmSettingsText(resumed);
				assert.doesNotMatch(details, /\(changed\)/);
				const prompt = await emit(resumed, "before_agent_start", { systemPrompt: "base" });
				assert.doesNotMatch(prompt[0].systemPrompt, /Context-management guidance/);
			} finally { await emit(resumed, "session_shutdown", {}); }
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM settings: a change that cannot be saved does not take effect", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 10_000 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		const append = harness.pi.appendEntry.bind(harness.pi);
		let failSettingsSaves = false;
		(harness.pi as any).appendEntry = (customType: string, data: unknown) => {
			if (failSettingsSaves && customType === "pi-clm-settings") throw new Error("disk full");
			append(customType, data);
		};
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await harness.commands.get("clm").handler("config budget 200k", harness.ctx);
			failSettingsSaves = true;
			await harness.commands.get("clm").handler("config guard off", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Settings unchanged: saving them to the session failed \(disk full\)/);
			await harness.commands.get("clm").handler("config reset", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /Settings unchanged/);
			const details = await clmSettingsText(harness);
			assert.match(details, /Overflow guard +on\n/, "the unsaved guard change is not active");
			assert.match(details, /Budget +200k {2}\(changed\)/, "the unsaved reset is not active");
			assert.equal(harness.branch.filter((entry) => entry.customType === "pi-clm-settings").length, 1);

			failSettingsSaves = false;
			await harness.commands.get("clm").handler("config guard off", harness.ctx);
			assert.match(await clmSettingsText(harness), /Overflow guard +off {2}\(changed\)/, "saving works again");
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM settings: a malformed saved entry is ignored with a warning instead of breaking session start", async () => {
		const harness = createHarness([
			{ type: "custom", id: "s1", parentId: null, timestamp: new Date().toISOString(), customType: "pi-clm-settings", data: { version: 1, overrides: { reminders: "50/75", guard: "off" } } },
		]);
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 10_000 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "resume" });
		try {
			assert.match(harness.notifications.join("\n"), /pi-clm: ignored invalid saved settings: reminders/);
			await harness.commands.get("clm").handler("path", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /LIVE_CONTEXT\.md$/, "session start finished: the mirror exists");
			const details = await clmSettingsText(harness);
			assert.match(details, /Overflow guard +off {2}\(changed\)/, "the well-formed part still applies");
			assert.match(details, /Reminders +50\/75\/90%\n/);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /⚠ ignored invalid saved settings: reminders/);
			await harness.commands.get("clm").handler("config reminders 75/90", harness.ctx);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.doesNotMatch(harness.notifications.at(-1)!, /ignored/, "saving settings again clears the warning");
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: after /clm reset, status and footer estimate the rebuilt context, not the old projection", async () => {
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "x".repeat(40_000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "done" }], api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 2, usage: { input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10_010, cost: { total: 0 } } } as any,
		];
		const checkpoint = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: raw,
			projectedMessages: [{ role: "user", content: "saved context ".repeat(1_000), timestamp: 1 }],
			beforeEstimate: 10_010,
			afterEstimate: 3_000,
		});
		const harness = createHarness([
			...raw.map((message, index) => ({ type: "message", id: `m${index}`, parentId: index ? "m0" : null, message })),
			{ type: "custom", id: "checkpoint", parentId: "m1", customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 1, checkpoint } },
		]);
		harness.ctx.sessionManager.getLeafId = () => harness.branch.at(-1)?.id ?? null;
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "resume" });
		try {
			await emit(harness, "context", { messages: raw });
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /next request ~3\.5k of 100k/);
			await harness.commands.get("clm").handler("reset", harness.ctx);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /next request ~10k of 100k/, "the raw context is what goes out now");
			assert.equal(harness.statuses.get("live-context"), "clm 10k / 100k · r2");
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: after a settings change, status and footer still count the system prompt", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 1000 } });
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "s".repeat(8000);
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await emit(harness, "context", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /next request ~2k of 1k budget/);
			// The budget change drops the reading; the next-request estimate must not drop to the messages alone.
			await harness.commands.get("clm").handler("config budget 4k", harness.ctx);
			await harness.commands.get("clm").handler("status", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /next request ~2k of 4k budget \(50%\)/);
			assert.equal(harness.statuses.get("live-context"), "clm 2k / 4k · r0");
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: /clm-compact sends a fixed prompt asking the model to compact its own context", async (t) => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 100_000 } });
		harness.ctx.model = { contextWindow: 200_000 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const compact = (args: string) => harness.commands.get("clm-compact").handler(args, harness.ctx);
			assert.ok(harness.commands.has("clm-compact"), "a top-level command, so completion lists it beside Pi's /compact");
			await compact("");
			assert.match(harness.notifications.at(-1)!, /Nothing to compact yet/);
			assert.equal(harness.sentUserMessages.length, 0);

			await emit(harness, "context", { messages: [{ role: "user", content: "x".repeat(40_000), timestamp: 1 }] });
			await harness.commands.get("clm").handler("path", harness.ctx);
			const mirror = harness.notifications.at(-1)!;
			await compact("");
			const sent = harness.sentUserMessages.at(-1)!;
			assert.equal(sent.options, undefined, "idle: sent now");
			const prompt = String(sent.content);
			assert.match(prompt, /^Compact your live context now\./);
			assert.ok(prompt.includes(`about 10k tokens (budget 100k). Your context is mirrored at \`${mirror}\``), prompt);
			assert.doesNotMatch(prompt, /\{\{|Also:/);
			assert.match(harness.notifications.at(-1)!, /Asked the model to compact its context \(now about 10k tokens\)/);

			await compact("keep the PR numbers");
			assert.match(String(harness.sentUserMessages.at(-1)!.content), /\n\nAlso: keep the PR numbers\n\n/);

			// Busy: say so, wait for the run to finish, then send.
			harness.ctx.isIdle = () => false;
			harness.ctx.waitForIdle = async () => { harness.ctx.isIdle = () => true; };
			await compact("");
			assert.match(harness.notifications.at(-2)!, /when the current run finishes/);
			assert.equal(harness.sentUserMessages.length, 3);
			assert.equal(harness.sentUserMessages.at(-1)!.options, undefined);

			// A custom template replaces the prompt; a file that cannot be read is rejected when it is set.
			const directory = await mkdtemp(join(tmpdir(), "clm-compact-"));
			t.after(() => rm(directory, { recursive: true, force: true }));
			const template = join(directory, "compact.md");
			await writeFile(template, "Shrink {{mirror}} ({{current}}). {{instructions}}");
			await harness.commands.get("clm").handler(`config compact-prompt ${template}`, harness.ctx);
			assert.match(harness.notifications.at(-1)!, /CLM Compact prompt: compact\.md\./);
			await harness.commands.get("clm").handler("config compact-prompt /nonexistent/compact.md", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /compact prompt not loaded/);
			await compact("tidy up");
			assert.equal(String(harness.sentUserMessages.at(-1)!.content), `Shrink ${mirror} (10k). Also: tidy up`);

			await harness.commands.get("clm").handler("off", harness.ctx);
			await compact("");
			assert.match(harness.notifications.at(-1)!, /CLM is off/);
			assert.equal(harness.sentUserMessages.length, 4);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: /clm-compact estimates a resumed context whose last usage predates its checkpoint", async () => {
		const raw: LiveContextMessage[] = [
			{ role: "user", content: "x".repeat(40_000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "done" }], api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 2, usage: { input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10_010, cost: { total: 0 } } } as any,
		];
		const checkpoint = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: raw,
			projectedMessages: [{ role: "user", content: "saved context ".repeat(1_000), timestamp: 1 }],
			beforeEstimate: 10_010,
			afterEstimate: 3_000,
		});
		const harness = createHarness([
			...raw.map((message, index) => ({ type: "message", id: `m${index}`, parentId: index ? "m0" : null, message })),
			{ type: "custom", id: "checkpoint", parentId: "m1", customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 1, checkpoint } },
		]);
		harness.ctx.sessionManager.getLeafId = () => "checkpoint";
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "resume" });
		try {
			await harness.commands.get("clm-compact").handler("", harness.ctx);
			assert.equal(harness.sentUserMessages.length, 1, "a nonempty restored context is compacted");
			assert.match(String(harness.sentUserMessages[0]!.content), /about 3\.5k tokens/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: a waiting /clm-compact is dropped if the context changes, and a second one is refused", async () => {
		const harness = createHarness();
		harness.ctx.model = { contextWindow: 100_000 };
		harness.ctx.getSystemPrompt = () => "";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await emit(harness, "context", { messages: [{ role: "user", content: "original branch", timestamp: 1 }] });
			let release!: () => void;
			harness.ctx.isIdle = () => false;
			harness.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });

			// A branch switch while waiting: nothing is sent into the new branch.
			const stale = harness.commands.get("clm-compact").handler("keep original branch facts", harness.ctx);
			await emit(harness, "session_tree", {});
			await emit(harness, "context", { messages: [{ role: "user", content: "different branch", timestamp: 2 }] });
			harness.ctx.isIdle = () => true;
			release();
			await stale;
			assert.equal(harness.sentUserMessages.length, 0);
			assert.match(harness.notifications.at(-1)!, /live context changed while \/clm-compact was waiting/);

			// Two while one run is busy: Pi still reports idle for a moment after the first send, so a
			// second send would throw "Agent is already processing a prompt"; it is refused instead.
			let processing = false;
			(harness.pi as any).sendUserMessage = (content: unknown, options?: { deliverAs?: string }) => {
				if (processing && !options?.deliverAs) throw new Error("Agent is already processing a prompt");
				processing = true;
				harness.sentUserMessages.push({ content, options });
			};
			harness.ctx.isIdle = () => false;
			harness.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
			const first = harness.commands.get("clm-compact").handler("", harness.ctx);
			await harness.commands.get("clm-compact").handler("", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /already waiting for the current run/);
			harness.ctx.isIdle = () => true;
			release();
			await first;
			assert.equal(harness.sentUserMessages.length, 1);

			// A send Pi refuses anyway is reported, not thrown.
			harness.ctx.waitForIdle = async () => {};
			await harness.commands.get("clm-compact").handler("", harness.ctx);
			assert.match(harness.notifications.at(-1)!, /\/clm-compact was not sent: Agent is already processing a prompt/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});

	test("CLM: PI_CLM_COMPACT_PROMPT sets the default compact prompt", async () => {
		const saved = process.env.PI_CLM_COMPACT_PROMPT;
		try {
			for (const [value, shown] of [["/somewhere/team-compact.md", "team-compact.md"], ["default", "default"], ["none", "default"]] as const) {
				process.env.PI_CLM_COMPACT_PROMPT = value;
				const harness = createHarness();
				clmExtension(harness.pi);
				await emit(harness, "session_start", { reason: "startup" });
				try {
					assert.match(await clmSettingsText(harness), new RegExp(`Compact prompt +${shown.replace(".", "\\.")}\\n`), value);
				} finally { await emit(harness, "session_shutdown", {}); }
			}
		} finally {
			if (saved === undefined) delete process.env.PI_CLM_COMPACT_PROMPT;
			else process.env.PI_CLM_COMPACT_PROMPT = saved;
		}
	});

	test("CLM without parity switches leaves tool calls and results alone", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			await emit(harness, "turn_start", {});
			await emit(harness, "tool_call", { toolName: "read", toolCallId: "c1", input: {} });
			assert.equal((await emit(harness, "tool_call", { toolName: "read", toolCallId: "c2", input: {} }))[0], undefined);
			assert.equal((await emit(harness, "tool_result", { toolName: "read", toolCallId: "c1", input: {}, content: [{ type: "text", text: "x" }], isError: false }))[0], undefined);
			const details = await clmSettingsText(harness);
			assert.match(details, /One tool per turn +off/);
			assert.match(details, /Size trailer +off/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
	test("CLM: lifts Pi's raw-history max_tokens clamp using the effective estimate", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 30_000 } });
		harness.ctx.model = { contextWindow: 32_768, maxTokens: 4096 };
		harness.ctx.getSystemPrompt = () => "";
		await emit(harness, "session_start", { reason: "startup" });
		try {
			// No reading yet → leave the payload alone.
			assert.equal((await emit(harness, "before_provider_request", { payload: { max_tokens: 1 } }))[0], undefined);
			await emit(harness, "context", { messages: [{ role: "user", content: "small effective context", timestamp: 1 }] });
			// Pi clamped to 1 based on a large raw transcript; effective is tiny → lift to model max.
			const lifted = await emit(harness, "before_provider_request", { payload: { model: "m", max_tokens: 1 } });
			assert.deepEqual(lifted[0], { model: "m", max_tokens: 4096 });
			const responses = await emit(harness, "before_provider_request", { payload: { max_output_tokens: 1 } });
			assert.deepEqual(responses[0], { max_output_tokens: 4096 });
			// Already generous → untouched.
			assert.equal((await emit(harness, "before_provider_request", { payload: { max_tokens: 4096 } }))[0], undefined);
			// Non-numeric or absent fields → untouched.
			assert.equal((await emit(harness, "before_provider_request", { payload: { temperature: 0 } }))[0], undefined);
			assert.match(await clmSettingsText(harness), /max_tokens clamp lifted on 2 requests/);
			// Disabled → untouched.
			await harness.commands.get("clm").handler("off", harness.ctx);
			assert.equal((await emit(harness, "before_provider_request", { payload: { max_tokens: 1 } }))[0], undefined);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
});

describe("native prompt sections", () => {
	for (const editingMode of ["clm", "conservative"] as const) {
		test(`${editingMode}: contributes its section without forcing a prompt snapshot`, async () => {
			const harness = createHarness();
			liveContextExtension(harness.pi, { editingMode });
			await emit(harness, "session_start", { reason: "startup" });
			try {
				const sections: Record<string, string> = { third_party: "Keep sibling guidance" };
				const event = { systemPrompt: "base prompt", systemPromptOptions: { sections } };
				const result = await emit(harness, "before_agent_start", event);
				assert.equal(result[0], undefined);
				assert.equal(event.systemPrompt, "base prompt");
				assert.equal(sections.third_party, "Keep sibling guidance");
				assert.match(sections.live_context_management, /mirrored at `[^`]+`/);
				assert.doesNotMatch(sections.live_context_management, /base prompt/);
				sections.later_extension = "Later contributions must remain composable";
				assert.equal(event.systemPromptOptions.sections.later_extension, "Later contributions must remain composable");
			} finally { await emit(harness, "session_shutdown", {}); }
		});
	}

	test("does not clear another extension's intentional forced prompt", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "startup" });
		try {
			const sections: Record<string, string> = {};
			const options = { sections, forceSystemPrompt: "INTENTIONAL_OVERRIDE", selectedTools: ["read"] };
			const result = await emit(harness, "before_agent_start", {
				systemPrompt: "INTENTIONAL_OVERRIDE", systemPromptOptions: options,
			});
			assert.equal(result[0], undefined);
			assert.equal(options.forceSystemPrompt, "INTENTIONAL_OVERRIDE");
			assert.deepEqual(options.selectedTools, ["read"]);
			assert.match(sections.live_context_management, /Editable context/);
		} finally { await emit(harness, "session_shutdown", {}); }
	});
});

describe("restored native snapshots", () => {
	test("ignores Pi-owned system messages when validating a resumed conversation checkpoint", async () => {
		const raw = rawConversation();
		const projected: LiveContextMessage[] = [
			raw[0],
			{ role: "custom", customType: "live-context-projection", content: "PROJECTED_NOTES_MARKER",
				display: false, timestamp: 3 },
		];
		const checkpoint = createProjectionCheckpoint({
			revision: 1, sourceMessages: raw, projectedMessages: projected,
			beforeEstimate: 1200, afterEstimate: 30, estimateUnit: "tokens",
		});
		const harness = createHarness([
			{ type: "message", id: "system-1", parentId: null,
				message: { role: "system", content: "Native prompt and tool state", timestamp: 0 } },
			{ type: "message", id: "m1", parentId: "system-1", message: raw[0] },
			{ type: "message", id: "m2", parentId: "m1", message: raw[1] },
			{ type: "custom", id: "saved", parentId: "m2", customType: LIVE_CONTEXT_STATE,
				data: { version: 1, enabled: true, revision: 1, checkpoint } },
		]);
		harness.ctx.sessionManager.getLeafId = () => harness.branch.at(-1)?.id ?? null;
		harness.ctx.mode = "rpc";
		liveContextExtension(harness.pi, { editingMode: "clm" });
		await emit(harness, "session_start", { reason: "resume" });
		try {
			await harness.commands.get("clm").handler("input", harness.ctx);
			const input = harness.notifications.at(-1)!;
			assert.match(input, /current input \(2 messages\)/);
			assert.match(input, /PROJECTED_NOTES_MARKER/);
			assert.doesNotMatch(input, /Old investigation/);
			assert.equal(harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).length, 1,
				"viewing a restored snapshot must not reset or rewrite the saved checkpoint");
		} finally { await emit(harness, "session_shutdown", {}); }
	});
});

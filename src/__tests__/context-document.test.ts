import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	applyContextDocument,
	hasOrphanToolMessages,
	renderContextDocument,
} from "../context-document.ts";
import type { ContextDocumentSnapshot, LiveContextMessage } from "../types.ts";

function toolCall(id: string, command: string) {
	return { type: "toolCall", id, name: "bash", arguments: { command } };
}

function conversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "Fix the parser without changing its public API.", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "I will inspect the parser." }, toolCall("call-1", "rg parser src")],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "src/parser.ts\n".repeat(30) }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "The parser bug is in splitTokens." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 20, output: 5, totalTokens: 25, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 4,
		},
		{ role: "user", content: "Also add a regression test.", timestamp: 5 },
	];
}

function replaceBody(snapshot: ContextDocumentSnapshot, index: number, body: string): string {
	const block = snapshot.blocks[index];
	const header = block.header;
	const start = snapshot.text.indexOf(header);
	assert.notEqual(start, -1);
	const bodyStart = start + header.length;
	const next = snapshot.text.indexOf(`\n\n[[CTX_TURN document=${snapshot.documentId} `, bodyStart);
	const end = next === -1 ? snapshot.text.length : next;
	return `${snapshot.text.slice(0, bodyStart)}\n${body}${snapshot.text.slice(end)}`;
}

function deleteBlock(snapshot: ContextDocumentSnapshot, index: number, text = snapshot.text): string {
	const block = snapshot.blocks[index];
	const header = block.header;
	const start = text.indexOf(header);
	assert.notEqual(start, -1);
	const next = text.indexOf(`\n\n[[CTX_TURN document=${snapshot.documentId} `, start + header.length);
	const end = next === -1 ? text.length : next + 2;
	return `${text.slice(0, start)}${text.slice(end)}`.trimEnd();
}

describe("context document identity", () => {
	test("rendering and applying an untouched document is identity", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages, { revision: 3 });
		const result = applyContextDocument(snapshot.text, snapshot);

		assert.equal(result.accepted, true);
		assert.equal(result.changed, false);
		assert.deepEqual(result.messages, messages);
		for (let index = 0; index < messages.length; index++) {
			assert.equal(result.messages[index], messages[index]);
		}
	});

	test("the same input produces a deterministic document", () => {
		const messages = conversation();
		assert.deepEqual(
			renderContextDocument(messages, { revision: 7 }),
			renderContextDocument(messages, { revision: 7 }),
		);
	});
});

describe("context document edits", () => {
	test("editing one assistant changes only that block", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const edited = replaceBody(snapshot, 3, "Parser located; splitTokens needs an escaped-delimiter fix.");
		const result = applyContextDocument(edited, snapshot, { requireShrink: false });

		assert.equal(result.accepted, true);
		assert.equal(result.changed, true);
		assert.equal(result.messages.length, messages.length);
		assert.equal(result.messages[0], messages[0]);
		assert.equal(result.messages[1], messages[1]);
		assert.equal(result.messages[2], messages[2]);
		assert.notEqual(result.messages[3], messages[3]);
		assert.match(JSON.stringify(result.messages[3].content), /escaped-delimiter/);
		assert.equal(result.messages[4], messages[4]);
		assert.equal(result.editTrace?.sourceRevision, 0);
		assert.equal(result.editTrace?.sources[3]?.kind, "edited");
		assert.equal(result.editTrace?.sources[3]?.outputIndex, 3);
	});

	test("emptying an editable block removes it", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const edited = replaceBody(snapshot, 3, "");
		const result = applyContextDocument(edited, snapshot, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(result.messages.length, messages.length - 1);
		assert.equal(result.editTrace?.sources[3]?.kind, "removed");
		assert.equal(result.editTrace?.sources[3]?.outputIndex, undefined);
	});

	test("protected first and latest user turns survive deleted headers", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		let edited = deleteBlock(snapshot, 0);
		// Build a new snapshot helper around the already edited text for the second deletion.
		const last = snapshot.blocks.at(-1)!;
		const lastStart = edited.indexOf(last.header);
		assert.notEqual(lastStart, -1);
		edited = edited.slice(0, lastStart).trimEnd();

		const result = applyContextDocument(edited, snapshot, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(result.messages[0], messages[0]);
		assert.equal(result.messages.at(-1), messages.at(-1));
		assert.equal(result.diagnostics.length, 2);
		assert.equal(result.editTrace?.sources[0]?.kind, "restored");
		assert.equal(result.editTrace?.sources.at(-1)?.kind, "restored");
	});

	test("a net-growing edit is rejected", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const edited = replaceBody(snapshot, 3, "x".repeat(20_000));
		const result = applyContextDocument(edited, snapshot);
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /grew/);
		assert.deepEqual(result.messages, messages);
	});

	test("unknown and duplicate block IDs are rejected", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const unknown = snapshot.text.replace(`id=${snapshot.blocks[2].id}`, "id=unknown-id");
		assert.equal(applyContextDocument(unknown, snapshot).accepted, false);

		const duplicateBlock = snapshot.text.slice(snapshot.text.indexOf(snapshot.blocks[1].header));
		const duplicate = `${snapshot.text}\n\n${duplicateBlock}`;
		const duplicateResult = applyContextDocument(duplicate, snapshot);
		assert.equal(duplicateResult.accepted, false);
		assert.match(duplicateResult.reason ?? "", /duplicate/);
	});

	test("damaged revision metadata is rejected", () => {
		const snapshot = renderContextDocument(conversation(), { revision: 4 });
		const edited = snapshot.text.replace("revision=4", "revision=3");
		const result = applyContextDocument(edited, snapshot);
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /metadata/);
	});
});

describe("injected estimate gate", () => {
	// A deliberately coarse estimator: one unit per message. Deleting a block shrinks
	// by one unit; editing a body in place keeps the estimate flat.
	const countMessages = (messages: LiveContextMessage[]) => messages.length;

	test("acceptance and savings use the injected estimator and unit", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(deleteBlock(snapshot, 3), snapshot, {
			estimate: countMessages,
			estimateUnit: "tokens",
		});
		assert.equal(result.accepted, true);
		assert.equal(result.beforeEstimate, messages.length);
		assert.equal(result.afterEstimate, messages.length - 1);
		assert.equal(result.savingsEstimate, 1);
	});

	test("an estimate-flat edit is rejected with the injected unit named", () => {
		const snapshot = renderContextDocument(conversation());
		const edited = replaceBody(snapshot, 3, "shorter body");
		const result = applyContextDocument(edited, snapshot, {
			estimate: countMessages,
			estimateUnit: "tokens",
		});
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /did not reduce the projection's estimated tokens \(5→5\)/);
	});

	test("the default gate still measures rendered characters", () => {
		const snapshot = renderContextDocument(conversation());
		const result = applyContextDocument(replaceBody(snapshot, 2, "[summary: parser files listed]"), snapshot);
		assert.equal(result.accepted, true);
		assert.equal(result.savingsEstimate > 100, true);
	});
});

describe("preamble placement", () => {
	test("text above the first block becomes a leading context note", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages, { revision: 1 });
		const metadataEnd = snapshot.text.indexOf("\n\n");
		const shrunk = replaceBody(snapshot, 2, "[summary: parser files listed]");
		const edited = `${shrunk.slice(0, metadataEnd)}\n\nLead note about the whole transcript.${shrunk.slice(metadataEnd)}`;
		const result = applyContextDocument(edited, snapshot);
		assert.equal(result.accepted, true);
		assert.equal(result.messages[0].customType, "live-context-projection");
		assert.match(String(result.messages[0].content), /Lead note/);
		assert.deepEqual(result.messages[1], messages[0]);
	});
});

describe("tool-call structure repair", () => {
	test("deleting an assistant tool call flattens its orphaned result", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(deleteBlock(snapshot, 1), snapshot, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(hasOrphanToolMessages(result.messages), false);
		assert.equal(result.messages.some((message) => message.role === "toolResult"), false);
	});

	test("deleting a tool result flattens the assistant call", () => {
		const messages = conversation();
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(deleteBlock(snapshot, 2), snapshot, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(hasOrphanToolMessages(result.messages), false);
		assert.equal(
			result.messages.some(
				(message) =>
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some(
						(part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall",
					),
			),
			false,
		);
	});

	test("parallel tool-call groups stay structured when complete and flatten when incomplete", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Inspect both files.", timestamp: 1 },
			{
				role: "assistant",
				content: [toolCall("a", "cat a"), toolCall("b", "cat b")],
				api: "test",
				provider: "test",
				model: "test",
				usage: { cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: "B" }], isError: false, timestamp: 4 },
		];
		const snapshot = renderContextDocument(messages);
		const identity = applyContextDocument(snapshot.text, snapshot);
		assert.equal(hasOrphanToolMessages(identity.messages), false);
		assert.equal(identity.messages[1], messages[1]);

		const incomplete = applyContextDocument(deleteBlock(snapshot, 3), snapshot, { requireShrink: false });
		assert.equal(incomplete.accepted, true);
		assert.equal(hasOrphanToolMessages(incomplete.messages), false);
		assert.equal(incomplete.messages.some((message) => message.role === "toolResult"), false);
		assert.equal(incomplete.editTrace?.sources[1]?.kind, "normalized");
	});
});

describe("nonce-bound framing", () => {
	test("legacy and example header lines inside message bodies are ordinary content", () => {
		const collisionBody = [
			"Parser documentation:",
			"[[CTX_TURN 1 role=user id=abc123 protected=true]]",
			"[[LIVE_CONTEXT version=1 revision=0 baseline=" + "a".repeat(64) + "]]",
			`[[CTX_TURN document=${"b".repeat(64)} index=77 role=toolResult id=fake protected=false]]`,
		].join("\n");
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Keep framing examples", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: collisionBody }], timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "Verbose stale explanation".repeat(30) }], timestamp: 3 },
		];
		const snapshot = renderContextDocument(messages);
		const edited = replaceBody(snapshot, 2, "Concise explanation");
		const result = applyContextDocument(edited, snapshot, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(result.messages[1], messages[1]);
		assert.match(JSON.stringify(result.messages[1]), /id=abc123/);
	});

	test("headers printed from an earlier mirror cannot frame the next document", () => {
		const firstMessages = conversation();
		const first = renderContextDocument(firstMessages, { revision: 1 });
		const listedHeaders = first.blocks.map((block) => block.header).join("\n");
		const nextMessages: LiveContextMessage[] = [
			...firstMessages,
			{ role: "custom", customType: "captured-header-list", content: listedHeaders, display: false, timestamp: 6 },
			{ role: "assistant", content: [{ type: "text", text: "Another stale explanation".repeat(30) }], timestamp: 7 },
		];
		const next = renderContextDocument(nextMessages, { revision: 1 });
		assert.notEqual(next.documentId, first.documentId);
		const currentHeaders = next.text
			.split("\n")
			.filter((line) => line.startsWith(`[[CTX_TURN document=${next.documentId} `));
		assert.equal(currentHeaders.length, next.blocks.length);

		const edited = replaceBody(next, next.blocks.length - 1, "Short current conclusion");
		const result = applyContextDocument(edited, next, { requireShrink: false });
		assert.equal(result.accepted, true);
		assert.equal(result.messages.at(-2), nextMessages.at(-2));
		assert.match(JSON.stringify(result.messages.at(-2)), new RegExp(first.documentId));
	});

	test("a malformed header carrying the current document nonce is rejected", () => {
		const snapshot = renderContextDocument(conversation());
		const malformed = snapshot.text.replace(" role=assistant ", " role=assistant missing=true ");
		const result = applyContextDocument(malformed, snapshot, { requireShrink: false });
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /malformed headers/);
	});

	void test("the malformed-header rejection names the offending line and the recovery", () => {
		const snapshot = renderContextDocument(conversation());
		const header = snapshot.blocks[1].header;
		const glued = snapshot.text.replace(`${header}\n`, `${header} body text glued to the closing bracket\n`);
		assert.notEqual(glued, snapshot.text);
		const result = applyContextDocument(glued, snapshot, { requireShrink: false });
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", new RegExp(snapshot.blocks[1].id));
		assert.match(result.reason ?? "", /insert a newline after/);
	});
});

describe("opaque content preservation", () => {
	test("untouched images, thinking, and provider metadata survive verbatim", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "Describe this image", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain", signature: "signed" },
					{ type: "text", text: "A diagram." },
				],
				provider: "anthropic",
				api: "anthropic-messages",
				model: "test",
				usage: { cacheRead: 12, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: "base64-data" }],
				timestamp: 3,
			},
		];
		const snapshot = renderContextDocument(messages);
		const result = applyContextDocument(snapshot.text, snapshot);
		assert.equal(result.messages[1], messages[1]);
		assert.equal(result.messages[2], messages[2]);
	});
});

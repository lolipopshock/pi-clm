import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import liveContextExtension from "../index.ts";

function harness(options: Record<string, unknown>, mode: "tui" | "rpc" = "tui") {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const headers: unknown[] = [];
	const notifications: string[] = [];
	const branch: unknown[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: () => {},
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `e${branch.length}`, customType, data }),
	};
	const ctx = {
		mode,
		hasUI: mode === "tui",
		cwd: "/tmp",
		isIdle: () => true,
		ui: { notify: (text: string) => notifications.push(text), setStatus: () => {}, setHeader: (factory: unknown) => headers.push(factory) },
		waitForIdle: async () => {},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "system prompt",
		model: { contextWindow: 200_000, maxTokens: 8192 },
		sessionManager: { getSessionId: () => "banner", getSessionFile: () => undefined, getBranch: () => branch, getEntries: () => branch, getLeafId: () => null, getTree: () => [] },
	};
	liveContextExtension(pi as never, { editingMode: "clm", ...options } as never);
	return { handlers, commands, headers, notifications, ctx };
}

test("the banner replaces the header once per marker, and /clm about brings it back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-clm-banner-ext-"));
	try {
		const markerPath = join(dir, "welcomed");
		const first = harness({ banner: { enabled: true, markerPath } });
		await first.handlers.get("session_start")!({}, first.ctx);
		assert.equal(first.headers.length, 1, "first session sets the header");
		const rendered = (first.headers[0] as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
			{}, { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		).render(100);
		assert.match(rendered.join("\n"), /pi-clm .*the model manages its own context/);
		await first.handlers.get("session_shutdown")?.({}, first.ctx);

		const second = harness({ banner: { enabled: true, markerPath } });
		await second.handlers.get("session_start")!({}, second.ctx);
		assert.equal(second.headers.length, 0, "later sessions keep Pi's header");
		await second.commands.get("clm")!.handler("about", second.ctx);
		assert.equal(second.headers.length, 1, "/clm about sets the header again");
		await second.handlers.get("session_shutdown")?.({}, second.ctx);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the banner is off unless enabled, and prints as text outside the TUI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-clm-banner-ext-"));
	try {
		const off = harness({});
		await off.handlers.get("session_start")!({}, off.ctx);
		assert.equal(off.headers.length, 0);
		await off.handlers.get("session_shutdown")?.({}, off.ctx);

		const rpc = harness({ banner: { enabled: true, markerPath: join(dir, "welcomed") } }, "rpc");
		await rpc.handlers.get("session_start")!({}, rpc.ctx);
		assert.equal(rpc.headers.length, 0, "no header outside the TUI");
		await rpc.commands.get("clm")!.handler("about", rpc.ctx);
		assert.match(rpc.notifications.at(-1) ?? "", /\/clm-compact/, "about prints the banner");
		await rpc.handlers.get("session_shutdown")?.({}, rpc.ctx);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

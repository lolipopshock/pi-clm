import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { BANNER_ART, bannerHeader, bannerLines, bannerMarkerPath, claimFirstRun, packageVersion } from "../banner.ts";

test("the banner names the package, its version and the three commands", () => {
	const lines = bannerLines(undefined, "1.2.3");
	assert.equal(lines.length, BANNER_ART.length);
	const text = lines.join("\n");
	assert.match(text, /pi-clm 1\.2\.3 — the model manages its own context/);
	assert.match(text, /\/clm {2}panel/);
	assert.match(text, /\/clm status/);
	assert.match(text, /\/clm-compact/);
	for (const [index, art] of BANNER_ART.entries()) assert.ok(lines[index]!.startsWith(art.trimEnd()), `line ${index} starts with the art`);
});

test("without a version the name stands alone; by default the package version is read", () => {
	assert.match(bannerLines(undefined, "")[1]!, /pi-clm — the model/);
	assert.match(packageVersion() ?? "", /^\d+\.\d+\.\d+/);
	assert.match(bannerLines()[1]!, new RegExp(`pi-clm ${packageVersion()!.replace(/\\./g, "\\\\.")} — the model`));
});

test("theme colours go to the art and the text separately", () => {
	const calls: string[] = [];
	const theme = { fg: (color: string, text: string) => { calls.push(color); return `<${color}>${text}</${color}>`; }, bold: (text: string) => `*${text}*` };
	const lines = bannerLines(theme, "1.0.0");
	assert.ok(lines[0]!.startsWith("<accent>"));
	assert.match(lines[1]!, /\*<text>pi-clm 1\.0\.0<\/text>\*<muted> — the model/);
	assert.ok(calls.includes("accent") && calls.includes("muted") && calls.includes("text"));
});

test("the header component pads with blank lines and cuts to the width", () => {
	const header = bannerHeader({ fg: (_c, t) => t, bold: (t) => t }, "1.0.0");
	const wide = header.render(120);
	assert.equal(wide[0], "");
	assert.equal(wide.at(-1), "");
	assert.equal(wide.length, BANNER_ART.length + 2);
	const narrow = header.render(30);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 30), "no line wider than the terminal");
	assert.ok(narrow[2]!.startsWith(BANNER_ART[1]!.slice(0, 10)));
});

test("the first run is claimed once per marker file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-clm-banner-"));
	try {
		const marker = bannerMarkerPath(dir);
		assert.equal(marker, join(dir, "pi-clm", "welcomed"));
		assert.equal(claimFirstRun(marker), true);
		assert.ok(existsSync(marker));
		assert.equal(claimFirstRun(marker), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

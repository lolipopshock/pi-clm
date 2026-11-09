/**
 * The pi-clm banner: shown in place of Pi's startup header on the first session after
 * install, and again on `/clm about`. A marker file next to Pi's settings remembers that
 * it has been shown, so it appears once per machine rather than on every start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { truncateToWidth } from "@earendil-works/pi-tui";

export const BANNER_ART: readonly string[] = [
	"  ____ _     __  __ ",
	" / ___| |   |  \\/  |",
	"| |   | |   | |\\/| |",
	"| |___| |___| |  | |",
	" \\____|_____|_|  |_|",
];

/** The subset of Pi's theme the banner uses, so tests can pass plain functions. */
export interface BannerTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const PLAIN: BannerTheme = { fg: (_color, text) => text, bold: (text) => text };

/** Version from the package's own package.json; undefined if it cannot be read. */
export function packageVersion(): string | undefined {
	try {
		const file = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The banner: the letters on the left, and to their right the name and version, then the
 * three commands a new user needs. `theme` colours it; omit it for plain text.
 */
export function bannerLines(theme: BannerTheme = PLAIN, version: string | undefined = packageVersion()): string[] {
	const name = theme.bold(theme.fg("text", `pi-clm${version ? ` ${version}` : ""}`));
	const command = (text: string) => theme.fg("text", text);
	const note = (text: string) => theme.fg("muted", text);
	const right = [
		"",
		`${name}${note(" — the model manages its own context")}`,
		"",
		`${command("/clm")}${note("  panel    ")}${command("/clm status")}${note("  size vs budget")}`,
		`${command("/clm-compact")}${note("   ask the model to compact now")}`,
	];
	return BANNER_ART.map((art, index) => `${theme.fg("accent", art)}     ${right[index] ?? ""}`.trimEnd());
}

/** Where the first-run marker lives: `<agent dir>/pi-clm/welcomed`. */
export function bannerMarkerPath(agentDir: string): string {
	return join(agentDir, "pi-clm", "welcomed");
}

/**
 * True the first time it is called for `markerPath` (and records that it was), false after
 * that. A marker that cannot be written just means the banner shows again next time.
 */
export function claimFirstRun(markerPath: string): boolean {
	if (existsSync(markerPath)) return false;
	try {
		mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
		writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
	} catch {
		// Ignored: showing the banner twice is harmless.
	}
	return true;
}

/** A Pi header component: the banner, each line cut to the terminal width. */
export function bannerHeader(theme: BannerTheme, version: string | undefined = packageVersion()) {
	const lines = bannerLines(theme, version);
	return {
		render(width: number): string[] {
			return ["", ...lines.map((line) => truncateToWidth(line, Math.max(1, width))), ""];
		},
		invalidate(): void {},
	};
}

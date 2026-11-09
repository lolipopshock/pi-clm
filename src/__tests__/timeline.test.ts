import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntryLike } from "../state.ts";
import {
	buildContextTimeline,
	describeTimelineBucket,
	formatMarkerCompact,
	formatMarkerRow,
	formatTimelineReport,
	formatTokenCount,
	layoutTimeline,
	renderTimelineChart,
	timelineWindow,
} from "../timeline.ts";

function request(tokens: number, at: number, stopReason = "stop"): SessionEntryLike {
	return { type: "message", message: { role: "assistant", stopReason, timestamp: at, usage: { totalTokens: tokens } } } as SessionEntryLike;
}
function outcome(revision: number, kind: "applied" | "rejected" | "reset", at: string, before?: number, after?: number): SessionEntryLike {
	return {
		type: "custom",
		customType: "live-context-state",
		data: {
			version: 1,
			enabled: true,
			revision,
			lastOutcome: { kind, message: kind === "rejected" ? "unknown block ids" : kind, beforeEstimate: before, afterEstimate: after, estimateUnit: before !== undefined ? "tokens" : undefined, at },
		},
	};
}
const entries: SessionEntryLike[] = [
	{ type: "message", message: { role: "user", timestamp: 1 } } as SessionEntryLike,
	request(3000, 1_000),
	request(6000, 2_000),
	request(0, 2_500), // zero usage: skipped
	request(9000, 3_000, "error"), // failed: skipped
	outcome(1, "applied", "2026-01-01T00:00:03Z", 9500, 2900),
	{ type: "custom", customType: "live-context-state", data: { version: 1, enabled: false, revision: 1, event: { kind: "disabled", at: "x" }, lastOutcome: { kind: "applied", message: "applied", beforeEstimate: 9500, afterEstimate: 2900, estimateUnit: "tokens", at: "2026-01-01T00:00:03Z" } } }, // slim repeat: no second marker
	request(4000, 4_000),
	request(7000, 5_000),
	outcome(2, "rejected", "2026-01-01T00:00:06Z"),
	outcome(3, "reset", "2026-01-01T00:00:07Z"),
];

describe("context timeline", () => {
	test("builds one point per successful request and one marker per distinct outcome", () => {
		const timeline = buildContextTimeline(entries);
		assert.deepEqual(timeline.points.map((p) => [p.request, p.tokens, p.revision]), [[1, 3000, 0], [2, 6000, 0], [3, 4000, 1], [4, 7000, 1]]);
		assert.equal(timeline.peakTokens, 7000);
		assert.deepEqual(timeline.markers.map((m) => [m.kind, m.revision, m.afterPoint, m.beforeTokens, m.afterTokens]), [
			["applied", 1, 1, 9500, 2900],
			["rejected", 2, 3, undefined, undefined],
			["reset", 3, 3, undefined, undefined],
		]);
	});
	test("counts prompt usage separately from output and tolerates empty branches", () => {
		const summed = buildContextTimeline([{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 } } } as SessionEntryLike]);
		assert.equal(summed.points[0]?.tokens, 110);
		assert.equal(summed.points[0]?.outputTokens, 5);
		assert.match(describeTimelineBucket(summed, layoutTimeline(summed, { width: 40 }).buckets[0]!), /110 tok · 5 generated tok/);
		assert.deepEqual(buildContextTimeline([]), { points: [], markers: [], peakTokens: 0, turnStarts: [] });
		assert.deepEqual(renderTimelineChart(buildContextTimeline([]), { width: 40, height: 5 }), ["No completed requests on this branch yet."]);
	});
	test("chart has labelled axis, edit markers above their bars, budget line and x label", () => {
		const timeline = buildContextTimeline(entries);
		const lines = renderTimelineChart(timeline, { width: 40, height: 6, budget: 6000, selectedMarker: 0 });
		// No headroom row: the edited bar (6k of 7k) leaves room for its marker inside the plot.
		assert.equal(lines.length, 6 + 2);
		assert.match(lines[0]!, /^ {2}7\.0k ┤ +▼ +███/);
		// The marker is in the cell right above the edited bar.
		const markerColumn = lines[0]!.indexOf("▼");
		assert.match(lines[1]![markerColumn]!, /█/);
		// The selected compaction column is drawn with the plain block through the `selected` style hook; unselected edit columns use ▓.
		assert.equal(lines.some((line) => line.includes("▓")), false);
		const unselected = renderTimelineChart(timeline, { width: 40, height: 6, budget: 6000 });
		assert.ok(unselected.some((line) => line.includes("▓")), "edited request column uses ▓");
		const styled = renderTimelineChart(timeline, { width: 40, height: 6, selectedMarker: 0, style: { selected: (t) => `<${t}>` } });
		assert.ok(styled.some((line) => line.includes("<█")), "selected column passes through the selected style");
		const now = renderTimelineChart(timeline, { width: 40, height: 6, selectedPoint: timeline.points.length - 1, style: { selected: (t) => `<${t}>` } });
		assert.ok(now.some((line) => /<█+> *$/.test(line)), "the selected point highlights the newest column");
		assert.ok(lines.some((line) => line.includes("╌") && line.includes("┼")), "budget line drawn");
		// The user message before request 1 is a turn landmark on the baseline.
		assert.match(lines.at(-2)!, /^ {5}0 ┴•─+$/);
		assert.match(lines.at(-1)!, /requests 1–4 of 4$/);
		// Bottom row is filled for every request; top row only for the peak.
		const bottom = lines[5]!;
		assert.equal((bottom.match(/[█▓]/g) ?? []).length >= 4, true);
	});
	test("shows a window of requests when there are more than the plot can show, panning to the focus", () => {
		const many = Array.from({ length: 200 }, (_v, i) => request(1000 + i * 10, i));
		const timeline = buildContextTimeline(many);
		const newest = renderTimelineChart(timeline, { width: 30, height: 4 });
		assert.match(newest.at(-1)!, /◂ \d+ earlier {2}requests \d+–200 of 200$/);
		for (const line of newest.slice(0, -1)) assert.ok(line.length <= 30, `line too wide: ${line.length}`);
		const focused = renderTimelineChart(timeline, { width: 30, height: 4, focusPoint: 50 });
		assert.match(focused.at(-1)!, /◂ \d+ earlier {2}requests \d+–\d+ of 200 {2}\d+ later ▸$/);
		const start = renderTimelineChart(timeline, { width: 30, height: 4, focusPoint: 0 });
		assert.match(start.at(-1)!, /^ +requests 1–\d+ of 200 {2}\d+ later ▸$/);
		assert.deepEqual(timelineWindow(10, 22, 3), { start: 0, end: 10 });
		assert.deepEqual(timelineWindow(100, 20, undefined), { start: 80, end: 100 });
		// Centred on the focus, clamped so the window stays full at either end.
		assert.deepEqual(timelineWindow(100, 20, 50), { start: 40, end: 60 });
		assert.deepEqual(timelineWindow(100, 20, 99), { start: 80, end: 100 });
		assert.deepEqual(timelineWindow(100, 20, 3), { start: 0, end: 20 });
	});
	test("fit and turns zoom show the whole branch, bucketed, with turn landmarks and edit counts", () => {
		// 10 user turns × 30 requests; edits after requests 45 and 46 (same bucket when fitted) and 250.
		const long: SessionEntryLike[] = [];
		const start = Date.parse("2026-01-01T09:00:00Z");
		for (let turn = 0; turn < 10; turn++) {
			long.push({ type: "message", message: { role: "user", timestamp: start } } as SessionEntryLike);
			for (let step = 0; step < 30; step++) {
				const index = turn * 30 + step;
				long.push(request(1_000 + index * 10, start + index * 60_000));
				if (index === 44) long.push(outcome(1, "applied", "2026-01-01T09:45:00Z", 9_000, 2_000));
				if (index === 45) long.push(outcome(2, "applied", "2026-01-01T09:46:00Z", 2_100, 2_000));
				if (index === 249) long.push(outcome(3, "applied", "2026-01-01T13:10:00Z", 9_000, 2_000));
			}
		}
		const timeline = buildContextTimeline(long);
		assert.deepEqual(timeline.turnStarts, [0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);

		const detail = renderTimelineChart(timeline, { width: 40, height: 4 });
		assert.match(detail.at(-1)!, /◂ \d+ earlier {2}requests \d+–300 of 300$/);

		const fit = layoutTimeline(timeline, { width: 40, zoom: "fit" });
		assert.equal(fit.buckets[0]?.first, 0);
		assert.equal(fit.buckets.at(-1)?.last, 299, "the whole branch is shown");
		assert.ok(fit.buckets.length <= 32 && fit.requestsPerColumn === 10);
		const shared = fit.buckets.find((bucket) => bucket.edits.length === 2);
		assert.ok(shared, "two edits close together share a bucket");
		const fitChart = renderTimelineChart(timeline, { width: 40, height: 4, zoom: "fit" });
		assert.ok(fitChart.some((line) => /┤.*2/.test(line)), "a shared bucket shows its edit count above its bar");
		const sharedIndex = timeline.markers.findIndex((marker) => marker.afterPoint === 44);
		const selectedShared = renderTimelineChart(timeline, { width: 40, height: 4, zoom: "fit", selectedMarker: sharedIndex, style: { selected: (t) => `<${t}>` } });
		assert.ok(selectedShared.some((line) => /<2>/.test(line)), "selecting a shared bucket keeps its count, styled as selected");
		assert.match(fitChart.at(-2)!, /•/, "user turns are landmarks");
		assert.match(fitChart.at(-1)!, /all 300 requests · 10\/column$/);
		for (const line of fitChart) assert.ok(line.length <= 40, `line too wide: ${line}`);
		const wide = renderTimelineChart(timeline, { width: 90, height: 4, zoom: "fit" });
		assert.match(wide.at(-1)!, /all 300 requests · 4\/column · .*–.* \(4h 59m\)$/, "time span when it fits");

		const turns = layoutTimeline(timeline, { width: 40, zoom: "turns" });
		assert.equal(turns.buckets.length, 10);
		assert.deepEqual(turns.buckets.map((bucket) => bucket.last - bucket.first + 1), Array(10).fill(30));
		const turnChart = renderTimelineChart(timeline, { width: 40, height: 4, zoom: "turns" });
		assert.match(turnChart.at(-1)!, /10 user turns · 1\/column · 300 requests/);
		assert.doesNotMatch(turnChart.at(-2)!, /•/, "no landmarks when every column is a turn");

		const edited = turns.buckets.find((bucket) => bucket.edits.length > 0)!;
		assert.match(describeTimelineBucket(timeline, edited), /^requests 31–60 \(30\) · .* · peak 1\.6k · last 1\.6k tok · 1 user turn · 2 accepted edits$/);
		assert.match(describeTimelineBucket(timeline, detailBucket(timeline)), /^request 300 · .+ · 4\.0k tok$/);
	});

	test("compact marker rows keep only revision, time, sizes and change", () => {
		const timeline = buildContextTimeline(entries);
		assert.match(formatMarkerCompact(timeline.markers[0]!), /^r1 {2}.+ {3}9\.5k → 2\.9k {3}−69%$/);
		assert.match(formatMarkerCompact(timeline.markers[1]!), /^r2 {2}.+ {2}rejected: unknown block ids$/);
		assert.match(formatMarkerCompact(timeline.markers[2]!), /^r3 {2}.+ {2}reset to raw context$/);
	});
	test("a full-height edited bar gets one headroom row for its marker", () => {
		const peakEdit: SessionEntryLike[] = [request(3000, 1_000), request(9000, 2_000), outcome(1, "applied", "2026-01-01T00:00:03Z", 9000, 2000), request(2000, 3_000)];
		const lines = renderTimelineChart(buildContextTimeline(peakEdit), { width: 30, height: 4 });
		assert.equal(lines.length, 1 + 4 + 2);
		assert.match(lines[0]!, /^ {8}.*▿/);
		assert.match(lines[1]!, /^ {2}9\.0k ┤/);
	});
	test("marker rows describe accepted, rejected and reset outcomes", () => {
		const timeline = buildContextTimeline(entries);
		assert.match(formatMarkerRow(timeline.markers[0]!, timeline), /^r1 {2}\d{2}:\d{2}.*edit accepted {2}9\.5k → 2\.9k −69% {2}\(after request 2\)$/);
		assert.match(formatMarkerRow(timeline.markers[1]!, timeline), /edit rejected: unknown block ids {2}\(after request 4\)/);
		assert.match(formatMarkerRow(timeline.markers[2]!, timeline), /reset to raw context/);
		const grown = { ...timeline.markers[0]!, beforeTokens: 100, afterTokens: 150 };
		assert.match(formatMarkerRow(grown, timeline), /100 → 150 \+50%/);
	});
	test("report and token formatting", () => {
		assert.equal(formatTokenCount(999), "999");
		assert.equal(formatTokenCount(2_950), "3.0k");
		assert.equal(formatTokenCount(29_952), "30k");
		assert.equal(formatTokenCount(1_500_000), "1.5m");
		const report = formatTimelineReport(buildContextTimeline(entries), 60, 32_000);
		assert.match(report, /1 accepted context edit:/);
		// A 32k budget is more than 2× the 7k peak: reported in the footer, not drawn as a line.
		assert.match(report, /budget 32k \(above scale\)/);
		assert.doesNotMatch(report, /┼╌/);
	});
	test("small contexts under a large model window still render bars; a near budget is drawn", () => {
		const small = buildContextTimeline([request(10_000, 1), request(4_000, 2), request(250, 3)]);
		const lines = renderTimelineChart(small, { width: 60, height: 6, budget: 272_000 });
		assert.ok(lines.some((line) => line.includes("█")), "bars visible with far-away budget");
		// No edits, so no headroom row: the chart starts at the ceiling label.
		assert.match(lines[0]!, /^ {3}10k ┤/);
		// Every nonzero request occupies at least the bottom row.
		const bottom = lines[5]!;
		assert.equal((bottom.match(/█+/g) ?? []).length, 3);
		assert.match(lines.at(-1)!, /budget 272k \(above scale\)/);
		const near = renderTimelineChart(small, { width: 60, height: 6, budget: 12_000 });
		assert.ok(near.some((line) => line.includes("┼╌")), "budget within 2× peak is drawn");
	});
});

function detailBucket(timeline: ReturnType<typeof buildContextTimeline>) {
	return layoutTimeline(timeline, { width: 40 }).buckets.at(-1)!;
}

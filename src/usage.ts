import type { Usage } from "@earendil-works/pi-ai";

/** Pi input counters exclude cache counters and generated output. */
export function promptTokens(usage: Partial<Usage> | undefined): number {
	if (!usage) return 0;
	if (usage.input !== undefined || usage.cacheRead !== undefined || usage.cacheWrite !== undefined) {
		return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	}
	// Older records may contain only the total. Remove output when it is known.
	return Math.max(0, (usage.totalTokens ?? 0) - (usage.output ?? 0));
}

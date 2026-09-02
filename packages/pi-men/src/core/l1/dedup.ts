import type { PiMenConfig } from "../../config.ts";
import type { DedupDecision, ExtractedMemory, LlmRunner } from "../../types.ts";
import { clampPriority, extractJsonArray, isValidMemoryType, toStringArray } from "../parse.ts";
import { buildFtsQuery, type SqliteMemoryStore } from "../store/sqlite-store.ts";
import { type CandidateMatch, formatBatchConflictPrompt, getDedupSystemPrompt } from "./prompts.ts";

/** Candidate pool size per new memory when looking for conflicts. */
const CANDIDATES_PER_MEMORY = 8;

/**
 * Pair each extracted candidate with similar existing records (keyword
 * search by content) to seed batch conflict detection.
 */
export function buildCandidateMatches(extracted: ExtractedMemory[], store: SqliteMemoryStore): CandidateMatch[] {
	return extracted.map((memory) => {
		const matchQuery = buildFtsQuery(memory.content);
		const keywordHits = matchQuery
			? store.searchMemoriesKeyword(matchQuery, CANDIDATES_PER_MEMORY)
			: store.searchMemoriesLike(memory.content, CANDIDATES_PER_MEMORY);
		const ids = new Set<string>(keywordHits.map((hit) => hit.id));
		return { memory, candidates: store.getMemories([...ids]) };
	});
}

/**
 * Batch dedup/conflict resolution: one LLM call decides store/update/merge/
 * skip for each candidate. Unparsable output degrades to "store everything".
 */
export async function dedupMemories(params: {
	runner: LlmRunner;
	config: PiMenConfig;
	matches: CandidateMatch[];
	signal?: AbortSignal;
}): Promise<DedupDecision[]> {
	const { runner, config, matches, signal } = params;
	if (matches.length === 0) return [];
	const raw = await runner({
		systemPrompt: getDedupSystemPrompt(config.promptMode),
		userPrompt: formatBatchConflictPrompt(matches),
		maxTokens: 4096,
		signal,
	});
	const decisions: DedupDecision[] = [];
	const known = new Set(matches.map((match) => match.memory.recordId));
	for (const item of extractJsonArray(raw)) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const recordId = typeof record.record_id === "string" ? record.record_id : "";
		if (!recordId || !known.has(recordId)) continue;
		const action = record.action;
		if (action !== "store" && action !== "update" && action !== "merge" && action !== "skip") continue;
		const decision: DedupDecision = {
			recordId,
			action,
			targetIds: toStringArray(record.target_ids),
		};
		if ((action === "update" || action === "merge") && isValidMemoryType(record.merged_type, true)) {
			const content = typeof record.merged_content === "string" ? record.merged_content.trim() : "";
			if (!content) continue; // malformed decision; drop it
			decision.mergedContent = content;
			decision.mergedType = record.merged_type;
			decision.mergedPriority = clampPriority(record.merged_priority);
			const timestamps = toStringArray(record.merged_timestamps);
			if (timestamps.length > 0) decision.mergedTimestamps = timestamps;
		}
		decisions.push(decision);
	}
	// Any candidate without a decision defaults to store.
	const decided = new Set(decisions.map((decision) => decision.recordId));
	for (const match of matches) {
		if (!decided.has(match.memory.recordId)) {
			decisions.push({ recordId: match.memory.recordId, action: "store", targetIds: [] });
		}
	}
	return decisions;
}

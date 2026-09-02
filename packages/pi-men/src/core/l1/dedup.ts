import type { PiMenConfig } from "../../config.ts";
import type { DedupDecision, ExtractedMemory, HostLogger, LlmRunner } from "../../types.ts";
import { errorMessage } from "../errors.ts";
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
 * skip for each candidate. Unparsable output degrades to "store everything";
 * a runner (transport) failure propagates so the pass retries later — the L0
 * watermark only advances after the whole batch succeeds.
 */
export async function dedupMemories(params: {
	runner: LlmRunner;
	config: PiMenConfig;
	matches: CandidateMatch[];
	signal?: AbortSignal;
	logger?: HostLogger;
}): Promise<DedupDecision[]> {
	const { runner, config, matches, signal, logger } = params;
	if (matches.length === 0) return [];
	const raw = await runner({
		systemPrompt: getDedupSystemPrompt(config.promptMode),
		userPrompt: formatBatchConflictPrompt(matches),
		maxTokens: 4096,
		signal,
	});
	let parsed: unknown[];
	try {
		parsed = extractJsonArray(raw);
	} catch (error) {
		logger?.warn?.(`[pi-men] dedup output unparsable; storing all candidates: ${errorMessage(error)}`);
		return matches.map((match) => ({ recordId: match.memory.recordId, action: "store" as const, targetIds: [] }));
	}
	const decisions: DedupDecision[] = [];
	const known = new Set(matches.map((match) => match.memory.recordId));
	const memoryById = new Map(matches.map((match) => [match.memory.recordId, match.memory]));
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const recordId = typeof record.record_id === "string" ? record.record_id : "";
		if (!recordId || !known.has(recordId)) continue;
		const action = record.action;
		if (action !== "store" && action !== "update" && action !== "merge" && action !== "skip") continue;
		if (action === "update" || action === "merge") {
			const content = typeof record.merged_content === "string" ? record.merged_content.trim() : "";
			const mergedType = isValidMemoryType(record.merged_type, true) ? record.merged_type : undefined;
			if (!content || !mergedType) {
				// Malformed fold: keep the candidate as a plain new record instead
				// of dropping it or corrupting the targets.
				decisions.push({ recordId, action: "store", targetIds: [] });
				continue;
			}
			decisions.push({
				recordId,
				action,
				targetIds: toStringArray(record.target_ids),
				mergedContent: content,
				mergedType,
				// An omitted merged_priority falls back to the candidate's own
				// priority (never the 50 default).
				mergedPriority: clampPriority(record.merged_priority, memoryById.get(recordId)?.priority ?? 50),
				...(toStringArray(record.merged_timestamps).length > 0
					? { mergedTimestamps: toStringArray(record.merged_timestamps) }
					: {}),
			});
			continue;
		}
		decisions.push({ recordId, action, targetIds: toStringArray(record.target_ids) });
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

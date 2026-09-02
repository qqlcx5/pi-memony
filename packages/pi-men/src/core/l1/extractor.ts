import type { PiMenConfig } from "../../config.ts";
import type { ConversationMessage, ExtractedMemory, LlmRunner, SceneExtraction } from "../../types.ts";
import { clampPriority, extractJsonArray, isValidMemoryType, parseMetadata, toStringArray } from "../parse.ts";
import { formatExtractionPrompt, getExtractionSystemPrompt } from "./prompts.ts";

let candidateCounter = 0;

function nextCandidateId(): string {
	candidateCounter = (candidateCounter + 1) % 0xffff;
	return `nm_${Date.now().toString(36)}_${candidateCounter.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export interface ExtractParams {
	newMessages: ConversationMessage[];
	backgroundMessages?: ConversationMessage[];
	previousSceneName?: string;
	signal?: AbortSignal;
}

/**
 * L1 extraction: one LLM call performs scene segmentation plus memory
 * extraction over the batch, returning validated candidates.
 */
export async function extractMemories(
	runner: LlmRunner,
	config: PiMenConfig,
	params: ExtractParams,
): Promise<SceneExtraction[]> {
	const raw = await runner({
		systemPrompt: getExtractionSystemPrompt(config.promptMode),
		userPrompt: formatExtractionPrompt(params),
		maxTokens: 4096,
		signal: params.signal,
	});
	const array = extractJsonArray(raw);
	const allowWorkTypes = config.promptMode === "code";
	const cap = config.extraction.maxMemoriesPerSession;
	const scenes: SceneExtraction[] = [];
	// Cap counts across all scenes, not per scene (one cap per extraction pass).
	let total = 0;
	for (const item of array) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const sceneName = typeof record.scene_name === "string" ? record.scene_name.trim() : "";
		if (!sceneName) continue;
		const memories: ExtractedMemory[] = [];
		if (Array.isArray(record.memories) && total < cap) {
			for (const entry of record.memories) {
				if (typeof entry !== "object" || entry === null) continue;
				const candidate = entry as Record<string, unknown>;
				if (!isValidMemoryType(candidate.type, allowWorkTypes)) continue;
				const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
				if (!content) continue;
				const scene =
					typeof candidate.scene_name === "string" && candidate.scene_name.trim()
						? candidate.scene_name.trim()
						: sceneName;
				memories.push({
					recordId: nextCandidateId(),
					content,
					type: candidate.type,
					priority: clampPriority(candidate.priority),
					sceneName: scene,
					sourceMessageIds: toStringArray(candidate.source_message_ids),
					metadata: parseMetadata(candidate.metadata),
				});
			}
			const taken = memories.slice(0, cap - total);
			total += taken.length;
			scenes.push({
				sceneName,
				messageIds: toStringArray(record.message_ids),
				memories: taken,
			});
			continue;
		}
		scenes.push({
			sceneName,
			messageIds: toStringArray(record.message_ids),
			memories: [],
		});
	}
	return scenes;
}

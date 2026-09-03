import { existsSync, readFileSync } from "node:fs";
import type { AntaAgentConfig } from "../../config.ts";
import type { RecallHit, RecallResult, RecallStrategy } from "../../types.ts";
import { generateSceneNavigation, type SceneIndexEntry } from "../scene/scene-store.ts";
import { sanitizeUntrustedText } from "../security.ts";
import type { StoragePaths } from "../storage/paths.ts";

const RECALL_SEPARATOR = "\n";
/** Tool usage guide appended to the stable (cacheable) system-prompt block. */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件、规则等关键信息。
- **conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节。

### 调用次数限制
每轮对话中，memory_search 和 conversation_search **合计最多调用 3 次**。
若 3 次搜索后仍无结果，说明该信息不在记忆中，直接根据已有信息回答即可。
</memory-tools-guide>`;

/**
 * Build the recall payload: dynamic `<relevant-memories>` prepended to the
 * user message, plus the stable persona/scene-navigation/tools-guide block
 * appended to the system prompt (kept identical across turns for prompt
 * caching).
 */
export function buildRecallResult(params: {
	hits: RecallHit[];
	strategy: RecallStrategy;
	config: AntaAgentConfig;
	paths: StoragePaths;
	sceneEntries: readonly SceneIndexEntry[];
}): RecallResult | undefined {
	const { hits, strategy, config, paths, sceneEntries } = params;
	let personaContent: string | null = null;
	try {
		if (existsSync(paths.personaFile)) personaContent = readFileSync(paths.personaFile, "utf8").trim();
	} catch {
		personaContent = null;
	}
	const sceneNavigationRaw = sceneEntries.length > 0 ? generateSceneNavigation(sceneEntries) : "";
	// Conversation-derived text can carry literal closing tags; neutralize any
	// occurrence so it cannot break out of its injection block.
	const sceneNavigation = sanitizeUntrustedText(sceneNavigationRaw, { maxChars: 20_000 });

	const stableParts: string[] = [];
	if (personaContent) {
		const escaped = sanitizeUntrustedText(personaContent, { maxChars: 50_000 });
		stableParts.push(`<user-persona>\n${escaped}\n</user-persona>`);
	}
	if (sceneNavigation) stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);

	let prependContext: string | undefined;
	if (hits.length > 0) {
		const lines = hits.map((hit) => formatMemoryLine(hit, config));
		prependContext = `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${lines.join(RECALL_SEPARATOR)}\n</relevant-memories>`;
	}

	if (stableParts.length === 0 && !prependContext) return undefined;
	if (stableParts.length > 0 || prependContext) stableParts.push(MEMORY_TOOLS_GUIDE);
	return {
		prependContext,
		appendSystemContext: stableParts.length > 0 ? stableParts.join("\n\n") : undefined,
		hits,
		strategy,
	};
}

const TRUNCATION_NOTICE = "…（已截断；可用 memory_search 查看详情）";

function formatMemoryLine(hit: RecallHit, config: AntaAgentConfig): string {
	let content = sanitizeUntrustedText(hit.content);
	const maxChars = config.recall.maxCharsPerMemory;
	if (maxChars > 0 && content.length > maxChars) {
		// Cut on code points, not UTF-16 units, so surrogate pairs survive.
		content = `${[...content].slice(0, Math.max(0, maxChars - 1)).join("")}${TRUNCATION_NOTICE}`;
	}
	const prefix = `- [${hit.type}]`;
	return `${prefix} ${content}`;
}

/** Total character budget across injected memories (0 disables the cap). */
export function applyRecallBudget(hits: RecallHit[], maxTotalChars: number): RecallHit[] {
	if (maxTotalChars <= 0) return hits;
	const kept: RecallHit[] = [];
	let total = 0;
	for (const hit of hits) {
		const size = [...sanitizeUntrustedText(hit.content)].length;
		if (total + size > maxTotalChars) continue;
		total += size;
		kept.push(hit);
	}
	return kept;
}

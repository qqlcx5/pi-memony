import type { AntaAgentConfig } from "../../config.ts";
import type { HostLogger, LlmRunner, MemoryRecord } from "../../types.ts";
import { extractJsonArray } from "../parse.ts";
import type { StoragePaths } from "../storage/paths.ts";
import { applySceneOps, generateSceneNavigation, type SceneIndexEntry, type SceneOp } from "./scene-store.ts";

/**
 * L2 scene extraction (single-shot adaptation): instead of driving file tools,
 * the LLM returns a JSON array of create/update/delete operations which are
 * applied to scene_blocks/ by the engine.
 */

const MAX_OPS = 12;

const SYSTEM_PROMPT = `# Memory Consolidation Architect

**输出语言**：场景文件内容使用与"新增记忆列表"中记忆相同的语言；JSON 字段名、action 枚举和 META 字段名保持英文。

## 角色
你是记忆整合架构师，负责把碎片化的 L1 记忆整合成场景块（scene blocks）：连贯的叙事文档，不是清单。

## 输入
1. 新增记忆列表（JSON）
2. 现有场景索引（文件名 + 摘要 + heat）
3. 当前时间

## 操作规则
- 对每个场景文件输出一个操作：create（新建）、update（更新，content 为完整重写后的文件内容）、delete（删除）。
- **默认策略是 update，不是 create**：优先把新记忆整合进现有场景；确属全新话题才 create；每次最多 create 1 个新场景。
- 场景文件总数上限为 {{maxScenes}}。若已达上限，必须先合并：把相似的多个场景整合为一个（对旧文件输出 delete，对合并结果输出 create 或 update），再处理新记忆。
- 无需更新的场景不要输出操作。无任何有价值的操作时输出空数组 []。

## 场景文件内容模板（content 字段，1500 字符内）
文件开头必须有 META 块：

-----META-START-----
created: {{已存在则填原值，否则当前时间}}
updated: {{当前时间}}
summary: [30-40 字的简洁摘要，用于索引]
heat: [整数：新建为 1，更新为原 heat + 1，合并为所有相关 heat 之和 + 1]
-----META-END-----

之后是 Markdown 正文，包含以下章节（章节标题按输出语言书写；无内容的章节可省略）：
- 核心特征（连贯段落，100 字内，宁缺毋滥）
- 偏好（列表，可复用的显性偏好）
- 隐性信号（推断出的"没明说但重要"的信息，宁缺毋滥）
- 核心叙事（连贯段落，400 字内，遵循 情境 -> 行动 -> 结果）
- 演变轨迹（仅记录重大转变，不记录琐碎更新）

## 输出格式
严格输出一个 JSON 数组，不要任何解释或代码块修饰：

[
  {
    "action": "create|update|delete",
    "file": "场景文件名.md（字母/数字/CJK/-/_/. 组合，禁空格和括号）",
    "summary": "30-40 字摘要（create/update 必填）",
    "heat": 3,
    "content": "完整文件内容（create/update 必填；delete 时省略）"
  }
]`;

export interface SceneExtractionResult {
	entries: SceneIndexEntry[];
	navigation: string;
}

/** Run one L2 consolidation pass over `memories` and apply the result. */
export async function extractScenes(params: {
	runner: LlmRunner;
	config: AntaAgentConfig;
	paths: StoragePaths;
	memories: readonly MemoryRecord[];
	existingIndex: readonly SceneIndexEntry[];
	logger?: HostLogger;
	signal?: AbortSignal;
}): Promise<SceneExtractionResult> {
	const { runner, config, paths, memories, existingIndex, logger, signal } = params;
	if (memories.length === 0) {
		return { entries: [...existingIndex], navigation: generateSceneNavigation(existingIndex) };
	}
	const memoriesJson = JSON.stringify(
		memories.map((memory) => ({
			id: memory.id,
			type: memory.type,
			priority: memory.priority,
			scene_name: memory.sceneName,
			created: memory.createdAt,
			content: memory.content,
		})),
		null,
		2,
	);
	const indexJson = JSON.stringify(
		existingIndex.map((entry) => ({
			file: entry.file,
			summary: entry.summary,
			heat: entry.heat,
			updated: entry.updatedAt,
		})),
		null,
		2,
	);
	const userPrompt = `当前时间：${new Date().toISOString()}
场景文件上限：${config.persona.maxScenes}
现有场景数：${existingIndex.length}

## 现有场景索引
${indexJson}

## 新增记忆列表（共 ${memories.length} 条）
${memoriesJson}

请输出场景操作 JSON 数组。`;

	const raw = await runner({ systemPrompt: buildSystemPrompt(config), userPrompt, maxTokens: 8192, signal });
	const ops = parseSceneOps(raw);
	const entries = applySceneOps(paths, ops, logger);
	return { entries, navigation: generateSceneNavigation(entries) };
}

function buildSystemPrompt(config: AntaAgentConfig): string {
	return SYSTEM_PROMPT.replaceAll("{{maxScenes}}", String(config.persona.maxScenes));
}

export function parseSceneOps(raw: string): SceneOp[] {
	const ops: SceneOp[] = [];
	for (const item of extractJsonArray(raw)) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const action = record.action;
		if (action !== "create" && action !== "update" && action !== "delete") continue;
		const file = typeof record.file === "string" ? record.file.trim() : "";
		if (!file) continue;
		const content = typeof record.content === "string" ? record.content : undefined;
		if ((action === "create" || action === "update") && (!content || !content.trim())) continue;
		ops.push({
			action,
			file,
			...(typeof record.summary === "string" && record.summary.trim() ? { summary: record.summary.trim() } : {}),
			...(typeof record.heat === "number" && Number.isFinite(record.heat) ? { heat: Math.trunc(record.heat) } : {}),
			...(content !== undefined ? { content } : {}),
		});
		if (ops.length >= MAX_OPS) break;
	}
	return ops;
}

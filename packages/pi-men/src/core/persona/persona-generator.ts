import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiMenConfig } from "../../config.ts";
import type { LlmRunner } from "../../types.ts";
import { stripCodeFences } from "../parse.ts";
import type { SceneIndexEntry } from "../scene/scene-store.ts";
import type { StoragePaths } from "../storage/paths.ts";

/**
 * L3 persona/doctrine generation (single-shot): the LLM returns the full
 * persona.md content; the engine rotates backups and writes it.
 */

const CHAT_SYSTEM_PROMPT = `# Persona Architect - Incremental Evolution Protocol

**输出语言**：persona 文档的自然语言内容使用与变化场景内容相同的语言；Markdown 标题格式保持英文模板骨架。

## 约束
- 直接输出最终 persona 文档的完整 Markdown 内容（不要代码块包裹，不要解释、不要分析过程）。
- 内容总长度不要超过 2000 字符，及时总结并删除不重要的信息。
- 禁止过度推测：没有场景证据的信息不要臆想，没有相关内容可以不填。
- 只能使用提供的场景数据，不要从工作区路径、系统信息等技术元数据推断个人信息。

## 核心逻辑（四层深度扫描）
1. Layer 1 基础锚点：确凿事实、当前状态（供 Agent 破冰与上下文感知）。
2. Layer 2 兴趣图谱：投入时间/金钱/注意力的事物，区分活跃度（供闲聊与推荐）。
3. Layer 3 交互协议：沟通习惯、雷区、工作流偏好（指导 Agent 如何说话与交付）。
4. Layer 4 认知内核：决策逻辑、矛盾点、驱动力（供深层共鸣）。
遵循"叙事连贯性"原则，禁止罗列堆砌；保持精简，不确定可以不写。

## 迭代策略
面对变化场景自主判断：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增）。

## 输出模板（可按信息量增删章节，必须保持 Markdown）

# User Narrative Profile

> **Archetype (核心原型)**: [一句话定义]

> **基本信息**
（年龄、职业、技术栈等；冲突则覆盖，不冲突则叠加）

> **长期偏好**
（最稳定且可复用的偏好）

## Chapter 1: Context & Current State (全景语境)
（基础事实与当前状态融合成连贯背景）

## Chapter 2: The Texture of Life (生活的肌理)
（兴趣、习惯、品味串联）

## Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)
### 3.1 沟通策略 (How to Speak)
### 3.2 决策逻辑 (How to Think)

## Chapter 4: Deep Insights & Evolution (深层洞察与演变)
- **矛盾统一性**: [看似冲突实则合理的特质]
- **演变轨迹**: [带时间的变化]
- **涌现特征**: 3-7 个核心特质标签，每行一个并附 10-15 字注释`;

const CODE_SYSTEM_PROMPT = `# Operating Doctrine Architect

**输出语言**：文档的自然语言内容使用与变化场景内容相同的语言；Markdown 标题格式保持英文。

这份 L3 不是项目总结、进度记录或事实汇总，而是跨任务可复用的 Operating Doctrine：帮助用户和 Agent 在未来任务中知道如何判断、如何执行、如何避免错误。

## 约束
- 直接输出最终文档的完整 Markdown 内容（不要代码块包裹，不要解释）。
- 全文不超过 1200 字，求精不求多。
- 禁止项目化碎片（"项目 v2 要优化"）、流水账、低层事实堆积。
- 每条内容必须脱离原项目仍能理解，包含动作对象、适用条件或判断逻辑。
- 禁止过度推测；只有能抽象成跨场景规则的内容才写入。

## 提炼目标
1. SOP：类似任务应按什么流程做。
2. Principle：长期遵守的工作原则。
3. Decision Logic：取舍时按什么标准判断。
4. Boundary：哪些事不能做、哪些内容不能自动化。
5. Anti-pattern：哪些做法会导致错误、污染记忆、降低质量。
6. Agent Rule：Agent 执行任务、更新记忆时应遵守什么规则。

## 过滤标准（逐条检查，任一为否则不写入）
通用性 / 完整性 / 可执行性 / 稳定性 / 精炼性。

## 增量策略
强化（佐证已有原则，压缩或不改）/ 补充 / 修正 / 重构（变散变长时整体压缩重写）/ 不改（只有项目状态或低层事实）。

## 输出模板（可删减章节，必须保持 Markdown）

# Operating Doctrine

> **Operating Thesis**: [一句话概括最核心的工作方法或执行原则]

## Core Principles
- [原则]: [适用条件 / 判断逻辑 / 为什么重要]

## Reusable SOPs
- [SOP 名称]: 当 [触发条件] 时，先 [步骤1]，再 [步骤2]，最后 [产出/验收标准]。

## Decision Logic
- 当 [场景] 时，优先 [A] 而不是 [B]，因为 [原因]。

## Boundaries & Anti-patterns
- 不要 [错误做法]；应改为 [推荐做法]，因为 [原因]。

## Agent Rules
- Agent 应 [行为规则]，避免 [风险]。`;

export interface PersonaResult {
	content: string | null;
	mode: "first" | "incremental";
}

/** Run one L3 pass over changed scene blocks; returns the new persona content. */
export async function generatePersona(params: {
	runner: LlmRunner;
	config: PiMenConfig;
	existingPersona: string | null;
	changedScenes: readonly SceneIndexEntry[];
	paths: StoragePaths;
	totalMemories: number;
	signal?: AbortSignal;
}): Promise<PersonaResult> {
	const { runner, config, existingPersona, changedScenes, paths, totalMemories, signal } = params;
	const mode: "first" | "incremental" = existingPersona ? "incremental" : "first";
	const changedContent = changedScenes
		.map((entry) => {
			const file = join(paths.sceneBlocksDir, entry.file);
			const body = existsSync(file) ? readFileSync(file, "utf8") : "";
			return `### ${entry.file}\n\n${body.trim() || "（文件已丢失）"}`;
		})
		.join("\n\n---\n\n");
	const systemPrompt = config.promptMode === "chat" ? CHAT_SYSTEM_PROMPT : CODE_SYSTEM_PROMPT;
	const userPrompt = `**输出语言**：使用下方变化场景内容的主导语言。

**模式**: ${mode === "first" ? "首次生成" : "迭代更新"}
**当前时间**: ${new Date().toISOString()}

## 统计
- 总记忆数: ${totalMemories} 条
- 场景总数: 未变化场景 + 下方变化场景
- 变化场景: ${changedScenes.length} 个（自上次更新后）

## 变化场景内容
${changedContent || "（无）"}

${existingPersona ? `## 当前 persona 文档（基于此更新，控制在${config.promptMode === "chat" ? 2000 : 1200}字内）\n\n\`\`\`markdown\n${existingPersona}\n\`\`\`\n` : ""}
请直接输出最终的完整 Markdown 文档。`;

	const raw = await runner({ systemPrompt, userPrompt, maxTokens: 4096, signal });
	const content = stripCodeFences(raw.trim());
	if (!content) return { content: null, mode };
	return { content, mode };
}

/** Write persona.md with a rotating backup of the previous version. */
export function writePersona(paths: StoragePaths, content: string, backupCount: number): void {
	mkdirSync(paths.root, { recursive: true });
	if (backupCount > 0 && existsSync(paths.personaFile)) {
		mkdirSync(paths.backupDir, { recursive: true });
		copyFileSync(paths.personaFile, join(paths.backupDir, `persona-${Date.now()}.md`));
		const backups = readdirBackup(paths);
		while (backups.length > backupCount) {
			const oldest = backups.shift();
			if (oldest) rmSync(join(paths.backupDir, oldest));
		}
	}
	writeFileSync(paths.personaFile, `${content.trimEnd()}\n`, "utf8");
}

function readdirBackup(paths: StoragePaths): string[] {
	try {
		if (!existsSync(paths.backupDir)) return [];
		return readdirSync(paths.backupDir).sort();
	} catch {
		return [];
	}
}

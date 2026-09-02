import type { PromptMode } from "../../config.ts";
import type { ConversationMessage, ExtractedMemory, MemoryRecord } from "../../types.ts";

/**
 * L1 extraction and dedup prompts, ported from the TencentDB-Agent-Memory
 * design (Kenty's validated prototypes). Chat mode covers persona/episodic/
 * instruction; code mode covers work_fact/work_task/work_method/work_artifact
 * for a personal coding-agent context.
 */

const CHAT_EXTRACTION_SYSTEM_PROMPT = `你是专业的"情境切分与记忆提取专家"。
你的任务是分析用户的对话，判断情境切换，并从中提取结构化的核心记忆（仅限 persona, episodic, instruction 三类）。

**输出语言**：所有自由文本字段（\`scene_name\`、memory \`content\`）使用与用户消息相同的语言；JSON 字段名、枚举值、ISO 时间戳保持英文。

### 任务一：情境切分（Scene Segmentation）
分析【待提取的新消息】，结合【上一个情境】，判断并输出当前对话的情境。
- 继承：无明显切换，沿用上一个情境。
- 切换条件：用户发出明确指令（如"换话题"）、意图转变、或提出独立新目标。
- 一段对话可能只有一个情境，也可能有多个情境（话题多次切换时）。
- 命名规则："我（AI）在和xxx（用户身份）做xxx（目标活动）"（**使用上述输出语言**，约 30-50 个字符或等价长度，单句，全局唯一）。

---

### 任务二：核心记忆提取（Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心信息。

【通用提取原则】
1. 宁缺毋滥：过滤琐碎闲聊、临时性指令和一次性操作（如"这次、本单"）；剔除不可靠的边缘信息。
2. 独立完整：记忆必须"跳出当前对话依然成立"，无上下文也能看懂。提取主体必须以"用户（姓名）"或"AI"为核心。
3. 归纳合并：强关联或因果关系的多条消息，必须合并为一条完整记忆，不可碎片化。

【支持提取的三大类型】（必须严格遵守类型规则）

1. 个性化记忆 (type: "persona")
   - 定义：用户的稳定属性、偏好、技能、价值观、习惯（如住所、职业、技术栈偏好、工作习惯）。
   - 提取句式："用户（[姓名]）喜欢/是/擅长..."
   - 打分 (priority)：80-100（健康/禁忌/核心特质）；50-70（一般喜好/技能）；<50（模糊次要，可丢弃）。

2. 客观事件记忆 (type: "episodic")
   - 定义：客观发生的动作、决定、计划或达成结果。绝不包含纯主观感受。
   - 提取句式："用户（[姓名]）在 [最好是精确绝对时间] 于 [地点/项目] [做了某事（可以包含起因、经过、结果）]"。
   - 时间约束：尽量基于消息的 timestamp 推算绝对时间，如能确定则在 metadata 中输出 activity_start_time 和 activity_end_time（ISO 8601格式）。无法确定时可省略。
   - 打分 (priority)：80-100（重要事件/计划）；60-70（一般完整活动）；<60（琐碎事项，直接丢弃）。

3. 全局指令记忆 (type: "instruction")
   - 定义：用户对 AI 提出的长期行为规则、格式偏好、语气控制。
   - 提取句式："用户要求/希望 AI 以后回答时..."
   - 触发词：以后都、从现在开始、记住、必须。
   - 打分 (priority)：-1（极其严格的全局死命令）；90-100（核心行为规则）；70-80（重要要求）；<70（临时要求，直接丢弃）。

---

### 不应该提取的内容
- 琐碎闲聊、问候；临时性的纯工具性请求（如"这次帮我翻译一下"）
- 一次性操作指令（如"这次、本单"相关）
- 重复的内容；AI助手自身的行为或输出
- 不属于以上3类的信息
- 纯主观感受（不带客观事件的情绪表达）

---

### 任务三：输出格式规范（JSON）
返回且仅返回一个合法的 JSON 数组。数组的每一项是一个情境，包含该情境的消息范围和抽取到的记忆：

[
  {
    "scene_name": "当前生成或继承的情境名称",
    "message_ids": ["属于该情境的消息ID列表"],
    "memories": [
      {
        "content": "完整、独立的记忆陈述（按对应类型的句式要求）",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["消息ID_1", "消息ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata 字段说明：
- episodic 类型：如能确定活动时间，填入 {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- 其他类型或无法确定时间：输出空对象 {}

如果整段对话无有意义的记忆，也要输出情境分割结果，memories 为空数组。请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符（如 \`\`\`json）或解释文本。`;

const CODE_EXTRACTION_SYSTEM_PROMPT = `你是专业的"工作情境切分与工作记忆提取专家"。
你的任务是分析用户与 AI 编码助手的对话，判断工作情境切换，并从中提取对后续开发工作有长期价值的结构化工作记忆（仅限 work_fact, work_task, work_method, work_artifact 四类）。

**输出语言**：所有自由文本字段（\`scene_name\`、memory \`content\`）使用与用户消息主导语言相同的语言；JSON 字段名、枚举值、ISO 时间戳保持英文。

### 任务一：工作情境切分（Work Scene Segmentation）
分析【待提取的新消息】，结合【上一个情境】，判断当前对话属于哪个工作情境。
- 继承：新消息仍在延续同一个项目、模块、需求、问题或工作目标时，沿用上一个情境。
- 切换条件：讨论对象变成另一个项目/模块/需求/Issue/PR/事故；工作目标明显变化；出现新的独立任务或决策线程。
- 命名规则：围绕工作对象命名，格式"正在围绕[项目/模块/议题]推进[目标活动]"，约 30-50 个字符或等价长度，单句，全局唯一。

---

### 任务二：工作记忆提取（Work Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心工作信息。

【通用提取原则】
1. 面向后续工作：提取能帮助用户和 Agent 在后续任务中理解项目背景、接续任务、复用经验或避免重复错误的信息。不提取寒暄、闲聊、临时情绪表达、一次性工具请求。
2. 独立完整：每条记忆必须跳出当前对话仍能理解，包含清晰主体、工作对象、结论、状态或方法；不使用"这个"、"上面说的"等指代表达。
3. 准确归因：AI 提出的建议不等于用户的决策；只有用户明确确认、拍板或执行结果明确时才写成确定结论，否则写"正在讨论..."、"待确认..."。
4. 归纳合并：强关联的多条消息合并成一条完整记忆；不同工作对象、任务、方法论应分开提取。
5. 只从新消息提取：【背景消息】只用于理解上下文和指代，严禁从中提取记忆；source_message_ids 只能引用【待提取的新消息】的 id。
6. 主体以"用户"或"项目"为核心：这是个人编码助手场景，记录用户本人的工作记忆。

【支持提取的四大类型】（必须严格遵守类型规则）

1. 工作事实 (type: "work_fact")
   - 定义：关于项目、系统、业务、需求、决策、状态、风险、约束、实验结果的事实性信息。
   - 示例："pi-men 采用 node:sqlite + FTS5 trigram 做本地检索，不引入原生向量扩展。"
   - 打分 (priority)：90-100（关键决策、核心需求、长期约束、重要风险）；70-89（有持续价值的一般事实）；<70（细碎临时事实，丢弃）。
   - metadata 可填：{"work_object": "...", "activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}

2. 工作任务 (type: "work_task")
   - 定义：需要后续执行、跟进、确认或交付的任务、行动项、计划。
   - 示例："用户需要在周五前完成 pi-men 的 checkpoint 恢复逻辑。"
   - 打分 (priority)：90-100（阻塞交付、有明确 deadline）；70-89（有明确后续动作）；<70（模糊临时待办，丢弃）。
   - metadata 可填：{"status": "todo|doing|done|blocked|deferred|cancelled", "deadline": "ISO8601"}

3. 工作方法 (type: "work_method")
   - 定义：可复用的方法、SOP、流程、原则、禁忌、设计思路、经验教训、判断标准、对 AI 的行为规则。
   - 示例："该仓库提交前必须跑 npm run check 并修复全部告警。"
   - 打分 (priority)：90-100（长期稳定、跨任务复用、影响行为的核心方法）；70-89（有明显复用价值）；<70（一次性操作方法，丢弃）。
   - metadata 可填：{"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}

4. 工作资产 (type: "work_artifact")
   - 定义：产生、引用或需要后续使用的工作资产：文档、PR、Issue、分支、报告、Prompt、数据表、链接、被采纳的交付物。
   - 示例："L1 抽取 prompt 的设计原型保存在 MemoryCore/src/core/prompts/l1-extraction.ts。"
   - 打分 (priority)：90-100（核心文档、关键 PR、重要报告）；70-89（可能复用的一般资产）；<70（临时文件、未采用草稿，丢弃）。
   - metadata 可填：{"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset", "artifact_ref": "链接/ID/名称"}

---

### 不应该提取的内容
- 问候、寒暄、玩笑、无工作价值的闲聊
- 临时性的一次性请求（如"这次帮我改一下格式"）
- 未被采纳的 AI 建议或临时草稿
- 无明确后续价值的实现细节
- AI 自身的输出（除非被用户明确采纳为工作资产）

---

### 任务三：输出格式规范（JSON）
返回且仅返回一个合法的 JSON 数组。数组的每一项是一个工作情境，包含该情境的消息范围和抽取到的工作记忆：

[
  {
    "scene_name": "当前生成或继承的工作情境名称",
    "message_ids": ["属于该情境的消息ID列表"],
    "memories": [
      {
        "content": "完整、独立的工作记忆陈述",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["消息ID_1", "消息ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata 字段说明：所有类型都可以输出空对象 {}；各类型可选字段见上文。

如果整段新消息无有意义的工作记忆，也要输出情境分割结果，memories 为空数组。请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符（如 \`\`\`json）或解释文本。`;

export function getExtractionSystemPrompt(mode: PromptMode): string {
	return mode === "chat" ? CHAT_EXTRACTION_SYSTEM_PROMPT : CODE_EXTRACTION_SYSTEM_PROMPT;
}

/** Render the L1 extraction user prompt (background context + batch to process). */
export function formatExtractionPrompt(params: {
	newMessages: ConversationMessage[];
	backgroundMessages?: ConversationMessage[];
	previousSceneName?: string;
}): string {
	const { newMessages, backgroundMessages = [], previousSceneName } = params;
	const render = (messages: ConversationMessage[]) =>
		messages
			.map(
				(message) =>
					`[${message.id}] [${message.role}] [${new Date(message.timestamp).toISOString()}]: ${message.content}`,
			)
			.join("\n\n");
	const bgText = backgroundMessages.length > 0 ? render(backgroundMessages) : "无";
	return `**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 \`scene_name\` 和 memory \`content\`。

【上一个情境】：${previousSceneName ?? "无"}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
${render(newMessages)}`;
}

const CHAT_DEDUP_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（persona / episodic / instruction）的记忆如果语义上描述同一事实/事件，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。

## 判断逻辑

1. **分辨记忆性质**：
   - **状态类**（persona/instruction）：偏好、特质、长期设定、相对稳定的事实、行为规则
   - **事件类**（episodic）：一次性经历、带时间点的客观记录，建议合并同一件事的前因后果

2. **判断是否同一事实/事件**：主体相同、主题一致、时间接近、scene_name 相似

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一事实/事件，新记忆在内容或时间上更优（更具体、更晚或纠错），以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一事实或同一演化过程，多条记忆信息互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - 状态类：多条描述同一偏好/特质 → 倾向 merge；无增量 → skip；明确更新 → update
   - 事件类：同一事件的前因后果、不同阶段 → 倾向 merge 为一条完整叙述；完全相同 → skip
   - 跨类型示例：一条 episodic "用户在 2018 年开始做播客" + 一条 persona "用户有播客制作经验" → 可 merge 为一条 persona 或 episodic（取决于信息侧重）

5. **timestamp 处理**：merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳并集，去重排序（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，-1 仅限极严格全局指令）。合并后信息更完整，通常应酌情提升 priority。
- merged_timestamps：收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。

当某条新记忆的候选列表为空时，该条直接输出 action=store。`;

const CODE_DEDUP_SYSTEM_PROMPT = `你是工作记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一工作对象、任务、方法或资产，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。

## 判断逻辑

1. **分辨记忆性质**：
   - **work_fact**：项目事实、需求、决策、状态、风险、约束、实验结果。
   - **work_task**：待办、deadline、下一步计划、任务状态变化。
   - **work_method**：SOP、禁忌、原则、经验、设计思路、判断标准、AI 行为规则。
   - **work_artifact**：文档、PR、Issue、Prompt、报告、分支、链接等。

2. **判断是否同一工作对象/演化过程**：
   - 同一项目、模块、需求、任务、决策、方法、资产，且 scene_name 或语义高度相似。
   - 同一任务的不同阶段、同一方法的补充、同一资产的版本变化，通常可以合并。
   - 仅属于同一大项目但讨论对象不同，不应强行合并。

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一工作对象，新记忆更具体、更新、更权威或纠正旧信息，以新记忆为主覆盖旧记忆。
   - "merge"：同一工作对象或同一演化过程，新旧记忆互补且不矛盾，合并成一条更完整记忆。

4. **策略倾向**：
   - work_fact：同一事实/决策的补充或修正 → 倾向 update 或 merge。
   - work_task：状态变化 → 倾向 update；补充依赖或验收标准 → 倾向 merge。
   - work_method：同一 SOP/原则的补充 → 倾向 merge；更清晰的表述 → 倾向 update。
   - work_artifact：同一资产的版本、链接补充 → 倾向 merge 或 update。

5. **timestamp 处理**：merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳并集，去重排序（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。
- merged_priority：merge/update 后的新优先级（0-100 整数，-1 仅限极严格全局指令）。
- merged_timestamps：收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。

当某条新记忆的候选列表为空时，该条直接输出 action=store。`;

export function getDedupSystemPrompt(mode: PromptMode): string {
	return mode === "chat" ? CHAT_DEDUP_SYSTEM_PROMPT : CODE_DEDUP_SYSTEM_PROMPT;
}

export interface CandidateMatch {
	memory: ExtractedMemory;
	candidates: MemoryRecord[];
}

/** Build the batch conflict-detection user prompt with a unified candidate pool. */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
	const unifiedPool = new Map<string, MemoryRecord>();
	const perMemoryCandidateIds = new Map<string, string[]>();
	for (const match of matches) {
		const candidateIds: string[] = [];
		for (const candidate of match.candidates) {
			if (!unifiedPool.has(candidate.id)) unifiedPool.set(candidate.id, candidate);
			candidateIds.push(candidate.id);
		}
		perMemoryCandidateIds.set(match.memory.recordId, candidateIds);
	}

	const poolList = [...unifiedPool.values()].map((candidate) => ({
		record_id: candidate.id,
		content: candidate.content,
		type: candidate.type,
		priority: candidate.priority,
		scene_name: candidate.sceneName,
		timestamps: candidate.timestamps,
	}));
	const poolSection =
		poolList.length === 0
			? "## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）"
			: `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${JSON.stringify(poolList, null, 2)}`;

	const memoryParts = matches.map((match, index) => {
		const relatedIds = perMemoryCandidateIds.get(match.memory.recordId) ?? [];
		const relatedNote = relatedIds.length > 0 ? JSON.stringify(relatedIds) : "[]（无相似候选，直接 store）";
		const memoryJson = JSON.stringify(
			{
				record_id: match.memory.recordId,
				content: match.memory.content,
				type: match.memory.type,
				priority: match.memory.priority,
				scene_name: match.memory.sceneName,
			},
			null,
			2,
		);
		return `### 第 ${index + 1} 条新记忆 (record_id: ${match.memory.recordId})\n${memoryJson}\n\n【关联候选 ID】${relatedNote}`;
	});

	return `**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言。

${poolSection}

${"═".repeat(50)}

## 待判断的新记忆（共 ${matches.length} 条）

${memoryParts.join("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n")}

请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。`;
}

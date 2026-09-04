# anta-agent 产品介绍

> 核实基线：`packages/anta-agent` @ **v0.84.9**，MIT，Node ≥22.19。所有结论对到具体源码文件。对照系：Claude Code harness、DeepSeek harness（DSH）、TencentDB-Agent-Memory、Mem0/Letta。

## 一句话定位

anta-agent 是**长期记忆出厂内置的开源编码 agent**：终端 TUI、命令 `at`、40 家模型供应商、全量工具集、会话树——外加一套别的 harness 要么没有、要么做成外挂的**四层自动记忆引擎**。记忆不是插件，是底盘的一部分；一键可关，关掉就是一台普通编码 agent。

设计血缘（源码注释可查）：记忆引擎移植自 TencentDB-Agent-Memory 的已验证原型（`src/core/anta-agent-core.ts` 顶部注释），裁掉全部企业级特性（远程 Proxy、Knowledge 服务、多租户 ACL、分布式 worker），只做**单机个人版**。origin commit 链：四层记忆引擎 → 重构为 anta-agent → 生命周期加固 → 品牌化 + 安全场景存储 → 对抗性边界测试，共五轮迭代。

## 产品能力面

| 能力 | 具体内容 |
|---|---|
| 模型 | 40 家 provider（Anthropic/OpenAI/Google/Bedrock…），支持订阅 OAuth（Claude Pro/ChatGPT Plus/Copilot 等）与本地模型（llama.cpp/MLX/Ollama） |
| 工具 | `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`（Windows 另有原生 `powershell`） |
| 交互 | TUI：会话树 `/tree` 跳转、`/fork`、`/compact` 分支压缩、消息排队 steering；中文状态栏实时显示 token / 缓存命中 / 费用 / 上下文占用（`anta-agent-extension.ts` 的 `createChineseFooter`） |
| 模式 | interactive / print / JSON / RPC / SDK 五种 |
| 扩展 | TS 模块完整扩展 API（约 30 事件 + 注册工具/命令/快捷键/主题），热重载；Skills、Prompt 模板、主题 |
| **记忆** | `/remember` 显式存、`/memory` 看状态、`memory_search` + `conversation_search` 两个内置工具；数据独立住 `~/.anta-agent` |

## 架构解剖

### 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 壳（CLI） | `src/cli.ts` | `at` → 定位底座 CLI，以内置扩展身份启动，环境变量把数据目录钉到 `~/.anta-agent`（与任何其他 agent 安装完全隔离） |
| 宿主接线 | `src/anta-agent-extension.ts` | 挂 6 个生命周期事件、注册 2 工具 + 2 命令、TUI 中文状态栏 |
| 适配器 | `src/host-adapter.ts` | 把宿主会话身份翻译成记忆域 `MemoryScope`，宿主细节不进核心 |
| **核（宿主无关）** | `src/core/**` | 四层引擎全部逻辑，只依赖一个 `LlmRunner` 接口（单次文本补全），不知道宿主存在 |
| 自包含设施 | `src/http-dispatcher.ts` | undici 全局 dispatcher（300s 空闲超时、代理），发布包自带网络配置 |

核心不变量：`AntaAgent` 是 host-neutral facade，capture/recall/search **never throws**——记忆系统任何故障不允许杀掉宿主会话。

### 四层数据流（数字全是 `pipeline/manager.ts` / `config.ts` 默认值）

```
回合结束 ──▶ L0 记录 ──每5轮/空闲10min──▶ L1 提取+去重 ──延迟10s──▶ L2 场景整合 ──每50条新记忆──▶ L3 persona
                │                                                                              │
新回合 ◀── 混合检索(RRF) + persona + 场景导航 ◀────────────────────────────────────────────────┘
```

| 层 | 存什么 | 怎么进 | 存哪 |
|---|---|---|---|
| **L0 对话** | 每轮完整对话（失败/中止回合剔除） | 回合结束同步捕获；**先写每日 JSONL（真相源），再投影进 SQLite** | `conversations/*.jsonl` + `l0_conversations`/`l0_fts` |
| **L1 原子记忆** | chat 模式 3 类（persona/episodic/instruction）；code 模式 4 类（work_fact/work_task/work_method/work_artifact） | 一次 LLM 调用同时做情境切分 + 记忆提取；再一次批量去重，决策 **store/update/merge/skip**（允许跨类型合并、一换多） | SQLite `l1_records` + FTS5 trigram |
| **L2 场景块** | 叙事式 Markdown 场景文档（META 头：summary/heat/时间戳） | LLM 返回 create/update/delete 操作数组（≤12 op/次，默认 update 优先，≤15 个场景封顶，超出强制合并） | `scene_blocks/*.md` + 可重建索引 |
| **L3 persona** | chat 模式 = User Narrative Profile（≤2000 字）；code 模式 = Operating Doctrine（≤1200 字：SOP/原则/决策逻辑/边界/反模式/Agent 规则） | 每 50 条新记忆增量重生成（强化/补充/修正/重构/不改） | `persona.md` + 轮转备份 ×3 |

### 调度与可靠性

- **L1**：每 5 轮（冷启动预热 1→2→4）或空闲 600s；单批 ≤400 消息 / ≤120k 字符 / ≤3 个 LLM 分块，水位线只推进已处理部分——**崩溃不丢数据，只重试**。
- **L2 节流**：L1 后延迟 10s，最小间隔 15min，积压超 1h 强制通过；每次先快照 `scene_blocks/`（保留 10 份）。
- **写入顺序**：JSONL 先于 SQLite（崩溃后投影可重放恢复）；checkpoint 原子写（tmp+rename）；SQLite WAL。
- **关机协议**：停收新任务 → 等 ≤5s → flush → 关库；超时则**延迟关库**而不是在活跃操作底下抽走数据库。
- **审计**：每次 store/update/merge/skip 追加 `records/*.jsonl`（append-only）；主写失败抛错阻止水位线推进。

### 检索与注入（缓存友好是第一约束）

- **混合检索**：FTS5 trigram BM25 + 内存暴力余弦（typed-array 线性扫；源码注释明说"个人库万级条目毫秒级，不值得引入原生向量扩展"），RRF 融合（k=60）。中英一发出结果。
- **嵌入默认关闭**：`embedding.provider: "none"` 零嵌入网络调用；配置 OpenAI 兼容端点后后台批量回填（32/批），失败降级关键词，模型/维度变更自动清空重嵌。
- **注入分两股**（`recall/recall-context.ts`）：
  - 动态：`<relevant-memories>`（默认 ≤5 条）贴**最后一条用户消息**——每轮变，不碰系统提示；
  - 稳定：`<user-persona>` + `<scene-navigation>` + `<memory-tools-guide>` 追加**系统提示尾部**——跨轮不变，**保住 provider prompt cache**。
- **兜底**：注入不够时模型可调 `memory_search`/`conversation_search`，工具指南硬限每轮合计 ≤3 次。

### 安全边界

持久化 / 注入 / 文件写三处真边界统一过 `sanitizeUntrustedText`（中和包装标签字面量、剥控制字符、修非法代理对、字段截断）；场景文件名白名单 + 路径逃逸拒绝；记忆内容按"不可信参考数据"处理。

## Harness 坐标系对照（一）：六件套

把 agent 外壳拆 6 个组件，Claude Code / DeepSeek harness / anta-agent 各怎么做：

| 组件 | Claude Code | DeepSeek harness（DSH） | **anta-agent** |
|---|---|---|---|
| Rule 软约束 | `settings.json` + CLAUDE.md | profile→bundle→patch→overlay 配置层叠，任何一行可被上层替换 | `AGENTS.md`/`SYSTEM.md`，靠容器而非弹窗 |
| Skill 知识包 | plugins 市场 | 一切皆插件（含 agent 循环本身），按扩展点挂载 | `Skills` 按需加载（系统提示只放描述） |
| Sub-Agent | plugin 一等公民 | 能力接缝三角色（定义+提供者+消费者） | 不内置，扩展或 tmux |
| Workflow 状态机 | 无内置 | 内核只拥有注册与生命周期 | 不内置，扩展实现 |
| Script 门控 | `PreToolUse` hook | 校验只在真边界，进程内信任类型 | 不内置，扩展或 CI |
| MCP | plugin 一等公民 | —（不以此为中心） | 不内置（桥接或自写扩展） |
| **长期记忆** | CLAUDE.md 手写 + 记忆目录 | **事实源+投影**：模型可见皆可从日志重建 | **四层引擎出厂内置**（唯一的大件，可一键关） |

定位差异一句话：Claude Code 把功能做进**产品**（重、开箱即用），DSH 把一切做进**插件树**（内核零特权），anta-agent 走第三条路——**内核极小 + 唯一预装的大件是记忆**。

## Harness 坐标系对照（二）：用 DSH 七模型给 anta-agent 打分

这是最有信息量的横切面——anta-agent 的记忆引擎恰好是 DSH 哲学的单机实现样本：

| DSH 模型 | anta-agent 现状 | 判定 |
|---|---|---|
| 1 无特权内核 | 扩展系统覆盖工具/命令/事件/UI，但记忆引擎是出厂内置大件——**可关闭、不可卸载** | 半达标：记忆是"特权大件"（产品自觉的取舍） |
| 2 能力接缝三角色 | `LlmRunner`：定义（单次补全）+ 提供者（宿主注入模型与鉴权）+ 消费者（四层管线），换模型/provider 全引擎跟着走；`EmbeddingService`：none/openai 双提供者 | 达标（教科书式） |
| 3 唯一事实源与投影 | JSONL = append-only 真相源；SQLite/FTS/向量/场景索引全是**可重建投影**（启动重放、META 重建）；DSH 名言 "Model-visible means logged" ↔ anta 注入模型的每一句都可从记忆库 + 审计日志重建 | **完全达标，全库最大亮点** |
| 4 校验只在真边界 | 持久化/注入/文件写三处统一校验，进程内类型信任不设防 | 达标 |
| 5 显式默认与响亮失败 | `parseAntaAgentConfig` = 显式 resolve（clamp + 全默认值集中一处）；主写不完整 → 抛错 + 水位线不推进；对宿主 fail-soft 正是 DSH 说的受众区分（部署者响亮、终端用户降级） | 达标 |
| 6 穷尽与对称 | `DedupAction` 封闭四值对称处理、`SceneOp` 三值；未上 assertNever 式编译器强制 | 大体达标 |
| 7 验证世界而非自述 | 存在对抗性边界测试（注入/恢复/越界）；断言对象未逐条核实 | 未验证（推断有覆盖） |

## 记忆坐标系对照（三）：跨产品

| 组件 | Claude Code | ChatGPT Memory | Mem0/Letta | TencentDB-Agent-Memory | **anta-agent** |
|---|---|---|---|---|---|
| 记忆形态 | CLAUDE.md + 记忆目录 | 闭环产品记忆 | SDK/服务记忆层 | 四层（L0-L3） | **四层，同源移植** |
| 写入 | 手写为主 | 全自动黑盒 | API 显式调用 | 自动流水线 | **全自动，后台不阻塞回合** |
| 去重/冲突 | 无 | 黑盒 | 库内 | LLM 批量 4 动作决策 | **store/update/merge/skip，含跨类型合并** |
| 检索 | 文件全量注入 | 黑盒 | SDK 混合检索 | 服务端混合 | **FTS5+向量 RRF 本地单发，中英通吃** |
| 注入位置 | 系统提示常驻 | 黑盒 | 宿主决定 | 宿主决定 | **动态贴用户消息 + 稳定贴系统提示（保缓存）** |
| 审计 | 文件可读 | 不可 | 视实现 | 服务端日志 | **records/*.jsonl 全量审计 + 双备份 + JSONL 真相源** |

## 硬指标

| | anta-agent | Claude Code |
|---|---|---|
| 系统提示规模 | 底座 ~1K + 记忆稳定段（persona ≤1200 字 + 场景导航 + 工具指南，约 1-2K token） | ~10-15K |
| 每轮额外 token | ≤5 条记忆贴用户消息（预算可配） | 视记忆量 |
| 后台 token | 每 5 轮 2 次 LLM 调用（提取+去重）+ L2/L3 定期 | 低 |
| 额外依赖 | typebox + undici 8.9.0（锁死），`node:sqlite` 原生**零原生编译** | — |
| 代码量 | src ~4.6K 行 + test ~1.7K 行（5 个测试文件含对抗性测试），MIT 开源 | 闭源 |
| 数据主权 | `~/.anta-agent` 全本地；嵌入默认关 = 零外发 | 云端 |
| 可关闭 | `settings.json` 一行 `{"memory":{"enabled":false}}` | — |

## 反方意见（本人对源码的诚实批评，逐条给判断）

1. **"蒸馏双花 token"——成立。** 提取/去重/场景/persona 全用会话同款模型，重度使用一天多 10-20% token。缓解：调度默认保守、全程可关。但"自动记忆免费"的叙事不成立。
2. **"提取质量看模型脸色"——成立。** 质量契约全靠 prompt 约束（"宁缺毋滥"等），无硬校验；小本地模型跑 JSON 输出容易崩，有 degrade-to-store 和重试兜底，但**垃圾记忆会真实入库**。
3. **"中文硬编码"——半成立。** 三套 LLM prompt 主体中文（输出语言被要求跟随用户消息），非中文用户功能无碍，但 prompt token 开销固定偏高。
4. **"单机单进程"——成立。** `node:sqlite` 单写者，两个 `at` 实例共用数据目录无并发保护；无远程后端（README Notes 明说留给未来，走 host-neutral facade 接）。
5. **"暴力向量检索"——不成立，这是正确权衡。** 个人库万级条目线性扫毫秒级，不引原生扩展是明确设计决策。
6. **"记忆污染难回滚"——半成立。** 有全量审计 + 双备份，但没有单条记忆回滚命令，纠错要手改 SQLite 或等下一轮 LLM 去重。
7. **"注入检测是摆设"——成立。** `containsPromptInjection` 导出了但生产路径未接线（仅测试引用）；实际防护靠转义/截断/路径白名单，够用但别宣传"注入检测"。
8. **"底座耦合"——成立。** 记忆引擎通过宿主接线层挂载，底座扩展 API 演进需要跟进；资产拷贝脚本让发布自包含，但升级要重跑。

综合：**工程质量没争议**（生命周期、崩溃恢复、缓存设计、fail-soft 全部源码级兑现），真正的赌注是"自动蒸馏的记忆比手写规则文件值这个 token 价"——高频多项目用户成立，低频单项目用户不成立。

## 产品现状与路线图

1. v0.84.9，CHANGELOG `[Unreleased]` 仅 initial release 一条，**未发布 npm**；已接入仓库构建链与 workspaces。
2. 测试覆盖：store / pipeline / memory-core / extension / adversarial 五件。
3. 已知短板（对应反方 4/6/7）：多实例并发保护、`/memory` 回滚命令、注入检测接线。
4. 官方预留方向（README Notes）：远程记忆后端**必须**走 host-neutral facade 接入，不改本地存储契约——TencentDB 的 Proxy/Knowledge/ACL/分布式 worker 不在本产品范围。

## 选型一句话

- 要"越用越懂你"的个人编码助手、多项目高频使用、数据全本地 → **anta-agent**
- 开箱即用大项目重构、IDE 集成 → **Claude Code**
- 要自己搭插件化 agent 平台、一切可替换可回放 → **DSH 路线**（自建）
- 团队/多租户/远程记忆服务 → **TencentDB-Agent-Memory**
- 已有自研 agent 只要记忆库 → **Mem0 类 SDK**

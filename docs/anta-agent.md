# anta-agent — 终端 AI 编程助手使用指南

> GitHub：[earendil-works/pi](https://github.com/earendil-works/pi)（本产品位于 `packages/anta-agent`）
> anta-agent 构建于 [pi](https://github.com/earendil-works/pi) 基座之上：交互、命令、模式与 pi 完全一致，并内置四层记忆引擎。

---

## 目录

1. [简介](#简介)
2. [安装与认证](#安装与认证)
3. [交互模式](#交互模式)
4. [编辑器功能](#编辑器功能)
5. [常用命令](#常用命令)
6. [记忆引擎](#记忆引擎)
7. [快捷键](#快捷键)
8. [消息队列](#消息队列)
9. [会话管理](#会话管理)
10. [分支与压缩](#分支与压缩)
11. [支持的供应商与模型](#支持的供应商与模型)
12. [自定义与扩展](#自定义与扩展)
13. [编程式使用](#编程式使用)
14. [CLI 参考](#cli-参考)
15. [设计哲学](#设计哲学)
16. [配置文件位置](#配置文件位置)

---

## 简介

**anta-agent** 是一个极简的终端 AI 编程助手，构建于 pi 基座之上，核心差异是**内置四层记忆引擎**：自动记录你的对话与工作，提炼成可复用的记忆，并在后续会话中注入相关内容。用得越多，越不需要重复解释自己。

anta-agent 默认提供 4 个内建工具供 LLM 使用：

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容（支持文本和图片） |
| `write` | 写入/创建文件 |
| `edit` | 精确替换文件内容 |
| `bash` | 执行 bash 命令 |

另有两个记忆工具：`memory_search`（搜索结构化记忆）和 `conversation_search`（搜索历史对话）。

anta-agent 支持 4 种运行模式：

- **交互模式（Interactive）**：在终端中与 AI 对话
- **打印模式（Print / JSON）**：非交互输出结果
- **RPC 模式**：进程集成
- **SDK 模式**：嵌入到你自己的应用中

---

## 安装与认证

### 安装

```bash
npm install -g anta-agent
```

### 认证方式

**方式一：API Key（环境变量）**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
at
```

**方式二：订阅账号（OAuth 登录）**

```bash
at
/login  # 选择供应商并完成 OAuth 认证
```

首次运行 `at` 会像 pi 一样引导你配置模型/API Key。支持的订阅服务：Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot、Google Gemini CLI、Google Antigravity。

所有数据存放在 `~/.anta-agent`，与已有的 pi 安装完全独立。

---

## 交互模式

进入 anta-agent 后，界面从上到下依次为：

| 区域 | 说明 |
|------|------|
| **启动头部** | 显示快捷键提示、已加载的 AGENTS.md、模板、技能、扩展 |
| **消息区域** | 用户消息、AI 回复、工具调用结果、通知、错误信息 |
| **编辑器** | 输入区域，边框颜色表示 thinking 级别 |
| **底部状态栏** | 工作目录、会话名称、token 用量、费用、上下文使用率、当前模型 |

---

## 编辑器功能

| 功能 | 操作 |
|------|------|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 `Tab` |
| 多行输入 | `Shift+Enter`（Windows Terminal 上为 `Ctrl+Enter`） |
| 粘贴图片 | `Ctrl+V`（Windows 为 `Alt+V`），或拖拽到终端 |
| 执行命令并发送输出 | `!command`（发送给 LLM），`!!command`（仅执行不发送） |

---

## 常用命令

在编辑器中输入 `/` 触发命令菜单：

| 命令 | 说明 |
|------|------|
| `/login` / `/logout` | OAuth 认证 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用 Ctrl+P 循环的模型 |
| `/settings` | 设置 thinking 级别、主题、消息传递方式等 |
| `/remember <文本>` | 立即保存一条长期记忆 |
| `/memory` | 显示记忆库状态（各层数量、pipeline 最近运行时间） |
| `/resume` | 恢复之前的会话 |
| `/new` | 开始新会话 |
| `/name <名称>` | 设置会话显示名称 |
| `/session` | 显示会话信息（路径、token、费用） |
| `/tree` | 浏览会话树，可跳转到任意节点继续 |
| `/fork` | 从当前分支创建新会话 |
| `/compact [提示]` | 手动压缩上下文 |
| `/copy` | 复制最后一条 AI 消息到剪贴板 |
| `/export [文件]` | 导出会话为 HTML |
| `/share` | 上传为私有 GitHub Gist |
| `/reload` | 热重载快捷键、扩展、技能、模板 |
| `/hotkeys` | 显示所有快捷键 |
| `/quit` / `/exit` | 退出 |

---

## 记忆引擎

anta-agent 的核心增量是四层记忆（L0–L3）：

| 层 | 存储内容 | 位置 |
|---|---|---|
| L0 Conversation | 每一轮对话，完整保真 | SQLite + 每日 JSONL |
| L1 Atom | 结构化记忆：偏好、事件、指令、项目事实、任务、方法、产物 | SQLite |
| L2 Scenario | 叙事式场景块，整合相关记忆 | `scene_blocks/*.md` |
| L3 Core | 从场景中提炼的长期人格/行动方针 | `persona.md` |

**自动捕获**：完成的回合会被记录；每若干轮对话（或空闲超时）后，后台 pipeline 将其提炼为 L1 记忆，并做基于 LLM 的去重（可存储、更新、合并或跳过）。L2/L3 随记忆积累定期整合。pipeline 不阻塞你的对话。

**混合召回**：每次请求会把相关记忆以 `<relevant-memories>` 块注入用户消息，稳定的人格块追加到系统提示（保持供应商 prompt 缓存有效）。检索融合 SQLite FTS5 关键词评分与向量相似度（配置了 embedding 端点时），一次调用即可中英文通吃。

**始终可深入**：代理可随时调用 `memory_search` / `conversation_search` 挖掘历史；你也可以用 `/remember <文本>` 显式保存，用 `/memory` 查看状态。

**可关闭**：在 `~/.anta-agent/settings.json` 中配置即退化为纯代理，磁盘数据原样保留：

```json
{ "memory": { "enabled": false } }
```

### 记忆调优（`~/.anta-agent/memory.json`）

所有键均可选（括号内为默认值）：

```json
{
  "promptMode": "code",
  "capture": { "enabled": true },
  "extraction": { "enabled": true, "enableDedup": true },
  "pipeline": { "everyNConversations": 5, "l1IdleTimeoutSeconds": 600 },
  "recall": { "enabled": true, "strategy": "hybrid", "maxResults": 5, "scoreThreshold": 0.3 },
  "embedding": {
    "provider": "none",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

- `promptMode`：`"code"` 提炼工作记忆（事实/任务/方法/产物）；`"chat"` 提炼个人记忆（人格/情景/指令）。
- `embedding.provider`：`"none"` 时纯关键词召回，零 embedding 网络调用；`"openai"` 对任意 OpenAI 兼容 `/embeddings` 端点启用语义召回。embedding 失败时关键词召回仍可用。
- 优先通过供应商环境变量或外部密钥管理提供凭证，避免把 API key 写入 `memory.json`；保持 `~/.anta-agent` 仅当前用户可读。

### 记忆存储布局

```
~/.anta-agent/memory/
  memory.db        SQLite：对话、记忆、FTS + 向量索引
  conversations/   只追加的每日 JSONL（事实源）
  records/         每次记忆写入/更新/合并的审计记录
  scene_blocks/    L2 场景块 + scene_index.json
  persona.md       L3 人格/行动方针
  .backup/         persona 备份
  .metadata/       pipeline 断点（重启后恢复）
```

> 注意：记忆提炼使用你配置的模型并在后台消耗 token；提取、去重、场景整合、召回会把相关文本发送给该模型供应商。记忆内容按不可信引用数据处理，注入前会做净化与校验。

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 清空编辑器 |
| `Ctrl+C` × 2 | 退出 anta-agent |
| `Escape` | 取消/中止当前操作 |
| `Escape` × 2 | 打开 `/tree` 会话树 |
| `Ctrl+L` | 打开模型选择器 |
| `Ctrl+P` / `Shift+Ctrl+P` | 正向/反向循环切换模型 |
| `Shift+Tab` | 循环切换 thinking 级别 |
| `Ctrl+O` | 折叠/展开工具输出 |
| `Ctrl+T` | 折叠/展开 thinking 块 |

可通过 `~/.anta-agent/keybindings.json` 自定义。

---

## 消息队列

在 AI 工作时可以提前排队消息：

| 操作 | 说明 |
|------|------|
| `Enter` | 排队一条 **引导消息（steering）**，在当前 AI 回合工具调用完成后送达 |
| `Alt+Enter` | 排队一条 **后续消息（follow-up）**，在 AI 完成所有工作后送达 |
| `Escape` | 中止并恢复排队消息到编辑器 |
| `Alt+Up` | 将排队消息取回编辑器 |

---

## 会话管理

会话以 JSONL 文件存储在 `~/.anta-agent/sessions/`，按工作目录组织。

```bash
at -c                  # 继续最近的会话
at -r                  # 浏览并选择历史会话
at --no-session        # 临时模式（不保存会话）
at --session <路径>    # 使用特定会话文件
at --fork <路径>       # Fork 特定会话为新会话
```

---

## 分支与压缩

### 分支（Branching）

- **`/tree`** — 导航会话树，选择任意历史节点并从该处继续，所有历史保存在同一文件中
- **`/fork`** — 从当前分支创建全新会话文件

### 压缩（Compaction）

长时间会话可能耗尽上下文窗口。压缩会总结旧消息，保留近期消息。

- **手动压缩**：`/compact` 或 `/compact <自定义指令>`
- **自动压缩**：默认启用，在上下文溢出或接近上限时自动触发

压缩是有损的，但完整历史保留在 JSONL 文件中，可通过 `/tree` 回溯。

---

## 支持的供应商与模型

继承 pi 基座的全部供应商支持。

### 订阅方式（OAuth）

| 供应商 | 说明 |
|--------|------|
| Anthropic Claude Pro/Max | Claude 系列 |
| OpenAI ChatGPT Plus/Pro (Codex) | GPT 系列 |
| GitHub Copilot | 需在 VS Code 中启用对应模型 |
| Google Gemini CLI | Cloud Code Assist |
| Google Antigravity | 沙盒环境，包含 Gemini 3、Claude、GPT-OSS |

### API Key 方式

| 供应商 | 环境变量 |
|--------|----------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Kimi For Coding | `KIMI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |

也可将凭证存储在 `~/.anta-agent/auth.json` 中。

---

## 自定义与扩展

继承 pi 基座，几乎所有功能都可通过以下 4 种机制扩展：

### Prompt 模板

可复用的提示词模板，以 Markdown 文件形式存放。输入 `/模板名` 展开使用。

```markdown
<!-- ~/.anta-agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

**存放位置**：`~/.anta-agent/prompts/`（全局）或 `.anta-agent/prompts/`（项目级）

### Skills（技能）

遵循 [Agent Skills 标准](https://agentskills.io) 的按需加载能力包。在系统提示中仅包含描述，完整指令在需要时按需加载。

```markdown
<!-- ~/.anta-agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

**使用方式**：`/skill:技能名` 或让 AI 自动判断加载。

**存放位置**：
- 全局：`~/.anta-agent/skills/`、`~/.agents/skills/`
- 项目级：`.anta-agent/skills/`、`.agents/skills/`（会向上遍历父目录）

### Extensions（扩展）

TypeScript 模块，是最强大的扩展机制。可以：

- 注册 **自定义工具**（替换或增补内建工具）
- 注册 **自定义命令**（如 `/mycommand`）
- 拦截和修改 **事件**（工具调用、会话生命周期等）
- 构建 **自定义 UI**（编辑器、状态栏、对话框等）
- 实现 **权限控制**（危险命令确认、路径保护）
- 实现 **子代理（sub-agents）** 和 **计划模式（plan mode）**
- 自定义 **压缩逻辑**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

**存放位置**：`~/.anta-agent/extensions/`（全局）或 `.anta-agent/extensions/`（项目级）

> anta-agent 自身的记忆引擎就是以扩展形式实现的（`packages/anta-agent/src/anta-agent-extension.ts`），CLI 启动时自动加载。

### Themes（主题）

内建 `dark` 和 `light` 主题。自定义主题文件支持热重载。

**存放位置**：`~/.anta-agent/themes/`（全局）或 `.anta-agent/themes/`（项目级）

### Pi Packages（包管理）

将扩展、技能、模板、主题打包分享：

```bash
# 安装
at install npm:@foo/pi-tools
at install git:github.com/user/repo
at install https://github.com/user/repo

# 管理
at list                    # 列出已安装包
at update                  # 更新（跳过固定版本）
at remove npm:@foo/pi-tools   # 移除
at config                  # 启用/禁用资源
```

**创建包**：在 `package.json` 中添加 `pi` 字段：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

> ⚠️ **安全提示**：Pi 包拥有完整的系统访问权限。安装第三方包前请审查源代码。

---

## 编程式使用

### RPC 模式（非 Node.js 集成）

```bash
at --mode rpc
```

通过 stdin/stdout 使用 LF 分隔的 JSONL 协议通信。

### SDK（Node.js）

anta-agent 的 SDK 能力直接继承 pi 基座（`@earendil-works/pi-coding-agent`）：

```typescript
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.create(),
  modelRegistry: new ModelRegistry(authStorage),
});

await session.prompt("What files are in the current directory?");
```

`anta-agent` 包本身导出记忆引擎的配置解析 API（`parseAntaAgentConfig`、`loadAntaAgentConfigFile` 等）；CLI 启动时已自动附带记忆扩展。

---

## CLI 参考

### 基本用法

```bash
at [选项] [@文件...] [消息...]
```

### 运行模式

| 标志 | 说明 |
|------|------|
| （默认） | 交互模式 |
| `-p`, `--print` | 打印回复后退出 |
| `--mode json` | 以 JSON 行输出所有事件 |
| `--mode rpc` | RPC 模式 |
| `--export <输入> [输出]` | 导出会话为 HTML |

### 模型选项

| 选项 | 说明 |
|------|------|
| `--provider <名称>` | 指定供应商 |
| `--model <模式>` | 模型 ID（支持 `供应商/模型ID` 和 `模型:thinking级别`） |
| `--api-key <key>` | 覆盖环境变量中的 API key |
| `--thinking <级别>` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `--models <模式列表>` | 逗号分隔，用于 Ctrl+P 循环 |
| `--list-models [搜索]` | 列出可用模型 |

### 工具选项

| 选项 | 说明 |
|------|------|
| `--tools <列表>` | 启用特定内建工具（默认：`read,bash,edit,write`） |
| `--no-tools` | 禁用所有内建工具（扩展工具仍可用） |

可用内建工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`

### 文件参数

用 `@` 前缀传入文件：

```bash
at @prompt.md "Answer this"
at -p @screenshot.png "What's in this image?"
at @code.ts @test.ts "Review these files"
```

### 使用示例

```bash
# 交互模式 + 初始提示
at "List all .ts files in src/"

# 非交互模式
at -p "Summarize this codebase"

# 管道输入
cat README.md | at -p "Summarize this text"

# 使用 OpenAI 模型
at --model openai/gpt-4o "Help me refactor"

# 指定 thinking 级别
at --model sonnet:high "Solve this complex problem"

# 只读模式
at --tools read,grep,find,ls -p "Review the code"
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTA-AGENT_CODING_AGENT_DIR` | 覆盖配置目录（默认 `~/.anta-agent`） |
| `ANTA-AGENT_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录 |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的版本检查（继承自 pi 基座） |
| `PI_CACHE_RETENTION` | 设为 `long` 延长 prompt 缓存（Anthropic: 1h, OpenAI: 24h） |
| `VISUAL` / `EDITOR` | 外部编辑器（Ctrl+G） |

---

## 设计哲学

继承自 pi 基座：**极致的可扩展性**，核心保持精简：

| 理念 | 实现方式 |
|------|----------|
| **无 MCP** | 用 CLI 工具 + README（即 Skills），或用扩展实现 MCP 支持 |
| **无子代理** | 通过 tmux 启动多个实例，或用扩展实现 |
| **无权限弹窗** | 在容器中运行，或用扩展自定义确认流程 |
| **无计划模式** | 将计划写入文件，或用扩展实现 |
| **无内建 TODO** | 使用 TODO.md 文件，或用扩展实现 |
| **无后台 bash** | 使用 tmux，保持完全可观察性 |

> pi 不把功能硬编码进去，而是让你用扩展、技能、包来组装你自己的工作流。anta-agent 的四层记忆正是这一理念的体现：一个自动加载的扩展。

---

## 配置文件位置

| 文件 | 作用域 | 路径 |
|------|--------|------|
| 全局设置 | 所有项目 | `~/.anta-agent/settings.json` |
| 项目设置 | 当前项目 | `.anta-agent/settings.json` |
| 记忆开关 | 全局 | `~/.anta-agent/settings.json`（`memory.enabled`） |
| 记忆调优 | 全局 | `~/.anta-agent/memory.json` |
| 系统提示（替换） | 项目/全局 | `.anta-agent/SYSTEM.md` 或 `~/.anta-agent/SYSTEM.md` |
| 系统提示（追加） | 项目/全局 | `APPEND_SYSTEM.md` |
| 上下文文件 | 自动加载 | `AGENTS.md` 或 `CLAUDE.md`（当前目录及父目录） |
| 认证信息 | 全局 | `~/.anta-agent/auth.json` |
| 快捷键 | 全局 | `~/.anta-agent/keybindings.json` |
| 记忆存储 | 全局 | `~/.anta-agent/memory/` |

---

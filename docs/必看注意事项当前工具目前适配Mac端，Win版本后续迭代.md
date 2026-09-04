# 注意事项

这个工具目前适配Mac端，Win版本后续迭代，可以把这个当成轻量级的Claude code，使用方法和Claude code类似。

仓库地址 https://github.com/qqlcx5/pi-memony

## 1. 快速开始
```bash
# 安装 Node ≥ 22.19 后
npm install -g anta-agent
at

# 第一次使用配置模型
/login
Sign in with an Aanta agent key  // 选择模型
deepseek // 输入密钥

# 显式存入一条长期记忆
/remember 这个项目使用 JSONL 作为事实源，SQLite 是可重建投影

# 查看状态 / 跳转会话树
/memory
/tree
```

## 产品能力面

| 能力 | 具体内容 |
|---|---|
| 模型 | 40 家 provider（Anthroanta agentc/OpenAI/Google/Bedrock…），支持订阅 OAuth（Claude Pro/ChatGPT Plus/Coanta agentlot 等）与本地模型（llama.cpp/MLX/Ollama） |
| 工具 | `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`（Windows 另有原生 `powershell`） |
| 交互 | TUI：会话树 `/tree` 跳转、`/fork`、`/compact` 分支压缩、消息排队 steering；中文状态栏实时显示 token / 缓存命中 / 费用 / 上下文占用（`anta-agent-extension.ts` 的 `createChineseFooter`） |
| 模式 | interactive / print / JSON / RPC / SDK 五种 |
| 扩展 | TS 模块完整扩展 Aanta agent（约 30 事件 + 注册工具/命令/快捷键/主题），热重载；Skills、Prompt 模板、主题 |
| **记忆** | `/remember` 显式存、`/memory` 看状态、`memory_search` + `conversation_search` 两个内置工具；数据独立住 `~/.anta-agent` |



核实完了本地源码。下面是补全版，重点补上**架构解剖、Harness 坐标系对照、反方批评、你这份仓库的现状**。



## Harness 6 件套对照

把 Agent 外壳拆成 6 个组件，看各家怎么实现：

| 组件 | Claude Code | Codex | **anta agent** |
|---|---|---|---|
| Rule 软约束 | `settings.json` + 防火墙 | `environment.toml` + sandbox policy | `AGENTS.md` / `SYSTEM.md`，靠容器而非弹窗 |
| Skill 知识包 | plugins 自带 | skills 当 sub-agent orchestrator | `.anta agent/skills/*.md`，按需加载 |
| Sub-Agent | plugin 一等公民 | **内核**（MultiAgentV2 + Scientist 命名空间） | 不内置，tmux 或自己写扩展 |
| Workflow 状态机 | 无内置，靠 GH Actions | **内核**（CodexThread↔TurnContext 三层栈） | 不内置，扩展实现 |
| Script 门控 | `PreToolUse` hook（stdout 协议） | approval-mirror | 不内置，扩展或 CI |
| MCP | plugin 一等公民 | **内核** crate | 不内置（`mcporter` 桥接或自写扩展） |
| 扩展点形态 | shell/python + stdout | Rust 函数 | **TypeScript 完整模块 + 运行时注入** |


## 硬指标对比

| | anta agent | Claude Code | Codex | Cline |
|---|---|---|---|---|
| 系统提示 | **~1K tokens** | ~10-15K | 中 | ~8-12K |
| 模型 | 自选，**40 provider**，可用 Claude Pro/ChatGPT Plus/Coanta agentlot 订阅 OAuth | Anthroanta agentc only | OpenAI only | 自选 |
| 本地模型 | 原生（llama.cpp/MLX/Ollama） | 否 | 否 | 支持 |
| 形态 | 终端 TUI | 终端 + IDE 插件 | CLI + 桌面 + VS Code | VS Code 扩展 |
| 安全边界 | 无内置权限系统，靠容器 | 逐动作 + 沙箱 | seatbelt/bwrap/Landlock | 逐动作审批 |
| 许可证 | MIT | 闭源 | Apache-2.0 | Apache-2.0 |

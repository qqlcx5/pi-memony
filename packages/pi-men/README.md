# @earendil-works/pi-men

Local four-layer agent memory engine for pi, modeled on the TencentDB-Agent-Memory design:

- **L0 Conversation** — full-fidelity raw turns persisted to SQLite plus append-only daily JSONL files.
- **L1 Atom** — structured atomic memories (`persona` / `episodic` / `instruction`, plus `work_fact` / `work_task` / `work_method` / `work_artifact` in code mode) distilled from conversations by an async LLM pipeline with batch dedup/conflict resolution (`store` / `update` / `merge` / `skip`).
- **L2 Scenario** — narrative scene blocks (`scene_blocks/*.md`) consolidated from L1 memories with heat/summary metadata.
- **L3 Core** — a long-term persona (chat mode) or operating doctrine (code mode) regenerated incrementally as scenes evolve.

Recall is hybrid: FTS5 BM25 (trigram tokenizer, CJK-friendly) and — when an embedding endpoint is configured — cosine vector search, fused with reciprocal rank fusion. Injected context is split into a stable, cacheable system-prompt block (`<user-persona>`, `<scene-navigation>`, `<memory-tools-guide>`) and a dynamic `<relevant-memories>` prefix on the user message so prompt caches stay valid.

## Storage

Everything lives under one data directory (default `~/.pi/agent/memory`):

```
memory.db                  SQLite (node:sqlite): records, conversations, FTS, vectors
conversations/YYYY-MM-DD.jsonl
records/YYYY-MM-DD.jsonl   append-only audit of every write/merge
scene_blocks/*.md          L2 scene blocks + scene_index.json
persona.md                 L3 persona / operating doctrine (.backup/ rotations)
.metadata/checkpoint.json  pipeline scheduling state
```

## Configuration

`~/.pi/agent/memory.json` (all keys optional):

```json
{
  "promptMode": "code",
  "pipeline": { "everyNConversations": 5, "l1IdleTimeoutSeconds": 600 },
  "recall": { "strategy": "hybrid", "maxResults": 5, "scoreThreshold": 0.3 },
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

With no embedding provider configured, recall degrades to keyword search only and never makes network calls.

## Library use

```ts
import { PiMen } from "@earendil-works/pi-men";

const memory = new PiMen({
	runner: async ({ systemPrompt, userPrompt }) => callYourLlm(systemPrompt, userPrompt),
	config: { dataDir: "./memory" },
});
await memory.initialize();
await memory.capture({ sessionKey: "s1", messages: turns });
const recall = await memory.recall(userText);
```

The package has zero runtime dependencies (Node's built-in `node:sqlite`) and can be embedded by any host.

## In pi

The coding-agent wires this engine in as a built-in extension in every run mode (TUI, RPC, print, JSON, SDK). It adds `memory_search` and `conversation_search` tools plus `/remember <text>` and `/memory` commands. Disable it with `memory.enabled: false` in `~/.pi/agent/settings.json`.

### Manual acceptance checklist

About five minutes, from the repo root with `./pi-test.sh`.

1. **Auto-capture.** Chat for one or two turns, then run `/memory`. `L0 conversations` should have gone up. L1 extraction is async: the warmup schedule fires the first pass after a single captured turn (then 2, then 4, then `everyNConversations`), so wait a few seconds and re-run `/memory` to see `L1 memories` and `last extraction (L1)` populate.
2. **Manual memory.** Run `/remember I prefer tabs for indentation`. Start a fresh session (quit and re-launch `./pi-test.sh`, or `/new` in the TUI) and ask "what is my indentation preference?" — the answer should come from the injected `<relevant-memories>` block.
3. **Tools.** Ask the agent to "search my memory for …" and watch it call `memory_search` (`conversation_search` searches raw L0 transcripts).
4. **On-disk state.** Inspect `~/.pi/agent/memory/` (`$PI_CODING_AGENT_DIR/memory` when set): `memory.db`, `conversations/*.jsonl`, `records/*.jsonl`. `scene_blocks/` appears after the first L2 pass (10s after L1); `persona.md` only after an L3 pass, which by default needs 50 new memories (`persona.triggerEveryN`). Neither shows up in the first few minutes.
5. **Kill switch.** Add `"memory": { "enabled": false }` to `~/.pi/agent/settings.json` and restart. `/memory`, `/remember`, and both tools disappear, and nothing is written to disk.
6. **Optional — semantic recall.** Configure the `embedding` block in `~/.pi/agent/memory.json` to turn on vector recall. Without it, recall is keyword-only (SQLite FTS5) and makes no network requests.

Extraction uses the model from your current session and spends real tokens, so step 1 needs a working provider key. The automated tests drive the same pipeline with the faux provider instead.

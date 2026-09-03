# anta-agent

A coding agent with built-in four-layer memory, built on the [pi](https://github.com/earendil-works/pi) base.

`anta-agent` works exactly like `pi` — same interaction, same commands, same modes — plus a memory engine that captures your conversations and work, distills them into reusable memory, and re-injects the relevant parts into future sessions. The more you use it, the less you have to re-explain yourself.

## Quick start

```bash
npm install -g anta-agent
at                 # first run asks you to configure a model/API key, like pi
```

All data lives in `~/.anta-agent`, independent of any existing pi installation.

## What you get

### A full coding agent

anta-agent inherits the complete pi base: multi-provider models (Anthropic, OpenAI, Google, Bedrock, and more, plus a built-in llama.cpp provider for local models), the standard tool set (read, bash, edit, write, grep, find, ls), interactive TUI with session tree and compaction, print/RPC/JSON modes for scripting, an extension API, skills, prompt templates, and themes.

### Four-layer memory (the anta-agent part)

| Layer | What it stores | Where |
|---|---|---|
| L0 Conversation | every turn, full fidelity | SQLite + daily JSONL |
| L1 Atom | structured memories: preferences, events, instructions, project facts, tasks, methods, artifacts | SQLite |
| L2 Scenario | narrative scene blocks that consolidate related memories | `scene_blocks/*.md` |
| L3 Core | a long-term persona / operating doctrine distilled from scenes | `persona.md` |

**Capture is automatic.** Finished turns are recorded, and every few turns (or after an idle timeout) a background pipeline distills them into L1 memories — with LLM-based deduplication that can store, update, merge, or skip against what it already knows. L2 and L3 consolidate periodically as new memories accumulate. The pipeline never blocks your turns.

**Recall is hybrid and cache-friendly.** Each request gets the relevant memories injected as a `<relevant-memories>` block on the user message, while a stable persona block is appended to the system prompt (so provider prompt caches stay valid). Search fuses SQLite FTS5 keyword scoring with vector similarity (when an embedding endpoint is configured) using reciprocal rank fusion; it works in one language-agnostic shot — Chinese and English both covered.

**You can always dig deeper** with two built-in tools the agent can call: `memory_search` (structured memories) and `conversation_search` (raw past conversations). Or save something explicitly with `/remember <text>`; `/memory` shows store status.

**It is optional.** Disable memory with one setting and anta-agent behaves as a plain agent; the store stays on disk untouched.

## Commands and tools

| Item | Type | Purpose |
|---|---|---|
| `/remember <text>` | command | save a long-term memory right now |
| `/memory` | command | show memory store status (counts, last pipeline runs) |
| `memory_search` | tool | agent searches structured memories (L1) |
| `conversation_search` | tool | agent searches raw past conversations (L0) |

## Storage

```
~/.anta-agent/
  auth.json          provider credentials
  settings.json      settings (pi format)
  sessions/          session transcripts
  memory/
    memory.db        SQLite: conversations, memories, FTS + vector indexes
    conversations/   append-only daily JSONL (source of truth)
    records/         append-only audit of every memory write/update/merge
    scene_blocks/    L2 scene blocks + scene_index.json
    persona.md       L3 persona / operating doctrine
    .backup/         persona backups
    .metadata/       pipeline checkpoint (survives restarts)
```

## Configuration

Disable memory in `~/.anta-agent/settings.json`:

```json
{ "memory": { "enabled": false } }
```

Tune the engine in `~/.anta-agent/memory.json` (all keys optional; defaults shown):

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
    "apiKey": "sk-...",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

- `promptMode`: `"code"` extracts work memories (facts / tasks / methods / artifacts); `"chat"` extracts personal memories (persona / episodic / instructions).
- `embedding.provider`: `"none"` keeps recall keyword-only with zero network calls; `"openai"` enables semantic recall against any OpenAI-compatible `/embeddings` endpoint.

## Notes

- Memory distillation uses your configured model and consumes tokens in the background. If you want the agent without the cost, set `memory.enabled: false` or `extraction.enabled: false`.
- Memory data never leaves your machine; the only network calls are to your model/embedding providers.

## License

MIT — see [LICENSE](./LICENSE). Built on [pi](https://github.com/earendil-works/pi) by Earendil Works.

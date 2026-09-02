# pi-men

A coding agent with built-in four-layer memory, built on the [pi](https://github.com/earendil-works/pi) base.

`pi-men` works exactly like `pi` — same commands, same modes, same configuration surface — plus a memory engine that captures your conversations and work, distills them into reusable memory, and re-injects the relevant parts into future sessions.

## Install

```bash
npm install -g pi-men
pi-men
```

## Memory

Memory is on by default. Nothing to configure; a few things to know:

- **Capture**: every finished turn is recorded and, every few turns (or after idle), distilled by the model into atomic memories — preferences, events, instructions, project facts, tasks, methods, artifacts.
- **Scenes & persona**: memories are consolidated into narrative scene blocks, and a long-term persona / operating doctrine evolves over time.
- **Recall**: relevant memories are injected into each request; `memory_search` and `conversation_search` tools let the agent dig deeper. A stable persona block is appended to the system prompt (cache-friendly).
- **Commands**: `/remember <text>` saves a memory manually, `/memory` shows store status.

## Storage

Everything lives under `~/.pi-men` (the standard pi agent directory layout):

```
~/.pi-men/
  auth.json          provider credentials
  settings.json      settings
  sessions/          session transcripts
  memory/            memory store
    memory.db        SQLite: conversations, memories, search indexes
    conversations/   append-only daily JSONL (source of truth)
    records/         append-only audit of memory writes/merges
    scene_blocks/    L2 scene blocks
    persona.md       L3 persona / operating doctrine
    .metadata/       pipeline checkpoint
```

## Configuration

Disable memory in `~/.pi-men/settings.json`:

```json
{ "memory": { "enabled": false } }
```

Tune the engine in `~/.pi-men/memory.json` (all keys optional):

```json
{
  "promptMode": "code",
  "recall": { "strategy": "hybrid", "maxResults": 5 },
  "embedding": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

With no embedding provider configured, recall is keyword-only (SQLite FTS5) and makes no network calls.

## License

MIT — see [LICENSE](./LICENSE). Built on [pi](https://github.com/earendil-works/pi).

# Changelog

## [Unreleased]

### Added

- New `@earendil-works/pi-men` package: local four-layer agent memory engine with L0 conversation recording, L1 atomic memory extraction (LLM-based with batch dedup/conflict resolution), L2 scene blocks, L3 persona generation, and hybrid recall (FTS5 BM25 + optional vector search fused with RRF).

### Fixed

- L3 persona generation never ran: `runL3`'s re-entrancy guard rejected the pipeline-internal trigger because L1/L2 already held the run lock. The trigger counter is also no longer reset when no changed scenes exist yet, so memories are not lost before L2 consolidates them.
- L1 no longer silently skips messages: oversized batches are split into char-bounded chunks (each extracted), and the (timestamp, id) cursor advances only over processed chunks, so neither the old char-trim nor a same-millisecond LIMIT boundary can drop messages. L2 uses the same (updated_time, id) watermark and walks backlogs of any size across chunks instead of skipping everything past the first 40 records.
- Recall injects at most `recall.maxResults` memories (the oversized fusion pool no longer leaks into the injected block).
- An embedding-endpoint failure no longer kills the whole recall: keyword results and the stable persona/scene block still inject (strategy `embedding` falls back to keyword on embed errors).
- Warmup schedule now converges on `everyNConversations` (1→2→4→N) instead of freezing on 4.
- Unparsable dedup output now degrades to storing all candidates (as documented) instead of aborting the whole L1 pass; a malformed update/merge decision (missing `merged_content`/`merged_type`) degrades to a plain store; an omitted `merged_priority` falls back to the candidate's own priority instead of resetting it to 50.
- A merge into a record already rewritten by an earlier decision in the same batch degrades to a new record instead of clobbering that content; merged records now take the candidate's scene.
- `capture.l0RetentionDays` is now applied on `initialize()`: expired L0 rows are deleted and JSONL day files fully past the cutoff are pruned.
- The L0 JSONL audit trail no longer receives duplicate lines when a turn is replayed; only rows actually inserted by SQLite are appended.
- `conversation_search` LIKE fallback now honors the `sessionKey` filter, matching the FTS path, and results keep their relevance order.
- `maxMemoriesPerSession` now caps extraction across all scenes instead of per scene.
- Updated/merged L1 records no longer keep vectors of their pre-merge content when re-embedding fails, and a background backfill can no longer resurrect a stale vector.
- Recall timeouts no longer leave an unreferenced timer keeping the process alive; vector backfill runs in the background so `initialize()` does not delay the first recall.
- `scene_index.json` is written atomically and rebuilt from the META headers inside the scene blocks when lost or corrupt; scene_blocks are snapshotted under `.backup/scene_blocks/` (default 10) before each L2 pass.
- Persona content injected into `<user-persona>` escapes any literal closing tag so conversation-derived text cannot break out of the block; per-memory truncation cuts on code points and marks the truncation.

### Changed

- `persona.sceneBackupCount` config (default 10) controls the scene-block backup rotation.

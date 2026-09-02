import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiMenConfig } from "../src/config.ts";
import { ConversationRecorder } from "../src/core/l0/recorder.ts";
import { buildCandidateMatches, dedupMemories } from "../src/core/l1/dedup.ts";
import { extractMemories } from "../src/core/l1/extractor.ts";
import { MemoryWriter } from "../src/core/l1/writer.ts";
import { generatePersona, writePersona } from "../src/core/persona/persona-generator.ts";
import { PipelineManager } from "../src/core/pipeline/manager.ts";
import { extractScenes, parseSceneOps } from "../src/core/scene/scene-extractor.ts";
import { applySceneOps, readSceneIndex } from "../src/core/scene/scene-store.ts";
import { storagePaths } from "../src/core/storage/paths.ts";
import { createEmbeddingService } from "../src/core/store/embedding.ts";
import { rrfFuse } from "../src/core/store/hybrid-search.ts";
import { SqliteMemoryStore } from "../src/core/store/sqlite-store.ts";
import type { LlmRunner, MemoryRecord } from "../src/types.ts";

async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const now = new Date().toISOString();
	return {
		id: `m_${Math.random().toString(36).slice(2, 10)}`,
		content: "test memory",
		type: "persona",
		priority: 80,
		sceneName: "scene",
		sourceMessageIds: [],
		metadata: {},
		timestamps: [now],
		createdAt: now,
		updatedAt: now,
		version: 1,
		sessionKey: "s1",
		...overrides,
	};
}

/** Scripted runner: dispatches on the system prompt family, records calls. */
function scriptedRunner(responses: { match: RegExp; body: () => string }[]): {
	runner: LlmRunner;
	calls: () => string[];
} {
	const seen: string[] = [];
	const runner: LlmRunner = async (params) => {
		seen.push(params.systemPrompt.slice(0, 40));
		const entry = responses.find((candidate) => candidate.match.test(params.systemPrompt));
		if (!entry) throw new Error(`unexpected LLM call: ${params.systemPrompt.slice(0, 60)}`);
		return entry.body();
	};
	return { runner, calls: () => seen };
}

describe("rrfFuse", () => {
	it("fuses keyword and vector rankings, rewarding agreement", () => {
		const fused = rrfFuse(["a", "b", "c"], ["b", "a", "d"], 4);
		expect(fused.map((hit) => hit.id).slice(0, 2)).toEqual(["a", "b"]);
		expect(fused[0]!.keywordRank).toBe(1);
		expect(fused[0]!.vectorRank).toBe(2);
	});

	it("respects the limit", () => {
		expect(rrfFuse(["a", "b", "c"], [], 2)).toHaveLength(2);
	});
});

describe("extractMemories", () => {
	const config = parsePiMenConfig({ promptMode: "code" });

	it("parses scene segmentation and validates candidates", async () => {
		const { runner } = scriptedRunner([
			{
				match: /情境切分/,
				body: () =>
					JSON.stringify([
						{
							scene_name: "正在围绕 pi-men 推进存储层开发",
							message_ids: ["m1", "m2"],
							memories: [
								{
									content: "用户决定 pi-men 使用 node:sqlite 做存储",
									type: "work_fact",
									priority: 90,
									source_message_ids: ["m1"],
									metadata: {},
								},
								{ content: "", type: "work_fact", priority: 90, source_message_ids: [], metadata: {} },
								{ content: "bad type", type: "nonsense", priority: 90, source_message_ids: [], metadata: {} },
							],
						},
					]),
			},
		]);
		const scenes = await extractMemories(runner, config, {
			newMessages: [
				{ id: "m1", role: "user", content: "用 node:sqlite 吧", timestamp: Date.now() },
				{ id: "m2", role: "assistant", content: "好的", timestamp: Date.now() },
			],
		});
		expect(scenes).toHaveLength(1);
		expect(scenes[0]!.sceneName).toContain("pi-men");
		expect(scenes[0]!.memories).toHaveLength(1);
		expect(scenes[0]!.memories[0]!.recordId).toMatch(/^nm_/);
		expect(scenes[0]!.memories[0]!.priority).toBe(90);
	});

	it("tolerates code fences and prose around the JSON", async () => {
		const { runner } = scriptedRunner([
			{
				match: /情境切分/,
				body: () =>
					'Here you go:\n```json\n[{"scene_name":"s","message_ids":[],"memories":[{"content":"用户偏好深色主题","type":"persona","priority":75,"source_message_ids":[],"metadata":{}}]}]\n```',
			},
		]);
		const scenes = await extractMemories(runner, config, {
			newMessages: [{ id: "m1", role: "user", content: "我喜欢深色主题", timestamp: Date.now() }],
		});
		expect(scenes[0]!.memories[0]!.content).toContain("深色主题");
	});

	it("clamps priorities into [-1, 100]", async () => {
		const { runner } = scriptedRunner([
			{
				match: /情境切分/,
				body: () =>
					JSON.stringify([
						{
							scene_name: "s",
							message_ids: [],
							memories: [
								{ content: "a", type: "instruction", priority: 999, source_message_ids: [], metadata: {} },
								{ content: "b", type: "episodic", priority: -50, source_message_ids: [], metadata: {} },
							],
						},
					]),
			},
		]);
		const scenes = await extractMemories(runner, config, {
			newMessages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
		});
		expect(scenes[0]!.memories.map((memory) => memory.priority)).toEqual([100, 0]);
	});
	it("caps memories across scenes at maxMemoriesPerSession", async () => {
		const config = parsePiMenConfig({ promptMode: "code", extraction: { maxMemoriesPerSession: 3 } });
		const memory = {
			content: "x",
			type: "work_fact",
			priority: 80,
			source_message_ids: [],
			metadata: {},
		};
		const { runner } = scriptedRunner([
			{
				match: /情境切分/,
				body: () =>
					JSON.stringify([
						{ scene_name: "s1", message_ids: [], memories: [{ ...memory }, { ...memory }] },
						{ scene_name: "s2", message_ids: [], memories: [{ ...memory }, { ...memory }] },
					]),
			},
		]);
		const scenes = await extractMemories(runner, config, {
			newMessages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
		});
		expect(scenes.map((scene) => scene.memories.length)).toEqual([2, 1]);
	});
});

describe("dedupMemories", () => {
	it("parses batch decisions and defaults undecided candidates to store", async () => {
		const config = parsePiMenConfig({ promptMode: "chat" });
		const { runner } = scriptedRunner([
			{
				match: /冲突检测/,
				body: () =>
					JSON.stringify([
						{
							record_id: "nm-1",
							action: "merge",
							target_ids: ["old-1"],
							merged_content: "merged content",
							merged_type: "persona",
							merged_priority: 85,
							merged_timestamps: ["2026-01-01T00:00:00.000Z"],
						},
						{ record_id: "nm-unknown", action: "skip", target_ids: [] },
					]),
			},
		]);
		const store = new SqliteMemoryStore(join(tmpdir(), `pi-men-dedup-${Date.now()}.db`));
		store.insertMemory({
			id: "old-1",
			content: "old",
			type: "persona",
			priority: 70,
			sceneName: "s",
			sourceMessageIds: [],
			metadata: {},
			timestamps: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			version: 1,
			sessionKey: "s",
		});
		const extracted = [
			{
				recordId: "nm-1",
				content: "old-ish new",
				type: "persona" as const,
				priority: 70,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
			{
				recordId: "nm-2",
				content: "totally fresh fact about TypeScript compilers",
				type: "work_fact" as const,
				priority: 80,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
		];
		const matches = buildCandidateMatches(extracted, store);
		const decisions = await dedupMemories({ runner, config, matches });
		const byId = new Map(decisions.map((decision) => [decision.recordId, decision]));
		expect(byId.get("nm-1")?.action).toBe("merge");
		expect(byId.get("nm-1")?.mergedContent).toBe("merged content");
		expect(byId.get("nm-2")?.action).toBe("store");
		store.close();
	});

	it("degrades to store-all when the dedup output is unparsable", async () => {
		const config = parsePiMenConfig({ promptMode: "chat" });
		const { runner } = scriptedRunner([{ match: /冲突检测/, body: () => "抱歉，我无法输出 JSON。" }]);
		const store = new SqliteMemoryStore(join(tmpdir(), `pi-men-dedup-degrade-${Date.now()}.db`));
		const extracted = [
			{
				recordId: "nm-1",
				content: "some fresh fact",
				type: "persona" as const,
				priority: 70,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
		];
		const decisions = await dedupMemories({ runner, config, matches: buildCandidateMatches(extracted, store) });
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.action).toBe("store");
		store.close();
	});

	it("falls back to the candidate priority when merged_priority is omitted", async () => {
		const config = parsePiMenConfig({ promptMode: "chat" });
		const { runner } = scriptedRunner([
			{
				match: /冲突检测/,
				body: () =>
					JSON.stringify([
						{
							record_id: "nm-1",
							action: "update",
							target_ids: ["old-1"],
							merged_content: "updated fact",
							merged_type: "persona",
						},
					]),
			},
		]);
		const store = new SqliteMemoryStore(join(tmpdir(), `pi-men-dedup-prio-${Date.now()}.db`));
		const extracted = [
			{
				recordId: "nm-1",
				content: "candidate fact",
				type: "persona" as const,
				priority: 95,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
		];
		const decisions = await dedupMemories({ runner, config, matches: buildCandidateMatches(extracted, store) });
		expect(decisions[0]!.action).toBe("update");
		expect(decisions[0]!.mergedPriority).toBe(95);
		store.close();
	});

	it("degrades a malformed update decision to store instead of dropping the candidate", async () => {
		const config = parsePiMenConfig({ promptMode: "chat" });
		const { runner } = scriptedRunner([
			{
				match: /冲突检测/,
				body: () => JSON.stringify([{ record_id: "nm-1", action: "update", target_ids: ["old-1"] }]),
			},
		]);
		const store = new SqliteMemoryStore(join(tmpdir(), `pi-men-dedup-malformed-${Date.now()}.db`));
		const extracted = [
			{
				recordId: "nm-1",
				content: "candidate fact",
				type: "persona" as const,
				priority: 80,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
		];
		const decisions = await dedupMemories({ runner, config, matches: buildCandidateMatches(extracted, store) });
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.action).toBe("store");
		expect(decisions[0]!.targetIds).toEqual([]);
		store.close();
	});
});

describe("scene extraction", () => {
	it("applies create/update/delete ops and rebuilds the index", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-men-scene-"));
		const paths = storagePaths(dir);
		const config = parsePiMenConfig({ dataDir: dir });
		const { runner } = scriptedRunner([
			{
				match: /Memory Consolidation Architect/,
				body: () =>
					JSON.stringify([
						{
							action: "create",
							file: "技术研究 pi-men.md",
							summary: "pi-men 记忆系统开发",
							heat: 1,
							content:
								"-----META-START-----\ncreated: now\nupdated: now\nsummary: pi-men 记忆系统开发\nheat: 1\n-----META-END-----\n\n## 核心特征\n本地 SQLite 存储方案。",
						},
					]),
			},
		]);
		const memories = [
			{
				id: "m1",
				content: "pi-men 使用本地 SQLite",
				type: "work_fact" as const,
				priority: 80,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
				timestamps: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				version: 1,
				sessionKey: "s",
			},
		];
		const result = await extractScenes({ runner, config, paths, memories, existingIndex: [] });
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.file).toBe("技术研究-pi-men.md");
		expect(existsSync(join(paths.sceneBlocksDir, "技术研究-pi-men.md"))).toBe(true);
		expect(readSceneIndex(paths)).toHaveLength(1);

		const ops = parseSceneOps(JSON.stringify([{ action: "delete", file: "技术研究-pi-men.md" }]));
		const after = applySceneOps(paths, ops);
		expect(after).toHaveLength(0);
		expect(existsSync(join(paths.sceneBlocksDir, "技术研究-pi-men.md"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("rebuilds a corrupt scene index from META headers", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-men-scene-rebuild-"));
		const paths = storagePaths(dir);
		mkdirSync(paths.sceneBlocksDir, { recursive: true });
		writeFileSync(
			join(paths.sceneBlocksDir, "rebuilt.md"),
			"-----META-START-----\ncreated: c1\nupdated: u1\nsummary: 重建摘要\nheat: 7\n-----META-END-----\n\n正文",
		);
		writeFileSync(paths.sceneIndexFile, "{corrupt json");
		const entries = readSceneIndex(paths);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ file: "rebuilt.md", summary: "重建摘要", heat: 7 });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("persona generation", () => {
	it("generates on first run and writes persona.md with backups", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-men-persona-"));
		const paths = storagePaths(dir);
		const config = parsePiMenConfig({ dataDir: dir, promptMode: "chat" });
		let first = true;
		const { runner } = scriptedRunner([
			{
				match: /Persona Architect/,
				body: () =>
					first ? "# User Narrative Profile\n\nfirst persona" : "# User Narrative Profile\n\nupdated persona",
			},
		]);
		const entries = [{ file: "a.md", summary: "s", heat: 1, createdAt: "now", updatedAt: "now" }];

		const firstResult = await generatePersona({
			runner,
			config,
			existingPersona: null,
			changedScenes: entries,
			paths,
			totalMemories: 10,
		});
		expect(firstResult.mode).toBe("first");
		expect(firstResult.content).toContain("first persona");

		writePersona(paths, firstResult.content!, config.persona.backupCount);
		first = false;
		const second = await generatePersona({
			runner,
			config,
			existingPersona: readFileSync(paths.personaFile, "utf8"),
			changedScenes: entries,
			paths,
			totalMemories: 20,
		});
		expect(second.mode).toBe("incremental");
		writePersona(paths, second.content!, config.persona.backupCount);
		expect(readFileSync(paths.personaFile, "utf8")).toContain("updated persona");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("PipelineManager scheduling", () => {
	function makeManager(config: ReturnType<typeof parsePiMenConfig>, runner: LlmRunner) {
		const dir = mkdtempSync(join(tmpdir(), "pi-men-manager-"));
		const paths = storagePaths(dir);
		const store = new SqliteMemoryStore(paths.db);
		const recorder = new ConversationRecorder(store, paths);
		const writer = new MemoryWriter(store, paths, createEmbeddingService(config.embedding));
		const manager = new PipelineManager({ config, paths, store, recorder, writer, runner });
		return { paths, store, recorder, manager, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
	}

	it("fires L1 at warmup thresholds 1,2,4 then converges on everyNConversations", async () => {
		const config = parsePiMenConfig({
			pipeline: { everyNConversations: 5, l1IdleTimeoutSeconds: 600, l2DelayAfterL1Seconds: 86400 },
			extraction: { enableDedup: false },
			persona: { triggerEveryN: 1000 },
		});
		let extractions = 0;
		const runner: LlmRunner = async (params) => {
			if (/情境切分/.test(params.systemPrompt)) {
				extractions += 1;
				return JSON.stringify([
					{
						scene_name: "s",
						message_ids: [],
						memories: [
							{
								content: `fact ${extractions}`,
								type: "work_fact",
								priority: 80,
								source_message_ids: [],
								metadata: {},
							},
						],
					},
				]);
			}
			throw new Error(`unexpected LLM call: ${params.systemPrompt.slice(0, 40)}`);
		};
		const { store, recorder, manager, cleanup } = makeManager(config, runner);
		try {
			// Warmup schedule 1→2→4, then the steady everyNConversations (5).
			const groups = [1, 2, 4, 5, 5];
			let sent = 0;
			for (let g = 0; g < groups.length; g++) {
				for (let i = 0; i < groups[g]!; i++) {
					sent += 1;
					await recorder.record({
						sessionKey: "s",
						messages: [{ id: "", role: "user", content: `message ${sent}`, timestamp: Date.now() }],
					});
					manager.notifyTurn();
				}
				await waitFor(() => manager.state.conversationsSinceL1 === 0 && manager.state.lastL1At !== null);
				expect(extractions).toBe(g + 1);
			}
		} finally {
			await manager.destroy();
			store.close();
			cleanup();
		}
	}, 20000);

	it("runs L2 after L1 and generates the persona when the L3 trigger fires", async () => {
		const config = parsePiMenConfig({
			pipeline: { l1IdleTimeoutSeconds: 600, l2DelayAfterL1Seconds: 86400, l2MinIntervalSeconds: 0 },
			extraction: { enableDedup: false },
			persona: { triggerEveryN: 1 },
		});
		const runner: LlmRunner = async (params) => {
			if (/情境切分/.test(params.systemPrompt)) {
				return JSON.stringify([
					{
						scene_name: "s",
						message_ids: [],
						memories: [
							{
								content: "用户偏好深色主题",
								type: "persona",
								priority: 80,
								source_message_ids: [],
								metadata: {},
							},
						],
					},
				]);
			}
			if (/Memory Consolidation Architect/.test(params.systemPrompt)) {
				return JSON.stringify([
					{
						action: "create",
						file: "偏好.md",
						summary: "用户界面偏好",
						heat: 1,
						content:
							"-----META-START-----\ncreated: now\nupdated: now\nsummary: 用户界面偏好\nheat: 1\n-----META-END-----\n\n用户偏好深色主题。",
					},
				]);
			}
			if (/Operating Doctrine/.test(params.systemPrompt)) {
				return "# Operating Doctrine\n\n- 界面相关默认按用户深色主题偏好执行。";
			}
			throw new Error(`unexpected LLM call: ${params.systemPrompt.slice(0, 40)}`);
		};
		const { paths, store, recorder, manager, cleanup } = makeManager(config, runner);
		try {
			await recorder.record({
				sessionKey: "s",
				messages: [{ id: "", role: "user", content: "我喜欢深色主题", timestamp: Date.now() }],
			});
			manager.notifyTurn();
			// L1 stores a memory; the L3 trigger count survives the scan because
			// no scenes exist yet (the counter must not be burned before L2 runs).
			await waitFor(() => manager.state.lastL1At !== null && manager.state.conversationsSinceL1 === 0);
			expect(existsSync(paths.personaFile)).toBe(false);
			await manager.runL2();
			// L2 creates a scene → the pending L3 trigger fires persona generation.
			await waitFor(() => existsSync(paths.personaFile));
			expect(manager.state.lastL2At).not.toBeNull();
			expect(manager.state.lastL3At).not.toBeNull();
			expect(readFileSync(paths.personaFile, "utf8")).toContain("Operating Doctrine");
			expect(manager.state.unprocessedMemoriesSinceL3).toBe(0);
		} finally {
			await manager.destroy();
			store.close();
			cleanup();
		}
	}, 20000);

	it("extracts oversized messages in their own chunk instead of skipping them", async () => {
		const config = parsePiMenConfig({
			pipeline: { l1IdleTimeoutSeconds: 600, l2DelayAfterL1Seconds: 86400 },
			extraction: { enableDedup: false },
			persona: { triggerEveryN: 1000 },
		});
		const prompts: string[] = [];
		const runner: LlmRunner = async (params) => {
			if (/情境切分/.test(params.systemPrompt)) {
				prompts.push(params.userPrompt ?? "");
				return JSON.stringify([{ scene_name: "s", message_ids: [], memories: [] }]);
			}
			throw new Error(`unexpected LLM call: ${params.systemPrompt.slice(0, 40)}`);
		};
		const { store, recorder, manager, cleanup } = makeManager(config, runner);
		try {
			const big = "x".repeat(125_000);
			const sentAt = Date.now();
			await recorder.record({
				sessionKey: "s",
				messages: [
					{ id: "", role: "user", content: big, timestamp: sentAt },
					{ id: "", role: "user", content: "short tail message", timestamp: sentAt + 1 },
				],
			});
			manager.notifyTurn();
			await waitFor(() => manager.state.lastL1At !== null && manager.state.conversationsSinceL1 === 0);
			// The oversized message exceeds MAX_BATCH_CHARS on its own, so it gets
			// its own chunk and is extracted — not silently dropped by the trim.
			expect(prompts).toHaveLength(2);
			expect(prompts[0]).toContain(big);
			expect(prompts[1]).toContain("short tail message");
			// The watermark advanced past both messages: a flush finds nothing new.
			const callsBefore = prompts.length;
			await manager.flush();
			expect(prompts).toHaveLength(callsBefore);
		} finally {
			await manager.destroy();
			store.close();
			cleanup();
		}
	}, 20000);

	it("continues an L2 backlog across chunks instead of skipping the remainder", async () => {
		const config = parsePiMenConfig({
			pipeline: { l1IdleTimeoutSeconds: 600, l2DelayAfterL1Seconds: 86400, l2MinIntervalSeconds: 0 },
			extraction: { enableDedup: false },
			persona: { triggerEveryN: 1000 },
		});
		const batches: string[][] = [];
		const runner: LlmRunner = async (params) => {
			if (/Memory Consolidation Architect/.test(params.systemPrompt)) {
				const ids = [...(params.userPrompt?.matchAll(/"id": "(m-\d+)"/g) ?? [])].map((match) => match[1]!);
				batches.push(ids);
				return JSON.stringify([]);
			}
			throw new Error(`unexpected LLM call: ${params.systemPrompt.slice(0, 40)}`);
		};
		const { store, manager, cleanup } = makeManager(config, runner);
		try {
			// 45 memories stamped with the identical updated_time: the LIMIT-40
			// boundary falls inside one tie group, which the (time, id) cursor
			// must walk through instead of skipping.
			const at = new Date().toISOString();
			for (let i = 0; i < 45; i++) {
				store.insertMemory(makeRecord({ id: `m-${String(i).padStart(2, "0")}`, updatedAt: at }));
			}
			await manager.runL2();
			const seen = new Set(batches.flat());
			expect(seen.size).toBe(45);
			expect(batches).toHaveLength(2); // 40 + remainder
			// A second pass has nothing pending and performs no LLM calls.
			await manager.runL2();
			expect(batches).toHaveLength(2);
		} finally {
			await manager.destroy();
			store.close();
			cleanup();
		}
	}, 20000);
});

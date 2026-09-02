import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiMenConfig } from "../src/config.ts";
import { buildCandidateMatches, dedupMemories } from "../src/core/l1/dedup.ts";
import { extractMemories } from "../src/core/l1/extractor.ts";
import { generatePersona, writePersona } from "../src/core/persona/persona-generator.ts";
import { extractScenes, parseSceneOps } from "../src/core/scene/scene-extractor.ts";
import { applySceneOps, readSceneIndex } from "../src/core/scene/scene-store.ts";
import { storagePaths } from "../src/core/storage/paths.ts";
import { rrfFuse } from "../src/core/store/hybrid-search.ts";
import { SqliteMemoryStore } from "../src/core/store/sqlite-store.ts";
import type { LlmRunner } from "../src/types.ts";

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

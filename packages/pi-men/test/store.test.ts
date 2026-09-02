import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePiMenConfig } from "../src/config.ts";
import { ConversationRecorder } from "../src/core/l0/recorder.ts";
import { MemoryWriter } from "../src/core/l1/writer.ts";
import { storagePaths } from "../src/core/storage/paths.ts";
import { createEmbeddingService } from "../src/core/store/embedding.ts";
import { bm25ToRelevance, buildFtsQuery, SqliteMemoryStore } from "../src/core/store/sqlite-store.ts";
import { decodeVector, encodeVector, VectorIndex } from "../src/core/store/vector-index.ts";
import type { MemoryRecord } from "../src/types.ts";

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

describe("buildFtsQuery", () => {
	it("keeps terms of three or more characters", () => {
		expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
	});

	it("drops terms too short for trigrams and punctuation", () => {
		expect(buildFtsQuery("a an the")).toBe('"the"');
	});

	it("returns null when nothing survives", () => {
		expect(buildFtsQuery("ok ?? !!")).toBeNull();
	});

	it("escapes embedded quotes and strips punctuation-only edges", () => {
		expect(buildFtsQuery('say "hi" now')).toBe('"say" OR "now"');
	});
});

describe("bm25ToRelevance", () => {
	it("maps stronger matches (larger |bm25|) closer to 1", () => {
		expect(bm25ToRelevance(-5)).toBeGreaterThan(bm25ToRelevance(-0.5));
		expect(bm25ToRelevance(0)).toBe(0);
	});
});

describe("SqliteMemoryStore", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-men-store-"));
	const paths = storagePaths(dir);
	let store: SqliteMemoryStore;

	afterAll(() => {
		store?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("inserts, retrieves, and keyword-searches L1 records (CJK + English)", () => {
		store = new SqliteMemoryStore(paths.db);
		store.insertMemory(makeRecord({ id: "m1", content: "The user prefers TypeScript over JavaScript" }));
		store.insertMemory(makeRecord({ id: "m2", content: "用户喜欢吃苹果，讨厌香菜" }));

		const hits = store.searchMemoriesKeyword(buildFtsQuery("TypeScript") ?? "", 10);
		expect(hits.map((hit) => hit.id)).toEqual(["m1"]);

		const zhHits = store.searchMemoriesKeyword(buildFtsQuery("喜欢 吃苹果") ?? "", 10);
		expect(zhHits.map((hit) => hit.id)).toEqual(["m2"]);

		expect(store.countMemories()).toBe(2);
		expect(store.getMemories(["m1"])[0]?.content).toContain("TypeScript");
	});

	it("falls back to LIKE for sub-trigram queries", () => {
		const hits = store.searchMemoriesLike("苹果", 10);
		expect(hits.map((hit) => hit.id)).toEqual(["m2"]);
	});

	it("updates records (version bump, fts refresh) and deletes them", () => {
		store.updateMemory("m1", {
			content: "The user now prefers Rust",
			type: "persona",
			priority: 85,
			timestamps: [new Date().toISOString()],
			version: 2,
			updatedAt: new Date().toISOString(),
		});
		expect(store.searchMemoriesKeyword(buildFtsQuery("Rust") ?? "", 10).map((hit) => hit.id)).toEqual(["m1"]);
		expect(store.searchMemoriesKeyword(buildFtsQuery("TypeScript") ?? "", 10)).toEqual([]);
		expect(store.getMemories(["m1"])[0]?.version).toBe(2);

		store.deleteMemories(["m1"]);
		expect(store.getMemories(["m1"])).toEqual([]);
		expect(store.searchMemoriesKeyword(buildFtsQuery("Rust") ?? "", 10)).toEqual([]);
	});

	it("records conversations idempotently and searches L0", async () => {
		const recorder = new ConversationRecorder(store, paths);
		const turn = {
			sessionKey: "sess-a",
			messages: [
				{ id: "", role: "user" as const, content: "please refactor the parser module", timestamp: Date.now() },
				{
					id: "",
					role: "assistant" as const,
					content: "done, refactored the parser module",
					timestamp: Date.now(),
				},
			],
		};
		await recorder.record(turn);
		await recorder.record(turn);

		expect(store.countConversations()).toBe(2);
		const hits = await recorder.search("refactor parser", 10);
		expect(hits).toHaveLength(2);
		expect(hits.every((hit) => hit.sessionKey === "sess-a")).toBe(true);
	});

	it("lists conversations before/since watermarks for pipeline recovery", () => {
		const now = Date.now();
		store.insertConversations([
			{ id: "w-1", sessionKey: "s", role: "user", content: "first watermark message", timestamp: now },
			{ id: "w-2", sessionKey: "s", role: "assistant", content: "second watermark message", timestamp: now + 10 },
			{ id: "w-3", sessionKey: "s", role: "user", content: "third watermark message", timestamp: now + 20 },
		]);
		const since = store.conversationsSince(now, 10);
		expect(since.filter((message) => message.id.startsWith("w-")).map((message) => message.id)).toEqual([
			"w-2",
			"w-3",
		]);
		const before = store.conversationsBefore(now + 10, 50);
		expect(before.filter((message) => message.id.startsWith("w-")).map((message) => message.id)).toEqual([
			"w-1",
			"w-2",
		]);
		expect(before.every((message) => message.timestamp <= now + 10)).toBe(true);
	});

	it("prunes old conversations by retention", () => {
		const countBefore = store.countConversations();
		store.insertConversations([
			{ id: "old-1", sessionKey: "s", role: "user", content: "ancient message about dinosaurs", timestamp: 1000 },
		]);
		expect(store.deleteConversationsBefore(Date.now() - 60_000)).toBe(1);
		expect(store.countConversations()).toBe(countBefore);
	});
});

describe("VectorIndex", () => {
	it("ranks by cosine similarity", () => {
		const index = new VectorIndex();
		index.load([
			{ id: "a", dims: 3, vector: new Float32Array([1, 0, 0]) },
			{ id: "b", dims: 3, vector: new Float32Array([0.9, 0.1, 0]) },
			{ id: "c", dims: 3, vector: new Float32Array([0, 1, 0]) },
		]);
		const hits = index.search(new Float32Array([1, 0.05, 0]), 3);
		expect(hits[0]?.id).toBe("a");
		expect(hits[1]?.id).toBe("b");
		expect(hits[2]?.id).toBe("c");
		expect(index.search(new Float32Array([0, 0, 0]), 3)).toEqual([]);
	});

	it("round-trips vectors through BLOB encoding", () => {
		const vector = new Float32Array([0.25, -1.5, 3.75]);
		const decoded = decodeVector(encodeVector(vector));
		expect([...decoded]).toEqual([0.25, -1.5, 3.75]);
	});

	it("removes entries and reflects size", () => {
		const index = new VectorIndex();
		index.upsert("x", new Float32Array([1, 2]));
		expect(index.size).toBe(1);
		index.remove(["x"]);
		expect(index.size).toBe(0);
	});
});

describe("embedding service factory", () => {
	it("returns null service when provider is none", () => {
		const service = createEmbeddingService(parsePiMenConfig().embedding);
		expect(service.isReady()).toBe(false);
		expect(service.dimensions).toBe(0);
		expect(service.providerInfo()).toBe("none");
	});

	it("returns openai service only with baseUrl and model", () => {
		const embedding = (overrides: Record<string, unknown>) =>
			parsePiMenConfig({ embedding: { provider: "openai", apiKey: "k", dimensions: 8, ...overrides } }).embedding;
		expect(createEmbeddingService(embedding({ baseUrl: "", model: "" })).isReady()).toBe(false);
		const ready = createEmbeddingService(embedding({ baseUrl: "https://example.com/v1", model: "emb-1" }));
		expect(ready.isReady()).toBe(true);
		expect(ready.providerInfo()).toContain("emb-1");
	});
});

describe("MemoryWriter", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-men-writer-"));
	const paths = storagePaths(dir);

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores, updates, merges, and skips according to decisions", async () => {
		const store = new SqliteMemoryStore(paths.db);
		const writer = new MemoryWriter(store, paths, createEmbeddingService(parsePiMenConfig().embedding));
		store.insertMemory(
			makeRecord({ id: "old-1", content: "用户住在上海", timestamps: ["2026-01-01T00:00:00.000Z"] }),
		);

		const candidates = [
			{
				recordId: "nm-1",
				content: "用户喜欢 Rust",
				type: "persona" as const,
				priority: 70,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
			{
				recordId: "nm-2",
				content: "用户住在上海（更新：搬到北京）",
				type: "persona" as const,
				priority: 80,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
			{
				recordId: "nm-3",
				content: "重复信息",
				type: "persona" as const,
				priority: 60,
				sceneName: "s",
				sourceMessageIds: [],
				metadata: {},
			},
		];
		const candidateMap = new Map(candidates.map((candidate) => [candidate.recordId, candidate]));
		const result = await writer.applyDecisions(
			[
				{ recordId: "nm-1", action: "store", targetIds: [] },
				{
					recordId: "nm-2",
					action: "update",
					targetIds: ["old-1"],
					mergedContent: "用户搬到北京（原住上海）",
					mergedType: "persona",
					mergedPriority: 85,
					mergedTimestamps: ["2026-01-01T00:00:00.000Z", new Date().toISOString()],
				},
				{ recordId: "nm-3", action: "skip", targetIds: [] },
			],
			candidateMap,
			{ sessionKey: "sess" },
		);

		expect(result.stored).toHaveLength(1);
		expect(result.updated).toHaveLength(1);
		expect(result.skipped).toBe(1);
		const updated = store.getMemories(["old-1"])[0]!;
		expect(updated.content).toBe("用户搬到北京（原住上海）");
		expect(updated.version).toBe(2);
		expect(updated.timestamps).toHaveLength(2);

		const record = await writer.remember("以后回答都用中文", { sessionKey: "sess" });
		expect(record.type).toBe("instruction");
		expect(record.priority).toBe(90);
		store.close();
	});
});

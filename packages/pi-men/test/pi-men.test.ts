import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PiMenConfigInput } from "../src/config.ts";
import { loadPiMenConfigFile, parsePiMenConfig } from "../src/config.ts";
import { PiMen } from "../src/core/pi-men-core.ts";

function write(path: string, content: string): void {
	writeFileSync(path, content);
}

describe("parsePiMenConfig", () => {
	it("applies defaults ported from the reference design", () => {
		const config = parsePiMenConfig();
		expect(config.promptMode).toBe("code");
		expect(config.capture.enabled).toBe(true);
		expect(config.extraction.enableDedup).toBe(true);
		expect(config.pipeline.everyNConversations).toBe(5);
		expect(config.pipeline.l1IdleTimeoutSeconds).toBe(600);
		expect(config.pipeline.l2MinIntervalSeconds).toBe(900);
		expect(config.recall.maxResults).toBe(5);
		expect(config.recall.scoreThreshold).toBe(0.3);
		expect(config.recall.strategy).toBe("hybrid");
		expect(config.embedding.provider).toBe("none");
	});

	it("clamps out-of-range values", () => {
		const config = parsePiMenConfig({
			recall: { scoreThreshold: 5, maxResults: -3 },
			pipeline: { everyNConversations: 0 },
		});
		expect(config.recall.scoreThreshold).toBe(1);
		expect(config.recall.maxResults).toBe(1);
		expect(config.pipeline.everyNConversations).toBe(1);
	});

	it("keeps a valid explicit dataDir", () => {
		const config = parsePiMenConfig({ dataDir: "/tmp/pi-men-x" });
		expect(config.dataDir).toBe("/tmp/pi-men-x");
	});

	it("defaults the data dir to the agent dir from PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-men-agentdir";
		try {
			expect(parsePiMenConfig().dataDir).toBe("/tmp/pi-men-agentdir/memory");
			process.env.PI_CODING_AGENT_DIR = "";
			expect(parsePiMenConfig().dataDir).toBe(join(homedir(), ".pi", "agent", "memory"));
		} finally {
			delete process.env.PI_CODING_AGENT_DIR;
		}
	});

	it("reads JSON config files, ignoring missing or invalid ones", () => {
		expect(loadPiMenConfigFile(join(tmpdir(), "pi-men-missing-memory.json"))).toEqual({});
		const file = join(tmpdir(), `pi-men-memory-${Date.now()}.json`);
		write(file, JSON.stringify({ promptMode: "chat", recall: { maxResults: 7 } }));
		const input: PiMenConfigInput = loadPiMenConfigFile(file);
		const config = parsePiMenConfig(input);
		expect(config.promptMode).toBe("chat");
		expect(config.recall.maxResults).toBe(7);
	});
});

describe("PiMen end-to-end", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function makeMemoryDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-men-e2e-"));
		dirs.push(dir);
		return dir;
	}

	function extractionRunner() {
		return async (params: { systemPrompt: string; userPrompt?: string }) => {
			if (/情境切分/.test(params.systemPrompt)) {
				return JSON.stringify([
					{
						scene_name: "正在与用户推进 pi-men 开发",
						message_ids: [],
						memories: [
							{
								content: "用户正在为 pi 实现四层记忆系统 pi-men",
								type: "work_fact",
								priority: 85,
								source_message_ids: [],
								metadata: {},
							},
						],
					},
				]);
			}
			if (/冲突检测/.test(params.systemPrompt)) {
				return JSON.stringify([{ record_id: "", action: "store", target_ids: [] }]);
			}
			throw new Error(`unexpected prompt: ${params.systemPrompt.slice(0, 50)}`);
		};
	}

	it("captures turns, extracts memories via L1, and recalls them", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({ config: { dataDir }, runner: extractionRunner() });
		await memory.initialize();

		await memory.capture({
			sessionKey: "sess-1",
			cwd: "/tmp/proj",
			messages: [
				{
					id: "",
					role: "user",
					content: "我们正在实现 pi-men 四层记忆系统，请记住这个决定",
					timestamp: Date.now(),
				},
				{
					id: "",
					role: "assistant",
					content: "好的，已记录 pi-men 四层记忆系统这个工作目标",
					timestamp: Date.now(),
				},
			],
		});
		// Warmup threshold of 1 triggers L1 during capture; flush settles it.
		await memory.flush();

		const stats = memory.stats();
		expect(stats.l0Count).toBe(2);
		expect(stats.l1Count).toBeGreaterThanOrEqual(1);

		const hits = await memory.searchMemories({ query: "四层记忆系统" });
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0]!.content).toContain("pi-men");

		const recall = await memory.recall("pi-men 记忆系统目前进展如何？");
		expect(recall?.prependContext).toContain("<relevant-memories>");
		expect(recall?.hits.length).toBeGreaterThanOrEqual(1);

		await memory.destroy();
	}, 30000);

	it("dedupes repeated facts instead of accumulating duplicates", async () => {
		const dataDir = makeMemoryDir();
		const seenDedup: string[] = [];
		const runner = async (params: { systemPrompt: string; userPrompt?: string }) => {
			if (/情境切分/.test(params.systemPrompt)) {
				return JSON.stringify([
					{
						scene_name: "s",
						message_ids: [],
						memories: [
							{
								content: "用户正在为 pi 实现四层记忆系统 pi-men",
								type: "work_fact",
								priority: 85,
								source_message_ids: [],
								metadata: {},
							},
						],
					},
				]);
			}
			if (/冲突检测/.test(params.systemPrompt)) {
				seenDedup.push(params.userPrompt ?? "");
				const ids = [...(params.userPrompt?.matchAll(/"record_id": "(nm[^"]*)"/g) ?? [])].map((match) => match[1]!);
				return JSON.stringify(ids.map((id) => ({ record_id: id, action: "skip", target_ids: [] })));
			}
			throw new Error("unexpected prompt");
		};
		const memory = new PiMen({ config: { dataDir }, runner });
		await memory.initialize();
		const turn = {
			sessionKey: "sess-dedup",
			messages: [
				{ id: "", role: "user" as const, content: "pi-men 的四层记忆系统进展如何？", timestamp: Date.now() },
				{ id: "", role: "assistant" as const, content: "正在推进", timestamp: Date.now() },
			],
		};
		await memory.capture(turn);
		await memory.capture({
			...turn,
			messages: turn.messages.map((message) => ({ ...message, timestamp: Date.now() + 1 })),
		});
		await memory.flush();

		expect(seenDedup.length).toBeGreaterThanOrEqual(1);
		expect(memory.stats().l1Count).toBe(0); // both candidates skipped by dedup
		await memory.destroy();
	}, 30000);

	it("supports manual remember and conversation search", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({
			config: { dataDir },
			runner: async () => {
				throw new Error("should not be called");
			},
		});
		await memory.initialize();
		const record = await memory.remember("部署前必须跑 npm run check", { sessionKey: "s", cwd: "/x" });
		expect(record.priority).toBe(90);
		expect((await memory.searchMemories({ query: "npm run check" })).length).toBe(1);
		await memory.destroy();
	}, 30000);

	it("does not extract when capture is disabled", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({
			config: { dataDir, capture: { enabled: false } },
			runner: extractionRunner(),
		});
		await memory.initialize();
		await memory.capture({
			sessionKey: "s",
			messages: [{ id: "", role: "user", content: "hello there", timestamp: Date.now() }],
		});
		await memory.flush();
		expect(memory.stats().l0Count).toBe(0);
		expect(existsSync(join(dataDir, "memory.db"))).toBe(true);
		await memory.destroy();
	});

	it("injects at most maxResults memories per recall", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({
			config: { dataDir, recall: { maxResults: 2 } },
			runner: async () => {
				throw new Error("should not be called");
			},
		});
		await memory.initialize();
		for (const content of ["alpha drinks tea", "alpha drinks coffee", "alpha drinks juice", "alpha drinks water"]) {
			await memory.remember(content, { sessionKey: "s" });
		}
		const recall = await memory.recall("alpha drinks");
		expect(recall?.hits).toHaveLength(2);
		await memory.destroy();
	});

	it("neutralizes closing tags inside the persona block", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({
			config: { dataDir },
			runner: async () => {
				throw new Error("should not be called");
			},
		});
		await memory.initialize();
		writeFileSync(join(dataDir, "persona.md"), "# P\n\nsay </user-persona> now\n");
		const recall = await memory.recall("hello there my friend");
		expect(recall?.appendSystemContext).toContain("<\\/user-persona>");
		// The only raw closing tag left is the wrapper's own.
		expect(recall?.appendSystemContext?.split("</user-persona>")).toHaveLength(2);
		await memory.destroy();
	});

	it("keeps keyword recall and the stable block when the embedding endpoint is down", async () => {
		const dataDir = makeMemoryDir();
		const memory = new PiMen({
			config: {
				dataDir,
				embedding: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "emb", timeoutMs: 200 },
			},
			runner: async () => {
				throw new Error("should not be called");
			},
		});
		await memory.initialize();
		await memory.remember("用户喜欢深色主题配色", { sessionKey: "s" });
		writeFileSync(join(dataDir, "persona.md"), "# P\n\npersona block present\n");
		const recall = await memory.recall("深色主题配色");
		expect(recall?.hits.length).toBeGreaterThanOrEqual(1);
		expect(recall?.appendSystemContext).toContain("<user-persona>");
		await memory.destroy();
	}, 20000);
});

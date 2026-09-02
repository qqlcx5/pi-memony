import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiMenConfig } from "../../config.ts";
import type { DedupDecision, HostLogger, LlmRunner } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import type { ConversationRecorder } from "../l0/recorder.ts";
import { buildCandidateMatches, dedupMemories } from "../l1/dedup.ts";
import { extractMemories } from "../l1/extractor.ts";
import type { MemoryWriter } from "../l1/writer.ts";
import type { PersonaResult } from "../persona/persona-generator.ts";
import { generatePersona, writePersona } from "../persona/persona-generator.ts";
import { extractScenes } from "../scene/scene-extractor.ts";
import { changedScenes, readSceneIndex, type SceneIndexEntry } from "../scene/scene-store.ts";
import type { StoragePaths } from "../storage/paths.ts";
import type { SqliteMemoryStore } from "../store/sqlite-store.ts";

const CHECKPOINT_VERSION = 1;
/** Hard caps for one L1 batch. */
const MAX_BATCH_MESSAGES = 400;
const MAX_BATCH_CHARS = 120_000;
/** Messages from just before the batch kept as extraction background context. */
const BACKGROUND_MESSAGES = 6;
const SCENE_BATCH_SIZE = 40;
const WARMUP_SCHEDULE = [1, 2, 4] as const;

export interface PipelineCheckpoint {
	version: number;
	previousSceneName: string | null;
	conversationsSinceL1: number;
	warmupStage: number;
	lastL1At: string | null;
	lastL2At: string | null;
	lastL3At: string | null;
	lastL1MessageTimestamp: number | null;
	lastL3SceneSync: string | null;
	unprocessedMemoriesSinceL3: number;
}

function defaultCheckpoint(): PipelineCheckpoint {
	return {
		version: CHECKPOINT_VERSION,
		previousSceneName: null,
		conversationsSinceL1: 0,
		warmupStage: 0,
		lastL1At: null,
		lastL2At: null,
		lastL3At: null,
		lastL1MessageTimestamp: null,
		lastL3SceneSync: null,
		unprocessedMemoriesSinceL3: 0,
	};
}

/**
 * Distillation scheduler: L1 fires every N conversations (warmup 1→2→4) or
 * after an idle timeout; L2 follows L1 under min/max interval throttling; L3
 * regenerates the persona every N new memories. All state survives restarts
 * via checkpoint.json; crash recovery re-reads L0 rows after the watermark.
 */
export class PipelineManager {
	private config: PiMenConfig;
	private paths: StoragePaths;
	private store: SqliteMemoryStore;
	private recorder: ConversationRecorder;
	private writer: MemoryWriter;
	private runner: LlmRunner;
	private logger?: HostLogger;

	private checkpoint: PipelineCheckpoint;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private l2Timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private destroyed = false;
	private inFlight: Promise<void> | null = null;

	constructor(deps: {
		config: PiMenConfig;
		paths: StoragePaths;
		store: SqliteMemoryStore;
		recorder: ConversationRecorder;
		writer: MemoryWriter;
		runner: LlmRunner;
		logger?: HostLogger;
	}) {
		this.config = deps.config;
		this.paths = deps.paths;
		this.store = deps.store;
		this.recorder = deps.recorder;
		this.writer = deps.writer;
		this.runner = deps.runner;
		this.logger = deps.logger;
		this.checkpoint = this.loadCheckpoint();
	}

	private loadCheckpoint(): PipelineCheckpoint {
		try {
			if (!existsSync(this.paths.checkpointFile)) return defaultCheckpoint();
			const parsed = JSON.parse(readFileSync(this.paths.checkpointFile, "utf8")) as Partial<PipelineCheckpoint>;
			return { ...defaultCheckpoint(), ...parsed, version: CHECKPOINT_VERSION };
		} catch {
			return defaultCheckpoint();
		}
	}

	private saveCheckpoint(): void {
		try {
			mkdirSync(this.paths.metadataDir, { recursive: true });
			const tmp = join(this.paths.metadataDir, "checkpoint.json.tmp");
			writeFileSync(tmp, JSON.stringify(this.checkpoint, null, 2), "utf8");
			renameSync(tmp, this.paths.checkpointFile);
		} catch (error) {
			this.logger?.warn?.(`[pi-men] checkpoint save failed: ${errorMessage(error)}`);
		}
	}

	get state(): Readonly<PipelineCheckpoint> {
		return this.checkpoint;
	}

	/** Record a captured turn's L0 conversation count and schedule L1 if due. */
	notifyTurn(): void {
		if (this.destroyed || !this.config.extraction.enabled) return;
		this.checkpoint.conversationsSinceL1 += 1;
		this.saveCheckpoint();
		this.resetIdleTimer();
		if (this.checkpoint.conversationsSinceL1 >= this.currentThreshold()) {
			void this.runL1("threshold");
		}
	}

	private currentThreshold(): number {
		if (!this.config.pipeline.enableWarmup) return this.config.pipeline.everyNConversations;
		const warmup = WARMUP_SCHEDULE[Math.min(this.checkpoint.warmupStage, WARMUP_SCHEDULE.length - 1)];
		return Math.min(warmup ?? this.config.pipeline.everyNConversations, this.config.pipeline.everyNConversations);
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const timeoutMs = this.config.pipeline.l1IdleTimeoutSeconds * 1000;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.checkpoint.conversationsSinceL1 > 0) void this.runL1("idle");
		}, timeoutMs);
		this.idleTimer.unref?.();
	}

	/** Force an L1 pass now (shutdown flush, /memory flush). Returns when done. */
	async flush(): Promise<void> {
		if (this.destroyed) return;
		await this.runL1("manual");
	}

	/** Run one extraction + distillation cycle; never throws. */
	async runL1(trigger: "threshold" | "idle" | "manual"): Promise<void> {
		if (this.destroyed || this.running) {
			if (this.inFlight && trigger === "manual") await this.inFlight;
			return;
		}
		this.running = true;
		const task = this.runL1Inner()
			.catch((error) => {
				this.logger?.warn?.(`[pi-men] L1 pipeline failed: ${errorMessage(error)}`);
			})
			.finally(() => {
				this.running = false;
				this.inFlight = null;
			});
		this.inFlight = task;
		await task;
	}

	private async runL1Inner(): Promise<void> {
		if (!this.config.extraction.enabled) return;
		const since = this.checkpoint.lastL1MessageTimestamp ?? 0;
		const batch = this.store.conversationsSince(since, MAX_BATCH_MESSAGES);
		if (batch.length === 0) {
			this.checkpoint.conversationsSinceL1 = 0;
			this.saveCheckpoint();
			return;
		}
		// Trim by chars from the end so the most recent context survives.
		const trimmed: typeof batch = [];
		let chars = 0;
		for (let i = batch.length - 1; i >= 0; i--) {
			const message = batch[i]!;
			if (trimmed.length > 0 && chars + message.content.length > MAX_BATCH_CHARS) break;
			chars += message.content.length;
			trimmed.unshift(message);
		}
		const firstTimestamp = trimmed[0]!.timestamp;
		const background = this.store.conversationsBefore(firstTimestamp, BACKGROUND_MESSAGES);

		const scenes = await extractMemories(this.runner, this.config, {
			newMessages: trimmed.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				timestamp: message.timestamp,
			})),
			backgroundMessages: background.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				timestamp: message.timestamp,
			})),
			previousSceneName: this.checkpoint.previousSceneName ?? undefined,
		});

		const candidates = scenes.flatMap((scene) => scene.memories);
		if (candidates.length > 0) {
			let decisions: DedupDecision[] = candidates.map((memory) => ({
				recordId: memory.recordId,
				action: "store" as const,
				targetIds: [],
			}));
			if (this.config.extraction.enableDedup) {
				const matches = buildCandidateMatches(candidates, this.store);
				decisions = await dedupMemories({ runner: this.runner, config: this.config, matches });
			}
			const candidateMap = new Map(candidates.map((memory) => [memory.recordId, memory]));
			const result = await this.writer.applyDecisions(decisions, candidateMap, {
				sessionKey: trimmed[trimmed.length - 1]!.sessionKey,
			});
			this.checkpoint.unprocessedMemoriesSinceL3 += result.stored.length + result.updated.length;
		}

		const lastScene = [...scenes].reverse().find((scene) => scene.sceneName);
		if (lastScene) this.checkpoint.previousSceneName = lastScene.sceneName;
		this.checkpoint.lastL1MessageTimestamp = batch[batch.length - 1]!.timestamp;
		this.checkpoint.conversationsSinceL1 = 0;
		this.checkpoint.warmupStage = Math.min(this.checkpoint.warmupStage + 1, WARMUP_SCHEDULE.length);
		this.checkpoint.lastL1At = new Date().toISOString();
		this.saveCheckpoint();

		this.scheduleL2();
		await this.maybeRunL3();
	}

	private scheduleL2(): void {
		if (this.l2Timer) clearTimeout(this.l2Timer);
		const delayMs = this.config.pipeline.l2DelayAfterL1Seconds * 1000;
		this.l2Timer = setTimeout(() => {
			this.l2Timer = null;
			void this.runL2();
		}, delayMs);
		this.l2Timer.unref?.();
	}

	/** Run one L2 scene consolidation pass; never throws. */
	async runL2(): Promise<void> {
		if (this.destroyed || this.running) return;
		const now = Date.now();
		const lastL2 = this.checkpoint.lastL2At ? Date.parse(this.checkpoint.lastL2At) : 0;
		if (now - lastL2 < this.config.pipeline.l2MinIntervalSeconds * 1000) return;
		// Force a pass when the max interval has elapsed with pending memories.
		this.running = true;
		try {
			const memories = this.store.memoriesUpdatedSince(this.checkpoint.lastL2At ?? "", SCENE_BATCH_SIZE);
			if (memories.length === 0) {
				this.checkpoint.lastL2At = new Date().toISOString();
				this.saveCheckpoint();
				return;
			}
			const existingIndex = readSceneIndex(this.paths);
			await extractScenes({
				runner: this.runner,
				config: this.config,
				paths: this.paths,
				memories,
				existingIndex,
				logger: this.logger,
			});
			this.checkpoint.lastL2At = new Date().toISOString();
			this.saveCheckpoint();
			await this.maybeRunL3();
		} catch (error) {
			this.logger?.warn?.(`[pi-men] L2 pipeline failed: ${errorMessage(error)}`);
		} finally {
			this.running = false;
		}
	}

	private async maybeRunL3(): Promise<void> {
		if (this.checkpoint.unprocessedMemoriesSinceL3 < this.config.persona.triggerEveryN) return;
		await this.runL3();
	}

	/** Run one L3 persona generation pass; never throws. */
	async runL3(): Promise<void> {
		if (this.destroyed || this.running) return;
		this.running = true;
		try {
			const entries = readSceneIndex(this.paths);
			const changed = changedScenes(entries, this.checkpoint.lastL3SceneSync);
			if (changed.length === 0) {
				this.checkpoint.unprocessedMemoriesSinceL3 = 0;
				this.saveCheckpoint();
				return;
			}
			const existingPersona = existsSync(this.paths.personaFile)
				? readFileSync(this.paths.personaFile, "utf8")
				: null;
			const result: PersonaResult = await generatePersona({
				runner: this.runner,
				config: this.config,
				existingPersona,
				changedScenes: changed,
				paths: this.paths,
				totalMemories: this.store.countMemories(),
			});
			if (result.content) writePersona(this.paths, result.content, this.config.persona.backupCount);
			this.checkpoint.lastL3At = new Date().toISOString();
			this.checkpoint.lastL3SceneSync = new Date().toISOString();
			this.checkpoint.unprocessedMemoriesSinceL3 = 0;
			this.saveCheckpoint();
		} catch (error) {
			this.logger?.warn?.(`[pi-men] L3 pipeline failed: ${errorMessage(error)}`);
		} finally {
			this.running = false;
		}
	}

	/** Stop timers and wait (bounded) for in-flight work. */
	async destroy(timeoutMs = 3000): Promise<void> {
		this.destroyed = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.l2Timer) {
			clearTimeout(this.l2Timer);
			this.l2Timer = null;
		}
		if (this.inFlight) {
			await Promise.race([this.inFlight, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
		}
		this.saveCheckpoint();
	}

	sceneCount(): number {
		return readSceneIndex(this.paths).length;
	}

	sceneEntries(): SceneIndexEntry[] {
		return readSceneIndex(this.paths);
	}
}

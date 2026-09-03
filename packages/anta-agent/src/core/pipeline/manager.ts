import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AntaAgentConfig } from "../../config.ts";
import type { DedupDecision, HostLogger, LlmRunner } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import type { ConversationRecorder } from "../l0/recorder.ts";
import { buildCandidateMatches, dedupMemories } from "../l1/dedup.ts";
import { extractMemories } from "../l1/extractor.ts";
import type { MemoryWriter } from "../l1/writer.ts";
import type { PersonaResult } from "../persona/persona-generator.ts";
import { generatePersona, writePersona } from "../persona/persona-generator.ts";
import { extractScenes } from "../scene/scene-extractor.ts";
import { backupSceneBlocks, changedScenes, readSceneIndex, type SceneIndexEntry } from "../scene/scene-store.ts";
import type { StoragePaths } from "../storage/paths.ts";
import type { SqliteMemoryStore } from "../store/sqlite-store.ts";

const CHECKPOINT_VERSION = 1;
/** Hard caps for one L1 pass. */
const MAX_BATCH_MESSAGES = 400;
const MAX_BATCH_CHARS = 120_000;
/** Chunks (extraction LLM calls) processed per L1 pass; the rest stays pending. */
const MAX_L1_CHUNKS_PER_PASS = 3;
/** Chunks (scene LLM calls) processed per L2 pass. */
const MAX_L2_CHUNKS_PER_PASS = 3;
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
	lastL1MessageId: string | null;
	lastL2Watermark: string | null;
	lastL2WatermarkId: string | null;
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
		lastL1MessageId: null,
		lastL2Watermark: null,
		lastL2WatermarkId: null,
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
	private config: AntaAgentConfig;
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
	private readonly abortController = new AbortController();
	private destroyPromise: Promise<boolean> | null = null;

	constructor(deps: {
		config: AntaAgentConfig;
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
			const merged = { ...defaultCheckpoint(), ...parsed, version: CHECKPOINT_VERSION };
			// Checkpoints from before the L2 watermark existed: the old lastL2At
			// marker is the closest approximation, so no records are reprocessed.
			if (merged.lastL2Watermark === null && merged.lastL2At !== null) {
				merged.lastL2Watermark = merged.lastL2At;
			}
			return merged;
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
			this.logger?.warn?.(`[anta-agent] checkpoint save failed: ${errorMessage(error)}`);
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
		const everyN = this.config.pipeline.everyNConversations;
		if (!this.config.pipeline.enableWarmup) return everyN;
		// Warmup doubles (1→2→4) and then settles on everyNConversations; the
		// schedule must converge instead of freezing on its last entry.
		const scheduled = WARMUP_SCHEDULE[this.checkpoint.warmupStage];
		return Math.min(scheduled ?? everyN, everyN);
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
				this.logger?.warn?.(`[anta-agent] L1 pipeline failed: ${errorMessage(error)}`);
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
		const cursor = {
			timestamp: this.checkpoint.lastL1MessageTimestamp ?? 0,
			id: this.checkpoint.lastL1MessageId,
		};
		const pending = this.store.conversationsSince(cursor, MAX_BATCH_MESSAGES);
		if (pending.length === 0) {
			this.checkpoint.conversationsSinceL1 = 0;
			this.saveCheckpoint();
			return;
		}
		// Turns captured while this pass runs must keep their threshold credit:
		// subtract the triggering count instead of zeroing the counter.
		const creditAtStart = this.checkpoint.conversationsSinceL1;
		// Split into char-bounded chunks (a single oversized message gets its own
		// chunk) so prompts stay bounded without dropping any message. Chunks
		// beyond the per-pass cap stay pending; the cursor only advances over
		// processed chunks, so nothing is silently skipped.
		const chunks: (typeof pending)[] = [];
		let current: typeof pending = [];
		let chars = 0;
		for (const message of pending) {
			if (current.length > 0 && chars + message.content.length > MAX_BATCH_CHARS) {
				chunks.push(current);
				current = [];
				chars = 0;
			}
			current.push(message);
			chars += message.content.length;
		}
		if (current.length > 0) chunks.push(current);

		for (const chunk of chunks.slice(0, MAX_L1_CHUNKS_PER_PASS)) {
			// Background context only; exclude the chunk's own messages so its
			// first message is not fed to the extractor twice.
			const chunkIds = new Set(chunk.map((message) => message.id));
			const background = this.store
				.conversationsBefore(chunk[0]!.timestamp, BACKGROUND_MESSAGES + chunk.length)
				.filter((message) => !chunkIds.has(message.id))
				.slice(0, BACKGROUND_MESSAGES);
			const scenes = await extractMemories(this.runner, this.config, {
				newMessages: chunk.map((message) => ({
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
				signal: this.abortController.signal,
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
					decisions = await dedupMemories({
						runner: this.runner,
						config: this.config,
						matches,
						signal: this.abortController.signal,
						logger: this.logger,
					});
				}
				const candidateMap = new Map(candidates.map((memory) => [memory.recordId, memory]));
				const result = await this.writer.applyDecisions(decisions, candidateMap, {
					sessionKey: chunk[chunk.length - 1]!.sessionKey,
				});
				if (!result.primaryWritesComplete) {
					throw new Error(
						`L1 primary writes incomplete (${result.failedCandidateIds.length} failed, ${result.auditFailures} audit failures)`,
					);
				}
				this.checkpoint.unprocessedMemoriesSinceL3 += result.stored.length + result.updated.length;
			}

			const lastScene = [...scenes].reverse().find((scene) => scene.sceneName);
			if (lastScene) this.checkpoint.previousSceneName = lastScene.sceneName;
			const last = chunk[chunk.length - 1]!;
			this.checkpoint.lastL1MessageTimestamp = last.timestamp;
			this.checkpoint.lastL1MessageId = last.id;
			this.checkpoint.lastL1At = new Date().toISOString();
			this.saveCheckpoint();
		}
		this.checkpoint.conversationsSinceL1 = Math.max(0, this.checkpoint.conversationsSinceL1 - creditAtStart);
		this.checkpoint.warmupStage = Math.min(this.checkpoint.warmupStage + 1, WARMUP_SCHEDULE.length);
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

	/** Wait until any in-flight pipeline pass finishes. */
	private async awaitQuiet(): Promise<void> {
		while (this.running && !this.destroyed) {
			if (this.inFlight) {
				await this.inFlight;
			} else {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
	}

	/** Run one L2 scene consolidation pass; never throws. */
	async runL2(): Promise<void> {
		if (this.destroyed) return;
		// An explicit L2 request must not be silently swallowed by an in-flight
		// pass; queue behind it instead.
		await this.awaitQuiet();
		if (this.destroyed) return;
		this.running = true;
		const task = this.runL2Inner().finally(() => {
			this.running = false;
			if (this.inFlight === task) this.inFlight = null;
		});
		this.inFlight = task;
		await task;
	}

	/**
	 * L2 is triggered only after an L1 pass (scheduleL2). The min interval
	 * throttles passes while L1 fires more often than l2MinIntervalSeconds; a
	 * backlog older than l2MaxIntervalSeconds forces a pass through. The
	 * (updated_time, id) watermark advances only over consolidated records, so
	 * a backlog larger than one chunk is continued by the next pass instead of
	 * being skipped.
	 */
	private async runL2Inner(): Promise<void> {
		const cursor = { updatedAt: this.checkpoint.lastL2Watermark ?? "", id: this.checkpoint.lastL2WatermarkId };
		if (!this.store.hasMemoriesUpdatedSince(cursor)) {
			this.checkpoint.lastL2At = new Date().toISOString();
			this.saveCheckpoint();
			return;
		}
		const elapsed = Date.now() - (this.checkpoint.lastL2At ? Date.parse(this.checkpoint.lastL2At) : 0);
		const withinMin = elapsed >= 0 && elapsed < this.config.pipeline.l2MinIntervalSeconds * 1000;
		const overdue = elapsed >= this.config.pipeline.l2MaxIntervalSeconds * 1000;
		if (withinMin && !overdue) return;
		try {
			backupSceneBlocks(this.paths, this.config.persona.sceneBackupCount, this.logger);
			for (let chunk = 0; chunk < MAX_L2_CHUNKS_PER_PASS; chunk++) {
				const memories = this.store.memoriesUpdatedSince(cursor, SCENE_BATCH_SIZE);
				if (memories.length === 0) break;
				const existingIndex = readSceneIndex(this.paths);
				await extractScenes({
					runner: this.runner,
					config: this.config,
					paths: this.paths,
					memories,
					existingIndex,
					logger: this.logger,
					signal: this.abortController.signal,
				});
				const last = memories[memories.length - 1]!;
				cursor.updatedAt = last.updatedAt;
				cursor.id = last.id;
				this.checkpoint.lastL2Watermark = last.updatedAt;
				this.checkpoint.lastL2WatermarkId = last.id;
				this.saveCheckpoint();
			}
			this.checkpoint.lastL2At = new Date().toISOString();
			this.saveCheckpoint();
			await this.maybeRunL3();
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L2 pipeline failed: ${errorMessage(error)}`);
		}
	}

	private async maybeRunL3(): Promise<void> {
		if (this.checkpoint.unprocessedMemoriesSinceL3 < this.config.persona.triggerEveryN) return;
		await this.runL3Inner();
	}

	/** Run one L3 persona generation pass; never throws. */
	async runL3(): Promise<void> {
		if (this.destroyed) return;
		await this.awaitQuiet();
		if (this.destroyed) return;
		this.running = true;
		const task = this.runL3Inner().finally(() => {
			this.running = false;
			if (this.inFlight === task) this.inFlight = null;
		});
		this.inFlight = task;
		await task;
	}

	/** L3 body without the re-entrancy guard: L1/L2 callers already hold the lock. */
	private async runL3Inner(): Promise<void> {
		try {
			const entries = readSceneIndex(this.paths);
			const changed = changedScenes(entries, this.checkpoint.lastL3SceneSync);
			// No consolidated scenes yet (e.g. L2 has not run since the last
			// persona pass): keep the trigger count so the memories are not lost;
			// this branch is a cheap index scan with no LLM call.
			if (changed.length === 0) return;
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
				signal: this.abortController.signal,
			});
			if (result.content) writePersona(this.paths, result.content, this.config.persona.backupCount);
			this.checkpoint.lastL3At = new Date().toISOString();
			this.checkpoint.lastL3SceneSync = new Date().toISOString();
			this.checkpoint.unprocessedMemoriesSinceL3 = 0;
			this.saveCheckpoint();
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L3 pipeline failed: ${errorMessage(error)}`);
		}
	}

	/** Stop timers and wait (bounded) for in-flight work. */
	async destroy(timeoutMs = 3000): Promise<boolean> {
		if (this.destroyPromise) return this.destroyPromise;
		this.destroyPromise = this.destroyInner(timeoutMs);
		return this.destroyPromise;
	}

	/** Resolve once no pipeline pass can access the store anymore. */
	async waitForQuiescence(): Promise<void> {
		if (this.inFlight) await this.inFlight;
	}

	private async destroyInner(timeoutMs: number): Promise<boolean> {
		this.destroyed = true;
		this.abortController.abort();
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.l2Timer) {
			clearTimeout(this.l2Timer);
			this.l2Timer = null;
		}
		let quiescent = true;
		if (this.inFlight) {
			let timedOut = false;
			await Promise.race([
				this.inFlight,
				new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						timedOut = true;
						resolve();
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
			quiescent = !timedOut;
			if (timedOut) this.logger?.warn?.("[anta-agent] pipeline shutdown timed out; store remains open");
		}
		this.saveCheckpoint();
		return quiescent;
	}

	sceneCount(): number {
		return readSceneIndex(this.paths).length;
	}

	sceneEntries(): SceneIndexEntry[] {
		return readSceneIndex(this.paths);
	}
}

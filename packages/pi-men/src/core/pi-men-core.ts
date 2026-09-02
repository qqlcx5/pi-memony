import { existsSync, mkdirSync } from "node:fs";
import { type PiMenConfig, type PiMenConfigInput, parsePiMenConfig } from "../config.ts";
import type {
	CompletedTurn,
	ConversationHit,
	HostLogger,
	LlmRunner,
	MemoryRecord,
	MemoryStats,
	MemoryType,
	RecallHit,
	RecallResult,
	RememberOptions,
	SearchConversationsParams,
	SearchMemoriesParams,
} from "../types.ts";
import { errorMessage } from "./errors.ts";
import { ConversationRecorder } from "./l0/recorder.ts";
import { MemoryWriter } from "./l1/writer.ts";
import { PipelineManager } from "./pipeline/manager.ts";
import { applyRecallBudget, buildRecallResult } from "./recall/recall-context.ts";
import { readSceneIndex } from "./scene/scene-store.ts";
import { type StoragePaths, storagePaths } from "./storage/paths.ts";
import { createEmbeddingService, type EmbeddingService } from "./store/embedding.ts";
import { rrfFuse } from "./store/hybrid-search.ts";
import { buildFtsQuery, SqliteMemoryStore } from "./store/sqlite-store.ts";

export interface PiMenOptions {
	runner: LlmRunner;
	config?: PiMenConfigInput;
	logger?: HostLogger;
}

/** Default per-tool search cap. */
const SEARCH_RESULT_CAP = 20;
const EMBED_BATCH_SIZE = 32;

/**
 * Host-neutral memory facade (modeled on TencentDB-Agent-Memory's TdaiCore):
 * capture/recall/search over the four layers, with the distillation pipeline
 * running in the background. recall/capture/search never throw.
 */
export class PiMen {
	private readonly config: PiMenConfig;
	private readonly paths: StoragePaths;
	private readonly store: SqliteMemoryStore;
	private readonly embedding: EmbeddingService;
	private readonly recorder: ConversationRecorder;
	private readonly writer: MemoryWriter;
	private readonly pipeline: PipelineManager;
	private readonly logger?: HostLogger;

	constructor(options: PiMenOptions) {
		this.config = parsePiMenConfig(options.config);
		this.logger = options.logger;
		this.paths = storagePaths(this.config.dataDir);
		this.store = new SqliteMemoryStore(this.paths.db);
		this.embedding = createEmbeddingService(this.config.embedding, this.logger);
		this.recorder = new ConversationRecorder(this.store, this.paths, this.logger);
		this.writer = new MemoryWriter(this.store, this.paths, this.embedding, this.logger);
		this.pipeline = new PipelineManager({
			config: this.config,
			paths: this.paths,
			store: this.store,
			recorder: this.recorder,
			writer: this.writer,
			runner: options.runner,
			logger: this.logger,
		});
	}

	get effectiveConfig(): PiMenConfig {
		return this.config;
	}

	/** Create directories, sync embedding metadata, and backfill vectors. */
	async initialize(): Promise<void> {
		mkdirSync(this.paths.conversationsDir, { recursive: true });
		mkdirSync(this.paths.recordsDir, { recursive: true });
		mkdirSync(this.paths.sceneBlocksDir, { recursive: true });
		mkdirSync(this.paths.metadataDir, { recursive: true });
		if (!this.embedding.isReady()) return;
		const changed = this.store.setEmbeddingMeta(
			this.config.embedding.provider,
			this.config.embedding.model,
			this.config.embedding.dimensions,
		);
		if (changed) this.logger?.info?.("[pi-men] embedding setup changed; stored vectors cleared");
		await this.backfillVectors();
	}

	/** Embed any L1 records that lack a stored vector (provider change or first enable). */
	private async backfillVectors(): Promise<void> {
		try {
			const missing = this.store.recentMemories(this.store.countMemories()).filter((record) => {
				return !this.store.hasVector("l1", record.id);
			});
			for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
				const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
				const vectors = await this.embedding.embed(batch.map((record) => record.content));
				for (let j = 0; j < batch.length; j++) {
					const vector = vectors[j];
					if (vector) this.store.putVector("l1", batch[j]!.id, vector);
				}
			}
		} catch (error) {
			this.logger?.warn?.(`[pi-men] vector backfill failed: ${errorMessage(error)}`);
		}
	}

	/** Persist a completed turn (L0) and notify the distillation pipeline. */
	async capture(turn: CompletedTurn): Promise<void> {
		if (!this.config.capture.enabled) return;
		try {
			await this.recorder.record(turn);
			this.pipeline.notifyTurn();
		} catch (error) {
			this.logger?.warn?.(`[pi-men] capture failed: ${errorMessage(error)}`);
		}
	}

	/** Recall memories relevant to `userText`; returns undefined when nothing to inject. */
	async recall(userText: string): Promise<RecallResult | undefined> {
		if (!this.config.recall.enabled) return undefined;
		try {
			return await withTimeout(this.recallInner(userText), this.config.recall.timeoutMs);
		} catch (error) {
			this.logger?.warn?.(`[pi-men] recall failed: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private async recallInner(userText: string): Promise<RecallResult | undefined> {
		const hits = await this.searchMemoriesInternal(userText, this.config.recall.maxResults);
		const budgeted = applyRecallBudget(hits, this.config.recall.maxTotalRecallChars);
		return buildRecallResult({
			hits: budgeted,
			strategy: this.config.recall.strategy,
			config: this.config,
			paths: this.paths,
			sceneEntries: readSceneIndex(this.paths),
		});
	}

	/** Search L1 memories (hybrid when vectors are available, else keyword). */
	async searchMemories(params: SearchMemoriesParams): Promise<RecallHit[]> {
		const limit = Math.min(params.limit ?? 10, SEARCH_RESULT_CAP);
		try {
			const hits = await this.searchMemoriesInternal(params.query, limit, params.type);
			return hits.slice(0, limit);
		} catch (error) {
			this.logger?.warn?.(`[pi-men] memory search failed: ${errorMessage(error)}`);
			return [];
		}
	}

	private async searchMemoriesInternal(query: string, limit: number, type?: MemoryType): Promise<RecallHit[]> {
		const text = query.trim();
		if (!text) return [];
		const oversized = limit * 4;
		const matchQuery = buildFtsQuery(text);
		const keywordHits = matchQuery
			? this.store.searchMemoriesKeyword(matchQuery, oversized)
			: this.store.searchMemoriesLike(text, oversized);

		let vectorIds: string[] = [];
		if (this.embedding.isReady() && this.store.vectorCount("l1") > 0 && this.config.recall.strategy !== "keyword") {
			const [queryVector] = await this.embedding.embed([text]);
			if (queryVector) {
				vectorIds = this.store
					.searchVectors("l1", queryVector, oversized)
					.filter((hit) => hit.similarity >= this.config.recall.scoreThreshold)
					.map((hit) => hit.id);
			}
		}

		const fused = rrfFuse(
			keywordHits.map((hit) => hit.id),
			vectorIds,
			oversized,
		);
		const records = this.store.getMemories(fused.map((hit) => hit.id));
		const scoreById = new Map(fused.map((hit) => [hit.id, hit.score]));
		return records
			.filter((record) => (type ? record.type === type : true))
			.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
			.map((record) => toRecallHit(record, scoreById.get(record.id) ?? 0));
	}

	/** Search L0 conversations (keyword). */
	async searchConversations(params: SearchConversationsParams): Promise<ConversationHit[]> {
		const limit = Math.min(params.limit ?? 10, SEARCH_RESULT_CAP);
		try {
			const records = await this.recorder.search(params.query, limit, params.sessionKey);
			return records.map((record) => ({
				id: record.id,
				role: record.role,
				content: record.content,
				sessionKey: record.sessionKey,
				timestamp: record.timestamp,
				score: 1,
			}));
		} catch (error) {
			this.logger?.warn?.(`[pi-men] conversation search failed: ${errorMessage(error)}`);
			return [];
		}
	}

	/** Manually save a memory (/remember). */
	async remember(content: string, options?: RememberOptions): Promise<MemoryRecord> {
		return this.writer.remember(content, options ?? {});
	}

	stats(): MemoryStats {
		const personaExists = existsSync(this.paths.personaFile);
		return {
			l1Count: this.store.countMemories(),
			l0Count: this.store.countConversations(),
			sceneCount: this.pipeline.sceneCount(),
			personaExists,
			lastL1At: this.pipeline.state.lastL1At,
			lastL2At: this.pipeline.state.lastL2At,
			lastL3At: this.pipeline.state.lastL3At,
			strategy: this.config.recall.strategy,
			embedding: this.embedding.providerInfo(),
		};
	}

	/** Force pending L1 extraction now. */
	async flush(): Promise<void> {
		await this.pipeline.flush();
	}

	async destroy(): Promise<void> {
		await this.pipeline.destroy();
		this.store.close();
	}
}

function toRecallHit(record: MemoryRecord, score: number): RecallHit {
	return {
		id: record.id,
		content: record.content,
		type: record.type,
		priority: record.priority,
		sceneName: record.sceneName,
		createdAt: record.createdAt,
		score,
	};
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
	// Silence a late rejection from the losing side of the race.
	task.catch(() => undefined);
	return Promise.race([
		task,
		new Promise<T>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`recall timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

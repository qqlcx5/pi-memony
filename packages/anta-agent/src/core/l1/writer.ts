import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DedupDecision, ExtractedMemory, HostLogger, MemoryRecord, RememberOptions } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import { clampPriority } from "../parse.ts";
import { sanitizeUntrustedText } from "../security.ts";
import type { StoragePaths } from "../storage/paths.ts";
import type { EmbeddingService } from "../store/embedding.ts";
import type { SqliteMemoryStore } from "../store/sqlite-store.ts";

const MAX_MEMORY_CONTENT_CHARS = 100_000;
const MAX_SCENE_NAME_CHARS = 2_000;

let recordCounter = 0;

export function generateMemoryId(): string {
	recordCounter = (recordCounter + 1) % 0xffff;
	return `m_${Date.now().toString(36)}_${recordCounter.toString(36)}${randomBytes(2).toString("hex")}`;
}

export interface WriteResult {
	stored: MemoryRecord[];
	updated: MemoryRecord[];
	removedIds: string[];
	skipped: number;
	failedCandidateIds: string[];
	primaryWritesComplete: boolean;
	auditFailures: number;
}

/**
 * L1 writer: applies dedup decisions to the store and keeps the append-only
 * JSONL audit trail (records/YYYY-MM-DD.jsonl) in sync.
 */
export class MemoryWriter {
	private store: SqliteMemoryStore;
	private paths: StoragePaths;
	private embedding: EmbeddingService;
	private logger?: HostLogger;

	constructor(store: SqliteMemoryStore, paths: StoragePaths, embedding: EmbeddingService, logger?: HostLogger) {
		this.store = store;
		this.paths = paths;
		this.embedding = embedding;
		this.logger = logger;
	}

	/**
	 * Apply a batch of dedup decisions. Candidates referenced only by their
	 * temporary extraction id must be passed in `candidates`.
	 */
	async applyDecisions(
		decisions: readonly DedupDecision[],
		candidates: ReadonlyMap<string, ExtractedMemory>,
		source: { sessionKey: string; cwd?: string },
	): Promise<WriteResult> {
		const result: WriteResult = {
			stored: [],
			updated: [],
			removedIds: [],
			skipped: 0,
			failedCandidateIds: [],
			primaryWritesComplete: true,
			auditFailures: 0,
		};
		const now = new Date().toISOString();
		// Records already rewritten by an earlier decision in this batch: a later
		// fold into them would clobber that content (its merged text was computed
		// against the pre-update snapshot), so the later decision degrades to a
		// plain store instead.
		const rewritten = new Set<string>();
		for (const decision of decisions) {
			const candidate = candidates.get(decision.recordId);
			if (!candidate) {
				result.primaryWritesComplete = false;
				result.failedCandidateIds.push(decision.recordId);
				continue;
			}
			try {
				if (decision.action === "skip") {
					result.skipped += 1;
					if (!this.appendAudit(decision, candidate.content)) result.auditFailures += 1;
					continue;
				}

				const candidateContent = sanitizeUntrustedText(candidate.content, {
					maxChars: MAX_MEMORY_CONTENT_CHARS,
				}).trim();
				const candidateScene = sanitizeUntrustedText(candidate.sceneName, {
					maxChars: MAX_SCENE_NAME_CHARS,
				}).trim();
				if (!candidateContent) {
					result.primaryWritesComplete = false;
					result.failedCandidateIds.push(decision.recordId);
					continue;
				}

				if (decision.action === "store") {
					const record = makeStoredRecord(candidate, candidateContent, candidateScene, source, now);
					this.store.insertMemory(record);
					result.stored.push(record);
					if (!this.appendAudit(decision, record.content, record.id)) result.auditFailures += 1;
					continue;
				}

				// update / merge with unusable merge payload: keep the candidate as
				// a plain new record rather than dropping it.
				const mergedContent = decision.mergedContent
					? sanitizeUntrustedText(decision.mergedContent, { maxChars: MAX_MEMORY_CONTENT_CHARS }).trim()
					: "";
				if (!mergedContent || !decision.mergedType) {
					const record = makeStoredRecord(candidate, candidateContent, candidateScene, source, now);
					this.store.insertMemory(record);
					result.stored.push(record);
					if (!this.appendAudit({ ...decision, action: "store" }, record.content, record.id, [])) {
						result.auditFailures += 1;
					}
					continue;
				}

				const targets = this.store.getMemories(decision.targetIds);
				const reusable = targets.filter((target) => !rewritten.has(target.id));
				if (reusable.length === 0) {
					// Nothing to fold into: fall back to storing as a new record.
					const record = makeStoredRecord(
						candidate,
						mergedContent,
						candidateScene,
						source,
						now,
						decision.mergedType,
						decision.mergedPriority,
						decision.mergedTimestamps,
					);
					this.store.insertMemory(record);
					result.stored.push(record);
					if (!this.appendAudit({ ...decision, action: "store" }, record.content, record.id, [])) {
						result.auditFailures += 1;
					}
					continue;
				}

				const target = reusable[0]!;
				const removedNow = reusable.slice(1).map((extra) => extra.id);
				const timestamps = unionTimestamps(
					target.timestamps,
					decision.mergedTimestamps ?? [],
					reusable.slice(1).flatMap((extra) => extra.timestamps),
				);
				const fields = {
					content: mergedContent,
					type: decision.mergedType,
					priority: decision.mergedPriority ?? target.priority,
					// Merged records follow the latest conversation's scene.
					sceneName: candidateScene,
					timestamps,
					version: target.version + 1,
					updatedAt: now,
				};
				this.store.updateMemory(target.id, fields);
				const updated: MemoryRecord = { ...target, ...fields };
				result.updated.push(updated);
				result.removedIds.push(...removedNow);
				if (removedNow.length > 0) this.store.deleteMemories(removedNow);
				for (const used of reusable) rewritten.add(used.id);
				if (!this.appendAudit(decision, updated.content, target.id, removedNow)) result.auditFailures += 1;
			} catch (error) {
				result.primaryWritesComplete = false;
				result.failedCandidateIds.push(decision.recordId);
				this.logger?.warn?.(`[anta-agent] failed to apply ${decision.action} decision: ${errorMessage(error)}`);
			}
		}
		await this.embedRecords(
			[...result.stored, ...result.updated],
			result.updated.map((record) => record.id),
		);
		return result;
	}

	/** Manual save (/remember): write directly, bypassing dedup. */
	async remember(content: string, options: RememberOptions): Promise<MemoryRecord> {
		const now = new Date().toISOString();
		const safeContent = sanitizeUntrustedText(content, { maxChars: MAX_MEMORY_CONTENT_CHARS }).trim();
		if (!safeContent) throw new Error("memory content must not be empty");
		const record: MemoryRecord = {
			id: generateMemoryId(),
			content: safeContent,
			type: options.type ?? "instruction",
			priority: clampPriority(options.priority ?? 90, 90),
			sceneName: "手动记录",
			sourceMessageIds: [],
			metadata: {},
			timestamps: [now],
			createdAt: now,
			updatedAt: now,
			version: 1,
			sessionKey: options.sessionKey ?? "manual",
			...(options.cwd ? { cwd: options.cwd } : {}),
		};
		this.store.insertMemory(record);
		await this.embedRecords([record]);
		if (!this.appendAudit({ recordId: record.id, action: "store", targetIds: [] }, record.content, record.id)) {
			this.logger?.warn?.("[anta-agent] manual memory saved without an audit entry");
		}
		return record;
	}

	private async embedRecords(
		records: readonly MemoryRecord[],
		staleIdsOnFailure: readonly string[] = [],
	): Promise<void> {
		if (!this.embedding.isReady() || records.length === 0) return;
		try {
			const vectors = await this.embedding.embed(records.map((record) => record.content));
			if (vectors.length !== records.length) throw new Error("embedding count does not match records");
			for (let i = 0; i < records.length; i++) {
				const vector = vectors[i];
				if (!vector || vector.some((value) => !Number.isFinite(value))) {
					throw new Error("embedding contains an invalid vector");
				}
				if (vector.length > 0) this.store.putVector("l1", records[i]!.id, vector);
			}
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L1 embedding failed: ${errorMessage(error)}`);
			// Updated records would keep vectors of their pre-merge content;
			// drop them so recall never matches stale text (backfill re-embeds).
			if (staleIdsOnFailure.length > 0) this.store.removeVectors("l1", staleIdsOnFailure);
		}
	}

	private appendAudit(
		decision: DedupDecision,
		content: string,
		targetId?: string,
		replacedIds: readonly string[] = decision.targetIds,
	): boolean {
		try {
			mkdirSync(this.paths.recordsDir, { recursive: true });
			const day = new Date().toISOString().slice(0, 10);
			const line = JSON.stringify({
				at: new Date().toISOString(),
				action: decision.action,
				target: targetId ?? decision.recordId,
				replaced: [...replacedIds],
				content: sanitizeUntrustedText(content, { maxChars: MAX_MEMORY_CONTENT_CHARS }),
			});
			appendFileSync(join(this.paths.recordsDir, `${day}.jsonl`), `${line}\n`, "utf8");
			return true;
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] records jsonl append failed: ${errorMessage(error)}`);
			return false;
		}
	}
}

function makeStoredRecord(
	candidate: ExtractedMemory,
	content: string,
	sceneName: string,
	source: { sessionKey: string; cwd?: string },
	now: string,
	type = candidate.type,
	priority = candidate.priority,
	timestamps: readonly string[] = [now],
): MemoryRecord {
	return {
		id: generateMemoryId(),
		content,
		type,
		priority: clampPriority(priority),
		sceneName,
		sourceMessageIds: candidate.sourceMessageIds,
		metadata: candidate.metadata,
		timestamps: [...timestamps],
		createdAt: now,
		updatedAt: now,
		version: 1,
		sessionKey: source.sessionKey,
		...(source.cwd ? { cwd: source.cwd } : {}),
	};
}

function unionTimestamps(...groups: readonly string[][]): string[] {
	const set = new Set<string>();
	for (const group of groups) {
		for (const timestamp of group) {
			if (timestamp) set.add(timestamp);
		}
	}
	return [...set].sort();
}

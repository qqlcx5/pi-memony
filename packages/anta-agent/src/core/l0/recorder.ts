import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CompletedTurn, HostLogger } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import type { StoragePaths } from "../storage/paths.ts";
import { buildFtsQuery, type L0Record, type SqliteMemoryStore } from "../store/sqlite-store.ts";

/**
 * Deterministic L0 id: re-recording the same message (overlapping agent_end
 * payloads, replays) is a no-op via INSERT OR IGNORE.
 */
export function makeConversationId(sessionKey: string, role: string, timestamp: number, content: string): string {
	const hash = createHash("sha1").update(`${sessionKey}\u0000${role}\u0000${timestamp}\u0000${content}`).digest("hex");
	return `c_${hash.slice(0, 20)}`;
}

/**
 * L0 conversation recorder: full-fidelity raw messages, persisted to SQLite
 * (keyword retrieval) and to append-only daily JSONL files (source of truth).
 */
export class ConversationRecorder {
	private store: SqliteMemoryStore;
	private paths: StoragePaths;
	private logger?: HostLogger;

	constructor(store: SqliteMemoryStore, paths: StoragePaths, logger?: HostLogger) {
		this.store = store;
		this.paths = paths;
		this.logger = logger;
	}

	async record(turn: CompletedTurn): Promise<void> {
		const records: L0Record[] = turn.messages
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => ({
				id:
					message.id ||
					makeConversationId(turn.sessionKey, message.role, message.timestamp || Date.now(), message.content),
				sessionKey: turn.sessionKey,
				role: message.role,
				content: message.content,
				timestamp: message.timestamp || Date.now(),
			}));
		if (records.length === 0) return;
		// The store dedupes replays; only rows actually inserted belong in the
		// append-only JSONL audit trail (also collapse duplicate ids within one
		// turn, e.g. same role/content/ms messages hashing identically).
		const inserted = new Set(this.store.insertConversations(records));
		const fresh: L0Record[] = [];
		const seen = new Set<string>();
		for (const record of records) {
			if (!inserted.has(record.id) || seen.has(record.id)) continue;
			seen.add(record.id);
			fresh.push(record);
		}
		if (fresh.length === 0) return;
		this.appendJsonl(fresh);
	}

	private appendJsonl(records: L0Record[]): void {
		try {
			mkdirSync(this.paths.conversationsDir, { recursive: true });
			const byDay = new Map<string, L0Record[]>();
			for (const record of records) {
				const day = new Date(record.timestamp).toISOString().slice(0, 10);
				const bucket = byDay.get(day) ?? [];
				bucket.push(record);
				byDay.set(day, bucket);
			}
			for (const [day, dayRecords] of byDay) {
				const lines = dayRecords.map((record) => JSON.stringify(record)).join("\n");
				appendFileSync(join(this.paths.conversationsDir, `${day}.jsonl`), `${lines}\n`, "utf8");
			}
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L0 jsonl append failed: ${errorMessage(error)}`);
		}
	}

	async search(query: string, limit: number, sessionKey?: string): Promise<L0Record[]> {
		const matchQuery = buildFtsQuery(query);
		const hits = matchQuery
			? this.store.searchConversationsKeyword(matchQuery, limit, sessionKey)
			: this.store.searchConversationsLike(query, limit, sessionKey);
		if (hits.length === 0) return [];
		// getConversations' IN-list has no defined order; restore the ranking.
		const byId = new Map(this.store.getConversations(hits.map((hit) => hit.id)).map((row) => [row.id, row]));
		return hits.map((hit) => byId.get(hit.id)).filter((row): row is L0Record => row !== undefined);
	}

	count(): number {
		return this.store.countConversations();
	}

	/** Drop L0 rows (and whole expired JSONL day files) older than the retention window. */
	cleanup(retentionDays: number): number {
		if (retentionDays <= 0) return 0;
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		const deleted = this.store.deleteConversationsBefore(cutoff);
		this.pruneJsonl(cutoff);
		return deleted;
	}

	/** Remove JSONL day files wholly older than the cutoff; partial days stay. */
	private pruneJsonl(cutoff: number): void {
		try {
			if (!existsSync(this.paths.conversationsDir)) return;
			const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
			for (const name of readdirSync(this.paths.conversationsDir)) {
				if (!name.endsWith(".jsonl")) continue;
				if (name.slice(0, 10) < cutoffDay) rmSync(join(this.paths.conversationsDir, name));
			}
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L0 jsonl prune failed: ${errorMessage(error)}`);
		}
	}
}

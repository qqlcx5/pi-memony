import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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
		this.store.insertConversations(records);
		this.appendJsonl(records);
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
			this.logger?.warn?.(`[pi-men] L0 jsonl append failed: ${errorMessage(error)}`);
		}
	}

	async search(query: string, limit: number, sessionKey?: string): Promise<L0Record[]> {
		const matchQuery = buildFtsQuery(query);
		const hits = matchQuery
			? this.store.searchConversationsKeyword(matchQuery, limit, sessionKey)
			: this.store.searchConversationsLike(query, limit);
		return this.store.getConversations(hits.map((hit) => hit.id));
	}

	count(): number {
		return this.store.countConversations();
	}

	cleanup(retentionDays: number): number {
		if (retentionDays <= 0) return 0;
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		return this.store.deleteConversationsBefore(cutoff);
	}
}

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CompletedTurn, HostLogger } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import { sanitizeUntrustedText } from "../security.ts";
import type { StoragePaths } from "../storage/paths.ts";
import { buildFtsQuery, type L0Record, type SqliteMemoryStore } from "../store/sqlite-store.ts";

const MAX_CONTENT_CHARS = 200_000;
const MAX_SESSION_KEY_CHARS = 8_192;
const MAX_JSONL_LINE_CHARS = 1_000_000;
const JSONL_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Deterministic L0 id: re-recording the same message (overlapping agent_end
 * payloads, replays) is a no-op via INSERT OR IGNORE.
 */
export function makeConversationId(sessionKey: string, role: string, timestamp: number, content: string): string {
	const hash = createHash("sha1").update(`${sessionKey}\u0000${role}\u0000${timestamp}\u0000${content}`).digest("hex");
	return `c_${hash.slice(0, 20)}`;
}

/**
 * L0 conversation recorder. JSONL is the recovery log; SQLite/FTS is a
 * rebuildable projection. The log is written before the projection so a
 * process crash cannot leave a SQLite row with no recovery record.
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
		const records: L0Record[] = [];
		for (const message of turn.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const content = sanitizeUntrustedText(message.content, { maxChars: MAX_CONTENT_CHARS }).trim();
			if (!content) continue;
			const timestamp = Number.isFinite(message.timestamp) ? Math.trunc(message.timestamp) : Date.now();
			records.push({
				id: message.id || makeConversationId(turn.sessionKey, message.role, timestamp, content),
				sessionKey: turn.sessionKey,
				role: message.role,
				content,
				timestamp,
			});
		}
		if (records.length === 0) return;
		const unique = dedupeRecords(records);
		if (!this.appendJsonl(unique)) throw new Error("L0 recovery log append failed");
		this.store.insertConversations(unique);
	}

	/** Replay valid recovery-log rows into the SQLite projection. */
	replayJsonl(): number {
		if (!existsSync(this.paths.conversationsDir)) return 0;
		let restored = 0;
		for (const file of readdirSync(this.paths.conversationsDir).filter((name) => JSONL_FILE_RE.test(name))) {
			try {
				const raw = readFileSync(join(this.paths.conversationsDir, file), "utf8");
				const records: L0Record[] = [];
				for (const line of raw.split("\n")) {
					if (!line.trim() || line.length > MAX_JSONL_LINE_CHARS) continue;
					try {
						const record = parsePersistedRecord(JSON.parse(line));
						if (record) records.push(record);
					} catch {
						// One malformed line must not hide later recoverable rows.
					}
				}
				if (records.length > 0) restored += this.store.insertConversations(dedupeRecords(records)).length;
			} catch (error) {
				this.logger?.warn?.(`[anta-agent] L0 recovery replay failed for ${file}: ${errorMessage(error)}`);
			}
		}
		return restored;
	}

	/** Append only rows not already present in the recovery log. */
	private appendJsonl(records: readonly L0Record[]): boolean {
		try {
			mkdirSync(this.paths.conversationsDir, { recursive: true });
			const knownIds = this.readJsonlIds();
			const fresh = records.filter((record) => !knownIds.has(record.id));
			if (fresh.length === 0) return true;
			const byDay = new Map<string, L0Record[]>();
			for (const record of fresh) {
				const day = new Date(record.timestamp).toISOString().slice(0, 10);
				const bucket = byDay.get(day) ?? [];
				bucket.push(record);
				byDay.set(day, bucket);
			}
			for (const [day, dayRecords] of byDay) {
				const lines = dayRecords.map((record) => JSON.stringify(record)).join("\n");
				appendFileSync(join(this.paths.conversationsDir, `${day}.jsonl`), `${lines}\n`, "utf8");
			}
			return true;
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L0 jsonl append failed: ${errorMessage(error)}`);
			return false;
		}
	}

	private readJsonlIds(): Set<string> {
		const ids = new Set<string>();
		try {
			for (const file of readdirSync(this.paths.conversationsDir).filter((name) => JSONL_FILE_RE.test(name))) {
				for (const line of readFileSync(join(this.paths.conversationsDir, file), "utf8").split("\n")) {
					if (line.length > MAX_JSONL_LINE_CHARS) continue;
					try {
						const value = JSON.parse(line) as { id?: unknown };
						if (typeof value.id === "string" && value.id) ids.add(value.id);
					} catch {
						// Ignore malformed historical lines; replay handles them separately.
					}
				}
			}
		} catch {
			// The append operation below reports the actual filesystem failure.
		}
		return ids;
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
				if (!JSONL_FILE_RE.test(name)) continue;
				if (name.slice(0, 10) < cutoffDay) rmSync(join(this.paths.conversationsDir, name));
			}
		} catch (error) {
			this.logger?.warn?.(`[anta-agent] L0 jsonl prune failed: ${errorMessage(error)}`);
		}
	}
}

function dedupeRecords(records: readonly L0Record[]): L0Record[] {
	const seen = new Set<string>();
	return records.filter((record) => {
		if (seen.has(record.id)) return false;
		seen.add(record.id);
		return true;
	});
}

function parsePersistedRecord(value: unknown): L0Record | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : "";
	const role = record.role === "user" || record.role === "assistant" ? record.role : null;
	const rawContent = typeof record.content === "string" ? record.content : "";
	const timestamp = typeof record.timestamp === "number" ? record.timestamp : NaN;
	if (!role || !sessionKey || sessionKey.length > MAX_SESSION_KEY_CHARS || /\u0000/.test(sessionKey)) return null;
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
	const content = sanitizeUntrustedText(rawContent, { maxChars: MAX_CONTENT_CHARS }).trim();
	if (!content) return null;
	const id =
		typeof record.id === "string" && record.id ? record.id : makeConversationId(sessionKey, role, timestamp, content);
	return { id, sessionKey, role, content, timestamp };
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { MemoryMetadata, MemoryRecord, MemoryType } from "../../types.ts";
import type { VectorSearchHit } from "./vector-index.ts";
import { decodeVector, encodeVector, VectorIndex } from "./vector-index.ts";

export interface L0Record {
	id: string;
	sessionKey: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface KeywordSearchHit {
	id: string;
	relevance: number;
}

export interface L0KeywordSearchHit extends KeywordSearchHit {
	sessionKey?: string;
}

export type VectorTable = "l1" | "l0";

interface L1Row {
	record_id: string;
	content: string;
	type: string;
	priority: number;
	scene_name: string;
	source_message_ids: string;
	metadata_json: string;
	timestamps_json: string;
	version: number;
	session_key: string;
	cwd: string | null;
	created_time: string;
	updated_time: string;
}

interface L0Row {
	record_id: string;
	session_key: string;
	role: string;
	message_text: string;
	timestamp: number;
}

interface VecRow {
	record_id: string;
	dims: number;
	emb: Uint8Array;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS l1_records (
	record_id TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	type TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 50,
	scene_name TEXT NOT NULL DEFAULT '',
	source_message_ids TEXT NOT NULL DEFAULT '[]',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	timestamps_json TEXT NOT NULL DEFAULT '[]',
	version INTEGER NOT NULL DEFAULT 1,
	session_key TEXT NOT NULL DEFAULT '',
	cwd TEXT,
	created_time TEXT NOT NULL,
	updated_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l0_conversations (
	record_id TEXT PRIMARY KEY,
	session_key TEXT NOT NULL,
	role TEXT NOT NULL,
	message_text TEXT NOT NULL,
	timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp);
CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(record_id UNINDEXED, content, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(record_id UNINDEXED, message_text, tokenize='trigram');
CREATE TABLE IF NOT EXISTS l1_vec (record_id TEXT PRIMARY KEY, dims INTEGER NOT NULL, emb BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS l0_vec (record_id TEXT PRIMARY KEY, dims INTEGER NOT NULL, emb BLOB NOT NULL);
`;

/** Minimum term length the trigram tokenizer can match. */
const TRIGRAM_MIN = 3;

export class SqliteMemoryStore {
	private db: DatabaseSync;
	private statements: Map<string, StatementSync>;
	private l1Vectors: VectorIndex;
	private l0Vectors: VectorIndex;
	private l1VectorsLoaded = false;
	private l0VectorsLoaded = false;

	constructor(dbPath: string) {
		// The store owns its path: first run has no memory/ directory yet.
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.statements = new Map();
		this.l1Vectors = new VectorIndex();
		this.l0Vectors = new VectorIndex();
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}

	private prepare(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	// ── L1 records ──────────────────────────────────────────────────────────

	insertMemory(record: MemoryRecord, embedding?: Float32Array): void {
		this.transaction(() => {
			this.prepare(
				`INSERT INTO l1_records
					(record_id, content, type, priority, scene_name, source_message_ids, metadata_json,
					 timestamps_json, version, session_key, cwd, created_time, updated_time)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				record.id,
				record.content,
				record.type,
				record.priority,
				record.sceneName,
				JSON.stringify(record.sourceMessageIds),
				JSON.stringify(record.metadata),
				JSON.stringify(record.timestamps),
				record.version,
				record.sessionKey,
				record.cwd ?? null,
				record.createdAt,
				record.updatedAt,
			);
			this.prepare("INSERT INTO l1_fts (record_id, content) VALUES (?, ?)").run(record.id, record.content);
			if (embedding) this.putVector("l1", record.id, embedding);
		});
	}

	/** Replace content-bearing fields of an existing record (update/merge path). */
	updateMemory(
		id: string,
		fields: {
			content: string;
			type: MemoryType;
			priority: number;
			timestamps: string[];
			version: number;
			updatedAt: string;
		},
		embedding?: Float32Array,
	): void {
		this.transaction(() => {
			const result = this.prepare(
				`UPDATE l1_records
				 SET content = ?, type = ?, priority = ?, timestamps_json = ?, version = ?, updated_time = ?
				 WHERE record_id = ?`,
			).run(
				fields.content,
				fields.type,
				fields.priority,
				JSON.stringify(fields.timestamps),
				fields.version,
				fields.updatedAt,
				id,
			);
			if (result.changes === 0) throw new Error(`updateMemory: record ${id} not found`);
			this.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(id);
			this.prepare("INSERT INTO l1_fts (record_id, content) VALUES (?, ?)").run(id, fields.content);
			if (embedding) this.putVector("l1", id, embedding);
		});
	}

	deleteMemories(ids: readonly string[]): void {
		if (ids.length === 0) return;
		this.transaction(() => {
			for (const id of ids) {
				this.prepare("DELETE FROM l1_records WHERE record_id = ?").run(id);
				this.prepare("DELETE FROM l1_fts WHERE record_id = ?").run(id);
				this.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id);
			}
		});
		this.l1Vectors.remove(ids);
	}

	getMemories(ids: readonly string[]): MemoryRecord[] {
		if (ids.length === 0) return [];
		const statement = this.prepare(`SELECT * FROM l1_records WHERE record_id IN (${ids.map(() => "?").join(",")})`);
		return (statement.all(...ids) as unknown as L1Row[]).map(rowToMemory);
	}

	recentMemories(limit: number): MemoryRecord[] {
		const rows = this.prepare("SELECT * FROM l1_records ORDER BY updated_time DESC LIMIT ?").all(
			limit,
		) as unknown as L1Row[];
		return rows.map(rowToMemory);
	}

	memoriesUpdatedSince(iso: string, limit: number): MemoryRecord[] {
		const rows = this.prepare(
			"SELECT * FROM l1_records WHERE updated_time > ? ORDER BY updated_time ASC LIMIT ?",
		).all(iso, limit) as unknown as L1Row[];
		return rows.map(rowToMemory);
	}

	countMemories(): number {
		return (this.prepare("SELECT COUNT(*) AS n FROM l1_records").get() as { n: number }).n;
	}

	searchMemoriesKeyword(matchQuery: string | null, limit: number): KeywordSearchHit[] {
		if (matchQuery) {
			const rows = this.prepare(
				"SELECT record_id, bm25(l1_fts) AS score FROM l1_fts WHERE l1_fts MATCH ? ORDER BY score LIMIT ?",
			).all(matchQuery, limit) as { record_id: string; score: number }[];
			return rows.map((row) => ({ id: row.record_id, relevance: bm25ToRelevance(row.score) }));
		}
		// Trigram cannot match terms under three characters; fall back to LIKE.
		return [];
	}

	/** Substring fallback for queries the trigram tokenizer cannot match. */
	searchMemoriesLike(rawQuery: string, limit: number): KeywordSearchHit[] {
		const needle = `%${escapeLike(rawQuery.trim())}%`;
		if (needle === "%%") return [];
		const rows = this.prepare(
			"SELECT record_id FROM l1_records WHERE content LIKE ? ESCAPE '\\' ORDER BY updated_time DESC LIMIT ?",
		).all(needle, limit) as { record_id: string }[];
		return rows.map((row) => ({ id: row.record_id, relevance: 0.5 }));
	}

	// ── L0 conversations ────────────────────────────────────────────────────

	insertConversations(records: readonly L0Record[], embeddings?: readonly (Float32Array | undefined)[]): void {
		this.transaction(() => {
			for (let i = 0; i < records.length; i++) {
				const record = records[i]!;
				this.prepare(
					"INSERT OR IGNORE INTO l0_conversations (record_id, session_key, role, message_text, timestamp) VALUES (?, ?, ?, ?, ?)",
				).run(record.id, record.sessionKey, record.role, record.content, record.timestamp);
				this.prepare("INSERT OR IGNORE INTO l0_fts (record_id, message_text) VALUES (?, ?)").run(
					record.id,
					record.content,
				);
				const embedding = embeddings?.[i];
				if (embedding) this.putVector("l0", record.id, embedding);
			}
		});
	}

	searchConversationsKeyword(matchQuery: string | null, limit: number, sessionKey?: string): L0KeywordSearchHit[] {
		if (!matchQuery) return [];
		if (sessionKey) {
			const rows = this.prepare(
				`SELECT f.record_id AS record_id, bm25(l0_fts) AS score
				 FROM l0_fts f JOIN l0_conversations c ON c.record_id = f.record_id
				 WHERE l0_fts MATCH ? AND c.session_key = ?
				 ORDER BY score LIMIT ?`,
			).all(matchQuery, sessionKey, limit) as { record_id: string; score: number }[];
			return rows.map((row) => ({ id: row.record_id, relevance: bm25ToRelevance(row.score), sessionKey }));
		}
		const rows = this.prepare(
			"SELECT record_id, bm25(l0_fts) AS score FROM l0_fts WHERE l0_fts MATCH ? ORDER BY score LIMIT ?",
		).all(matchQuery, limit) as { record_id: string; score: number }[];
		return rows.map((row) => ({ id: row.record_id, relevance: bm25ToRelevance(row.score) }));
	}

	/** Substring fallback for conversations, mirroring searchMemoriesLike. */
	searchConversationsLike(rawQuery: string, limit: number): L0KeywordSearchHit[] {
		const needle = `%${escapeLike(rawQuery.trim())}%`;
		if (needle === "%%") return [];
		const rows = this.prepare(
			`SELECT record_id, session_key FROM l0_conversations
			 WHERE message_text LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT ?`,
		).all(needle, limit) as { record_id: string; session_key: string }[];
		return rows.map((row) => ({ id: row.record_id, relevance: 0.5, sessionKey: row.session_key }));
	}

	getConversations(ids: readonly string[]): L0Record[] {
		if (ids.length === 0) return [];
		const statement = this.prepare(
			`SELECT record_id, session_key, role, message_text, timestamp FROM l0_conversations
			 WHERE record_id IN (${ids.map(() => "?").join(",")})`,
		);
		return (statement.all(...ids) as unknown as L0Row[]).map(rowToL0);
	}

	conversationsSince(timestamp: number, limit: number): L0Record[] {
		const rows = this.prepare(
			`SELECT record_id, session_key, role, message_text, timestamp FROM l0_conversations
			 WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?`,
		).all(timestamp, limit) as unknown as L0Row[];
		return rows.map(rowToL0);
	}

	/** Up to `limit` messages at or before `timestamp`, oldest first. */
	conversationsBefore(timestamp: number, limit: number): L0Record[] {
		const rows = this.prepare(
			`SELECT record_id, session_key, role, message_text, timestamp FROM l0_conversations
			 WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT ?`,
		).all(timestamp, limit) as unknown as L0Row[];
		return rows.map(rowToL0).reverse();
	}

	countConversations(): number {
		return (this.prepare("SELECT COUNT(*) AS n FROM l0_conversations").get() as { n: number }).n;
	}

	deleteConversationsBefore(timestamp: number): number {
		const ids = this.prepare("SELECT record_id FROM l0_conversations WHERE timestamp < ? LIMIT 5000").all(
			timestamp,
		) as { record_id: string }[];
		if (ids.length === 0) return 0;
		this.transaction(() => {
			for (const { record_id } of ids) {
				this.prepare("DELETE FROM l0_conversations WHERE record_id = ?").run(record_id);
				this.prepare("DELETE FROM l0_fts WHERE record_id = ?").run(record_id);
				this.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(record_id);
			}
		});
		this.l0Vectors.remove(ids.map((row) => row.record_id));
		return ids.length;
	}

	// ── Vector storage ──────────────────────────────────────────────────────

	putVector(table: VectorTable, id: string, vector: Float32Array): void {
		this.prepare(`INSERT OR REPLACE INTO ${table}_vec (record_id, dims, emb) VALUES (?, ?, ?)`).run(
			id,
			vector.length,
			encodeVector(vector),
		);
		if (table === "l1") this.l1Vectors.upsert(id, vector);
		else this.l0Vectors.upsert(id, vector);
	}

	/**
	 * Record the active embedding setup; returns true when it changed since the
	 * last call, in which case stored vectors are stale and must be reindexed.
	 */
	setEmbeddingMeta(provider: string, model: string, dimensions: number): boolean {
		const previous = this.getEmbeddingMeta();
		const changed = previous.provider !== provider || previous.model !== model || previous.dimensions !== dimensions;
		if (changed) {
			this.prepare("DELETE FROM l1_vec").run();
			this.prepare("DELETE FROM l0_vec").run();
			this.l1Vectors.clear();
			this.l0Vectors.clear();
		}
		this.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding', ?)").run(
			JSON.stringify({ provider, model, dimensions }),
		);
		return changed;
	}

	getEmbeddingMeta(): { provider: string; model: string; dimensions: number } {
		const row = this.prepare("SELECT value FROM meta WHERE key = 'embedding'").get() as { value: string } | undefined;
		if (!row) return { provider: "", model: "", dimensions: 0 };
		try {
			const parsed = JSON.parse(row.value) as { provider?: string; model?: string; dimensions?: number };
			return { provider: parsed.provider ?? "", model: parsed.model ?? "", dimensions: parsed.dimensions ?? 0 };
		} catch {
			return { provider: "", model: "", dimensions: 0 };
		}
	}

	/** Load (once) and return the in-memory vector index for a table. */
	vectorIndex(table: VectorTable): VectorIndex {
		if (table === "l1") {
			if (!this.l1VectorsLoaded) {
				this.l1Vectors.load(this.readVectorRows("l1"));
				this.l1VectorsLoaded = true;
			}
			return this.l1Vectors;
		}
		if (!this.l0VectorsLoaded) {
			this.l0Vectors.load(this.readVectorRows("l0"));
			this.l0VectorsLoaded = true;
		}
		return this.l0Vectors;
	}

	searchVectors(table: VectorTable, query: Float32Array, limit: number): VectorSearchHit[] {
		return this.vectorIndex(table).search(query, limit);
	}

	private readVectorRows(table: VectorTable): { id: string; dims: number; vector: Float32Array }[] {
		const rows = this.prepare(`SELECT record_id, dims, emb FROM ${table}_vec`).all() as unknown as VecRow[];
		return rows.map((row) => ({ id: row.record_id, dims: row.dims, vector: decodeVector(row.emb) }));
	}

	vectorCount(table: VectorTable): number {
		return (this.prepare(`SELECT COUNT(*) AS n FROM ${table}_vec`).get() as { n: number }).n;
	}

	hasVector(table: VectorTable, id: string): boolean {
		return this.prepare(`SELECT 1 FROM ${table}_vec WHERE record_id = ?`).get(id) !== undefined;
	}
}

/**
 * Build an FTS5 MATCH query for the trigram tokenizer: whitespace-separated
 * terms, each quoted, joined with OR. Terms shorter than three characters
 * cannot match trigrams and are dropped. Returns null when no term survives.
 */
export function buildFtsQuery(query: string): string | null {
	const terms = query
		.split(/\s+/)
		.map((term) => term.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
		.filter((term) => term.length >= TRIGRAM_MIN);
	if (terms.length === 0) return null;
	const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
	return quoted.join(" OR ");
}

/**
 * Map an FTS5 bm25() score to a 0..1 relevance where stronger matches score
 * higher. bm25() returns "smaller is better" (large negative for strong hits).
 */
export function bm25ToRelevance(score: number): number {
	return 1 - 1 / (1 + Math.abs(score));
}

function escapeLike(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function rowToMemory(row: L1Row): MemoryRecord {
	return {
		id: row.record_id,
		content: row.content,
		type: row.type as MemoryType,
		priority: row.priority,
		sceneName: row.scene_name,
		sourceMessageIds: parseJsonArray(row.source_message_ids),
		metadata: parseJsonObject(row.metadata_json),
		timestamps: parseJsonArray(row.timestamps_json),
		createdAt: row.created_time,
		updatedAt: row.updated_time,
		version: row.version,
		sessionKey: row.session_key,
		...(row.cwd ? { cwd: row.cwd } : {}),
	};
}

function rowToL0(row: L0Row): L0Record {
	return {
		id: row.record_id,
		sessionKey: row.session_key,
		role: row.role === "assistant" ? "assistant" : "user",
		content: row.message_text,
		timestamp: row.timestamp,
	};
}

function parseJsonArray(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function parseJsonObject(raw: string): MemoryMetadata {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** L1 memory types extracted in chat mode. */
export type ChatMemoryType = "persona" | "episodic" | "instruction";

/** L1 memory types extracted in code (work) mode. */
export type WorkMemoryType = "work_fact" | "work_task" | "work_method" | "work_artifact";

export type MemoryType = ChatMemoryType | WorkMemoryType;

export type MemoryMetadataValue = string | number | boolean | null;
export type MemoryMetadata = Record<string, MemoryMetadataValue>;

/**
 * A single L1 atomic memory record.
 * `priority` is 0-100, or -1 for a strict global instruction.
 */
export interface MemoryRecord {
	id: string;
	content: string;
	type: MemoryType;
	priority: number;
	sceneName: string;
	sourceMessageIds: string[];
	metadata: MemoryMetadata;
	/** Union of timestamps of all records folded into this one (merge history). */
	timestamps: string[];
	createdAt: string;
	updatedAt: string;
	version: number;
	sessionKey: string;
	cwd?: string;
}

/** One side of an L0 conversation. */
export interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** Epoch milliseconds. */
	timestamp: number;
}

/** A finished agent turn captured by the host for L0 recording and extraction. */
export interface CompletedTurn {
	sessionKey: string;
	cwd?: string;
	messages: ConversationMessage[];
}

/** Memory candidate produced by L1 extraction, before dedup/conflict resolution. */
export interface ExtractedMemory {
	/** Temporary id used to reference this candidate in dedup decisions. */
	recordId: string;
	content: string;
	type: MemoryType;
	priority: number;
	sceneName: string;
	sourceMessageIds: string[];
	metadata: MemoryMetadata;
}

/** Result of L1 extraction: scene segmentation plus extracted memories. */
export interface SceneExtraction {
	sceneName: string;
	messageIds: string[];
	memories: ExtractedMemory[];
}

export type DedupAction = "store" | "update" | "merge" | "skip";

/** Decision for one extracted memory against the existing record pool. */
export interface DedupDecision {
	/** The extracted candidate this decision applies to. */
	recordId: string;
	action: DedupAction;
	/** Existing records replaced/deleted by an update/merge. */
	targetIds: string[];
	mergedContent?: string;
	mergedType?: MemoryType;
	mergedPriority?: number;
	mergedTimestamps?: string[];
}

export interface LlmRunParams {
	systemPrompt: string;
	userPrompt: string;
	maxTokens?: number;
	signal?: AbortSignal;
}

/** Host-provided single-shot text completion used by the extraction pipeline. */
export type LlmRunner = (params: LlmRunParams) => Promise<string>;

export interface HostLogger {
	debug?: (message: string) => void;
	info?: (message: string) => void;
	warn?: (message: string) => void;
	error?: (message: string) => void;
}

export type RecallStrategy = "keyword" | "embedding" | "hybrid";

export interface RecallHit {
	id: string;
	content: string;
	type: MemoryType;
	priority: number;
	sceneName: string;
	createdAt: string;
	score: number;
}

export interface ConversationHit {
	id: string;
	role: "user" | "assistant";
	content: string;
	sessionKey: string;
	timestamp: number;
	score: number;
}

export interface RecallResult {
	/** Dynamic per-turn context, prepended to the user message as `<relevant-memories>`. */
	prependContext?: string;
	/** Stable, cacheable context appended to the system prompt (persona, scene navigation, tools guide). */
	appendSystemContext?: string;
	hits: RecallHit[];
	strategy: RecallStrategy;
}

export interface SearchMemoriesParams {
	query: string;
	limit?: number;
	type?: MemoryType;
}

export interface SearchConversationsParams {
	query: string;
	limit?: number;
	sessionKey?: string;
}

export interface MemoryStats {
	l1Count: number;
	l0Count: number;
	sceneCount: number;
	personaExists: boolean;
	lastL1At: string | null;
	lastL2At: string | null;
	lastL3At: string | null;
	strategy: RecallStrategy;
	embedding: string;
}

export interface RememberOptions {
	type?: MemoryType;
	priority?: number;
	sessionKey?: string;
	cwd?: string;
}

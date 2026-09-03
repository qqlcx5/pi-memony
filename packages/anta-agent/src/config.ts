import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RecallStrategy } from "./types.ts";

export type PromptMode = "chat" | "code";
export type EmbeddingProvider = "none" | "openai";

export interface CaptureConfigInput {
	enabled?: boolean;
	/** Days to keep L0 conversation rows/lines; 0 disables cleanup. */
	l0RetentionDays?: number;
}

export interface ExtractionConfigInput {
	enabled?: boolean;
	enableDedup?: boolean;
	maxMemoriesPerSession?: number;
}

export interface PersonaConfigInput {
	triggerEveryN?: number;
	maxScenes?: number;
	backupCount?: number;
	/** Scene-block snapshots kept under .backup/scene_blocks/ before each L2 pass. */
	sceneBackupCount?: number;
}

export interface PipelineConfigInput {
	everyNConversations?: number;
	enableWarmup?: boolean;
	l1IdleTimeoutSeconds?: number;
	l2DelayAfterL1Seconds?: number;
	l2MinIntervalSeconds?: number;
	l2MaxIntervalSeconds?: number;
}

export interface RecallConfigInput {
	enabled?: boolean;
	maxResults?: number;
	maxCharsPerMemory?: number;
	maxTotalRecallChars?: number;
	scoreThreshold?: number;
	strategy?: RecallStrategy;
	timeoutMs?: number;
}

export interface EmbeddingConfigInput {
	provider?: EmbeddingProvider;
	/** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	/** 0 means "ask the endpoint for its default size". */
	dimensions?: number;
	maxInputChars?: number;
	timeoutMs?: number;
}

export interface AntaAgentConfigInput {
	dataDir?: string;
	promptMode?: PromptMode;
	capture?: CaptureConfigInput;
	extraction?: ExtractionConfigInput;
	persona?: PersonaConfigInput;
	pipeline?: PipelineConfigInput;
	recall?: RecallConfigInput;
	embedding?: EmbeddingConfigInput;
}

export interface AntaAgentConfig {
	dataDir: string;
	promptMode: PromptMode;
	capture: { enabled: boolean; l0RetentionDays: number };
	extraction: { enabled: boolean; enableDedup: boolean; maxMemoriesPerSession: number };
	persona: { triggerEveryN: number; maxScenes: number; backupCount: number; sceneBackupCount: number };
	pipeline: {
		everyNConversations: number;
		enableWarmup: boolean;
		l1IdleTimeoutSeconds: number;
		l2DelayAfterL1Seconds: number;
		l2MinIntervalSeconds: number;
		l2MaxIntervalSeconds: number;
	};
	recall: {
		enabled: boolean;
		maxResults: number;
		maxCharsPerMemory: number;
		maxTotalRecallChars: number;
		scoreThreshold: number;
		strategy: RecallStrategy;
		timeoutMs: number;
	};
	embedding: {
		provider: EmbeddingProvider;
		baseUrl: string;
		apiKey: string;
		model: string;
		dimensions: number;
		maxInputChars: number;
		timeoutMs: number;
	};
}

/** Default storage root: <agentDir>/memory, where agentDir is $PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function defaultDataDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (agentDir) return join(agentDir, "memory");
	return join(homedir(), ".pi", "agent", "memory");
}

function int(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function num(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * Parse and validate a config input, filling defaults ported from the
 * TencentDB-Agent-Memory design (with enterprise features removed).
 */
export function parseAntaAgentConfig(input?: AntaAgentConfigInput): AntaAgentConfig {
	const i = input ?? {};
	return {
		dataDir: i.dataDir?.trim() ? i.dataDir : defaultDataDir(),
		promptMode: i.promptMode === "chat" ? "chat" : "code",
		capture: {
			enabled: i.capture?.enabled !== false,
			l0RetentionDays: int(i.capture?.l0RetentionDays, 30, 0, 3650),
		},
		extraction: {
			enabled: i.extraction?.enabled !== false,
			enableDedup: i.extraction?.enableDedup !== false,
			maxMemoriesPerSession: int(i.extraction?.maxMemoriesPerSession, 20, 1, 200),
		},
		persona: {
			triggerEveryN: int(i.persona?.triggerEveryN, 50, 1, 100000),
			maxScenes: int(i.persona?.maxScenes, 15, 2, 100),
			backupCount: int(i.persona?.backupCount, 3, 0, 100),
			sceneBackupCount: int(i.persona?.sceneBackupCount, 10, 0, 100),
		},
		pipeline: {
			everyNConversations: int(i.pipeline?.everyNConversations, 5, 1, 1000),
			enableWarmup: i.pipeline?.enableWarmup !== false,
			l1IdleTimeoutSeconds: int(i.pipeline?.l1IdleTimeoutSeconds, 600, 5, 86400 * 7),
			l2DelayAfterL1Seconds: int(i.pipeline?.l2DelayAfterL1Seconds, 10, 0, 86400),
			l2MinIntervalSeconds: int(i.pipeline?.l2MinIntervalSeconds, 900, 0, 86400 * 30),
			l2MaxIntervalSeconds: int(i.pipeline?.l2MaxIntervalSeconds, 3600, 0, 86400 * 30),
		},
		recall: {
			enabled: i.recall?.enabled !== false,
			maxResults: int(i.recall?.maxResults, 5, 1, 50),
			maxCharsPerMemory: int(i.recall?.maxCharsPerMemory, 0, 0, 100000),
			maxTotalRecallChars: int(i.recall?.maxTotalRecallChars, 0, 0, 1000000),
			scoreThreshold: num(i.recall?.scoreThreshold, 0.3, 0, 1),
			strategy:
				i.recall?.strategy === "keyword" || i.recall?.strategy === "embedding" ? i.recall.strategy : "hybrid",
			timeoutMs: int(i.recall?.timeoutMs, 5000, 100, 60000),
		},
		embedding: {
			provider: i.embedding?.provider === "openai" ? "openai" : "none",
			baseUrl: i.embedding?.baseUrl?.replace(/\/+$/, "") ?? "",
			apiKey: i.embedding?.apiKey ?? "",
			model: i.embedding?.model ?? "",
			dimensions: int(i.embedding?.dimensions, 0, 0, 100000),
			maxInputChars: int(i.embedding?.maxInputChars, 5000, 1, 1000000),
			timeoutMs: int(i.embedding?.timeoutMs, 10000, 100, 120000),
		},
	};
}

/** Read a anta-agent JSON config file; returns {} on missing/invalid files. */
export function loadAntaAgentConfigFile(filePath: string): AntaAgentConfigInput {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as AntaAgentConfigInput) : {};
	} catch {
		return {};
	}
}

import type { PiMenConfig } from "../../config.ts";
import type { HostLogger } from "../../types.ts";

type EmbeddingConfig = PiMenConfig["embedding"];

/**
 * Embedding backend used for vector recall. `dimensions` is 0 when no
 * provider is configured (keyword-only recall).
 */
export interface EmbeddingService {
	embed(inputs: readonly string[]): Promise<Float32Array[]>;
	readonly dimensions: number;
	providerInfo(): string;
	isReady(): boolean;
}

export class NullEmbeddingService implements EmbeddingService {
	readonly dimensions = 0;

	async embed(): Promise<Float32Array[]> {
		return [];
	}

	providerInfo(): string {
		return "none";
	}

	isReady(): boolean {
		return false;
	}
}

interface OpenAiEmbeddingResponse {
	data?: { index?: number; embedding?: number[] }[];
}

/**
 * Embeddings from any OpenAI-compatible `/embeddings` endpoint.
 * Each input is truncated to `maxInputChars` before the request.
 */
export class OpenAiEmbeddingService implements EmbeddingService {
	readonly dimensions: number;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly maxInputChars: number;
	private readonly timeoutMs: number;

	constructor(config: EmbeddingConfig) {
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.dimensions = config.dimensions;
		this.maxInputChars = config.maxInputChars;
		this.timeoutMs = config.timeoutMs;
	}

	providerInfo(): string {
		return `${this.model} (${this.dimensions > 0 ? `${this.dimensions}d` : "endpoint default dims"})`;
	}

	isReady(): boolean {
		return Boolean(this.baseUrl && this.model);
	}

	async embed(inputs: readonly string[]): Promise<Float32Array[]> {
		if (inputs.length === 0) return [];
		const body: Record<string, unknown> = {
			model: this.model,
			input: inputs.map((text) => text.slice(0, this.maxInputChars)),
		};
		if (this.dimensions > 0) body.dimensions = this.dimensions;
		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`embedding request failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
		}
		const payload = (await response.json()) as OpenAiEmbeddingResponse;
		const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (rows.length !== inputs.length) {
			throw new Error(`embedding request returned ${rows.length} vectors for ${inputs.length} inputs`);
		}
		return rows.map((row) => {
			if (!row.embedding) throw new Error("embedding response missing vector data");
			return Float32Array.from(row.embedding);
		});
	}
}

export function createEmbeddingService(config: EmbeddingConfig, logger?: HostLogger): EmbeddingService {
	if (config.provider === "openai" && config.baseUrl && config.model) {
		return new OpenAiEmbeddingService(config);
	}
	if (config.provider === "openai") {
		logger?.warn?.("[pi-men] embedding provider configured but baseUrl/model missing; falling back to none");
	}
	return new NullEmbeddingService();
}

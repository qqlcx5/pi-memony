import type { MemoryMetadata, MemoryType } from "../types.ts";

/**
 * Extract the first JSON array from an LLM response, tolerating code fences
 * and surrounding prose.
 */
export function extractJsonArray(raw: string): unknown[] {
	const text = stripCodeFences(raw.trim());
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("no JSON array found in LLM output");
	}
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("LLM output is not a JSON array");
	return parsed;
}

export function stripCodeFences(text: string): string {
	return text.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
}

const VALID_CHAT_TYPES = new Set<string>(["persona", "episodic", "instruction"]);
const VALID_WORK_TYPES = new Set<string>(["work_fact", "work_task", "work_method", "work_artifact"]);

export function isValidMemoryType(value: unknown, allowWorkTypes: boolean): value is MemoryType {
	if (typeof value !== "string") return false;
	return VALID_CHAT_TYPES.has(value) || (allowWorkTypes && VALID_WORK_TYPES.has(value));
}

export function clampPriority(value: unknown, fallback = 50): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return fallback;
	if (num === -1) return -1;
	return Math.min(100, Math.max(0, Math.trunc(num)));
}

export function parseMetadata(value: unknown): MemoryMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const result: MemoryMetadata = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
			result[key] = entry;
		}
	}
	return result;
}

export function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

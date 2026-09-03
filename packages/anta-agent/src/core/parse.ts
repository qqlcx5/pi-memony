import type { MemoryMetadata, MemoryType } from "../types.ts";

/**
 * Extract the first complete JSON array from an LLM response. The scanner
 * respects quoted strings, so prose containing `]` cannot truncate the payload.
 */
export function extractJsonArray(raw: string): unknown[] {
	const text = stripCodeFences(raw.trim());
	if (text.length > 1_000_000) throw new Error("LLM output exceeds the JSON size limit");
	for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
		const end = findJsonArrayEnd(text, start);
		if (end === -1) continue;
		try {
			const parsed: unknown = JSON.parse(text.slice(start, end + 1));
			if (!Array.isArray(parsed)) continue;
			if (parsed.length > 1_000) throw new Error("LLM JSON array has too many items");
			return parsed;
		} catch (error) {
			if (error instanceof Error && error.message === "LLM JSON array has too many items") throw error;
		}
	}
	throw new Error("no complete JSON array found in LLM output");
}

function findJsonArrayEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[") {
			depth += 1;
			if (depth > 32) return -1;
		} else if (char === "]") {
			depth -= 1;
			if (depth === 0) return index;
			if (depth < 0) return -1;
		}
	}
	return -1;
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

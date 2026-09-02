import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostLogger } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import type { StoragePaths } from "../storage/paths.ts";

export interface SceneIndexEntry {
	file: string;
	summary: string;
	heat: number;
	createdAt: string;
	updatedAt: string;
}

const DELETED_MARKER = "[DELETED]";

/** Filename policy shared with the L2 prompt: safe chars, `.md` suffix. */
export function normalizeSceneFileName(name: string): string {
	const cleaned = name
		.replaceAll(/\s+/g, "-")
		.replaceAll(/[^\p{L}\p{N}._-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|-+$/g, "");
	return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
}

export function readSceneIndex(paths: StoragePaths): SceneIndexEntry[] {
	try {
		if (!existsSync(paths.sceneIndexFile)) return [];
		const parsed = JSON.parse(readFileSync(paths.sceneIndexFile, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is SceneIndexEntry =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as SceneIndexEntry).file === "string" &&
				typeof (entry as SceneIndexEntry).summary === "string",
		);
	} catch {
		return [];
	}
}

export function writeSceneIndex(paths: StoragePaths, entries: readonly SceneIndexEntry[]): void {
	mkdirSync(paths.sceneBlocksDir, { recursive: true });
	writeFileSync(paths.sceneIndexFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

export function readSceneFile(paths: StoragePaths, file: string): string | null {
	const target = join(paths.sceneBlocksDir, basename(file));
	if (!existsSync(target)) return null;
	try {
		return readFileSync(target, "utf8");
	} catch {
		return null;
	}
}

export function listSceneFiles(paths: StoragePaths): string[] {
	if (!existsSync(paths.sceneBlocksDir)) return [];
	return readdirSync(paths.sceneBlocksDir)
		.filter((name) => name.endsWith(".md") && name !== "scene_index.json")
		.sort();
}

export interface SceneOp {
	action: "create" | "update" | "delete";
	file: string;
	summary?: string;
	heat?: number;
	content?: string;
}

/**
 * Apply LLM-produced scene operations to scene_blocks/ and refresh the index.
 * Deletes remove both the file and its index entry; creates/updates upsert.
 */
export function applySceneOps(paths: StoragePaths, ops: readonly SceneOp[], logger?: HostLogger): SceneIndexEntry[] {
	mkdirSync(paths.sceneBlocksDir, { recursive: true });
	const index = new Map(readSceneIndex(paths).map((entry) => [entry.file, entry]));
	const now = new Date().toISOString();
	for (const op of ops) {
		const file = normalizeSceneFileName(op.file);
		if (!file || file === ".md" || file === "scene_index.json") continue;
		try {
			if (op.action === "delete") {
				const target = join(paths.sceneBlocksDir, file);
				if (existsSync(target)) rmSync(target);
				index.delete(file);
				continue;
			}
			const content = op.content?.trim();
			if (!content) continue;
			if (content === DELETED_MARKER) {
				const target = join(paths.sceneBlocksDir, file);
				if (existsSync(target)) rmSync(target);
				index.delete(file);
				continue;
			}
			const existing = index.get(file);
			writeFileSync(join(paths.sceneBlocksDir, file), `${content.trimEnd()}\n`, "utf8");
			index.set(file, {
				file,
				summary: op.summary?.trim() || existing?.summary || "",
				heat:
					typeof op.heat === "number" && Number.isFinite(op.heat)
						? Math.max(0, Math.trunc(op.heat))
						: (existing?.heat ?? 0) + 1,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
		} catch (error) {
			logger?.warn?.(`[pi-men] scene op ${op.action} ${file} failed: ${errorMessage(error)}`);
		}
	}
	// Drop index entries whose file vanished (e.g. manual deletion).
	const files = new Set(listSceneFiles(paths));
	const entries = [...index.values()].filter((entry) => files.has(entry.file));
	writeSceneIndex(paths, entries);
	return entries;
}

/** One-line-per-scene listing injected as `<scene-navigation>`. */
export function generateSceneNavigation(entries: readonly SceneIndexEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => b.heat - a.heat)
		.map((entry) => `- ${entry.file}${entry.summary ? ` — ${entry.summary}` : ""}`)
		.join("\n");
}

/** Scene blocks changed since `sinceIso` (by updatedAt), newest last. */
export function changedScenes(
	entries: readonly SceneIndexEntry[],
	sinceIso: string | null,
): readonly SceneIndexEntry[] {
	if (!sinceIso) return entries;
	return entries.filter((entry) => entry.updatedAt > sinceIso);
}

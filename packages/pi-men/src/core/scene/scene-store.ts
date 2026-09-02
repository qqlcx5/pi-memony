import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const META_HEADER = /-----META-START-----\n([\s\S]*?)\n?-----META-END-----/;

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
		if (existsSync(paths.sceneIndexFile)) {
			const parsed = JSON.parse(readFileSync(paths.sceneIndexFile, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(entry): entry is SceneIndexEntry =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as SceneIndexEntry).file === "string" &&
						typeof (entry as SceneIndexEntry).summary === "string",
				);
			}
		}
	} catch {
		// Corrupt index: fall through to the META-based rebuild.
	}
	return rebuildSceneIndex(paths);
}

/**
 * Rebuild the index from the META headers inside the scene .md files, so a
 * lost or corrupt scene_index.json cannot permanently lose summaries/heats.
 */
function rebuildSceneIndex(paths: StoragePaths): SceneIndexEntry[] {
	const entries: SceneIndexEntry[] = [];
	for (const file of listSceneFiles(paths)) {
		try {
			const meta = parseSceneMeta(readFileSync(join(paths.sceneBlocksDir, file), "utf8"));
			entries.push({
				file,
				summary: meta.summary,
				heat: meta.heat,
				createdAt: meta.created,
				updatedAt: meta.updated,
			});
		} catch {}
	}
	if (entries.length > 0) writeSceneIndex(paths, entries);
	return entries;
}

function parseSceneMeta(raw: string): { summary: string; heat: number; created: string; updated: string } {
	const header = META_HEADER.exec(raw)?.[1] ?? "";
	const fields = new Map<string, string>();
	for (const line of header.split("\n")) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	const heat = Number.parseInt(fields.get("heat") ?? "0", 10);
	return {
		summary: fields.get("summary") ?? "",
		heat: Number.isFinite(heat) ? Math.max(0, heat) : 0,
		created: fields.get("created") ?? "",
		updated: fields.get("updated") ?? "",
	};
}

/** Atomic index write: a crash mid-write cannot corrupt the previous index. */
export function writeSceneIndex(paths: StoragePaths, entries: readonly SceneIndexEntry[]): void {
	mkdirSync(paths.sceneBlocksDir, { recursive: true });
	const tmp = join(paths.sceneBlocksDir, "scene_index.json.tmp");
	writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	renameSync(tmp, paths.sceneIndexFile);
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

/**
 * Snapshot scene_blocks/ under .backup/scene_blocks/ before an L2 pass
 * mutates it; keeps the newest `backupCount` snapshots (0 disables).
 */
export function backupSceneBlocks(paths: StoragePaths, backupCount: number, logger?: HostLogger): void {
	if (backupCount <= 0 || !existsSync(paths.sceneBlocksDir)) return;
	try {
		const root = join(paths.backupDir, "scene_blocks");
		mkdirSync(root, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		cpSync(paths.sceneBlocksDir, join(root, stamp), { recursive: true });
		const backups = readdirSync(root).sort();
		while (backups.length > backupCount) {
			const oldest = backups.shift();
			if (oldest) rmSync(join(root, oldest), { recursive: true, force: true });
		}
	} catch (error) {
		logger?.warn?.(`[pi-men] scene backup failed: ${errorMessage(error)}`);
	}
}

/** Scene blocks changed since `sinceIso` (by updatedAt), newest last. */
export function changedScenes(
	entries: readonly SceneIndexEntry[],
	sinceIso: string | null,
): readonly SceneIndexEntry[] {
	if (!sinceIso) return entries;
	return entries.filter((entry) => entry.updatedAt > sinceIso);
}

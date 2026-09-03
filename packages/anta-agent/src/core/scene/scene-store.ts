import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { HostLogger } from "../../types.ts";
import { errorMessage } from "../errors.ts";
import { sanitizeUntrustedText } from "../security.ts";
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
const MAX_SCENE_FILE_CHARS = 180;
const MAX_SCENE_CONTENT_CHARS = 20_000;
const MAX_SCENE_SUMMARY_CHARS = 2_000;

/** Filename policy shared with the L2 prompt: safe chars, `.md` suffix. */
export function normalizeSceneFileName(name: string): string {
	const cleaned = name
		.replaceAll(/\s+/g, "-")
		.replaceAll(/[^\p{L}\p{N}._-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|-+$/g, "");
	return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
}

function validSceneFile(name: string): string | null {
	const raw = name.trim();
	if (!raw || raw.length > MAX_SCENE_FILE_CHARS || raw.includes("\u0000") || isAbsolute(raw)) return null;
	if (raw.includes("/") || raw.includes("\\") || raw.split(".").includes("..")) return null;
	const file = normalizeSceneFileName(raw);
	if (!file || file === ".md" || file === "scene_index.json" || basename(file) !== file) return null;
	return file;
}

function sceneTarget(paths: StoragePaths, file: string): string {
	const target = join(paths.sceneBlocksDir, file);
	const relativePath = relative(paths.sceneBlocksDir, target);
	if (
		relativePath === "" ||
		relativePath.startsWith(`..${sep}`) ||
		relativePath === ".." ||
		isAbsolute(relativePath)
	) {
		throw new Error("scene path escapes the scene-block directory");
	}
	return target;
}

export function readSceneIndex(paths: StoragePaths): SceneIndexEntry[] {
	try {
		if (existsSync(paths.sceneIndexFile)) {
			const parsed = JSON.parse(readFileSync(paths.sceneIndexFile, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return [];
					const record = entry as Record<string, unknown>;
					const file = typeof record.file === "string" ? validSceneFile(record.file) : null;
					if (!file || typeof record.summary !== "string") return [];
					return [
						{
							file,
							summary: sanitizeUntrustedText(record.summary, { maxChars: MAX_SCENE_SUMMARY_CHARS }),
							heat:
								typeof record.heat === "number" && Number.isFinite(record.heat)
									? Math.max(0, Math.trunc(record.heat))
									: 0,
							createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
							updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
						},
					];
				});
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
			const meta = parseSceneMeta(readFileSync(sceneTarget(paths, file), "utf8"));
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
		summary: sanitizeUntrustedText(fields.get("summary") ?? "", { maxChars: MAX_SCENE_SUMMARY_CHARS }),
		heat: Number.isFinite(heat) ? Math.max(0, heat) : 0,
		created: fields.get("created") ?? "",
		updated: fields.get("updated") ?? "",
	};
}

/** Atomic index write: a crash mid-write cannot corrupt the previous index. */
export function writeSceneIndex(paths: StoragePaths, entries: readonly SceneIndexEntry[]): void {
	mkdirSync(paths.sceneBlocksDir, { recursive: true });
	const safeEntries = entries.flatMap((entry) => {
		const file = validSceneFile(entry.file);
		if (!file) return [];
		return [
			{
				...entry,
				file,
				summary: sanitizeUntrustedText(entry.summary, { maxChars: MAX_SCENE_SUMMARY_CHARS }),
				heat: Math.max(0, Math.trunc(entry.heat)),
			},
		];
	});
	const tmp = join(paths.sceneBlocksDir, "scene_index.json.tmp");
	writeFileSync(tmp, `${JSON.stringify(safeEntries, null, 2)}\n`, "utf8");
	renameSync(tmp, paths.sceneIndexFile);
}

export function readSceneFile(paths: StoragePaths, file: string): string | null {
	const safeFile = validSceneFile(file);
	if (!safeFile) return null;
	const target = sceneTarget(paths, safeFile);
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
		.filter((name) => name.endsWith(".md") && name !== "scene_index.json" && validSceneFile(name) === name)
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
	const touched = new Set<string>();
	for (const op of ops) {
		const file = validSceneFile(op.file);
		if (!file || touched.has(file)) {
			if (!file) logger?.warn?.("[anta-agent] rejected unsafe scene file name");
			continue;
		}
		touched.add(file);
		try {
			const target = sceneTarget(paths, file);
			if (op.action === "delete") {
				if (existsSync(target)) rmSync(target);
				index.delete(file);
				continue;
			}
			const content = op.content
				? sanitizeUntrustedText(op.content, { maxChars: MAX_SCENE_CONTENT_CHARS }).trim()
				: "";
			if (!content) continue;
			if (content === DELETED_MARKER) {
				if (existsSync(target)) rmSync(target);
				index.delete(file);
				continue;
			}
			const existing = index.get(file);
			writeFileSync(target, `${content.trimEnd()}\n`, "utf8");
			index.set(file, {
				file,
				summary: sanitizeUntrustedText(op.summary?.trim() || existing?.summary || "", {
					maxChars: MAX_SCENE_SUMMARY_CHARS,
				}),
				heat:
					typeof op.heat === "number" && Number.isFinite(op.heat)
						? Math.max(0, Math.trunc(op.heat))
						: (existing?.heat ?? 0) + 1,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
		} catch (error) {
			logger?.warn?.(`[anta-agent] scene op ${op.action} ${file} failed: ${errorMessage(error)}`);
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
		logger?.warn?.(`[anta-agent] scene backup failed: ${errorMessage(error)}`);
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

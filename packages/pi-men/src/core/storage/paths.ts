import { join } from "node:path";

/** Canonical file layout under the pi-men data directory. */
export interface StoragePaths {
	root: string;
	db: string;
	conversationsDir: string;
	recordsDir: string;
	sceneBlocksDir: string;
	sceneIndexFile: string;
	personaFile: string;
	metadataDir: string;
	checkpointFile: string;
	backupDir: string;
}

export function storagePaths(dataDir: string): StoragePaths {
	return {
		root: dataDir,
		db: join(dataDir, "memory.db"),
		conversationsDir: join(dataDir, "conversations"),
		recordsDir: join(dataDir, "records"),
		sceneBlocksDir: join(dataDir, "scene_blocks"),
		sceneIndexFile: join(dataDir, "scene_blocks", "scene_index.json"),
		personaFile: join(dataDir, "persona.md"),
		metadataDir: join(dataDir, ".metadata"),
		checkpointFile: join(dataDir, ".metadata", "checkpoint.json"),
		backupDir: join(dataDir, ".backup"),
	};
}

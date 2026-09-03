/**
 * In-memory vector index with brute-force cosine similarity.
 *
 * Local personal memory stores hold thousands, not millions, of records, so a
 * typed-array scan (a few ms at 10k x 768 dims) beats taking on a native
 * vector-extension dependency. Vectors are persisted as BLOBs in SQLite and
 * cached here for search.
 */
export interface StoredVector {
	id: string;
	dims: number;
	vector: Float32Array;
}

export interface VectorSearchHit {
	id: string;
	similarity: number;
}

export class VectorIndex {
	private vectors: Map<string, Float32Array>;
	private norms: Map<string, number>;

	constructor() {
		this.vectors = new Map();
		this.norms = new Map();
	}

	get size(): number {
		return this.vectors.size;
	}

	load(entries: StoredVector[]): void {
		for (const entry of entries) {
			this.upsert(entry.id, entry.vector);
		}
	}

	upsert(id: string, vector: Float32Array): void {
		const copy = new Float32Array(vector);
		this.vectors.set(id, copy);
		this.norms.set(id, l2Norm(copy));
	}

	remove(ids: readonly string[]): void {
		for (const id of ids) {
			this.vectors.delete(id);
			this.norms.delete(id);
		}
	}

	clear(): void {
		this.vectors.clear();
		this.norms.clear();
	}

	/** Rank stored vectors by cosine similarity to `query`, best first. */
	search(query: Float32Array, limit: number): VectorSearchHit[] {
		const queryNorm = l2Norm(query);
		if (queryNorm === 0 || this.vectors.size === 0) return [];
		const hits: VectorSearchHit[] = [];
		for (const [id, vector] of this.vectors) {
			if (vector.length !== query.length) continue;
			const norm = this.norms.get(id) ?? 0;
			if (norm === 0) continue;
			let dot = 0;
			for (let i = 0; i < query.length; i++) {
				dot += query[i]! * vector[i]!;
			}
			hits.push({ id, similarity: dot / (queryNorm * norm) });
		}
		hits.sort((a, b) => b.similarity - a.similarity);
		return hits.slice(0, Math.max(0, limit));
	}
}

function l2Norm(vector: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < vector.length; i++) {
		sum += vector[i]! * vector[i]!;
	}
	return Math.sqrt(sum);
}

/** Serialize a Float32Array for BLOB storage. */
export function encodeVector(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Deserialize a BLOB read from SQLite back into a Float32Array. */
export function decodeVector(blob: Uint8Array): Float32Array {
	const aligned = new Uint8Array(blob.byteLength);
	aligned.set(blob);
	return new Float32Array(aligned.buffer);
}

/**
 * Reciprocal Rank Fusion over keyword (FTS5 BM25) and vector (cosine)
 * result lists, ported from the TencentDB-Agent-Memory recall design.
 */
export interface RankedList {
	readonly ids: readonly string[];
}

export interface FusedHit {
	id: string;
	/** RRF score; only ranking matters, the absolute value is not normalized. */
	score: number;
	keywordRank: number | null;
	vectorRank: number | null;
}

const RRF_K = 60;

export function rrfFuse(keywordIds: readonly string[], vectorIds: readonly string[], limit: number): FusedHit[] {
	const scores = new Map<string, FusedHit>();
	const add = (ids: readonly string[], kind: "keyword" | "vector") => {
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]!;
			let hit = scores.get(id);
			if (!hit) {
				hit = { id, score: 0, keywordRank: null, vectorRank: null };
				scores.set(id, hit);
			}
			hit.score += 1 / (RRF_K + i + 1);
			if (kind === "keyword") hit.keywordRank = i + 1;
			else hit.vectorRank = i + 1;
		}
	};
	add(keywordIds, "keyword");
	add(vectorIds, "vector");
	const fused = [...scores.values()].sort((a, b) => b.score - a.score);
	return fused.slice(0, Math.max(0, limit));
}

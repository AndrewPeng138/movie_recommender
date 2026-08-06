/**
 * TF-IDF content similarity model.
 *
 * Replaces the hand-tuned additive scorer. Every design choice here targets a specific measured
 * failure of that model:
 *
 * | Old failure | Fix |
 * |---|---|
 * | Constant base of 60 carried no ranking information | Cosine similarity, no floor |
 * | Sharing "Drama" scored the same as sharing "Film-Noir" | IDF weighting from corpus frequency |
 * | Kept the best *single* pick pairing | Mean of top-*k* similarities |
 * | `+10` per extra match, saturating at 100 | Multi-match emerges from top-*k*, no cap |
 * | 13 of 30 results tied at exactly 100% | Continuous scores, ties are vanishingly unlikely |
 * | Franchise flooding | MMR diversity |
 *
 * Every hyperparameter below is swept against the evaluation harness on the tuning split. None is
 * chosen by intuition — that is the entire point of the rebuild.
 *
 * @module lib/score
 */

const { extractFeatures, buildVector, cosine, explain } = require('./features');
const { createQualityScorer } = require('./quality');

/**
 * Hyperparameters, as confirmed on the held-out test split (n=300, seed 42).
 *
 * Swept on the TUNE split only, then this exact configuration was run **once** on TEST:
 *
 *   metric          legacy              this model          change
 *   precision@30    0.0677 +/- 0.0087   0.1000 +/- 0.0128   +48%   significant
 *   MRR             0.2924 +/- 0.0415   0.4343 +/- 0.0468   +49%   significant
 *   hitRate@30      0.6600 +/- 0.0537   0.7500 +/- 0.0491   +14%   marginal
 *   obscure p@30    0.0204 +/- 0.0045   0.0227 +/- 0.0047   +11%   NOT significant
 *
 * Changing any value here invalidates that comparison. Re-sweep on tune, re-confirm once on test.
 */
const DEFAULTS = {
    /**
     * Similarities averaged per candidate. k=1 is pure max (outlier-sensitive), k=Infinity is a
     * pure centroid (washes out on diverse taste).
     *
     * Swept 1,2,3,5,10 -- monotonically improving, so the centroid-like end wins. The effect is
     * small (0.0773 -> 0.0824) and inside the confidence interval, but the trend is consistent.
     */
    k: 10,
    /**
     * Blend between content relevance and quality. 0 = pure similarity, 1 = pure quality.
     *
     * Swept 0 to 1. Pure content (0) scored 0.0633 -- WORSE than the legacy model. Overall precision
     * peaks at 0.5 and declines beyond it, while obscure precision falls monotonically above 0.5
     * (0.0263 -> 0.0192 at 1.0) as the model degenerates into ranking by popularity. 0.5 sits at the
     * optimum for both.
     */
    qualityWeight: 0.5,
    /**
     * Relative weights of the three quality signals; normalised internally.
     *
     * HONEST CAVEAT: tested individually (TMDB-only 0.0787, MovieLens-only 0.0751, awards-only
     * 0.0802) the three are statistically indistinguishable -- but at n=150 with +/-0.015 intervals,
     * signals separated by 0.005 always will be. That is an underpowered test, not evidence the
     * sources are equivalent.
     *
     * These weights were not individually validated. They were part of the ensemble confirmed on the
     * test split, and they are a reasonable prior the data does not contradict.
     *
     * Awards are retained deliberately: critical recognition is genuinely independent of audience
     * rating, and the two diverge exactly where it is interesting -- acclaimed films audiences rate
     * modestly, and crowd-pleasers with no critical standing. The natural use is raising wAwards to
     * 2-3 for a "critically acclaimed" mode, which needs no new code.
     */
    wTmdb: 1,
    wMovieLens: 1,
    wAwards: 0.5,
    /**
     * MMR tradeoff. 1 = pure relevance (no diversity), lower = more varied results.
     *
     * Confirmed on the test split: relevance is untouched (precision 0.1000 vs 0.1004 without MMR,
     * MRR marginally better at 0.4343 vs 0.4326) while diversity improves -- distinct franchises in
     * the top 30 rise 26.99 -> 27.53 and the largest single franchise falls 2.73 -> 2.56.
     *
     * Do NOT lower this much further. At 0.6 the diversity gain is larger (29.45 collections) but
     * costs 4.5% of overall precision and 15% of obscure precision. Franchise flooding measured far
     * milder than assumed -- ~27 of 30 slots were already distinct before any intervention.
     */
    mmrLambda: 0.9,
    /**
     * Background-similarity correction exponent: `relevance / background^alpha`.
     *
     * Measurement showed obscure films carry roughly HALF the keywords of popular ones (10.6 vs
     * 19.8) because TMDB's keyword data is community-curated and nobody tags obscure films. L2
     * normalisation equalises vector magnitude but not *dimensionality*, so a sparser vector has
     * fewer chances to overlap with anything and scores 36% lower similarity against the same
     * references — regardless of whether it is actually relevant.
     *
     * Dividing by a film's typical similarity to films in general cancels that handicap: a film that
     * resembles everything is discounted, one that rarely resembles anything but does resemble your
     * picks is boosted. It is IDF's logic applied per-film rather than per-feature.
     *
     * MEASURED AND REJECTED. On the tune split alpha=0.5 looked like the best MRR of anything tested
     * (0.4813 vs 0.4670). On the held-out test split it did not replicate -- MRR came back
     * *fractionally lower* than alpha=0 (0.4315 vs 0.4326) and precision was identical. The tune-split
     * advantage was noise.
     *
     * Kept at 0 and left in place rather than deleted, so the experiment is recorded and nobody
     * re-runs it. This is a deliberate exception to "no unused configurability".
     */
    backgroundAlpha: 0,
    /** Features named per recommendation when explaining a match. */
    explainLimit: 4
};

/**
 * Picks named in the "because you liked..." attribution.
 *
 * Deliberately smaller than `k`. With k=10, every candidate has non-zero similarity to essentially
 * every pick — films share a language, a genre, something — so listing them all said nothing.
 */
const SIMILAR_TO_LIMIT = 3;

/** Candidates sampled as the "films in general" reference for the background correction. */
const BACKGROUND_SAMPLE = 40;

/**
 * Floor on the background divisor.
 *
 * Without it, a film similar to nothing in the pool divides by ~0 and rockets to the top of the
 * ranking on noise alone — the correction would amplify exactly the outliers it should ignore.
 */
const BACKGROUND_EPSILON = 0.005;

/**
 * Scales values to 0..1 across a set.
 *
 * Relevance (cosine, realistically ~0.02-0.35) and quality (0..1) live on very different scales.
 * Blending them raw would let quality dominate regardless of `qualityWeight`, making that parameter
 * meaningless. Normalising both across the candidate pool is what makes the blend interpretable.
 *
 * @param {number[]} values
 * @returns {number[]} Normalised copy; all zeros if every value is identical.
 */
function normalise(values) {
    if (values.length === 0) return values;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    if (range === 0) return values.map(() => 0);
    return values.map(v => (v - min) / range);
}

/**
 * Mean of the largest `k` values.
 *
 * This is the fix for the max-versus-profile flaw, and it makes multi-match emergent rather than
 * bolted on: a film similar to several picks scores highly because its top-k similarities are all
 * high, with no `+10` bonus and no cap to saturate against.
 *
 * @param {number[]} values
 * @param {number} k
 * @returns {number}
 */
function topKMean(values, k) {
    if (values.length === 0) return 0;
    const take = Math.min(k, values.length);
    const sorted = [...values].sort((a, b) => b - a).slice(0, take);
    return sorted.reduce((a, b) => a + b, 0) / take;
}

/**
 * Reorders results to trade a little relevance for variety (Maximal Marginal Relevance).
 *
 * Greedily selects the candidate maximising `λ·relevance − (1−λ)·maxSimilarityToAlreadySelected`.
 *
 * This is the principled fix for franchise flooding, and it was impossible before this phase: the
 * previous model only ever compared a candidate to a *pick*, never to another candidate, so it had
 * no way to notice it was recommending the same film three times over.
 *
 * @param {Array<{id: number, score: number, vector: Map<string, number>}>} candidates - Sorted best first.
 * @param {number} limit
 * @param {number} lambda
 * @returns {Array<object>} Reordered selection.
 */
function applyMmr(candidates, limit, lambda) {
    if (lambda >= 1 || candidates.length <= 1) return candidates.slice(0, limit);

    const selected = [];
    const remaining = [...candidates];

    while (selected.length < limit && remaining.length > 0) {
        let bestIndex = 0;
        let bestValue = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            let maxSim = 0;
            for (const chosen of selected) {
                const sim = cosine(candidate.vector, chosen.vector);
                if (sim > maxSim) maxSim = sim;
            }
            const value = lambda * candidate.score - (1 - lambda) * maxSim;
            if (value > bestValue) {
                bestValue = value;
                bestIndex = i;
            }
        }

        selected.push(remaining[bestIndex]);
        remaining.splice(bestIndex, 1);
    }

    return selected;
}

/**
 * Creates a scoring model.
 *
 * @param {object} options
 * @param {Object<string, number>} options.idf - IDF table from data/idf.json.
 * @param {object} [options.quality] - Config forwarded to createQualityScorer().
 * @param {Partial<typeof DEFAULTS>} [options.params] - Hyperparameter overrides.
 * @returns {{name: string, description: string, params: object,
 *            rankCandidates: (groups: Array<object>, pickIds: Set<number>) => Array<object>}}
 */
function createModel({ idf, quality = {}, params = {} } = {}) {
    const p = { ...DEFAULTS, ...params };
    const qualityOf = createQualityScorer(quality);
    const weightSum = p.wTmdb + p.wMovieLens + p.wAwards || 1;

    /** Vectors are memoised per call to rankCandidates, since a film often appears under many picks. */
    const vectorise = (details, cache) => {
        const hit = cache.get(details.id);
        if (hit) return hit;

        const { weights, labels } = extractFeatures(details, details.keywords);
        const entry = { vector: buildVector(weights, idf), labels };
        cache.set(details.id, entry);
        return entry;
    };

    return {
        name: 'tfidf',
        description: `TF-IDF cosine, top-${p.k} aggregation, quality blend ${p.qualityWeight}`,
        params: p,

        /**
         * Scores and ranks candidates against the user's picks.
         *
         * @param {Array<{pick: object, candidates: object[]}>} groups
         * @param {Set<number>} pickIds
         * @returns {Array<object>} Ranked, best first.
         */
        rankCandidates(groups, pickIds) {
            const vectorCache = new Map();

            const pickEntries = [];
            const seenPicks = new Set();
            for (const { pick } of groups) {
                if (seenPicks.has(pick.id)) continue;
                seenPicks.add(pick.id);
                pickEntries.push({ pick, ...vectorise(pick, vectorCache) });
            }

            // Deduplicate candidates: the same film routinely appears under several picks.
            const candidateDetails = new Map();
            for (const { candidates } of groups) {
                for (const candidate of candidates) {
                    if (pickIds.has(candidate.id)) continue;
                    if (!candidateDetails.has(candidate.id)) {
                        candidateDetails.set(candidate.id, candidate);
                    }
                }
            }

            // Score each candidate against EVERY pick, not just the one that surfaced it.
            const scored = [];
            for (const details of candidateDetails.values()) {
                const { vector, labels } = vectorise(details, vectorCache);
                if (vector.size === 0) continue;

                const sims = pickEntries.map(entry => ({
                    pick: entry.pick,
                    similarity: cosine(vector, entry.vector),
                    entry
                }));

                sims.sort((a, b) => b.similarity - a.similarity);
                const relevance = topKMean(sims.map(s => s.similarity), p.k);

                const q = qualityOf(details);
                const qualityScore =
                    (p.wTmdb * q.tmdb + p.wMovieLens * q.movielens + p.wAwards * q.awards) / weightSum;

                scored.push({
                    id: details.id,
                    details,
                    vector,
                    labels,
                    relevance,
                    qualityScore,
                    qualitySignals: q,
                    // Picks contributing to the top-k, for the "similar to" attribution.
                    topPicks: sims.slice(0, p.k).filter(s => s.similarity > 0),
                    bestMatch: sims[0]
                });
            }

            if (scored.length === 0) return [];

            // --- Background-similarity correction -------------------------------------------------
            //
            // Corrects a measured bias: obscure films carry ~half the keywords of popular ones
            // (10.6 vs 19.8), because TMDB keywords are community-curated. L2 normalisation equalises
            // vector magnitude but not dimensionality, so sparser vectors have fewer chances to
            // overlap and score 36% lower similarity against identical references — whether or not
            // they are relevant.
            //
            // Dividing by a film's typical similarity to films in general cancels that: a film
            // resembling everything is discounted, one that rarely resembles anything but does
            // resemble these picks is boosted.
            //
            // The candidate pool is the reference sample. It is already hydrated (so this is free)
            // and it is the right population — these are the films the candidate competes against.
            if (p.backgroundAlpha > 0 && scored.length > 1) {
                // A fixed stride sample keeps this O(n · sampleSize) rather than O(n²), and stays
                // deterministic so runs remain reproducible.
                const stride = Math.max(1, Math.floor(scored.length / BACKGROUND_SAMPLE));
                const reference = scored.filter((_, i) => i % stride === 0).slice(0, BACKGROUND_SAMPLE);

                for (const entry of scored) {
                    let total = 0;
                    let count = 0;
                    for (const other of reference) {
                        if (other.id === entry.id) continue;
                        total += cosine(entry.vector, other.vector);
                        count++;
                    }
                    // EPSILON floors the divisor: a film similar to nothing in the pool would
                    // otherwise divide by ~0 and dominate the ranking on noise alone.
                    entry.background = Math.max(count > 0 ? total / count : 0, BACKGROUND_EPSILON);
                    entry.relevance /= entry.background ** p.backgroundAlpha;
                }
            }

            // Normalise both components across the pool so qualityWeight means what it says.
            const relNorm = normalise(scored.map(s => s.relevance));
            const qualNorm = normalise(scored.map(s => s.qualityScore));

            scored.forEach((entry, i) => {
                entry.score = (1 - p.qualityWeight) * relNorm[i] + p.qualityWeight * qualNorm[i];
            });

            scored.sort((a, b) => b.score - a.score || a.id - b.id);
            return scored;
        },

        /**
         * Applies MMR and shapes results for the client.
         *
         * Kept separate from ranking so the harness can measure ranking quality without diversity
         * reordering confounding the result.
         *
         * @param {Array<object>} scored - Output of rankCandidates.
         * @param {number} limit
         * @returns {Array<object>}
         */
        finalise(scored, limit) {
            // MMR chooses WHICH films appear; score decides the order they appear in.
            //
            // Splitting those two jobs fixes a defect where the list was ordered by MMR's objective
            // (`lambda*score - (1-lambda)*similarityToAlreadyShown`) while displaying `score`. The two
            // disagree whenever MMR swaps something, producing lists like 88%, 78%, 75%, 79% — which
            // reads as a bug.
            //
            // Sorting the selection costs nothing measurable, because MMR's benefit is a property of
            // the *set*: distinctCollections@30 and precision@30 both only care which 30 films are
            // shown, not their order.
            const selected = applyMmr(scored, limit, p.mmrLambda)
                .sort((a, b) => b.score - a.score || a.id - b.id);

            return selected.map(entry => {
                const best = entry.bestMatch;
                const contributions = best
                    ? explain(entry.vector, best.entry.vector,
                        new Map([...best.entry.labels, ...entry.labels]), p.explainLimit)
                    : [];

                return {
                    id: entry.id,
                    details: entry.details,
                    // Presented as a percentage for continuity with the existing UI.
                    //
                    // NOTE: this is *pool-relative*. Scores are min-max normalised across the
                    // candidate set, so 88% means "near the top of what this pool offered", not
                    // "88% match" in any absolute sense. The UI label should not overclaim.
                    matchScore: Math.round(entry.score * 100),
                    // Only the picks this film genuinely resembles.
                    //
                    // topPicks holds up to k=10 entries with similarity > 0, and nearly every film
                    // shares *something* (a language, a genre) — so an unfiltered count saturated at
                    // the number of picks and was identical on every card. Three is enough to say
                    // "because you liked X, Y and Z"; more is noise.
                    similarTo: entry.topPicks.slice(0, SIMILAR_TO_LIMIT).map(s => s.pick.title),
                    // Names the specific features that drove the match, rather than a fixed category.
                    contributions,
                    qualitySignals: entry.qualitySignals
                };
            });
        }
    };
}

module.exports = { DEFAULTS, createModel, topKMean, normalise, applyMmr };

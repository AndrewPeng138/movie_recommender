/**
 * Trivial ranking baselines.
 *
 * A model is only interesting if it beats the obvious alternatives. These exist to answer a question
 * the absolute numbers cannot: does the hand-tuned five-factor model actually earn its complexity, or
 * would sorting by popularity do just as well?
 *
 * That comparison matters more than it might seem, because MovieLens carries *exposure bias* — people
 * only rate films they chose to watch, which skews popular. A popularity ranker therefore has a
 * genuine advantage on this metric, and beating it is a real bar rather than a formality.
 *
 * All three expose the same `rankCandidates` interface as lib/score-legacy.js, so the harness can run
 * any of them without modification.
 *
 * @module lib/score-baselines
 */

/**
 * Collects the unique candidates across all picks, excluding the picks themselves.
 *
 * Shared by every baseline so they differ *only* in ordering — otherwise a difference in the candidate
 * set would be mistaken for a difference in ranking quality.
 *
 * @param {Array<{pick: object, candidates: object[]}>} groups
 * @param {Set<number>} pickIds
 * @returns {object[]} Unique candidate details.
 */
function uniqueCandidates(groups, pickIds) {
    const byId = new Map();
    for (const { candidates } of groups) {
        for (const candidate of candidates) {
            if (pickIds.has(candidate.id)) continue;
            if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
        }
    }
    return [...byId.values()];
}

/**
 * Deterministic PRNG (mulberry32), so the random baseline is reproducible.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Floor: shuffles the candidate pool.
 *
 * Establishes what "no ranking signal at all" scores. Any model that fails to beat this is not
 * ranking, it is reordering.
 */
const random = {
    name: 'random',
    description: 'Shuffles the candidate pool — the no-signal floor',
    rankCandidates(groups, pickIds) {
        const candidates = uniqueCandidates(groups, pickIds);
        // Seeded from the pool itself so the result is stable for a given instance without needing
        // the harness to thread a seed through.
        const rand = mulberry32(candidates.length * 2654435761);
        return candidates
            .map(c => ({ id: c.id, sort: rand() }))
            .sort((a, b) => a.sort - b.sort)
            .map(c => ({ id: c.id, matchScore: 0, matchCount: 1 }));
    }
};

/**
 * Ranks by how many TMDB users voted on a film — a pure popularity proxy.
 *
 * The bar the real model must clear. Exposure bias in MovieLens flatters this baseline, which is
 * exactly why it is the honest comparison.
 */
const popularity = {
    name: 'popularity',
    description: 'Ranks by TMDB vote_count — ignores the user\'s picks entirely',
    rankCandidates(groups, pickIds) {
        return uniqueCandidates(groups, pickIds)
            .map(c => ({ id: c.id, matchScore: c.vote_count || 0, matchCount: 1 }))
            .sort((a, b) => b.matchScore - a.matchScore);
    }
};

/**
 * Ranks by TMDB rating, with a vote-count floor.
 *
 * The floor matters: without it, a film rated 9.0 by 12 people outranks an acknowledged classic.
 * That is the flaw a Bayesian prior would fix, reproduced here as a crude cutoff.
 */
const rating = {
    name: 'rating',
    description: 'Ranks by TMDB vote_average (min 100 votes) — ignores the user\'s picks entirely',
    rankCandidates(groups, pickIds) {
        return uniqueCandidates(groups, pickIds)
            .map(c => ({
                id: c.id,
                matchScore: (c.vote_count || 0) >= 100 ? (c.vote_average || 0) : 0,
                matchCount: 1
            }))
            .sort((a, b) => b.matchScore - a.matchScore);
    }
};

/**
 * Ranks purely by how many of the user's picks surfaced each candidate.
 *
 * Isolates the single signal the current model treats as a bolt-on bonus. If this alone matches the
 * full five-factor model, then genre, director, actor, era, and rating scoring contribute nothing —
 * which would be the most useful negative result the harness could produce.
 */
const multiMatch = {
    name: 'multimatch',
    description: 'Ranks by how many picks surfaced the candidate — no content features at all',
    rankCandidates(groups, pickIds) {
        const counts = new Map();
        for (const { pick, candidates } of groups) {
            for (const candidate of candidates) {
                if (pickIds.has(candidate.id)) continue;
                if (!counts.has(candidate.id)) counts.set(candidate.id, new Set());
                counts.get(candidate.id).add(pick.id);
            }
        }
        return [...counts.entries()]
            .map(([id, picks]) => ({ id, matchScore: picks.size, matchCount: picks.size }))
            .sort((a, b) => b.matchScore - a.matchScore);
    }
};

module.exports = { random, popularity, rating, multiMatch };

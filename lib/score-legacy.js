/**
 * The current (hand-tuned) recommendation model, extracted for measurement.
 *
 * This is a faithful port of the scoring logic in public/index.html — `calculateMatchScore` and the
 * aggregation loop inside `buildAndRenderRecommendations`. It is deliberately **not** improved: its
 * whole purpose is to produce the baseline number that every future model is compared against.
 *
 * Without a baseline, "the new model is better" is unfalsifiable. Any change to the numbers here
 * invalidates every comparison made against them, so treat this file as frozen.
 *
 * Known flaws, reproduced intentionally:
 *
 *   1. The base of 60 is constant for every candidate and carries no ranking information. Realistic
 *      totals cluster in the 70-88 range, which makes the ranking weakly discriminative.
 *   2. Rarity is ignored — sharing "Drama" scores exactly as much as sharing "Film-Noir".
 *   3. Only 3 actors are kept per reference film while candidates are compared on their top 10, so
 *      actor overlap almost never fires.
 *   4. Aggregation keeps the best single pairing rather than modelling the profile as a whole.
 *   5. The multi-match bonus saturates against the 100 cap, so matching 5 picks and 8 picks are
 *      indistinguishable.
 *
 * @module lib/score-legacy
 */

/** Number of actors retained per reference film. Asymmetric with candidates by design — see above. */
const REFERENCE_ACTOR_COUNT = 3;
/** Number of candidate actors compared against the reference's list. */
const CANDIDATE_ACTOR_COUNT = 10;

/**
 * Converts full TMDB details into the trimmed shape the frontend stores for a selected movie.
 *
 * Mirrors the object literal built in `selectMovie` so the harness scores exactly what the app would.
 *
 * @param {object} details - TMDB movie details including `credits`.
 * @returns {{id: number, title: string, year: string, rating: number, genres: object[],
 *            director: string, actors: string[]}}
 */
function toReference(details) {
    return {
        id: details.id,
        title: details.title,
        year: details.release_date ? details.release_date.substring(0, 4) : 'N/A',
        rating: details.vote_average,
        genres: details.genres || [],
        director: details.credits?.crew?.find(c => c.job === 'Director')?.name || 'N/A',
        actors: details.credits?.cast?.slice(0, REFERENCE_ACTOR_COUNT).map(a => a.name) || []
    };
}

/**
 * Scores how well a candidate matches one reference film.
 *
 * Ported verbatim from `calculateMatchScore` in public/index.html.
 *
 * @param {object} candidate - Full TMDB details for the candidate.
 * @param {object} reference - A reference film, as produced by {@link toReference}.
 * @returns {{total: number, breakdown: {base: number, genre: number, director: number,
 *            actors: number, year: number, rating: number}}}
 */
function calculateMatchScore(candidate, reference) {
    let score = 60;
    const breakdown = { base: 60, genre: 0, director: 0, actors: 0, year: 0, rating: 0 };

    // 1. Genre overlap (up to 15)
    const candGenres = candidate.genres?.map(g => g.id) || [];
    const refGenres = reference.genres?.map(g => g.id) || [];
    const genreOverlap = candGenres.filter(g => refGenres.includes(g)).length;

    if (genreOverlap >= 3) breakdown.genre = 15;
    else if (genreOverlap === 2) breakdown.genre = 10;
    else if (genreOverlap === 1) breakdown.genre = 5;
    score += breakdown.genre;

    // 2. Director match (15)
    const candDirector = candidate.credits?.crew?.find(c => c.job === 'Director')?.name;
    if (candDirector && candDirector === reference.director) {
        breakdown.director = 15;
        score += 15;
    }

    // 3. Actor overlap (up to 15)
    const candActors = candidate.credits?.cast?.slice(0, CANDIDATE_ACTOR_COUNT).map(a => a.name) || [];
    const refActors = reference.actors || [];
    const actorOverlap = candActors.filter(a => refActors.includes(a)).length;
    breakdown.actors = Math.min(actorOverlap * 7, 15);
    score += breakdown.actors;

    // 4. Era proximity (up to 5)
    const candYear = candidate.release_date ? parseInt(candidate.release_date.substring(0, 4)) : 0;
    const refYear = parseInt(reference.year) || 0;
    if (candYear && refYear) {
        const yearDiff = Math.abs(candYear - refYear);
        if (yearDiff <= 2) breakdown.year = 5;
        else if (yearDiff <= 5) breakdown.year = 3;
        else if (yearDiff <= 10) breakdown.year = 2;
        else if (yearDiff <= 20) breakdown.year = 1;
        score += breakdown.year;
    }

    // 5. Rating quality (up to 10)
    const rating = candidate.vote_average || 0;
    if (rating >= 8.0) breakdown.rating = 10;
    else if (rating >= 7.5) breakdown.rating = 7;
    else if (rating >= 7.0) breakdown.rating = 5;
    else if (rating >= 6.5) breakdown.rating = 3;
    score += breakdown.rating;

    return { total: Math.min(Math.round(score), 100), breakdown };
}

/**
 * Ranks candidates against a set of picks, reproducing the app's aggregation.
 *
 * Faithful to `buildAndRenderRecommendations`, including its quirks:
 *
 *   - A candidate is scored **once**, against the first pick that surfaced it. The app's attempt to
 *     keep the higher score across picks sits in an unreachable branch, so later picks only increment
 *     `matchCount` and never rescore.
 *   - `+10` per additional matching pick, capped at 100.
 *   - Ties break by insertion order, which follows pick order — so the first-picked film's candidates
 *     win ties. `Array.prototype.sort` is stable, so this is reproduced exactly.
 *
 * @param {Array<{pick: object, candidates: object[]}>} groups - Per-pick candidate lists, in pick
 *   order. `pick` is full TMDB details; `candidates` are full TMDB details.
 * @param {Set<number>} pickIds - TMDB ids of the picks, excluded from results.
 * @returns {Array<{id: number, matchScore: number, matchCount: number}>} Ranked, highest first.
 */
function rankCandidates(groups, pickIds) {
    const all = new Map();
    const seenIds = new Set();

    for (const { pick, candidates } of groups) {
        const reference = toReference(pick);

        for (const candidate of candidates) {
            if (pickIds.has(candidate.id)) continue;

            if (!seenIds.has(candidate.id)) {
                seenIds.add(candidate.id);
                const { total } = calculateMatchScore(candidate, reference);
                all.set(candidate.id, {
                    id: candidate.id,
                    baseScore: total,
                    matchCount: 1,
                    matchedPicks: [pick.id]
                });
            } else {
                const existing = all.get(candidate.id);
                // Guard mirrors the app's `!includes(movie.title)` check: a candidate appearing in
                // both the similar and recommendations list for the *same* pick must not double-count.
                if (existing && !existing.matchedPicks.includes(pick.id)) {
                    existing.matchCount++;
                    existing.matchedPicks.push(pick.id);
                }
            }
        }
    }

    return [...all.values()]
        .map(entry => ({
            id: entry.id,
            matchCount: entry.matchCount,
            matchScore: entry.matchCount > 1
                ? Math.min(entry.baseScore + (entry.matchCount - 1) * 10, 100)
                : entry.baseScore
        }))
        .sort((a, b) => b.matchScore - a.matchScore);
}

module.exports = {
    name: 'legacy',
    description: 'Hand-tuned additive model shipped in public/index.html',
    toReference,
    calculateMatchScore,
    rankCandidates
};

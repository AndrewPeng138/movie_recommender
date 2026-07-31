/**
 * Recommendation ranking.
 *
 * Same five scoring factors as lib/score-legacy.js — genre, director, actors, era, rating — with the
 * aggregation bugs fixed. The *model* is deliberately unchanged so that Phase 4's effect can be
 * attributed to the bug fixes alone; replacing the model is a separate piece of work with its own
 * measurement.
 *
 * ## The four bugs fixed here
 *
 * **1. Candidates were only ever scored once.** The shipped code tries to keep the higher score when
 * a film is surfaced by several picks, but that branch sits inside `if (!seenIds.has(rec.id))` and a
 * film can only be in `allRecs` after being added to `seenIds` on the same line — so it is
 * unreachable. A candidate's score was permanently whatever the *first* pick that surfaced it
 * produced. Here every (candidate, pick) pair is scored and the best kept.
 *
 * **2. TMDB's `recommendations` results were discarded.** The shipped code slices the concatenation
 * `similar ++ recommendations` to 20 items, and since `similar` alone returns 20, the recommendations
 * list never survived. Fixed in lib/recommend.js by taking from each source separately.
 *
 * **3. Ties broke by insertion order**, which follows pick order, so the first-picked film's
 * candidates silently won every tie. Now ties break on a deterministic, meaningful key.
 *
 * **4. One failed request killed a whole pick's candidates.** The catch wrapped the entire candidate
 * loop. Handled per-candidate in lib/recommend.js instead.
 *
 * @module lib/rank
 */

/** Actors retained per reference film. Matches the shipped behaviour. */
const REFERENCE_ACTOR_COUNT = 3;
/** Candidate actors compared against the reference list. */
const CANDIDATE_ACTOR_COUNT = 10;

/**
 * Reduces full TMDB details to the fields scoring needs.
 *
 * @param {object} details - TMDB movie details including `credits`.
 * @returns {object} Reference shape used by {@link scorePair}.
 */
function toReference(details) {
    return {
        id: details.id,
        title: details.title,
        year: details.release_date ? details.release_date.substring(0, 4) : 'N/A',
        genres: details.genres || [],
        director: details.credits?.crew?.find(c => c.job === 'Director')?.name || 'N/A',
        actors: details.credits?.cast?.slice(0, REFERENCE_ACTOR_COUNT).map(a => a.name) || []
    };
}

/**
 * Scores one candidate against one reference film.
 *
 * Identical arithmetic to the shipped model, retained so Phase 4 changes plumbing rather than
 * results. Its known weaknesses — a constant base of 60 that carries no ranking information, no
 * rarity weighting, and an actor comparison that almost never fires — are model problems addressed
 * separately.
 *
 * @param {object} candidate - Full TMDB details for the candidate.
 * @param {object} reference - Output of {@link toReference}.
 * @returns {{total: number, breakdown: object}} Score out of 100 and per-factor contributions.
 */
function scorePair(candidate, reference) {
    let score = 60;
    const breakdown = { base: 60, genre: 0, director: 0, actors: 0, year: 0, rating: 0 };

    const candGenres = candidate.genres?.map(g => g.id) || [];
    const refGenres = reference.genres?.map(g => g.id) || [];
    const genreOverlap = candGenres.filter(g => refGenres.includes(g)).length;
    if (genreOverlap >= 3) breakdown.genre = 15;
    else if (genreOverlap === 2) breakdown.genre = 10;
    else if (genreOverlap === 1) breakdown.genre = 5;
    score += breakdown.genre;

    const candDirector = candidate.credits?.crew?.find(c => c.job === 'Director')?.name;
    if (candDirector && candDirector === reference.director) {
        breakdown.director = 15;
        score += 15;
    }

    const candActors = candidate.credits?.cast?.slice(0, CANDIDATE_ACTOR_COUNT).map(a => a.name) || [];
    const actorOverlap = candActors.filter(a => (reference.actors || []).includes(a)).length;
    breakdown.actors = Math.min(actorOverlap * 7, 15);
    score += breakdown.actors;

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

    const rating = candidate.vote_average || 0;
    if (rating >= 8.0) breakdown.rating = 10;
    else if (rating >= 7.5) breakdown.rating = 7;
    else if (rating >= 7.0) breakdown.rating = 5;
    else if (rating >= 6.5) breakdown.rating = 3;
    score += breakdown.rating;

    return { total: Math.min(Math.round(score), 100), breakdown };
}

/**
 * Ranks candidates against every pick that surfaced them.
 *
 * BUG FIX 1: each candidate is scored against *every* pick whose candidate list contained it, and the
 * best pairing is kept. The shipped code scored only against the first such pick.
 *
 * BUG FIX 3: ties break on `(score, matchCount, id)` rather than insertion order, so results no longer
 * depend on which film the user happened to select first. Sorting by id last is deliberate — it keeps
 * ordering deterministic without introducing a popularity signal the model never asked for.
 *
 * @param {Array<{pick: object, candidates: object[]}>} groups - Per-pick candidate lists, each
 *   entry holding full TMDB details.
 * @param {Set<number>} pickIds - Ids of the user's picks, excluded from output.
 * @returns {Array<object>} Ranked candidates with score, match count, and attribution.
 */
function rankCandidates(groups, pickIds) {
    /** @type {Map<number, object>} */
    const byId = new Map();

    for (const { pick, candidates } of groups) {
        const reference = toReference(pick);

        for (const candidate of candidates) {
            if (pickIds.has(candidate.id)) continue;

            const { total, breakdown } = scorePair(candidate, reference);
            const existing = byId.get(candidate.id);

            if (!existing) {
                byId.set(candidate.id, {
                    details: candidate,
                    bestScore: total,
                    breakdown,
                    matchedPickIds: new Set([pick.id]),
                    matchedPickTitles: [pick.title]
                });
                continue;
            }

            // Keep the strongest pairing, and its breakdown, so the explanation shown to the user
            // corresponds to the score actually displayed.
            if (total > existing.bestScore) {
                existing.bestScore = total;
                existing.breakdown = breakdown;
            }

            if (!existing.matchedPickIds.has(pick.id)) {
                existing.matchedPickIds.add(pick.id);
                existing.matchedPickTitles.push(pick.title);
            }
        }
    }

    return [...byId.values()]
        .map(entry => {
            const matchCount = entry.matchedPickIds.size;
            const multiMatchBonus = matchCount > 1 ? (matchCount - 1) * 10 : 0;
            return {
                id: entry.details.id,
                details: entry.details,
                matchScore: Math.min(entry.bestScore + multiMatchBonus, 100),
                matchCount,
                multiMatchBonus,
                breakdown: entry.breakdown,
                similarTo: entry.matchedPickTitles
            };
        })
        .sort((a, b) =>
            b.matchScore - a.matchScore
            || b.matchCount - a.matchCount
            || a.id - b.id);
}

module.exports = {
    name: 'fixed',
    description: 'Legacy five-factor model with the aggregation bugs fixed',
    toReference,
    scorePair,
    rankCandidates
};

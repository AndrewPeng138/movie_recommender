/**
 * Quality signals, independent of similarity.
 *
 * ## Why this exists
 *
 * A film can share a director, genre, and half its cast with something you love and still be bad.
 * Similarity answers "is this the same kind of film?" — it says nothing about whether the film is any
 * good. These are separate questions and deserve separate signals.
 *
 * Three independent sources, deliberately chosen because they fail in different ways:
 *
 *   1. **TMDB rating** — broad general-audience vote, Bayesian-adjusted for vote count.
 *   2. **MovieLens rating** — film-enthusiast ratings, a different population with different taste.
 *   3. **Awards** — critical recognition, which neither ratings source captures. A film can be
 *      widely disliked and still be a major award winner, and vice versa.
 *
 * ## Every signal is a popularity risk
 *
 * Measurement showed that ranking purely by popularity scores **exactly zero** on obscure targets —
 * it stops recommending and starts listing famous films. Quality signals correlate with popularity,
 * so each one carries that risk. That is why their blend weights are tuned against the harness with
 * popularity-stratified metrics watching, rather than assumed.
 *
 * @module lib/quality
 */

const fs = require('fs');
const path = require('path');
const { parseCsv, loadLinks, datasetDir } = require('./movielens');

/**
 * Bayesian prior strength for TMDB ratings, in votes.
 *
 * A film needs roughly this many votes before its raw average is trusted over the corpus mean. At
 * m = 500: a 7.8 from 15 votes lands near 6.5, while an 8.4 from 10,000 votes stays at ~8.3.
 */
const TMDB_PRIOR_VOTES = 500;

/**
 * Bayesian prior strength for MovieLens ratings, in ratings.
 *
 * Much smaller than the TMDB figure because MovieLens has ~100k ratings total rather than millions —
 * a film with 50 MovieLens ratings is comparatively well-attested.
 */
const ML_PRIOR_RATINGS = 20;

/**
 * Bayesian-adjusted rating.
 *
 * `(v/(v+m))·R + (m/(v+m))·C` — shrinks a rating toward the corpus mean in proportion to how little
 * evidence supports it. This is the fix for "9.0 from twelve people outranks an acknowledged classic":
 * the twelve-vote film is pulled almost entirely back to average, while a heavily-voted film keeps
 * its rating.
 *
 * @param {number} rating - Raw average.
 * @param {number} votes - Number of votes.
 * @param {number} priorMean - Corpus mean rating.
 * @param {number} priorStrength - Votes required before the raw rating dominates.
 * @returns {number} Adjusted rating on the input scale.
 */
function bayesianRating(rating, votes, priorMean, priorStrength) {
    if (!votes || votes <= 0) return priorMean;
    return (votes / (votes + priorStrength)) * rating
        + (priorStrength / (votes + priorStrength)) * priorMean;
}

/**
 * Loads per-film average MovieLens ratings.
 *
 * ## Leakage control
 *
 * `excludeUsers` drops those users' ratings before averaging, exactly as the collaborative filtering
 * model does. Without it, an evaluated user's own rating of the held-out film would feed the quality
 * score of that film — the model would rate it highly *because that user rated it highly*, which is
 * precisely the fact being withheld. The measurement would be fiction.
 *
 * @param {object} [options]
 * @param {string} [options.dataset]
 * @param {Set<number>} [options.excludeUsers] - User ids to omit entirely.
 * @returns {{byTmdbId: Map<number, {mean: number, count: number}>, corpusMean: number}}
 */
function loadMovieLensRatings({ dataset = 'ml-latest-small', excludeUsers = new Set() } = {}) {
    const { toTmdb } = loadLinks(dataset);
    const rows = parseCsv(path.join(datasetDir(dataset), 'ratings.csv'));

    /** @type {Map<number, {sum: number, count: number}>} */
    const totals = new Map();
    let globalSum = 0;
    let globalCount = 0;

    for (const row of rows) {
        if (excludeUsers.has(Number(row.userId))) continue;

        const tmdbId = toTmdb.get(Number(row.movieId));
        if (!tmdbId) continue;

        const rating = Number(row.rating);
        const entry = totals.get(tmdbId) || { sum: 0, count: 0 };
        entry.sum += rating;
        entry.count++;
        totals.set(tmdbId, entry);

        globalSum += rating;
        globalCount++;
    }

    const corpusMean = globalCount > 0 ? globalSum / globalCount : 3.5;

    const byTmdbId = new Map();
    for (const [tmdbId, { sum, count }] of totals) {
        byTmdbId.set(tmdbId, { mean: sum / count, count });
    }

    return { byTmdbId, corpusMean };
}

/**
 * Loads the awards artifact produced by scripts/fetch-awards.js.
 *
 * Returns an empty index if the artifact is absent, so the scorer degrades to using ratings alone
 * rather than failing. Awards are an enhancement, not a requirement.
 *
 * @param {string} [file]
 * @returns {{byTmdbId: Map<number, {wins: number, nominations: number}>, available: boolean}}
 */
function loadAwards(file = path.join(__dirname, '..', 'data', 'awards.json')) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const byTmdbId = new Map(
            Object.entries(raw.awards).map(([id, v]) => [Number(id), v])
        );
        return { byTmdbId, available: true };
    } catch {
        return { byTmdbId: new Map(), available: false };
    }
}

/**
 * Builds a quality scorer over the available signals.
 *
 * Each signal is normalised to roughly 0..1 so that blend weights are comparable, and so a weight of
 * 0 cleanly disables a signal during the sweep.
 *
 * @param {object} [options]
 * @param {Map<number, {mean: number, count: number}>} [options.movieLens]
 * @param {number} [options.movieLensMean]
 * @param {Map<number, {wins: number, nominations: number}>} [options.awards]
 * @param {number} [options.tmdbCorpusMean] - Mean TMDB rating across the corpus.
 * @returns {(details: object) => {tmdb: number, movielens: number, awards: number}} Per-signal
 *   scores in 0..1 for a film.
 */
function createQualityScorer({
    movieLens = new Map(),
    movieLensMean = 3.5,
    awards = new Map(),
    tmdbCorpusMean = 6.4
} = {}) {
    return function qualityOf(details) {
        // TMDB: 0-10 scale, Bayesian-adjusted, mapped to 0..1.
        const tmdb = bayesianRating(
            details.vote_average || 0,
            details.vote_count || 0,
            tmdbCorpusMean,
            TMDB_PRIOR_VOTES
        ) / 10;

        // MovieLens: 0.5-5.0 scale, Bayesian-adjusted, mapped to 0..1.
        const ml = movieLens.get(details.id);
        const movielens = bayesianRating(
            ml ? ml.mean : movieLensMean,
            ml ? ml.count : 0,
            movieLensMean,
            ML_PRIOR_RATINGS
        ) / 5;

        // Awards: log-compressed, because the difference between 0 and 2 wins is meaningful while
        // the difference between 40 and 42 is not. Nominations count less than wins but are not
        // worthless — a nomination is still recognition.
        const record = awards.get(details.id);
        const weighted = record ? record.wins + 0.4 * record.nominations : 0;
        // ln(1+30) ~ 3.43 puts a heavily-awarded film near 1.0 without hard-capping.
        const awardScore = Math.min(Math.log1p(weighted) / Math.log1p(30), 1);

        return { tmdb, movielens, awards: awardScore };
    };
}

module.exports = {
    TMDB_PRIOR_VOTES,
    ML_PRIOR_RATINGS,
    bayesianRating,
    loadMovieLensRatings,
    loadAwards,
    createQualityScorer
};

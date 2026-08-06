/**
 * Server-side recommendation pipeline.
 *
 * Replaces the browser-side loop that issued up to ~200 sequential HTTP round-trips and took 30-60
 * seconds. The same work now happens here in parallel, behind the cache, in a single request.
 *
 * ## Generation is a seam
 *
 * Candidate generation is deliberately isolated behind {@link GENERATORS}. Measurement showed
 * generation matters far more than ranking — collaborative filtering lifted the candidate ceiling
 * from 10.4% to 95.7% in evaluation — but CF currently has data for only ~13% of films people
 * realistically pick, and none released after roughly 2018. It is therefore not wired in yet. This
 * seam exists so adding it later is a registration, not a rewrite.
 *
 * @module lib/recommend
 */

const fs = require('fs');
const path = require('path');

const { getMovie, getSimilar, getRecommendations, mapWithLimit } = require('./tmdb');
const rank = require('./rank');
const { createModel } = require('./score');

/**
 * Loads the TF-IDF model from its committed artifacts.
 *
 * Both artifacts are committed rather than built on Render, because building them requires the
 * 19,204-file TMDB corpus and the MovieLens dataset, neither of which exists in production. They are
 * derived aggregates — an IDF table and per-film rating/award summaries — not the source data.
 *
 * Loaded once at module load. `data/idf.json` is ~0.5 MB and `data/quality.json` ~261 KB, so this
 * costs a few MB of heap against Render's 512 MB and roughly 10 ms of boot time.
 *
 * Returns null if either artifact is missing, in which case the server falls back to the legacy
 * scorer rather than failing to boot. A missing artifact should degrade recommendations, not take
 * the site down.
 *
 * @returns {object|null}
 */
function loadTfidfModel() {
    try {
        const dataDir = path.join(__dirname, '..', 'data');
        const { idf } = JSON.parse(fs.readFileSync(path.join(dataDir, 'idf.json'), 'utf8'));
        const artifact = JSON.parse(fs.readFileSync(path.join(dataDir, 'quality.json'), 'utf8'));

        // [mean, count] pairs, compacted in the artifact to keep it small.
        const movieLens = new Map(
            Object.entries(artifact.movielens).map(([id, [mean, count]]) => [Number(id), { mean, count }])
        );
        const awards = new Map(
            Object.entries(artifact.awards).map(([id, v]) => [Number(id), v])
        );

        const model = createModel({
            idf,
            quality: {
                movieLens,
                movieLensMean: artifact.movieLensCorpusMean,
                awards
            }
        });

        console.log(`TF-IDF model loaded: ${Object.keys(idf).length.toLocaleString()} features, `
            + `${movieLens.size.toLocaleString()} rated films, ${awards.size.toLocaleString()} with awards`);
        return model;
    } catch (error) {
        console.error('Could not load TF-IDF artifacts; falling back to the legacy scorer:',
            error.message);
        return null;
    }
}

const tfidfModel = loadTfidfModel();

/** Candidates taken from each source list per pick. */
const CANDIDATES_PER_SOURCE = 20;

/** Results returned to the client. */
const RESULT_LIMIT = 30;

/** Maximum picks accepted, matching the UI. */
const MAX_PICKS = 10;

/** Minimum picks required, matching the UI. */
const MIN_PICKS = 3;

/**
 * Candidate generators, keyed by name.
 *
 * Each takes a TMDB id and resolves to candidate ids. Registering a new one here is all that is
 * needed to make it selectable.
 */
const GENERATORS = {
    /**
     * TMDB's own `similar` and `recommendations` lists.
     *
     * BUG FIX 2: takes the top N from **each** list rather than slicing their concatenation. The
     * shipped code sliced `similar ++ recommendations` to 20 total, and because `similar` alone
     * returns 20, TMDB's recommendations were discarded entirely — every one of those API calls was
     * wasted on data that was thrown away.
     *
     * @param {string} tmdbId
     * @returns {Promise<number[]>}
     */
    async tmdb(tmdbId) {
        const [similar, recommended] = await Promise.all([
            getSimilar(tmdbId).catch(() => ({ results: [] })),
            getRecommendations(tmdbId).catch(() => ({ results: [] }))
        ]);

        return [...new Set([
            ...(similar.results || []).slice(0, CANDIDATES_PER_SOURCE).map(m => m.id),
            ...(recommended.results || []).slice(0, CANDIDATES_PER_SOURCE).map(m => m.id)
        ])];
    }
};

/**
 * Validates and normalises the requested movie ids.
 *
 * @param {unknown} movieIds
 * @returns {string[]} Validated ids as strings.
 * @throws {Error} With a `status` property for the error middleware.
 */
function requirePicks(movieIds) {
    const fail = message => {
        const error = new Error(message);
        error.status = 400;
        throw error;
    };

    if (!Array.isArray(movieIds)) fail('Body must include an array: movieIds.');

    const ids = [...new Set(movieIds.map(String))];
    if (ids.length < MIN_PICKS) fail(`At least ${MIN_PICKS} movies are required.`);
    if (ids.length > MAX_PICKS) fail(`At most ${MAX_PICKS} movies are allowed.`);
    if (!ids.every(id => /^\d+$/.test(id))) fail('Every movie id must be a positive integer.');

    return ids;
}

/**
 * Builds recommendations for a set of picks.
 *
 * BUG FIX 4: failures are handled per item rather than per pick. The shipped code wrapped an entire
 * pick's candidate loop in one try/catch, so a single failed request — a TMDB 429 was likely at ~200
 * rapid requests — silently discarded every remaining candidate for that pick, quietly returning
 * incomplete results with no indication anything had gone wrong.
 *
 * @param {string[]} pickIds - Validated TMDB ids.
 * @param {object} [options]
 * @param {string} [options.generator] - Key into {@link GENERATORS}.
 * @param {number} [options.limit] - Results to return.
 * @returns {Promise<{results: object[], meta: object}>}
 */
async function recommend(pickIds, { generator = 'tmdb', limit = RESULT_LIMIT } = {}) {
    const started = Date.now();
    const generate = GENERATORS[generator];
    if (!generate) {
        const error = new Error(`Unknown generator: ${generator}`);
        error.status = 400;
        throw error;
    }

    // 1. Fetch details for the picks themselves, in parallel.
    const pickResults = await mapWithLimit(pickIds, id => getMovie(id));
    const picks = pickResults.filter(r => r.value).map(r => r.value);

    if (picks.length < MIN_PICKS) {
        const error = new Error('Could not load enough of the selected movies.');
        error.status = 502;
        throw error;
    }

    const pickIdSet = new Set(picks.map(p => p.id));

    // 2. Generate candidates for every pick, in parallel. A pick whose generation fails contributes
    //    nothing rather than aborting the run.
    const generated = await mapWithLimit(picks, pick => generate(String(pick.id)));

    const groupIds = generated.map((result, index) => ({
        pick: picks[index],
        ids: (result.value || []).filter(id => !pickIdSet.has(id))
    }));

    // 3. Hydrate every unique candidate exactly once, in parallel. This is the step that was ~200
    //    sequential round-trips in the browser.
    const uniqueIds = [...new Set(groupIds.flatMap(g => g.ids))];
    const detailResults = await mapWithLimit(uniqueIds, id => getMovie(String(id)));

    const detailsById = new Map();
    for (const result of detailResults) {
        if (result.value) detailsById.set(result.value.id, result.value);
    }

    // 4. Score and rank.
    const groups = groupIds.map(({ pick, ids }) => ({
        pick,
        candidates: ids.map(id => detailsById.get(id)).filter(Boolean)
    }));

    // The TF-IDF model measured +48% precision@30 and +49% MRR against the legacy scorer on a
    // held-out test split. It is used whenever its artifacts loaded; the legacy scorer remains as a
    // fallback so a missing artifact degrades quality rather than breaking the endpoint.
    const usingTfidf = Boolean(tfidfModel);
    let results;

    if (usingTfidf) {
        const scored = tfidfModel.rankCandidates(groups, pickIdSet);
        results = tfidfModel.finalise(scored, limit).map(entry => ({
            id: entry.id,
            title: entry.details.title,
            year: entry.details.release_date ? entry.details.release_date.substring(0, 4) : 'N/A',
            poster_path: entry.details.poster_path,
            vote_average: entry.details.vote_average,
            overview: entry.details.overview,
            matchScore: entry.matchScore,
            matchCount: entry.similarTo.length,
            similarTo: entry.similarTo,
            // Names the specific features behind the match ("shared keywords: heist") rather than a
            // fixed category total. Cosine decomposes exactly, so each figure is the real
            // contribution, not an approximation.
            contributions: entry.contributions.map(c => ({
                label: c.label,
                type: c.type,
                share: Number((c.contribution).toFixed(4))
            }))
        }));
    } else {
        results = rank.rankCandidates(groups, pickIdSet).slice(0, limit).map(entry => ({
            id: entry.id,
            title: entry.details.title,
            year: entry.details.release_date ? entry.details.release_date.substring(0, 4) : 'N/A',
            poster_path: entry.details.poster_path,
            vote_average: entry.details.vote_average,
            overview: entry.details.overview,
            matchScore: entry.matchScore,
            matchCount: entry.similarTo.length,
            multiMatchBonus: entry.multiMatchBonus,
            breakdown: entry.breakdown,
            similarTo: entry.similarTo
        }));
    }

    const failedPicks = pickResults.filter(r => r.error).length;
    const failedCandidates = detailResults.filter(r => r.error).length;

    return {
        results,
        meta: {
            generator,
            model: usingTfidf ? 'tfidf' : 'legacy',
            picks: picks.length,
            candidatePoolSize: uniqueIds.length,
            returned: results.length,
            durationMs: Date.now() - started,
            // Surfaced rather than swallowed, so partial results are visible instead of silently
            // looking like a complete answer.
            failedPicks,
            failedCandidates
        }
    };
}

module.exports = {
    recommend,
    requirePicks,
    GENERATORS,
    CANDIDATES_PER_SOURCE,
    RESULT_LIMIT,
    MIN_PICKS,
    MAX_PICKS
};

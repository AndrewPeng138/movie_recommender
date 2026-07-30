/**
 * Item-item collaborative filtering over MovieLens co-ratings.
 *
 * ## Why this exists
 *
 * The evaluation harness found that the held-out film reaches TMDB's candidate pool only **10.4%**
 * of the time — and only **3.25%** for less-known films. That is a hard ceiling: 89.6% of correct
 * answers are discarded before any scoring happens, so no ranking change can reach them.
 *
 * Content features cannot fix this, because the pool itself comes from TMDB's `similar` and
 * `recommendations` lists. Collaborative filtering is a fundamentally different information source:
 * it answers "people who liked X also liked Y" from the ratings matrix directly, and can therefore
 * surface any film people co-rated rather than only what TMDB chose to suggest.
 *
 * ## The method
 *
 * Item-item cosine similarity over the binary "liked" matrix. For films `i` and `j`:
 *
 *     sim(i, j) = |users who liked both| / sqrt(|liked i| * |liked j|)
 *
 * The denominator is what stops blockbusters dominating. Without it, popular films co-occur with
 * everything simply because many people rated them, and the model degenerates into the popularity
 * baseline — which scored *exactly zero* on obscure targets. Normalising by each film's own
 * popularity measures whether the overlap is disproportionate rather than merely large.
 *
 * This is deliberately the simplest CF that can work: no latent factors, no training loop, and the
 * output is a plain lookup table that can be precomputed and shipped as a build artifact. That
 * matters because production is a 512 MB Render instance that spins down when idle — live model
 * inference is not an option, a precomputed neighbour list is.
 *
 * ## Leakage
 *
 * The single most important correctness property here. See {@link buildModel} — the evaluated user's
 * ratings must be excluded when building the matrix, or the model has seen the answer and every
 * resulting number is fiction.
 *
 * @module lib/collaborative
 */

const path = require('path');
const { parseCsv, loadLinks, datasetDir, LIKED_THRESHOLD } = require('./movielens');

/**
 * Minimum co-rating count for a pair to be considered related.
 *
 * With 610 users, a pair sharing one or two raters is noise: cosine similarity can be high purely by
 * accident when both films are rare. Requiring a floor trades a little coverage for far less garbage.
 */
const MIN_CO_RATINGS = 3;

/**
 * Neighbours retained per film.
 *
 * Bounds both memory and the size of the shipped artifact. 50 is far more than the ~20 per pick the
 * candidate pool actually consumes, leaving room to tune without rebuilding.
 */
const MAX_NEIGHBOURS = 50;

/**
 * Loads "who liked what" as TMDB ids.
 *
 * @param {string} [dataset]
 * @returns {Map<number, Set<number>>} userId -> set of TMDB ids they rated >= LIKED_THRESHOLD.
 */
function loadLikedByUser(dataset = 'ml-latest-small') {
    const { toTmdb } = loadLinks(dataset);
    const rows = parseCsv(path.join(datasetDir(dataset), 'ratings.csv'));
    const byUser = new Map();

    for (const row of rows) {
        if (Number(row.rating) < LIKED_THRESHOLD) continue;

        const tmdbId = toTmdb.get(Number(row.movieId));
        if (!tmdbId) continue;

        const userId = Number(row.userId);
        if (!byUser.has(userId)) byUser.set(userId, new Set());
        byUser.get(userId).add(tmdbId);
    }

    return byUser;
}

/**
 * Builds an item-item similarity model.
 *
 * ## Excluding users (leakage control)
 *
 * `excludeUsers` drops those users' ratings entirely before counting co-occurrences. This is not an
 * optimisation — it is what makes the evaluation honest.
 *
 * If the evaluated user's ratings stayed in the matrix, their own liking of picks *and* the held-out
 * film would contribute to the co-occurrence counts linking them. The model would then "predict" the
 * held-out film partly because that user liked it, which is precisely the fact being withheld. The
 * result would look excellent and mean nothing.
 *
 * Excluding the whole user (rather than just the held-out rating) is the stricter, correct choice:
 * their remaining ratings still describe the same person's taste and would leak indirectly.
 *
 * @param {object} [options]
 * @param {string} [options.dataset]
 * @param {Set<number>} [options.excludeUsers] - User ids to omit entirely.
 * @param {number} [options.minCoRatings]
 * @param {number} [options.maxNeighbours]
 * @returns {{neighbours: Map<number, Array<{id: number, score: number}>>, stats: object}}
 */
function buildModel({
    dataset = 'ml-latest-small',
    excludeUsers = new Set(),
    minCoRatings = MIN_CO_RATINGS,
    maxNeighbours = MAX_NEIGHBOURS
} = {}) {
    const likedByUser = loadLikedByUser(dataset);

    /** @type {Map<number, number>} How many users liked each film. */
    const likeCount = new Map();
    /** @type {Map<number, Map<number, number>>} Co-occurrence counts, upper triangle only. */
    const coCounts = new Map();

    let usersUsed = 0;

    for (const [userId, liked] of likedByUser) {
        if (excludeUsers.has(userId)) continue;
        usersUsed++;

        const films = [...liked];
        for (const film of films) {
            likeCount.set(film, (likeCount.get(film) || 0) + 1);
        }

        // Count every unordered pair this user liked. O(k^2) per user; with a median of ~50 liked
        // films that is a few thousand increments each, which is fine at this dataset size.
        for (let i = 0; i < films.length; i++) {
            for (let j = i + 1; j < films.length; j++) {
                const [a, b] = films[i] < films[j] ? [films[i], films[j]] : [films[j], films[i]];
                if (!coCounts.has(a)) coCounts.set(a, new Map());
                const row = coCounts.get(a);
                row.set(b, (row.get(b) || 0) + 1);
            }
        }
    }

    // Convert co-occurrence counts into cosine similarity, writing both directions.
    /** @type {Map<number, Array<{id: number, score: number}>>} */
    const neighbours = new Map();
    let pairs = 0;

    const push = (from, to, score) => {
        if (!neighbours.has(from)) neighbours.set(from, []);
        neighbours.get(from).push({ id: to, score });
    };

    for (const [a, row] of coCounts) {
        for (const [b, count] of row) {
            if (count < minCoRatings) continue;

            // Cosine over binary vectors: co-occurrences normalised by each film's own popularity.
            const score = count / Math.sqrt(likeCount.get(a) * likeCount.get(b));
            push(a, b, score);
            push(b, a, score);
            pairs++;
        }
    }

    // Keep only the strongest neighbours per film, bounding memory and artifact size.
    for (const [film, list] of neighbours) {
        list.sort((x, y) => y.score - x.score);
        if (list.length > maxNeighbours) neighbours.set(film, list.slice(0, maxNeighbours));
    }

    return {
        neighbours,
        stats: {
            usersUsed,
            usersExcluded: excludeUsers.size,
            filmsWithNeighbours: neighbours.size,
            pairsRetained: pairs,
            minCoRatings,
            maxNeighbours
        }
    };
}

/**
 * Generates candidates for a set of picks.
 *
 * A film's score is the sum of its similarities to every pick that surfaced it, so a film related to
 * several picks outranks one strongly related to a single pick. That is the same intuition behind the
 * existing multi-match bonus, but derived from the data instead of a hand-chosen `+10`.
 *
 * @param {{neighbours: Map<number, Array<{id: number, score: number}>>}} model
 * @param {number[]} pickIds - TMDB ids of the user's picks.
 * @param {number} [perPick] - Neighbours to draw from each pick.
 * @returns {Array<{id: number, score: number, fromPicks: number}>} Candidates, strongest first.
 */
function generateCandidates(model, pickIds, perPick = 20) {
    const picks = new Set(pickIds);
    /** @type {Map<number, {score: number, fromPicks: number}>} */
    const scores = new Map();

    for (const pickId of pickIds) {
        const related = model.neighbours.get(pickId);
        if (!related) continue;

        for (const { id, score } of related.slice(0, perPick)) {
            if (picks.has(id)) continue;      // Never recommend something already chosen.

            const entry = scores.get(id) || { score: 0, fromPicks: 0 };
            entry.score += score;
            entry.fromPicks++;
            scores.set(id, entry);
        }
    }

    return [...scores.entries()]
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => b.score - a.score);
}

module.exports = {
    MIN_CO_RATINGS,
    MAX_NEIGHBOURS,
    loadLikedByUser,
    buildModel,
    generateCandidates
};

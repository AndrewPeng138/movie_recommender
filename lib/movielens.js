/**
 * MovieLens dataset loader.
 *
 * MovieLens (GroupLens Research, University of Minnesota) publishes real user movie ratings. It is
 * the ground truth this project evaluates against: without it there is no way to tell whether a
 * scoring change made recommendations better or worse.
 *
 * The critical file is `links.csv`, which maps MovieLens `movieId` to **`tmdbId`**. That mapping is
 * the bridge between the ratings data and everything the app already knows how to fetch.
 *
 * Dataset: `ml-latest-small` — 100,836 ratings from 610 users across 9,742 movies. Small enough to
 * iterate on quickly. `ml-25m` exists for final validation but needs roughly 13x the corpus fetching.
 *
 * LICENSE: MovieLens data is provided for research and personal use. It may not be redistributed
 * without permission, which is why the download is gitignored rather than committed.
 * @see https://files.grouplens.org/datasets/movielens/ml-latest-small-README.html
 *
 * @module lib/movielens
 */

const fs = require('fs');
const path = require('path');

/** Where datasets are extracted. Gitignored. */
const DATA_DIR = path.join(__dirname, '..', 'data', 'movielens');

/**
 * Rating at or above which we treat a film as one the user genuinely liked.
 *
 * MovieLens uses a 0.5-5.0 scale in half-star steps. 4.0 is the conventional threshold for
 * "positive" in leave-one-out evaluation: high enough to mean real enthusiasm, low enough to leave
 * most users with enough liked films to sample from.
 */
const LIKED_THRESHOLD = 4.0;

/**
 * Parses a CSV file into row objects.
 *
 * MovieLens CSVs are RFC-4180: fields containing commas are double-quoted, and embedded quotes are
 * doubled. Movie titles routinely contain commas ("Godfather, The (1972)"), so a naive split on comma
 * silently corrupts the data — hence a real parser rather than `line.split(',')`.
 *
 * @param {string} file - Absolute path to the CSV.
 * @returns {Array<Object<string, string>>} Rows keyed by header name.
 */
function parseCsv(file) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = [];
    let headers = null;
    let field = '';
    let record = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }   // Escaped quote.
                else inQuotes = false;
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') { inQuotes = true; }
        else if (char === ',') { record.push(field); field = ''; }
        else if (char === '\n' || char === '\r') {
            // Consume CRLF as a single terminator, and skip blank lines.
            if (char === '\r' && text[i + 1] === '\n') i++;
            if (field !== '' || record.length > 0) {
                record.push(field);
                field = '';
                if (!headers) {
                    headers = record;
                } else {
                    const row = {};
                    headers.forEach((h, idx) => { row[h] = record[idx]; });
                    rows.push(row);
                }
                record = [];
            }
        } else {
            field += char;
        }
    }

    // Final record when the file does not end in a newline.
    if (field !== '' || record.length > 0) {
        record.push(field);
        if (headers) {
            const row = {};
            headers.forEach((h, idx) => { row[h] = record[idx]; });
            rows.push(row);
        }
    }

    return rows;
}

/**
 * Resolves the extracted dataset directory.
 *
 * @param {string} [dataset] - Dataset name.
 * @returns {string} Absolute path.
 */
function datasetDir(dataset = 'ml-latest-small') {
    return path.join(DATA_DIR, dataset);
}

/**
 * Reports whether a dataset has been downloaded and extracted.
 *
 * @param {string} [dataset]
 * @returns {boolean}
 */
function isDownloaded(dataset = 'ml-latest-small') {
    return fs.existsSync(path.join(datasetDir(dataset), 'links.csv'))
        && fs.existsSync(path.join(datasetDir(dataset), 'ratings.csv'));
}

/**
 * Loads the MovieLens → TMDB id mapping.
 *
 * Not every MovieLens film has a TMDB id — `links.csv` leaves the column blank for a small number —
 * so those rows are dropped. Anything without a TMDB id is unusable here, since the recommender can
 * only reason about films it can fetch.
 *
 * @param {string} [dataset]
 * @returns {{toTmdb: Map<number, number>, toMovieLens: Map<number, number>}} Bidirectional mapping.
 */
function loadLinks(dataset = 'ml-latest-small') {
    const rows = parseCsv(path.join(datasetDir(dataset), 'links.csv'));
    const toTmdb = new Map();
    const toMovieLens = new Map();

    for (const row of rows) {
        const movieId = Number(row.movieId);
        const tmdbId = Number(row.tmdbId);
        if (!row.tmdbId || !Number.isFinite(tmdbId) || tmdbId <= 0) continue;

        toTmdb.set(movieId, tmdbId);
        // A handful of MovieLens entries map to the same TMDB id (duplicate listings). Keep the
        // first so the reverse mapping stays deterministic across runs.
        if (!toMovieLens.has(tmdbId)) toMovieLens.set(tmdbId, movieId);
    }

    return { toTmdb, toMovieLens };
}

/**
 * Loads movie titles, for readable output.
 *
 * @param {string} [dataset]
 * @returns {Map<number, string>} MovieLens movieId → title.
 */
function loadTitles(dataset = 'ml-latest-small') {
    const rows = parseCsv(path.join(datasetDir(dataset), 'movies.csv'));
    return new Map(rows.map(r => [Number(r.movieId), r.title]));
}

/**
 * Groups highly-rated films by user.
 *
 * Only films rated at or above {@link LIKED_THRESHOLD} are kept, and only those with a TMDB id. The
 * result is "here are the films this person actually liked, expressed as TMDB ids" — which is exactly
 * the input the recommender takes.
 *
 * @param {object} [options]
 * @param {string} [options.dataset]
 * @param {number} [options.minLiked] - Users with fewer liked films than this are dropped, since a
 *   leave-one-out sample needs picks *plus* a held-out film.
 * @returns {Array<{userId: number, liked: number[]}>} Per-user TMDB ids, sorted by userId for
 *   deterministic ordering.
 */
function loadUserProfiles({ dataset = 'ml-latest-small', minLiked = 8 } = {}) {
    const { toTmdb } = loadLinks(dataset);
    const rows = parseCsv(path.join(datasetDir(dataset), 'ratings.csv'));

    /** @type {Map<number, number[]>} */
    const byUser = new Map();

    for (const row of rows) {
        if (Number(row.rating) < LIKED_THRESHOLD) continue;

        const tmdbId = toTmdb.get(Number(row.movieId));
        if (!tmdbId) continue;

        const userId = Number(row.userId);
        if (!byUser.has(userId)) byUser.set(userId, []);
        byUser.get(userId).push(tmdbId);
    }

    return [...byUser.entries()]
        .filter(([, liked]) => liked.length >= minLiked)
        .map(([userId, liked]) => ({ userId, liked }))
        .sort((a, b) => a.userId - b.userId);
}

/**
 * Counts how many users rated each film, as a popularity proxy.
 *
 * Needed to report metrics stratified by popularity. MovieLens carries *exposure bias*: people only
 * rate films they chose to watch, which skews popular. A recommender that simply suggests blockbusters
 * therefore scores well on raw recall. Splitting results by popularity stops that hiding in an average.
 *
 * @param {string} [dataset]
 * @returns {Map<number, number>} TMDB id → number of ratings.
 */
function loadPopularity(dataset = 'ml-latest-small') {
    const { toTmdb } = loadLinks(dataset);
    const rows = parseCsv(path.join(datasetDir(dataset), 'ratings.csv'));
    const counts = new Map();

    for (const row of rows) {
        const tmdbId = toTmdb.get(Number(row.movieId));
        if (!tmdbId) continue;
        counts.set(tmdbId, (counts.get(tmdbId) || 0) + 1);
    }

    return counts;
}

module.exports = {
    DATA_DIR,
    LIKED_THRESHOLD,
    datasetDir,
    isDownloaded,
    parseCsv,
    loadLinks,
    loadTitles,
    loadUserProfiles,
    loadPopularity
};

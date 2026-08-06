/**
 * TMDB API client.
 *
 * Replaces four near-identical copy-pasted handlers in server.js with one function that owns the
 * API-key check, URL construction, caching, upstream error handling, and status propagation.
 *
 * Three behaviours here are deliberate changes from the previous inline code:
 *
 *   1. **Input is validated before it reaches TMDB.** Movie ids were previously interpolated straight
 *      into the upstream URL with no check.
 *   2. **Upstream status is propagated.** Every handler used to `res.json(data)` regardless of what
 *      TMDB returned, so a 401 (bad key) or 404 (no such movie) came back as HTTP 200 with a
 *      `{ success: false }` body. Callers could not distinguish "no results" from "the call failed".
 *   3. **Responses are cached.** See lib/cache.js for why the backend differs between local and
 *      production.
 *
 * Uses the global `fetch` built into Node 18+, so the `node-fetch` dependency is no longer needed.
 *
 * @module lib/tmdb
 */

const { createCache, HOUR, DAY } = require('./cache');

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Shared cache instance. Backend is chosen by environment — see createCache(). */
const cache = createCache();

/**
 * Maximum retry attempts for a rate-limited (429) request.
 *
 * Bounded deliberately: an unbounded retry would turn a sustained rate limit into a hung request.
 * Three attempts with exponential backoff covers a transient burst without stalling a user's page.
 */
const MAX_RETRIES = 3;

/**
 * Concurrent in-flight TMDB requests allowed process-wide.
 *
 * TMDB removed its original 40-requests-per-10-seconds limit in December 2019 and now applies a soft
 * ceiling "somewhere in the 40 requests per second range", asking callers to respect a 429. This sits
 * well under that so bulk corpus building stays a good citizen, while being high enough that fetching
 * thousands of movies takes minutes rather than an hour.
 *
 * Override with TMDB_CONCURRENCY.
 */
const MAX_CONCURRENT = Number(process.env.TMDB_CONCURRENCY) || 12;

/** @type {number} Requests currently in flight. */
let inFlight = 0;
/** @type {Array<() => void>} Resolvers for calls waiting on a free slot. */
const waiting = [];

/**
 * Acquires a concurrency slot, waiting if the ceiling is reached.
 *
 * @returns {Promise<void>} Resolves once a slot is held.
 */
function acquireSlot() {
    if (inFlight < MAX_CONCURRENT) {
        inFlight++;
        return Promise.resolve();
    }
    return new Promise(resolve => waiting.push(resolve));
}

/** Releases a concurrency slot, handing it to the longest-waiting caller if there is one. */
function releaseSlot() {
    const next = waiting.shift();
    if (next) next();      // Hand the slot over directly; inFlight stays the same.
    else inFlight--;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * An error carrying the HTTP status the client should receive.
 *
 * Lets route handlers stay free of try/catch: they throw, and the error middleware in server.js maps
 * `status` onto the response.
 */
class TmdbError extends Error {
    /**
     * @param {number} status - HTTP status to send to our client.
     * @param {string} message - Client-safe message.
     * @param {object} [meta]
     * @param {number} [meta.upstreamStatus] - Status TMDB returned, when the failure came from them.
     */
    constructor(status, message, { upstreamStatus } = {}) {
        super(message);
        this.name = 'TmdbError';
        this.status = status;
        this.upstreamStatus = upstreamStatus;
    }
}

/**
 * Validates a TMDB movie id.
 *
 * Ids are always positive integers. Without this check the value flows into the upstream URL, so a
 * value containing path separators could reshape the request TMDB receives.
 *
 * @param {string} value - Raw value from the request path.
 * @returns {string} The validated id.
 * @throws {TmdbError} 400 if it is not a positive integer.
 */
function requireTmdbId(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new TmdbError(400, 'Invalid movie id: expected a positive integer.');
    }
    return value;
}

/**
 * Validates a search query.
 *
 * A missing query previously reached TMDB as the literal string "undefined", producing confusing
 * results rather than an error.
 *
 * @param {unknown} value - Raw value from the query string.
 * @returns {string} The trimmed query.
 * @throws {TmdbError} 400 if absent, empty, or overlong.
 */
function requireQuery(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TmdbError(400, 'Missing required query parameter: query.');
    }
    const trimmed = value.trim();
    if (trimmed.length > 200) {
        throw new TmdbError(400, 'Query too long: maximum 200 characters.');
    }
    return trimmed;
}

/**
 * Calls a TMDB endpoint, returning parsed JSON.
 *
 * @param {string} endpoint - Path below the API root, e.g. `/movie/27205`.
 * @param {Object<string, string>} [params] - Extra query parameters (the API key is added here).
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Cache lifetime. Defaults to one hour.
 * @returns {Promise<object>} Parsed TMDB response.
 * @throws {TmdbError} 503 if no API key is configured, or the upstream status on failure.
 */
async function tmdb(endpoint, params = {}, { ttlMs = HOUR } = {}) {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
        // 503 rather than 400: the client's request was fine, the server is misconfigured.
        throw new TmdbError(503, 'Server is not configured with a TMDB API key.');
    }

    // Cache key excludes the API key so that rotating the key does not invalidate the whole cache.
    const search = new URLSearchParams(params);
    const cacheKey = `${endpoint}?${search.toString()}`;

    return cache.wrap(cacheKey, ttlMs, async () => {
        search.set('api_key', apiKey);
        const url = `${TMDB_BASE}${endpoint}?${search.toString()}`;

        for (let attempt = 0; ; attempt++) {
            await acquireSlot();

            let response;
            try {
                response = await fetch(url);
            } catch (error) {
                releaseSlot();
                // Network-level failure (DNS, timeout, connection reset) — TMDB never answered. Log
                // the underlying cause server-side; the client gets a generic 502 because the failing
                // URL contains the API key and must never be echoed back.
                console.error(`TMDB network failure for ${endpoint}:`, error.message);
                throw new TmdbError(502, 'Could not reach TMDB.');
            }

            // Rate limited. TMDB asks callers to respect the 429, so back off and retry rather than
            // hammering. Honour Retry-After when present; otherwise back off exponentially.
            if (response.status === 429 && attempt < MAX_RETRIES) {
                const retryAfter = Number(response.headers.get('retry-after'));
                const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : 2 ** attempt * 500;      // 500ms, 1s, 2s

                releaseSlot();                  // Free the slot *before* sleeping, so waiting callers
                                                // are not blocked by our backoff.
                console.warn(`TMDB rate limited on ${endpoint}; retrying in ${waitMs}ms`);
                await delay(waitMs);
                continue;
            }

            releaseSlot();

            if (!response.ok) {
                // Surface TMDB's own explanation when it provides one, but never leak the URL (it
                // contains the API key).
                let detail = '';
                try {
                    const body = await response.json();
                    if (body && typeof body.status_message === 'string') {
                        detail = ` ${body.status_message}`;
                    }
                } catch {
                    // Non-JSON error body; the status alone is enough.
                }

                throw new TmdbError(
                    response.status,
                    `TMDB request failed (${response.status}).${detail}`,
                    { upstreamStatus: response.status }
                );
            }

            return response.json();
        }
    });
}

/**
 * Runs an async mapper over many items, respecting the shared TMDB concurrency ceiling.
 *
 * Used by the offline corpus build, which fetches thousands of movies. Errors are captured per item
 * rather than aborting the batch: one movie missing from TMDB should not end a 20-minute build.
 *
 * @template T, R
 * @param {T[]} items - Items to process.
 * @param {(item: T, index: number) => Promise<R>} mapper - Async operation per item.
 * @param {object} [options]
 * @param {(done: number, total: number) => void} [options.onProgress] - Called after each completion.
 * @returns {Promise<Array<{item: T, value?: R, error?: Error}>>} One entry per input, in order.
 */
async function mapWithLimit(items, mapper, { onProgress } = {}) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;

    // One worker per concurrency slot; each pulls the next index until the list is exhausted. The
    // slot ceiling is enforced inside tmdb() itself, so workers here simply keep it saturated.
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;

            try {
                results[index] = { item: items[index], value: await mapper(items[index], index) };
            } catch (error) {
                results[index] = { item: items[index], error };
            }

            done++;
            if (onProgress) onProgress(done, items.length);
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * Searches movies by free text.
 *
 * @param {string} query - Search text (validate with requireQuery first).
 * @returns {Promise<object>} TMDB search payload: `{ page, results[], total_pages, total_results }`.
 */
function searchMovies(query) {
    // Short TTL: search rankings shift as popularity changes, and queries are highly varied, so a
    // long TTL would fill the cache with entries that are never read again.
    return tmdb('/search/movie', { query }, { ttlMs: HOUR });
}

/**
 * Fetches full movie details, including cast, crew, and keywords.
 *
 * `append_to_response` folds credits *and* keywords into a single request. This matters for the
 * recommendation pipeline: scoring ~300 candidates with separate keyword calls would double the
 * cold-path request count and roughly double its latency. One call, both payloads.
 *
 * It also keeps the evaluation harness and the live server on the *same* fetch path, which is what
 * makes the measured numbers describe the code that actually runs.
 *
 * @param {string} tmdbId - Validated movie id.
 * @returns {Promise<object>} Movie details with `credits` and `keywords` objects.
 */
function getMovie(tmdbId) {
    // Long TTL: a released film's genres, cast, crew, and keywords are effectively immutable.
    return tmdb(`/movie/${tmdbId}`, { append_to_response: 'credits,keywords' }, { ttlMs: DAY });
}

/**
 * Fetches TMDB's "similar" list for a movie.
 *
 * @param {string} tmdbId - Validated movie id.
 * @returns {Promise<object>} Paginated `{ results[] }`.
 */
function getSimilar(tmdbId) {
    return tmdb(`/movie/${tmdbId}/similar`, {}, { ttlMs: DAY });
}

/**
 * Fetches TMDB's recommendations for a movie.
 *
 * @param {string} tmdbId - Validated movie id.
 * @returns {Promise<object>} Paginated `{ results[] }`.
 */
function getRecommendations(tmdbId) {
    return tmdb(`/movie/${tmdbId}/recommendations`, {}, { ttlMs: DAY });
}

/**
 * Fetches a movie's keywords.
 *
 * Keywords ("time loop", "heist", "coming of age") describe what a film is *about* in a way genres
 * cannot — genres are a 19-value vocabulary shared by thousands of films, while keywords are specific
 * and therefore far more informative when two films share one. This is the highest-signal content
 * feature available from TMDB and the basis of the rarity weighting planned for the scoring rebuild.
 *
 * @param {string} tmdbId - Validated movie id.
 * @returns {Promise<object>} `{ id, keywords: [{ id, name }] }`.
 */
function getKeywords(tmdbId) {
    return tmdb(`/movie/${tmdbId}/keywords`, {}, { ttlMs: DAY });
}

module.exports = {
    tmdb,
    mapWithLimit,
    cache,
    TmdbError,
    requireTmdbId,
    requireQuery,
    searchMovies,
    getMovie,
    getSimilar,
    getRecommendations,
    getKeywords,
    HOUR,
    DAY
};

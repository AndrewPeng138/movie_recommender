/**
 * Movie Recommender — backend API server.
 *
 * Acts as a proxy in front of the TMDB v3 API. Its single most important job is keeping
 * TMDB_API_KEY server-side: the browser never sees it, and every TMDB call is routed through here.
 *
 * It also serves the static frontend from public/, so in production the frontend and the API share
 * an origin (which is why the client can use a relative `/api` base URL).
 *
 * All TMDB access, validation, caching, and error mapping lives in lib/tmdb.js — the route handlers
 * below are deliberately thin.
 *
 * @see https://developer.themoviedb.org/reference/intro/getting-started
 */

const path = require('path');

// Load .env from the project directory rather than process.cwd(). dotenv defaults to the working
// directory, so starting the server from anywhere else silently loaded zero variables and the app
// came up with no API key - the same failure mode as the express.static path below.
//
// On Render there is no .env file at all; environment variables come from the dashboard. dotenv
// simply finds nothing and leaves process.env untouched, which is why this is safe in production.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

const {
    cache,
    TmdbError,
    requireTmdbId,
    requireQuery,
    searchMovies,
    getMovie,
    getSimilar,
    getRecommendations,
    getKeywords
} = require('./lib/tmdb');
const { recommend, requirePicks } = require('./lib/recommend');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// NOTE: __dirname, not a bare relative path. `express.static('public')` resolves against
// process.cwd(), so starting the server from any directory other than the project root would
// silently 404 the entire frontend while the API kept working.
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Wraps an async route handler so rejections reach the error middleware.
 *
 * Express 4 does not catch promise rejections from async handlers — an unhandled one hangs the
 * request until the client times out. This adapter removes the need for try/catch in every route.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} handler
 * @returns {import('express').RequestHandler}
 */
function route(handler) {
    return (req, res, next) => handler(req, res).catch(next);
}

/**
 * GET /api/health
 *
 * Liveness check plus cache statistics. Useful for confirming the cache is actually being hit
 * (`hits` should climb on repeated identical requests) and for uptime monitoring.
 *
 * @returns {object} `{ status, apiKeyConfigured, cache: { hits, misses, size, hitRate, backend } }`
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        apiKeyConfigured: Boolean(process.env.TMDB_API_KEY),
        cache: cache.stats()
    });
});

/**
 * GET /api/search?query=<text>
 *
 * Free-text movie search. Backs the frontend's autocomplete dropdown.
 *
 * @param {string} req.query.query - Search text. Required; must be 1-200 characters.
 * @returns {object} TMDB's search payload — `{ page, results[], total_pages, total_results }`.
 */
app.get('/api/search', route(async (req, res) => {
    const query = requireQuery(req.query.query);
    res.json(await searchMovies(query));
}));

/**
 * GET /api/movie/:tmdbId
 *
 * Full movie details, with cast and crew folded in via `append_to_response=credits` — that avoids a
 * second round-trip when the client needs the director or top-billed actors.
 *
 * @param {string} req.params.tmdbId - TMDB movie id (positive integer).
 * @returns {object} TMDB movie details plus a `credits` object (`{ cast[], crew[] }`).
 */
app.get('/api/movie/:tmdbId', route(async (req, res) => {
    const id = requireTmdbId(req.params.tmdbId);
    res.json(await getMovie(id));
}));

/**
 * GET /api/movie/:tmdbId/similar
 *
 * TMDB's `similar` list — driven largely by shared genres and keywords.
 *
 * One of the two candidate-generation sources for recommendations. Everything the app can ever
 * recommend originates here or in /recommendations below, so this pair defines a hard ceiling on
 * recommendation quality that no amount of re-ranking can raise.
 *
 * @param {string} req.params.tmdbId - TMDB movie id.
 * @returns {object} Paginated `{ results[] }` — 20 movies per page.
 */
app.get('/api/movie/:tmdbId/similar', route(async (req, res) => {
    const id = requireTmdbId(req.params.tmdbId);
    res.json(await getSimilar(id));
}));

/**
 * GET /api/movie/:tmdbId/recommendations
 *
 * TMDB's own recommendations, which blend content signals with user behaviour and are generally
 * more useful than /similar.
 *
 * @param {string} req.params.tmdbId - TMDB movie id.
 * @returns {object} Paginated `{ results[] }` — 20 movies per page.
 */
app.get('/api/movie/:tmdbId/recommendations', route(async (req, res) => {
    const id = requireTmdbId(req.params.tmdbId);
    res.json(await getRecommendations(id));
}));

/**
 * GET /api/movie/:tmdbId/keywords
 *
 * A movie's keywords — short thematic tags such as "time loop", "heist", or "coming of age".
 *
 * Unlike genres (a 19-value vocabulary shared by thousands of films), keywords are specific, so two
 * films sharing one is genuinely informative. This endpoint exists to feed the scoring rebuild.
 *
 * @param {string} req.params.tmdbId - TMDB movie id.
 * @returns {object} `{ id, keywords: [{ id, name }] }`.
 */
app.get('/api/movie/:tmdbId/keywords', route(async (req, res) => {
    const id = requireTmdbId(req.params.tmdbId);
    res.json(await getKeywords(id));
}));

/**
 * POST /api/recommend
 *
 * Builds recommendations for a set of selected movies.
 *
 * This replaces a browser-side loop that issued up to ~200 sequential round-trips and took 30-60
 * seconds. The same work now happens server-side in parallel behind the cache, in one request.
 *
 * @param {object} req.body
 * @param {Array<number|string>} req.body.movieIds - 3 to 10 TMDB movie ids.
 * @param {string} [req.body.generator] - Candidate source. Only "tmdb" is registered today; the seam
 *   exists so collaborative filtering can be added without reworking this route.
 * @returns {object} `{ results[], meta }` where meta reports pool size, timing, and how many
 *   sub-requests failed — so partial results are visible rather than silently looking complete.
 */
app.post('/api/recommend', route(async (req, res) => {
    const pickIds = requirePicks(req.body?.movieIds);
    const generator = req.body?.generator || 'tmdb';
    res.json(await recommend(pickIds, { generator }));
}));

/**
 * Error middleware.
 *
 * Maps TmdbError onto its intended HTTP status so clients can tell a bad request (400) from an
 * unknown movie (404) from a misconfigured server (503). Previously every failure was either
 * swallowed into a 200 response or flattened into a generic 500.
 *
 * Anything that is not a TmdbError is genuinely unexpected, so it is logged in full and reported as
 * a 500 without leaking internals to the client.
 */
// The fourth parameter is required: Express identifies error middleware by arity, and a 3-argument
// function would be registered as an ordinary handler and never receive errors. Named `_next` to
// mark it as intentionally unused.
app.use((err, req, res, _next) => {
    if (err instanceof TmdbError) {
        if (err.status >= 500) {
            console.error(`${req.method} ${req.path} -> ${err.status}: ${err.message}`);
        }
        return res.status(err.status).json({ error: err.message });
    }

    // Validation errors from lib/recommend.js carry their own status.
    if (typeof err.status === 'number' && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
    }

    console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`TMDB API Key loaded: ${process.env.TMDB_API_KEY ? 'YES' : 'NO'}`);
    console.log(`Cache backend: ${cache.stats().backend}`);
});

/**
 * Movie Recommender — backend API server.
 *
 * Acts as a thin proxy in front of the TMDB v3 API. Its single most important job is keeping
 * TMDB_API_KEY server-side: the browser never sees it, and every TMDB call is routed through here.
 *
 * It also serves the static frontend from public/, so in production the frontend and the API share
 * an origin (which is why the client can use a relative `/api` base URL).
 *
 * @see https://developer.themoviedb.org/reference/intro/getting-started
 */

const path = require('path');

// Load .env from the project directory rather than process.cwd(). dotenv defaults to the working
// directory, so starting the server from anywhere else silently loaded zero variables and the app
// came up with no API key - the same failure mode as the express.static path below.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// NOTE: __dirname, not a bare relative path. `express.static('public')` resolves against
// process.cwd(), so starting the server from any directory other than the project root would
// silently 404 the entire frontend while the API kept working.
app.use(express.static(path.join(__dirname, 'public')));

/**
 * TMDB API key, read from .env (see .env.example). Absent key is handled per-route with a 400
 * rather than crashing at boot, so the static frontend still loads and can surface the error.
 */
const TMDB_API_KEY = process.env.TMDB_API_KEY;

/**
 * GET /api/search?query=<text>
 *
 * Free-text movie search. Backs the frontend's autocomplete dropdown.
 *
 * @param {string} req.query.query - Search text. Currently unvalidated; a missing value produces a
 *   literal search for "undefined". Validation lands in Phase 1 along with the shared tmdb() helper.
 * @returns {object} TMDB's raw search payload — `{ page, results[], total_pages, total_results }`.
 *
 * KNOWN LIMITATION: the upstream status is not propagated. A TMDB 401/404 is relayed as HTTP 200
 * with a `{ success: false }` body, so the client cannot distinguish "no matches" from "call
 * failed". Fixed in Phase 1.
 */
app.get('/api/search', async (req, res) => {
    const { query } = req.query;
    const apiKey = TMDB_API_KEY;
    
    console.log('Search request received. API Key exists:', !!apiKey);
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key not set in .env file' });
    }
    
    try {
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
        console.log('Fetching from TMDB...');
        const response = await fetch(url);
        const data = await response.json();
        console.log('TMDB Response:', data.results ? `Found ${data.results.length} movies` : 'No results');
        res.json(data);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Error searching movies' });
    }
});

/**
 * GET /api/movie/:tmdbId
 *
 * Full movie details, with cast and crew folded in via `append_to_response=credits` — that avoids a
 * second round-trip when the client needs the director or top-billed actors.
 *
 * @param {string} req.params.tmdbId - TMDB movie id. Interpolated into the upstream URL without
 *   validation; a `/^\d+$/` guard lands in Phase 1.
 * @returns {object} TMDB movie details plus a `credits` object (`{ cast[], crew[] }`).
 */
app.get('/api/movie/:tmdbId', async (req, res) => {
    const { tmdbId } = req.params;
    const apiKey = TMDB_API_KEY;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key not set in .env file' });
    }
    
    try {
        const response = await fetch(
            `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&append_to_response=credits`
        );
        const data = await response.json();
        res.json(data);
    } catch (error) {
        // Log before responding; swallowing the error made upstream failures invisible in the logs.
        console.error(`Movie details failed for id=${tmdbId}:`, error);
        res.status(500).json({ error: 'Error fetching movie details' });
    }
});

/**
 * GET /api/movie/:tmdbId/similar
 *
 * TMDB's `similar` list — driven largely by shared genres and keywords.
 *
 * One of the two candidate-generation sources for recommendations. Note that everything the app can
 * ever recommend originates here or in /recommendations below, so this pair defines a hard ceiling
 * on recommendation quality that no amount of re-ranking can raise.
 *
 * @param {string} req.params.tmdbId - TMDB movie id.
 * @returns {object} Paginated `{ results[] }` — 20 movies per page.
 */
app.get('/api/movie/:tmdbId/similar', async (req, res) => {
    const { tmdbId } = req.params;
    const apiKey = TMDB_API_KEY;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key not set in .env file' });
    }
    
    try {
        const response = await fetch(
            `https://api.themoviedb.org/3/movie/${tmdbId}/similar?api_key=${apiKey}`
        );
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error(`Similar movies failed for id=${tmdbId}:`, error);
        res.status(500).json({ error: 'Error fetching similar movies' });
    }
});

/**
 * GET /api/movie/:tmdbId/recommendations
 *
 * TMDB's own recommendations, which blend content signals with user behaviour and are generally
 * more useful than /similar.
 *
 * @param {string} req.params.tmdbId - TMDB movie id.
 * @returns {object} Paginated `{ results[] }` — 20 movies per page.
 */
app.get('/api/movie/:tmdbId/recommendations', async (req, res) => {
    const { tmdbId } = req.params;
    const apiKey = TMDB_API_KEY;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key not set in .env file' });
    }
    
    try {
        const response = await fetch(
            `https://api.themoviedb.org/3/movie/${tmdbId}/recommendations?api_key=${apiKey}`
        );
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error(`Recommendations failed for id=${tmdbId}:`, error);
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`TMDB API Key loaded: ${TMDB_API_KEY ? 'YES' : 'NO'}`);
});
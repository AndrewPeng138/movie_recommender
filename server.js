require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Get API key from environment variable
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Search movies endpoint
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

// Get movie details endpoint
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
        res.status(500).json({ error: 'Error fetching movie details' });
    }
});

// Get similar movies endpoint
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
        res.status(500).json({ error: 'Error fetching similar movies' });
    }
});

// Get movie recommendations endpoint (TMDB's built-in recommendations)
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
        res.status(500).json({ error: 'Error fetching recommendations' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`TMDB API Key loaded: ${TMDB_API_KEY ? 'YES' : 'NO'}`);
});
# 🎬 Movie Recommender

Pick 3–10 movies you love and get 30 recommendations ranked by a match score — with a visible
breakdown of *why* each one was suggested.

Unlike most recommenders, this one doesn't just relay TMDB's suggestions. It re-ranks them with its
own weighting and explains itself: each result shows which factors contributed (genres, director,
cast, era, rating) and which of your picks it matched.

---

## Quick start

**Prerequisites:** Node.js 18 or newer (developed on v22).

```bash
# 1. Install dependencies
npm install

# 2. Configure your TMDB API key
cp .env.example .env
#    then edit .env and paste in your key — see .env.example for where to get one

# 3. Start the server
npm start
```

Open <http://localhost:3001>. On boot you should see:

```
Server running on http://localhost:3001
TMDB API Key loaded: YES
```

If it says `NO`, the key isn't being read — check that `.env` exists in the project root and
contains `TMDB_API_KEY=...`.

---

## How it works

```
Browser (public/index.html)
    │
    │  all TMDB access goes through our own proxy
    ▼
Express server (server.js)  ──────►  TMDB API v3
    │
    └─ also serves public/ statically, so in production
       the frontend and API share one origin
```

The server's most important job is **keeping the TMDB API key server-side.** The browser never sees
it; every TMDB call is routed through `/api/*`.

### User flow

1. **Search** — typing fires a debounced (500 ms) call to `/api/search`. Results render as a
   dropdown of up to 10 with poster, year, and rating. Responses are memoized per query.
2. **Select** — clicking a suggestion fetches full details and stores a trimmed record: id, title,
   year, poster, rating, genres, director, and top-billed actors. Renders as a removable chip.
3. **Gate** — the button unlocks at 3 selections and caps at 10.
4. **Recommend** — for each pick, the app asks TMDB for both `similar` and `recommendations`, fetches
   details for every candidate, and scores it against that pick. Candidates surfaced by several picks
   accumulate a match count.
5. **Rank** — sorted by score, top 30, rendered with the factor breakdown.

### Scoring model

Every candidate starts at a base of **60** — the reasoning being that TMDB already vouched for it —
then earns:

| Factor | Points | Rule |
|---|---|---|
| Genre overlap | up to 15 | 3+ shared → 15, two → 10, one → 5 |
| Director match | 15 | exact same director |
| Actor overlap | up to 15 | 7 per shared actor |
| Era proximity | up to 5 | ≤2 yrs → 5, ≤5 → 3, ≤10 → 2, ≤20 → 1 |
| Rating quality | up to 10 | ≥8.0 → 10, ≥7.5 → 7, ≥7.0 → 5, ≥6.5 → 3 |

Plus **+10 per extra matching pick**. Capped at 100.

See `calculateMatchScore` in [public/index.html](public/index.html) for the implementation and its
documented limitations.

---

## API reference

All routes return TMDB's payload largely unmodified.

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/search?query=<text>` | Free-text movie search |
| `GET` | `/api/movie/:tmdbId` | Full details, with `credits` appended |
| `GET` | `/api/movie/:tmdbId/similar` | TMDB's `similar` list (20 per page) |
| `GET` | `/api/movie/:tmdbId/recommendations` | TMDB's recommendations (20 per page) |

**Error responses**

| Status | Meaning |
|---|---|
| `400` | `TMDB_API_KEY` is not configured |
| `500` | The upstream request threw |

---

## Project layout

```
movie_recommender/
├── server.js            # Express server — TMDB proxy + static hosting
├── public/
│   └── index.html       # Entire frontend: markup, CSS, and JS inline
├── eslint.config.js     # Flat config; separate Node and browser sections
├── .env                 # Your API key (gitignored — never commit)
├── .env.example         # Template documenting required variables
└── package.json
```

---

## Development

```bash
npm start          # Start the server
npm run lint       # Run ESLint
npm run lint:fix   # Auto-fix what can be fixed
```

The frontend JS lives inline in `index.html`, so ESLint reads it through `eslint-plugin-html`, which
extracts `<script>` contents. If the frontend is ever split into `public/app.js`, that plugin can be
dropped.

`npm run lint` currently reports **five `no-await-in-loop` warnings** and zero errors. Those warnings
are intentional — they mark the sequential-fetch bottleneck described below and are left visible
rather than suppressed.

---

## Known limitations

Honest accounting of what's wrong today, so nobody rediscovers these the hard way.

### Performance

**A full recommendation run can take 30–60 seconds.** Candidate details are fetched serially inside a
nested loop, so 10 selected movies issue up to ~200 sequential round-trips. At this request volume
TMDB rate limiting (HTTP 429) is likely, and because the error handler wraps the entire candidate
loop, a single 429 silently drops the rest of that pick's candidates. Results can therefore be quietly
incomplete. There is also no server-side caching, so identical lookups re-hit TMDB on every run.

### Recommendation quality

- **The base of 60 is constant**, so it carries no ranking information. Realistic totals cluster
  between roughly 70 and 88, which makes the ranking weakly discriminative.
- **Rarity is ignored** — sharing "Drama" counts the same as sharing "Film-Noir".
- **Actor overlap almost never fires** — only 3 actors are stored per pick, but candidates are
  compared on their top 10.
- **Aggregation keeps the best single pairing**, so picking 9 comedies and 1 horror film lets horror
  sequels rank as highly as anything else.
- **The multi-match bonus saturates** against the 100 cap; matching 5 picks and 8 picks both display
  100%. Equal scores tie-break by insertion order, which favours the first-picked movie.
- **Candidate generation is fully outsourced to TMDB**, so the app cannot surface anything TMDB
  wouldn't have suggested — a ceiling no re-ranking can raise.
- The `recommendations` results are largely discarded: the code slices the first 20 of
  `similar ++ recommendations`, and `similar` alone fills those 20 slots.

### Security & operations

- **CORS is fully open** (`app.use(cors())`), so any origin can use this server as a free TMDB proxy
  on your quota.
- **No rate limiting.**
- **Upstream status is not propagated** — a TMDB 401 or 404 is relayed as HTTP 200 with a
  `{ success: false }` body, so the client can't distinguish "no matches" from "call failed".
- **No input validation** — `tmdbId` is interpolated into the upstream URL unchecked, and a missing
  `query` produces a literal search for `"undefined"`.

### Frontend

- **No responsive design** — there are no media queries; the layout is desktop-only.
- **Limited accessibility** — the search box has no ARIA combobox semantics and the suggestions
  dropdown can't be driven by keyboard.
- **Selections don't survive a refresh** (no persistence).

---

## Credits

Movie data and imagery from [The Movie Database (TMDB)](https://www.themoviedb.org/).
This product uses the TMDB API but is not endorsed or certified by TMDB.

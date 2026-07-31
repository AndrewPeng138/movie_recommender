# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A movie recommender. You search TMDB, pick 3–10 films you love, and get 30 recommendations ranked by
a match score — with a visible breakdown of *why* each was suggested.

The explainability is the point. Most recommenders are a black box; this one shows its reasoning.
Preserve that in any change to the model or the UI.

## Critical context

**`main` is production.** Render auto-deploys from it at
<https://movie-recommender-t547.onrender.com/>. **Merging a PR ships to real users.** There is no
staging environment. Never push directly to `main` — it is protected, requires a green CI run, and
requires a PR.

**The project is mid-rebuild.** The scoring model's weights were hand-tuned by trial and error with
no way to measure whether any change helped. The work in progress replaces that with a measured,
principled model. The phase plan lives in the user's plan file; the short version:

| Phase | Status | What |
|---|---|---|
| 0 | ✅ shipped | Pre-flight cleanup: path bugs, XSS, race conditions, lint, docs |
| 1 | ✅ shipped | Cached TMDB data layer, input validation, status propagation |
| 2 | 🚧 in progress | Evaluation harness — ground truth to measure against |
| 3 | planned | TF-IDF content model replacing the hand-tuned weights |
| 4 | planned | Server-side recommendation pipeline (fixes the 30–60s latency) |
| 5 | conditional | Candidate generation — **only if Phase 2 proves it is needed** |
| 6 | planned | Frontend redesign, responsive, accessibility |

## Architecture

```
Browser (public/index.html)  →  Express (server.js)  →  lib/tmdb.js  →  TMDB API
                                       ↓                     ↓
                                  public/ static        lib/cache.js
```

- **`server.js`** — thin routes only. It contains *no* TMDB logic; routes validate input and delegate.
- **`lib/tmdb.js`** — owns the API key, URL building, caching, retry/backoff, concurrency, and error
  mapping. All TMDB access goes through here.
- **`lib/cache.js`** — TTL cache with two backends (see below).
- **`lib/movielens.js`** — MovieLens dataset loader. Evaluation only; the app never imports it.
- **`lib/score-legacy.js`** — the current scoring model, extracted for measurement. **Frozen.**
- **`public/index.html`** — the entire frontend: markup, CSS, and JS inline, ~1,080 lines.

The frontend is deliberately still one file. Split it into `public/styles.css` + `public/app.js` only
when it passes ~900 lines of *script* or when Phase 6 starts.

## Things that will bite you

**Paths must resolve against `__dirname`, never `process.cwd()`.** Two production bugs came from
this: `express.static('public')` and `dotenv.config()` both defaulted to the working directory, so
starting the server from anywhere else served nothing and loaded *zero* environment variables. Render
starts processes outside the project root. Always use `path.join(__dirname, ...)`.

**Render's filesystem is ephemeral and the instance spins down when idle** (free tier). Nothing
written at runtime survives a restart or deploy. Never assume persistence in server code. The
in-memory cache starts empty on every cold start — that is expected, not a bug.

**The cache backend is chosen by `CACHE_DIR`.** Unset → in-memory LRU (production). Set → sharded
JSON on disk (local dev, corpus build, eval). Production must never need the disk backend.

**The evaluation corpus is frozen deliberately.** Entries carry a one-year TTL. This is about
reproducibility, not staleness: a baseline measured against a corpus that silently re-fetched is not
comparable to a later run. See `docs/CORPUS.md` before refreshing it.

**`lib/score-legacy.js` is frozen.** It exists to produce the baseline number every future model is
compared against. Changing it invalidates every comparison ever made against it. Do not "improve" it.

**TMDB rate limits.** The original 40-per-10-seconds limit was removed in December 2019; the current
soft ceiling is around 40 requests/second. `lib/tmdb.js` caps concurrency at 12 and backs off on 429.
Respect the 429 — do not raise concurrency to chase speed.

## Commands

```bash
npm start                      # Run the server (http://localhost:3001)
npm run lint                   # ESLint — must report 0 errors
npm run lint:fix

node scripts/fetch-dataset.js  # Download MovieLens (~1 MB)
node scripts/build-corpus.js   # Fetch TMDB corpus (~19k requests, ~10 min, resumable)
node scripts/freeze-corpus.js  # Pin corpus TTL + write manifest
```

`npm run lint` reports a small number of `no-await-in-loop` **warnings** in `public/index.html`.
Those are intentional — they mark the serial fan-out that Phase 4 fixes. Do not suppress them; lint
exits 0.

## Conventions

- **4-space indent**, single quotes, semicolons. Match the surrounding file.
- **JSDoc on every exported function**, with `@param` and `@returns`.
- **Comments explain *why*, not *what*.** This codebase documents non-obvious constraints and
  deliberate tradeoffs. A comment restating the code is noise; one explaining why the 4th middleware
  parameter must exist is not.
- **CommonJS** (`require`/`module.exports`), not ESM.
- **No frontend framework, no build step.** Vanilla JS, no bundler. Keep it that way unless the user
  decides otherwise — a stack migration to Next.js/React has been discussed but *not* decided.
- **Never build HTML from API strings.** Use `textContent` and `createElement`. TMDB data is
  community-edited; interpolating it into `innerHTML` was a real vulnerability that has been fixed.
  Do not reintroduce it.

## Workflow

**One branch per phase → PR → squash merge.** Branch names: `phase-N-short-description`.

Before opening a PR, every one of these must pass:

1. `npm ci` from a clean clone (Render installs fresh — catches lockfile drift)
2. `npm run lint` → **0 errors**
3. `npm start` boots and logs `TMDB API Key loaded: YES`
4. Smoke test: search → select 3 films → Get Recommendations → results render
5. **Any new environment variable is set in the Render dashboard *before* merging.** Render does not
   read your local `.env`. This is the most common way to break the deploy.
6. If a new build step is added, Render's Build Command is updated first.

After merging: watch the Render deploy, then smoke-test the live URL.

**Verify against the live site, not assumptions.** Fingerprint the served HTML for markers of the
change rather than trusting that a deploy landed.

## Testing

There is no test framework. Verification is done with purpose-built scripts, generally written to a
scratch directory rather than committed:

- **Frontend:** drive `public/index.html` in `jsdom` with stubbed TMDB responses and assert on the
  resulting DOM. Lint and `curl` cannot catch a DOM-construction bug.
- **Backend:** boot the server and `curl` the endpoints, including failure cases.
- **Render simulation:** run with `npm ci --omit=dev` and **no `.env` file**, supplying the key via
  the environment. This is the single most valuable pre-deploy check.

If a test suite is ever added, prefer `node:test` over adding a framework dependency.

## Working with the user

### Phase checklist discipline (required)

**At the start of every phase, build a detailed todo list from the plan's own bullets for that
phase — one todo per bullet — and do not move on until every item is either done or explicitly
deferred with a stated reason.**

This exists because it has already failed once. Phase 4 shipped with only one of its three planned
items; MMR and cosine-decomposition explainability were silently omitted because reordering the
phases left them without the TF-IDF vectors they depended on. Nobody noticed until the user asked
directly. The plan is the source of truth for a phase's scope, not the parts that happened to be
convenient.

Concretely:

1. Read the plan's section for the phase and enumerate every bullet as a todo.
2. Add the phase's verification steps and the deployment gate as todos too.
3. Before proposing a commit, walk the list and state the status of each item.
4. **Anything not done gets named out loud**, with the reason, and is moved somewhere explicit in
   the plan — never dropped in silence.

A deferred item is fine. An unmentioned one is not.

### Other

- **Check in at the end of every phase**, and before any major design decision — anything that
  changes the API contract, adds a dependency or dataset, or alters the scoring model's shape.
- **Verify claims rather than asserting them.** Run the command, read the output, report what it
  actually said. If something was not tested, say so.
- **Flag scope honestly.** If part of a task is deliberately deferred, name it and say why — the
  standing reason here is "this code gets replaced in a later phase; fixing it now means fixing it
  twice."

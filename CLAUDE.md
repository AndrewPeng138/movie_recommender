# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A movie recommender. You search TMDB, pick 3–10 films you love, and get 30 recommendations ranked by
a match score — with a visible breakdown of *why* each was suggested.

The explainability is the point. Most recommenders are a black box; this one shows its reasoning.
Preserve that in any change to the model or the UI.

---

## Working principles

These come first because they govern everything below. They bias toward caution over speed; for
genuinely trivial tasks, use judgement.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.

In this project that has repeatedly meant checking a measurement before committing to a direction —
candidate generation was reordered ahead of the model rebuild because the harness said the ceiling
was 10.4%, not because it seemed likely.

### 2. Simplicity first — for product code

**The minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: *would a senior engineer call this overcomplicated?* If yes, simplify.

**One deliberate carve-out: verification is not a feature.**

Separate the two kinds of code in this repo:

| | Simplicity applies... |
|---|---|
| **Product** — `server.js`, `lib/` used at runtime, `public/` | **Hard.** Every line justifies itself against the request. |
| **Verification** — `eval/`, `scripts/`, throwaway test drivers | **To its design, not its existence.** |

The harness, the sweep driver, and the build artifacts are not extras. `main` is production with no
staging environment, so a check is often the only thing standing between a change and real users.
Never trim a check to look leaner — that is the one place where "simpler" makes things worse.

But verification code still has to be simple *for what it does*. `eval/sweep.js` exists because
re-running the harness per parameter combination takes minutes, not because sweeping deserves a
framework. `lib/score.js` exposes hyperparameters because the sweep varies them **today** — that is
the bar for configurability: a reason that exists now, not one that might arrive.

The question to ask before building either kind: *could I ship this to real users and know it works?*
If the honest answer needs a new check, build the check. If it doesn't, don't.

### 3. Surgical changes — scaled to the work

**Default to touching only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style, even where you'd choose differently.
- If you spot unrelated dead code, mention it — don't delete it.
- Remove imports and variables that *your* change orphaned; leave pre-existing dead code alone
  unless asked.

**This project is a deliberate rebuild, so "surgical" is a lean, not a hard limit.** A phase owns
code and rewriting it *is* the job — Phase 4 replaced 142 lines of the frontend pipeline on purpose.
Being precious about that would have been the wrong call.

Where the rule genuinely bites is **outside the phase's scope**:

- Don't drift into files the phase doesn't own.
- Don't tidy formatting you happen to scroll past.
- Don't fix bugs in code a later phase replaces — "this gets rewritten in Phase N" is the standing
  reason to leave a known bug documented rather than fixed twice.

The test: **can you name which plan bullet each changed file serves?** If not, that file is drift.

### 4. Goal-driven execution

**Define success criteria, then loop until verified.**

Turn tasks into verifiable goals:

| Vague | Verifiable, in this repo |
|---|---|
| "Add validation" | `curl` the endpoint with bad input, assert 400 |
| "Fix the DOM bug" | Drive `index.html` in jsdom, assert on the resulting DOM |
| "Improve the model" | Beat the baseline on the **held-out test split**, outside the CI |
| "Refactor the harness" | Re-run it and reproduce the recorded baseline exactly |

For multi-step work, state the plan as steps with their checks. Strong criteria let you loop
independently; weak ones ("make it work") force constant clarification.

**A measurement you haven't run is not evidence.** Report what the command actually printed.

---

## Critical context

**`main` is production.** Render auto-deploys from it at
<https://movie-recommender-t547.onrender.com/>. **Merging a PR ships to real users.** There is no
staging environment. Never push directly to `main` — it is protected, requires a green CI run, and
requires a PR.

**The project is mid-rebuild.** The scoring model's weights were hand-tuned by trial and error with
no way to measure whether any change helped. The work in progress replaces that with a measured,
principled model. The phase plan lives in the user's plan file; the short version:

Phases are identifiers, not execution order — Phase 5 ran before Phase 3 because the measurement said
generation mattered more than ranking.

| Phase | Status | What |
|---|---|---|
| 0 | ✅ shipped | Pre-flight cleanup: path bugs, XSS, race conditions, lint, docs |
| 1 | ✅ shipped | Cached TMDB data layer, input validation, status propagation |
| 2 | ✅ shipped | Evaluation harness — found generation, not ranking, was the bottleneck |
| 5 | ✅ shipped | Collaborative filtering: candidate ceiling 10.4% → 95.7% (offline only) |
| 4 | ✅ shipped | Server-side pipeline: 60s → 6.7s cold, 18ms warm |
| 3 | 🚧 in progress | TF-IDF content model + quality signals, replacing hand-tuned weights |
| 6 | planned | Frontend redesign, responsive, accessibility |

**Phase 3 also owns two items deferred from Phase 4** — MMR diversity and cosine-decomposition
explainability. Both needed TF-IDF vectors that didn't exist yet.

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

### Say it plainly

**Lead with what a number means, then name it.** The term is a label for the idea, not a substitute
for it.

> ✅ "3 of the 30 films shown were ones they'd already rated highly — that's precision@30 of 0.10."
> ❌ "precision@30 improved to 0.10."

Introduce a term once, then use it freely. Assume the reader is smart and busy, not that they share
your vocabulary.

**Reach for a technical term only when it's load-bearing** — when the precise meaning matters, or the
reader will meet it in the code or literature. Not to signal rigour. "Bayesian-weighted rating" earns
its place because the mechanism matters; "leverage the aggregation layer" does not.

**Offer depth, don't front-load it.** Give the answer, then say what could be expanded. A reader who
wants the derivation will ask; one who doesn't shouldn't have to scroll past it.

### Justify with numbers, not adjectives

Every claim about better/worse should carry a figure.

> ✅ "+0.54 distinct franchises out of 30, and precision unchanged at 0.1000 vs 0.1004."
> ❌ "MMR improves diversity at negligible cost."

Three rules that follow from this:

- **When there is no number, say so.** "I haven't measured this" is a complete and respectable
  sentence. Do not reach for an adjective to fill the gap.
- **Keep *measured* separate from *expected*.** "Confirmed on the held-out split" and "should help"
  are different claims. Never let the second borrow the authority of the first.
- **Report the interval, not just the point.** A change from 0.0677 to 0.1000 means something
  different when the intervals are ±0.009 than when they are ±0.05. If they overlap, the honest
  word is "indistinguishable", not "slightly better".

### Say how big the difference is, not just that there is one

A raw delta is meaningless on its own. **0.1000 vs 0.1004 sounds like a change and isn't one.**
Always answer two questions:

**1. Is it bigger than the noise?** Compare the difference to the confidence interval.

| difference vs interval | verdict | wording |
|---|---|---|
| smaller than half the interval | noise | "indistinguishable", "no measurable difference" |
| comparable to the interval | suggestive only | "directionally better, not established" |
| larger than the interval, no overlap | real | "significant", "a real difference" |

**2. What does it mean in something you can picture?** Convert to the unit a person cares about.

Worked examples from this project:

> **0.1000 → 0.1004** — difference 0.0004 against an interval of ±0.0128. That is **3% of the noise**,
> and translates to **0.01 films out of 30**. Negligible. Say so plainly and move on.
>
> **0.0677 → 0.1000** — difference 0.0323, intervals ±0.0087 and ±0.0128 with no overlap. Translates
> to **2 relevant films per screen becoming 3**. Real, and worth the work.
>
> **0.0204 → 0.0227 (obscure films)** — an 11% relative gain that *sounds* meaningful, but the
> intervals overlap heavily and it amounts to **0.07 of a film per screen**. Not established.

**Beware percentage framing on small numbers.** "+11%" and "+0.07 films per screen" describe the same
change; the first flatters it and the second is honest. When the base is small, lead with the absolute
figure.

**Practical significance and statistical significance are different questions.** A result can be
statistically real and still too small to care about. Say which one you mean.

### Other

- **Check in at the end of every phase**, and before any major design decision — anything that
  changes the API contract, adds a dependency or dataset, or alters the scoring model's shape.
- **Verify claims rather than asserting them.** Run the command, read the output, report what it
  actually said. If something was not tested, say so.
- **Flag scope honestly.** If part of a task is deliberately deferred, name it and say why — the
  standing reason here is "this code gets replaced in a later phase; fixing it now means fixing it
  twice."

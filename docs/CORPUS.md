# The evaluation corpus

## Short answer: no, you should *not* routinely update it

The corpus is **frozen on purpose**. Entries carry a one-year TTL and a manifest records exactly what
was built and when.

That is not laziness about freshness — it is the requirement that makes evaluation meaningful.

## Why freezing is the correct default

The corpus exists to produce a **baseline**: a number that later models are compared against. That
comparison is only valid if both runs measured the same thing.

If the corpus refreshed itself, then a month from now:

- TMDB's `similar` and `recommendations` lists would have shifted (their algorithm evolves)
- `vote_average` and `vote_count` would have drifted
- Some keywords would have been added or edited by TMDB's community

Re-run the baseline and you would get a different number — with **no way to tell** whether the model
changed or the ground beneath it did. A moving corpus makes every measurement uninterpretable.

So: freshness is the wrong goal here. Reproducibility is the goal.

## What is actually in the corpus, and how stale it can get

| Data | Changes over time? | Matters? |
|---|---|---|
| Genres, cast, crew, release date | Effectively never for released films | No |
| Keywords | Occasionally — community-edited | Barely |
| `vote_average`, `vote_count` | Slowly, continuously | Only as a quality prior |
| `similar` / `recommendations` | Yes — TMDB's algorithm evolves | Yes, if fetched |

The bulk of what the scoring model reads — genres, cast, crew, keywords — is **immutable for released
films**. A film's director does not change. This is why a frozen corpus stays valid for a long time.

## When you actually should refresh

Four cases, and only these:

1. **You need data the corpus doesn't have.** Adding a new feature to the model — a new TMDB endpoint
   or field — requires fetching it. This is *incremental*, not a rebuild: the cache is keyed per
   endpoint, so adding `/videos` fetches only `/videos` for each film and leaves everything else
   untouched. (This is exactly why keywords were fetched up front in Phase 1 — to avoid a second pass.)

2. **You scale to a bigger dataset.** Moving from `ml-latest-small` (9.7k films) to `ml-25m` (62k
   films) for final validation. That is a new corpus, and it needs its own baseline.

3. **You want candidate-generation metrics.** `--candidates` additionally fetches each film's
   `similar` and `recommendations` lists, roughly doubling the request count. Needed to measure the
   candidate-recall ceiling that gates Phase 5.

4. **The TTL is about to expire** (currently 2027-07-30). Re-run `freeze-corpus.js` to extend it
   without re-fetching anything.

Notably absent: "it has been a while." Age alone is not a reason.

## How to refresh, if you must

**Treat a refresh as a versioned event, not a maintenance chore.** The rule:

> Refreshing the corpus and re-recording the baseline must happen in the **same commit**.

Otherwise the recorded baseline silently stops describing the corpus in the repository, and every
comparison made afterwards is against a number that no longer means anything.

```bash
# 1. Refresh (resumable; only re-fetches what is missing or expired)
node scripts/build-corpus.js

# 2. Re-freeze and regenerate the manifest
node scripts/freeze-corpus.js

# 3. Re-run the baseline against the new corpus
node eval/harness.js --model legacy

# 4. Commit the new baseline AND the new manifest together
```

## Cost

| Operation | Requests | Time |
|---|---|---|
| `ml-latest-small`, details + keywords | ~19,400 | ~10 min |
| `ml-latest-small`, with `--candidates` | ~39,000 | ~20 min |
| `ml-25m`, details + keywords | ~124,000 | ~1 hr |

Measured on the actual build: 9,715 films in **9m 48s**, 12 concurrent requests, zero rate-limit
retries. TMDB's soft ceiling is around 40 requests/second; `lib/tmdb.js` stays well under it.

Builds are **resumable** — everything is written through the disk cache, so an interrupted run picks
up where it left off. It is always safe to re-run.

## Known gaps

**113 of 9,715 films failed** with a 404 — MovieLens entries pointing at TMDB ids that have since
been deleted or merged. That is expected and handled: those films are simply excluded from evaluation.
It is about 1.2% of the corpus and does not bias results in any direction worth correcting for.

**The data is gitignored.** MovieLens is licensed for research and personal use and may not be
redistributed, and the corpus is far too large to commit. Anyone cloning the repo runs
`fetch-dataset.js` and `build-corpus.js` to reproduce it. Only the *manifest* is committed, so results
remain traceable to a corpus description even though the corpus itself is not in the repo.

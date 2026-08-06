# How recommendations are scored

## The short version

You pick 3–10 films. Every candidate film gets compared against your picks, scored, and the best 30
are shown. The score has two halves:

- **How much it resembles your picks** (70% of the decision at the shipped settings)
- **How good the film is** (30%), from audience ratings and awards

Measured against the previous hand-tuned model on data it had never seen: **3 relevant films per
screen of 30, up from 2** — a 48% improvement, and the same again on how near the top the first good
one lands.

---

## Why the old model was replaced

The previous scorer gave every candidate 60 points for existing, then added up to 60 more across five
categories. Three problems, none fixable by adjusting the numbers:

1. **60 of ~100 points were identical for every film**, so most of the score carried no information.
2. **Rarity was invisible.** Two films both being "Drama" scored the same as two films both being
   "Film-Noir" — although ~4,000 films are Dramas and a few dozen are Film-Noir.
3. **A film was only ever compared to your single closest pick.** Pick nine comedies and one horror
   film, and horror sequels ranked as highly as anything else.

The symptom, from a real run: **13 of 30 results tied at exactly 100%**, with only 9 distinct scores
across the whole list. *Masters of the Universe* topped a Christopher Nolan list on a bare score of
60 with zero content signal.

---

## How the new model works

### 1. Films become lists of features

Each film is reduced to what it's made of: genres, keywords ("time loop", "heist"), top-10 cast,
director, writers, decade, original language. Roughly 20–40 features per film.

**Deliberately excluded: studio and franchise.** Including them would make sequels look maximally
alike and worsen the franchise-clustering problem.

### 2. Rare features count more (TF-IDF)

A feature's weight is how rare it is across the 9,602-film corpus — `log(N / how many films have it)`.
This is the fix for problem 2 above, and **nobody chooses these numbers.** They fall out of counting:

| feature | weight | why |
|---|---|---|
| English language | 1.16 | almost every film — sharing it means nothing |
| Drama | 1.76 | thousands of films |
| Comedy | 1.89 | thousands of films |
| a rare keyword | 9.07 | a handful of films — sharing it means a lot |

So sharing an unusual keyword is worth **5× more** than sharing "Drama".

### 3. Similarity is the overlap between two feature lists

Vectors are length-normalised and compared by cosine similarity, giving a genuine 0-to-1 measure with
no constant floor. That fixes problem 1.

### 4. Compared against *all* your picks, not just the closest

A candidate is scored against every pick; the top 10 similarities are averaged. That fixes problem 3,
and it makes "matches several of your films" emerge naturally rather than being a bolted-on bonus
with a cap to saturate against.

### 5. Blended with quality

Three independent signals, because a film can resemble your taste and still be bad:

| signal | source | note |
|---|---|---|
| Audience rating | TMDB | Bayesian-adjusted — a 7.8 from 15 votes lands near the average, not near the classics |
| Enthusiast rating | MovieLens | different population, same adjustment |
| Critical recognition | Wikidata | Oscar/BAFTA/Cannes wins and nominations, log-compressed |

**Quality matters, and the amount is measured, not assumed.** Pure similarity with no quality signal
scored 0.0633 — *worse* than the old model. Pure quality with no similarity scored 0.1027 but found
**zero** obscure films. The optimum is an even split, and it degrades in both directions.

### 6. A light diversity pass

The final 30 are chosen with a penalty for resembling films already selected, then sorted by score.
This raises distinct franchises in the top 30 from 27.0 to 27.5 with no measurable cost to relevance.

---

## Results

Held-out test data — 300 users, never used for tuning.

| | old model | new model | change |
|---|---|---|---|
| Relevant films per 30 shown | 2.0 | **3.0** | **+48%** ✅ |
| How near the top the first good one lands | ~position 3 | **~position 2** | **+48%** ✅ |
| Users getting at least one hit | 198 of 300 | 225 of 300 | +14% ⚠️ marginal |
| Obscure films per 30 shown | 0.61 | 0.68 | +11% ❌ not significant |
| Distinct franchises in the 30 | — | 27.5 | — |

✅ = the confidence intervals don't overlap, so the difference is real. ❌ = they do overlap, so it
isn't established.

---

## Known limitation: obscure films did not improve

This was a stated goal and **we did not achieve it.** The investigation is recorded here so it isn't
repeated.

### Root cause: TMDB keyword coverage

| | popular films | obscure films |
|---|---|---|
| features per film | 37.8 | 27.9 |
| **keywords per film** | **19.8** | **10.6** |
| cast entries | 10.0 | 9.6 |
| films with zero keywords | 0.0% | 5.2% |
| **best similarity score** | **0.0776** | **0.0499** |

The gap is *specifically keywords* — cast and genres are near-identical. TMDB keywords are
community-curated, and nobody tags obscure films.

The consequence is mechanical: length-normalisation equalises vector *magnitude* but not
*dimensionality*. A film with 28 features has fewer chances to overlap with anything than one with 38,
so obscure films score **36% lower similarity** regardless of whether they're relevant.

### Four fixes tried, none worked

| attempt | result |
|---|---|
| Reduce the quality weight (obscure films have few votes, so quality penalises them) | Real but negligible. Dropping quality weight 0.5 → 0.1 costs 33% of overall precision to gain 2.7% of obscure precision. |
| Diversity reordering (MMR), to stop popular films filling every slot | **Made it worse.** Obscure precision fell 0.0275 → 0.0234 at λ=0.6. MMR evicts obscure films that resemble popular ones, replacing them with genuinely dissimilar — and usually irrelevant — films. |
| Background normalisation — divide by how similar a film is to films in general, cancelling the sparsity handicap | Looked like the best result on the tuning split. **Did not replicate** on held-out data (MRR 0.4315 vs 0.4326 — fractionally *worse*). The tuning-split gain was noise. |
| Nothing at all | Obscure precision 0.0227 vs the old model's 0.0204 — within noise |

### What's actually available

Ranking concentrates obscure relevance at **3.25×** versus **5.88×** for popular films. If ranking
handled obscure films as well as popular ones, obscure precision would be ~0.041 rather than 0.023 —
an 81% improvement that exists in principle and that we could not reach.

**The constraint is upstream data, not our model.** Closing it needs better metadata or a different
signal — which points at collaborative filtering and the larger `ml-25m` dataset, not at more tuning.

---

## Why awards are kept despite no proven benefit

Tested individually, the three quality sources are statistically indistinguishable — TMDB-only 0.0787,
MovieLens-only 0.0751, awards-only 0.0802. **But that test was underpowered:** at 150 users with
±0.015 intervals, signals separated by 0.005 will always look identical. That's absence of evidence,
not evidence of absence.

Awards are retained because critical recognition is genuinely independent of audience rating, and the
two diverge exactly where it's interesting — acclaimed films audiences rate modestly, and
crowd-pleasers with no critical standing. The natural use is a **"critically acclaimed" mode** raising
the award weight from 0.5 to 2–3, which needs no new code.

---

## Reproducing any of this

```bash
node scripts/fetch-dataset.js     # MovieLens (~1 MB)
node scripts/build-corpus.js      # TMDB corpus (~19k requests, ~10 min, resumable)
node scripts/freeze-corpus.js     # pin it for reproducibility
node scripts/build-idf.js         # -> data/idf.json
node scripts/build-quality.js     # -> data/quality.json (includes Wikidata awards)

node eval/sweep.js --limit 150                              # tune split only
node eval/harness.js --limit 300 --split test --model tfidf # confirm, once
```

**Tune on the tuning split; report on the test split once.** Two results in this document looked good
on the tuning split and evaporated on held-out data. That separation is the only thing that caught
them.

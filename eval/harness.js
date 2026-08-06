#!/usr/bin/env node
/**
 * Leave-one-out evaluation harness.
 *
 * This is the instrument the whole rebuild depends on. Before it existed there was no way to tell
 * whether a scoring change made recommendations better or worse — the weights were adjusted by feel.
 * Everything downstream is compared against the baseline this produces.
 *
 * ## Protocol
 *
 * For each MovieLens user with enough highly-rated films:
 *
 *   1. Sample *k* of their liked films (k in 3..10, matching what the real UI accepts) as the "picks".
 *   2. Hold out one **other** liked film as the target.
 *   3. Run the recommender on the picks.
 *   4. Record where the held-out film landed.
 *
 * The reasoning: the user demonstrably liked the held-out film, so a good recommender given their
 * other favourites should surface it. This is the standard protocol for offline recommender
 * evaluation.
 *
 * ## Two numbers, not one
 *
 * The harness separates **candidate recall** (was the target in the pool at all?) from **ranking
 * quality** (given it was, how high did it rank?). That distinction decides where effort should go:
 * if targets rarely enter the pool, no amount of scoring work can help, and the bottleneck is
 * candidate generation instead.
 *
 * ## Determinism
 *
 * Sampling uses a seeded PRNG, so the same seed produces the same instances. Re-running must
 * reproduce the same numbers or the baseline is worthless.
 *
 * Usage:
 *   node eval/harness.js [--limit N] [--seed N] [--split tune|test|all] [--model legacy]
 */

const fs = require('fs');
const path = require('path');

// Force the disk cache: eval reads the frozen corpus and must never silently re-fetch it.
process.env.CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
process.env.CACHE_TTL_MS = process.env.CACHE_TTL_MS || String(365 * 24 * 60 * 60 * 1000);

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getMovie, getSimilar, getRecommendations, cache } = require('../lib/tmdb');
const { loadUserProfiles, loadPopularity, isDownloaded } = require('../lib/movielens');
const collaborative = require('../lib/collaborative');
const { applyMmr } = require('../lib/score');

/** Candidates considered by MMR. Wider than the cutoff so it has room to swap in alternatives. */
const MMR_WINDOW = 120;
/** Slots MMR fills. Matches what the app displays. */
const MMR_LIMIT = 30;
const metrics = require('./metrics');

const baselines = require('../lib/score-baselines');

/**
 * Available models.
 *
 * `legacy` is the shipped model; the rest are trivial baselines that answer whether it earns its
 * complexity. A model that fails to beat `popularity` is not ranking on taste, and one that fails to
 * beat `multimatch` is getting nothing from its content features.
 */
/**
 * Builds the TF-IDF model from its committed artifacts.
 *
 * MovieLens quality averages are recomputed here with the evaluated users excluded -- the same
 * leakage control the CF model uses. A user's own rating of a held-out film must not raise that
 * film's quality score, because that rating is precisely what is being withheld.
 *
 * @param {Set<number>} evaluatedUsers
 * @param {object} params - Hyperparameter overrides.
 * @returns {object} A model exposing rankCandidates().
 */
function buildTfidfModel(evaluatedUsers, params) {
    const fs2 = require('fs');
    const { createModel } = require('../lib/score');
    const { loadMovieLensRatings } = require('../lib/quality');

    const idfPath = path.join(__dirname, '..', 'data', 'idf.json');
    const qualityPath = path.join(__dirname, '..', 'data', 'quality.json');

    if (!fs2.existsSync(idfPath) || !fs2.existsSync(qualityPath)) {
        console.error('Missing data/idf.json or data/quality.json. Run scripts/build-idf.js and '
            + 'scripts/build-quality.js first.');
        process.exit(1);
    }

    const { idf } = JSON.parse(fs2.readFileSync(idfPath, 'utf8'));
    const artifact = JSON.parse(fs2.readFileSync(qualityPath, 'utf8'));
    const { byTmdbId, corpusMean } = loadMovieLensRatings({ excludeUsers: evaluatedUsers });
    const awards = new Map(Object.entries(artifact.awards).map(([id, v]) => [Number(id), v]));

    console.log(`TF-IDF model: ${Object.keys(idf).length.toLocaleString()} IDF features, `
        + `${byTmdbId.size.toLocaleString()} rated films (${evaluatedUsers.size} users excluded), `
        + `${awards.size.toLocaleString()} with awards`);

    return createModel({
        idf,
        quality: { movieLens: byTmdbId, movieLensMean: corpusMean, awards },
        params
    });
}

const MODELS = {
    legacy: require('../lib/score-legacy'),
    fixed: require('../lib/rank'),
    random: baselines.random,
    popularity: baselines.popularity,
    rating: baselines.rating,
    multimatch: baselines.multiMatch
};

/** Minimum and maximum picks per instance, matching the UI's 3-10 range. */
const MIN_PICKS = 3;
const MAX_PICKS = 10;

/** How many candidates to take from each source list, mirroring the app's per-pick budget. */
const CANDIDATES_PER_SOURCE = 20;

/**
 * Deterministic PRNG (mulberry32).
 *
 * `Math.random()` cannot be seeded, and a harness whose samples change between runs cannot produce a
 * reproducible baseline.
 *
 * @param {number} seed
 * @returns {() => number} Generator returning [0, 1).
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Fisher-Yates shuffle using a supplied PRNG.
 *
 * @template T
 * @param {T[]} array - Copied, not mutated.
 * @param {() => number} rand
 * @returns {T[]}
 */
function shuffle(array, rand) {
    const out = [...array];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Assigns a user to the tuning or test split.
 *
 * Hyperparameters are tuned on one split and the final number reported once on the other. Without
 * this separation, sweeping *k* and picking the best result reports an overfit number that will not
 * hold up.
 *
 * Splitting by user id (not by instance) keeps a single user's instances entirely on one side.
 *
 * @param {number} userId
 * @returns {'tune'|'test'}
 */
function splitFor(userId) {
    return userId % 2 === 0 ? 'tune' : 'test';
}

/**
 * Parses command-line flags.
 *
 * @returns {{limit: number, seed: number, split: string, model: string, verbose: boolean}}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, fallback) => {
        const i = args.indexOf(flag);
        return i === -1 ? fallback : args[i + 1];
    };
    return {
        limit: Number(get('--limit', 500)),
        seed: Number(get('--seed', 42)),
        split: get('--split', 'all'),
        model: get('--model', 'legacy'),
        generator: get('--generator', 'tmdb'),
        targets: get('--targets', 'all'),
        params: get('--params', ''),
        mmr: args.includes('--mmr'),
        mmrLambda: Number(get('--mmr-lambda', 0.8)),
        verbose: args.includes('--verbose')
    };
}

/**
 * Builds the candidate pool for one pick using TMDB's own lists.
 *
 * This is the generator the shipped app uses, and the one measured at a 10.4% ceiling.
 *
 * @param {number} tmdbId
 * @returns {Promise<number[]>}
 */
async function tmdbCandidates(tmdbId) {
    return candidatesFor(tmdbId);
}

/**
 * Builds the candidate pool from collaborative filtering neighbours.
 *
 * @param {object} cfModel - Model from lib/collaborative.js buildModel().
 * @param {number} tmdbId
 * @returns {number[]}
 */
function cfCandidates(cfModel, tmdbId) {
    const related = cfModel.neighbours.get(tmdbId) || [];
    return related.slice(0, CANDIDATES_PER_SOURCE * 2).map(n => n.id);
}

/**
 * Loads full TMDB details for a film, returning null if it is unavailable.
 *
 * A small number of MovieLens entries point at TMDB ids that have since been deleted. Those films are
 * excluded rather than failing the run.
 *
 * @param {number} tmdbId
 * @returns {Promise<object|null>}
 */
async function safeDetails(tmdbId) {
    try {
        return await getMovie(String(tmdbId));
    } catch {
        return null;
    }
}

/**
 * Gathers the candidate pool for one pick, from both TMDB source lists.
 *
 * Note this takes the top N from **each** list separately rather than slicing the concatenation. The
 * shipped app slices `similar ++ recommendations` to 20 total, and since `similar` alone returns 20,
 * it discards the recommendations results entirely. Reproducing that bug here would understate the
 * pool and confuse a generation problem with a ranking one, so the harness measures the pool that is
 * actually available.
 *
 * @param {number} tmdbId
 * @returns {Promise<number[]>} Candidate TMDB ids.
 */
async function candidatesFor(tmdbId) {
    const id = String(tmdbId);
    const [similar, recommended] = await Promise.all([
        getSimilar(id).catch(() => ({ results: [] })),
        getRecommendations(id).catch(() => ({ results: [] }))
    ]);

    const ids = [
        ...(similar.results || []).slice(0, CANDIDATES_PER_SOURCE).map(m => m.id),
        ...(recommended.results || []).slice(0, CANDIDATES_PER_SOURCE).map(m => m.id)
    ];

    return [...new Set(ids)];
}

/**
 * Builds the evaluation instances.
 *
 * @param {object} options
 * @returns {Array<{userId: number, picks: number[], targetId: number, split: string}>}
 */
function buildInstances({ limit, seed, split, targetMode }) {
    const rand = mulberry32(seed);
    const profiles = loadUserProfiles({ minLiked: MIN_PICKS + 1 });
    const instances = [];

    for (const { userId, liked } of profiles) {
        const userSplit = splitFor(userId);
        if (split !== 'all' && userSplit !== split) continue;

        const shuffled = shuffle(liked, rand);
        // Pick count varies across instances so the baseline reflects the whole 3-10 input range
        // rather than one arbitrary size.
        const k = Math.min(
            MIN_PICKS + Math.floor(rand() * (MAX_PICKS - MIN_PICKS + 1)),
            shuffled.length - 1
        );

        // Held-out films: liked by this user, never shown to the model.
        //
        // 'all' holds out every remaining like, so success means "recommended something they liked" --
        // which is what the app actually tries to do. 'single' holds out exactly one, reproducing the
        // stricter original protocol so previously recorded baselines stay comparable.
        const held = targetMode === 'single' ? [shuffled[k]] : shuffled.slice(k);

        instances.push({
            userId,
            picks: shuffled.slice(0, k),
            targetIds: held,
            split: userSplit
        });

        if (instances.length >= limit) break;
    }

    return instances;
}

/**
 * Runs one evaluation instance.
 *
 * @param {object} instance
 * @param {object} model - A scoring model exposing `rankCandidates`.
 * @returns {Promise<object|null>} Per-instance outcome, or null if unevaluable.
 */
async function runInstance(instance, model, { generator, cfModel, mmr = false, mmrLambda = 0.8 }) {
    const pickDetails = (await Promise.all(instance.picks.map(safeDetails))).filter(Boolean);
    if (pickDetails.length < MIN_PICKS) return null;

    const pickIds = new Set(pickDetails.map(p => p.id));

    // Build each pick's candidate list, then hydrate every unique candidate once.
    const groups = [];
    const candidateIds = new Set();

    for (const pick of pickDetails) {
        let ids;
        if (generator === 'cf') {
            ids = cfCandidates(cfModel, pick.id);
        } else if (generator === 'hybrid') {
            // Union of both sources. Content ranking still applies afterwards, so explanations
            // survive regardless of which generator surfaced a given film.
            ids = [...new Set([
                ...(await tmdbCandidates(pick.id)),
                ...cfCandidates(cfModel, pick.id)
            ])];
        } else {
            ids = await tmdbCandidates(pick.id);
        }

        ids = ids.filter(id => !pickIds.has(id));
        groups.push({ pick, ids });
        ids.forEach(id => candidateIds.add(id));
    }

    const detailsById = new Map();
    await Promise.all([...candidateIds].map(async id => {
        const details = await safeDetails(id);
        if (details) detailsById.set(id, details);
    }));

    const hydrated = groups.map(({ pick, ids }) => ({
        pick,
        candidates: ids.map(id => detailsById.get(id)).filter(Boolean)
    }));

    let scored = model.rankCandidates(hydrated, pickIds);

    // Diversity reordering, applied only when requested.
    //
    // Every result recorded before 2026-08-04 ran WITHOUT this: lib/score.js implements MMR inside
    // finalise(), and the harness only ever called rankCandidates(). MMR was built and never
    // measured. It is applied to the head of the list and the tail is appended in relevance order,
    // so metrics beyond the cutoff (MRR) still see a complete ranking.
    if (mmr && typeof applyMmr === 'function' && scored[0]?.vector) {
        // MUST mirror lib/score.js finalise(): MMR chooses WHICH films appear, then the selection is
        // sorted by score for display. If the harness ordered them differently from production, the
        // measured MRR would describe a ranking users never see.
        const head = applyMmr(scored.slice(0, MMR_WINDOW), MMR_LIMIT, mmrLambda)
            .sort((a, b) => b.score - a.score || a.id - b.id);
        const chosen = new Set(head.map(c => c.id));
        scored = [...head, ...scored.filter(c => !chosen.has(c.id))];
    }

    const ranked = scored.map(r => r.id);

    // Franchise membership for the ranked films, so metrics can measure flooding.
    // belongs_to_collection already arrives in the details payload, so this is free.
    const collectionOf = new Map();
    for (const entry of scored) {
        const collection = entry.details?.belongs_to_collection
            || detailsById.get(entry.id)?.belongs_to_collection;
        if (collection) collectionOf.set(entry.id, collection.id);
    }

    return {
        ranked,
        collectionOf,
        targets: new Set(instance.targetIds),
        // The pool is reported separately from the ranked output so a generation ceiling stays
        // visible independently of how the model ordered things.
        pool: candidateIds,
        split: instance.split
    };
}

async function main() {
    const { limit, seed, split, model: modelName, generator, targets, params, mmr, mmrLambda,
        verbose } = parseArgs();
    const started = Date.now();

    if (!isDownloaded()) {
        console.error('MovieLens data missing. Run: node scripts/fetch-dataset.js');
        process.exit(1);
    }

    let model = MODELS[modelName];
    if (!model && modelName !== 'tfidf') {
        console.error(`Unknown model "${modelName}". Available: ${Object.keys(MODELS).join(', ')}, tfidf`);
        process.exit(1);
    }

    // tfidf is built after instances exist, so the evaluated users can be excluded from its
    // MovieLens quality averages.
    const pendingTfidf = modelName === 'tfidf';
    console.log(`Evaluation harness — model "${pendingTfidf ? 'tfidf' : model.name}", generator "${generator}"`);
    if (!pendingTfidf) console.log(`  ${model.description}`);
    console.log(`  seed ${seed} | split ${split} | limit ${limit}\n`);

    const popularity = loadPopularity();
    const instances = buildInstances({ limit, seed, split, targetMode: targets });
    console.log(`Built ${instances.length} instances.`);

    // --- Collaborative filtering model, built ONCE with every evaluated user excluded ------------
    //
    // LEAKAGE CONTROL. This is the correctness property the whole comparison rests on.
    //
    // If an evaluated user's ratings stayed in the co-occurrence matrix, their own liking of both the
    // picks and the held-out film would contribute to the counts linking them. The model would then
    // "predict" the held-out film partly because that user liked it -- which is exactly the fact being
    // withheld. Results would look excellent and mean nothing.
    //
    // Excluding the entire user, not merely the held-out rating, is the stricter and correct choice:
    // their remaining ratings describe the same person's taste and would leak indirectly.
    let cfModel = null;
    if (generator === 'cf' || generator === 'hybrid') {
        const evaluatedUsers = new Set(instances.map(i => i.userId));
        console.log(`\nBuilding CF model, excluding ${evaluatedUsers.size} evaluated users...`);

        cfModel = collaborative.buildModel({ excludeUsers: evaluatedUsers });

        console.log(`  users used:            ${cfModel.stats.usersUsed}`);
        console.log(`  users excluded:        ${cfModel.stats.usersExcluded} (leakage control)`);
        console.log(`  films with neighbours: ${cfModel.stats.filmsWithNeighbours.toLocaleString()}`);
        console.log(`  pairs retained:        ${cfModel.stats.pairsRetained.toLocaleString()}`);

        if (cfModel.stats.usersUsed === 0) {
            console.error('\nNo users left after exclusion — cannot build a CF model.');
            process.exit(1);
        }
    }

    // Built here rather than at module load because it needs the evaluated user set: their MovieLens
    // ratings must be excluded from the quality averages, or a user's own rating of a held-out film
    // would raise that film's score — leaking exactly what is being withheld.
    if (pendingTfidf) {
        const overrides = {};
        for (const pair of params.split(',').filter(Boolean)) {
            const [key, value] = pair.split('=');
            overrides[key] = Number(value);
        }
        model = buildTfidfModel(new Set(instances.map(i => i.userId)), overrides);
        console.log(`  ${model.description}`);
    }

    console.log('\nRunning...\n');

    const outcomes = [];
    let skipped = 0;

    for (let i = 0; i < instances.length; i++) {
        const result = await runInstance(instances[i], model, { generator, cfModel, mmr, mmrLambda });

        if (!result) { skipped++; continue; }

        outcomes.push({ ...result, popularityOf: popularity });

        if ((i + 1) % 25 === 0 || i === instances.length - 1) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(0);
            const stats = cache.stats();
            console.log(
                `  ${String(i + 1).padStart(4)}/${instances.length} ` +
                `| ${elapsed}s | cache hit rate ${(stats.hitRate * 100).toFixed(0)}%`
            );
        }

        if (verbose && result.ranked.length) {
            const firstHit = result.ranked.findIndex(id => result.targets.has(id));
            console.log(`      user ${instances[i].userId}: ${result.targets.size} targets, ` +
                `first hit at ${firstHit === -1 ? 'none' : firstHit + 1} of ${result.ranked.length}`);
        }
    }

    const report = metrics.summarize(outcomes);
    console.log(metrics.format(report, `BASELINE — model "${model.name}"`));

    const stats = cache.stats();
    console.log(`\nSkipped (unresolvable picks): ${skipped}`);
    console.log(`Runtime: ${((Date.now() - started) / 1000).toFixed(0)}s`);
    console.log(`TMDB requests sent: ${stats.misses.toLocaleString()} ` +
        `(${stats.hits.toLocaleString()} served from the frozen corpus)`);

    // Persist so the number is in the repository, not just a terminal scrollback.
    // The split MUST be in the filename. Without it a test-split run silently overwrites the
    // all-split results for the same model — which happened, and destroyed a recorded baseline until
    // it was recovered from git.
    const outPath = path.join(__dirname, '..', 'data',
        `results-${model.name}-${generator}-${targets}-${split}`
        + `${params ? `-${params.replace(/[=,]/g, '')}` : ''}`
        + `${mmr ? `-mmr${mmrLambda}` : ''}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify({
        model: model.name,
        description: model.description,
        generator,
        targetMode: targets,
        mmr,
        mmrLambda: mmr ? mmrLambda : null,
        cfStats: cfModel ? cfModel.stats : null,
        seed, split, limit,
        instancesEvaluated: outcomes.length,
        skipped,
        recordedAt: new Date().toISOString(),
        report
    }, null, 2)}\n`);

    console.log(`\nResults written to ${path.relative(process.cwd(), outPath)}`);
}

/**
 * Exported so eval/sweep.js can reuse instance construction and candidate hydration rather than
 * reimplementing the protocol — a second implementation is a second thing that can silently
 * disagree with the first, and the whole value of the harness rests on both measuring the same thing.
 */
module.exports = { buildInstances, runInstance, safeDetails, candidatesFor, MODELS, splitFor };

// Only run the CLI when invoked directly, not when imported by the sweep driver.
if (require.main === module) {
    main().catch(error => {
        console.error('\nHarness failed:', error);
        process.exit(1);
    });
}

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
const metrics = require('./metrics');

const baselines = require('../lib/score-baselines');

/**
 * Available models.
 *
 * `legacy` is the shipped model; the rest are trivial baselines that answer whether it earns its
 * complexity. A model that fails to beat `popularity` is not ranking on taste, and one that fails to
 * beat `multimatch` is getting nothing from its content features.
 */
const MODELS = {
    legacy: require('../lib/score-legacy'),
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
        verbose: args.includes('--verbose')
    };
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
function buildInstances({ limit, seed, split }) {
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

        instances.push({
            userId,
            picks: shuffled.slice(0, k),
            targetId: shuffled[k],      // The held-out film: liked, but never shown to the model.
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
async function runInstance(instance, model) {
    const pickDetails = (await Promise.all(instance.picks.map(safeDetails))).filter(Boolean);
    if (pickDetails.length < MIN_PICKS) return null;

    const pickIds = new Set(pickDetails.map(p => p.id));

    // Build each pick's candidate list, then hydrate every unique candidate once.
    const groups = [];
    const candidateIds = new Set();

    for (const pick of pickDetails) {
        const ids = (await candidatesFor(pick.id)).filter(id => !pickIds.has(id));
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

    const ranked = model.rankCandidates(hydrated, pickIds).map(r => r.id);

    return {
        ranked,
        targetId: instance.targetId,
        // Measured against the *pool*, not the ranked output, so a generation ceiling is visible
        // independently of how the model ordered things.
        inCandidatePool: candidateIds.has(instance.targetId),
        poolSize: candidateIds.size,
        split: instance.split
    };
}

async function main() {
    const { limit, seed, split, model: modelName, verbose } = parseArgs();
    const started = Date.now();

    if (!isDownloaded()) {
        console.error('MovieLens data missing. Run: node scripts/fetch-dataset.js');
        process.exit(1);
    }

    const model = MODELS[modelName];
    if (!model) {
        console.error(`Unknown model "${modelName}". Available: ${Object.keys(MODELS).join(', ')}`);
        process.exit(1);
    }

    console.log(`Evaluation harness — model "${model.name}"`);
    console.log(`  ${model.description}`);
    console.log(`  seed ${seed} | split ${split} | limit ${limit}\n`);

    const popularity = loadPopularity();
    const instances = buildInstances({ limit, seed, split });
    console.log(`Built ${instances.length} instances. Running...\n`);

    const outcomes = [];
    let skipped = 0;

    for (let i = 0; i < instances.length; i++) {
        const result = await runInstance(instances[i], model);

        if (!result) { skipped++; continue; }

        outcomes.push({
            ...result,
            targetPopularity: popularity.get(instances[i].targetId) || 0
        });

        if ((i + 1) % 25 === 0 || i === instances.length - 1) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(0);
            const stats = cache.stats();
            console.log(
                `  ${String(i + 1).padStart(4)}/${instances.length} ` +
                `| ${elapsed}s | cache hit rate ${(stats.hitRate * 100).toFixed(0)}%`
            );
        }

        if (verbose && result.ranked.length) {
            const rank = result.ranked.indexOf(result.targetId);
            console.log(`      user ${instances[i].userId}: target rank ` +
                `${rank === -1 ? 'not found' : rank + 1} of ${result.ranked.length}`);
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
    const outPath = path.join(__dirname, '..', 'data', `results-${model.name}-${split}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify({
        model: model.name,
        description: model.description,
        seed, split, limit,
        instancesEvaluated: outcomes.length,
        skipped,
        recordedAt: new Date().toISOString(),
        report
    }, null, 2)}\n`);

    console.log(`\nResults written to ${path.relative(process.cwd(), outPath)}`);
}

main().catch(error => {
    console.error('\nHarness failed:', error);
    process.exit(1);
});

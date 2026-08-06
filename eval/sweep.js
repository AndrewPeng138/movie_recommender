#!/usr/bin/env node
/**
 * Hyperparameter sweep for the TF-IDF model.
 *
 * ## Why this is a separate script
 *
 * Sweeping means running the same instances through many parameter combinations. Doing that by
 * re-invoking the harness would rebuild the instances and re-hydrate every candidate on each run —
 * minutes per combination. Here the expensive work happens **once** and each combination is scored
 * against the cached results, so a 20-point sweep takes about as long as one harness run.
 *
 * ## Tuning discipline
 *
 * This sweeps on the **tune** split only. Choosing hyperparameters by looking at the test split and
 * then reporting that same number is how you convince yourself of a result that does not exist:
 * with enough combinations, something always wins by chance. The winner is reported once on the
 * held-out test split by eval/harness.js, and that is the number that counts.
 *
 * Usage:
 *   node eval/sweep.js [--limit N] [--generator tmdb|cf|hybrid]
 */

const fs = require('fs');
const path = require('path');

process.env.CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
process.env.CACHE_TTL_MS = process.env.CACHE_TTL_MS || String(365 * 24 * 60 * 60 * 1000);
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { buildInstances, safeDetails, candidatesFor } = require('./harness');
const { loadPopularity } = require('../lib/movielens');
const { loadMovieLensRatings } = require('../lib/quality');
const { createModel, DEFAULTS } = require('../lib/score');
const legacyModel = require('../lib/score-legacy');
const metrics = require('./metrics');

const IDF_PATH = path.join(__dirname, '..', 'data', 'idf.json');
const QUALITY_PATH = path.join(__dirname, '..', 'data', 'quality.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, fallback) => {
        const i = args.indexOf(flag);
        return i === -1 ? fallback : args[i + 1];
    };
    return {
        limit: Number(get('--limit', 200)),
        seed: Number(get('--seed', 42)),
        generator: get('--generator', 'tmdb')
    };
}

/**
 * Loads and hydrates every instance once, so parameter combinations are cheap to evaluate.
 *
 * @param {object} options
 * @returns {Promise<Array<object>>} Hydrated instances with pick and candidate details attached.
 */
async function prepare({ limit, seed }) {
    const instances = buildInstances({ limit, seed, split: 'tune', targetMode: 'all' });
    console.log(`Hydrating ${instances.length} tuning instances (once)...`);

    const prepared = [];
    for (let i = 0; i < instances.length; i++) {
        const instance = instances[i];
        const picks = (await Promise.all(instance.picks.map(safeDetails))).filter(Boolean);
        if (picks.length < 3) continue;

        const pickIds = new Set(picks.map(p => p.id));
        const groups = [];
        const poolIds = new Set();

        for (const pick of picks) {
            const ids = (await candidatesFor(pick.id)).filter(id => !pickIds.has(id));
            groups.push({ pick, ids });
            ids.forEach(id => poolIds.add(id));
        }

        const detailsById = new Map();
        await Promise.all([...poolIds].map(async id => {
            const details = await safeDetails(id);
            if (details) detailsById.set(id, details);
        }));

        const collectionOf = new Map();
        for (const [id, d] of detailsById) {
            if (d.belongs_to_collection) collectionOf.set(id, d.belongs_to_collection.id);
        }

        prepared.push({
            userId: instance.userId,
            targets: new Set(instance.targetIds),
            collectionOf,
            pickIds,
            pool: poolIds,
            groups: groups.map(({ pick, ids }) => ({
                pick,
                candidates: ids.map(id => detailsById.get(id)).filter(Boolean)
            }))
        });

        if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${instances.length}`);
    }

    return prepared;
}

/**
 * Scores one parameter combination against the prepared instances.
 *
 * @param {Array<object>} prepared
 * @param {object} model
 * @param {Map<number, number>} popularity
 * @returns {object} Metrics report.
 */
function evaluate(prepared, model, popularity) {
    const outcomes = prepared.map(instance => {
        const ranked = model.rankCandidates(instance.groups, instance.pickIds);
        return {
            ranked: ranked.map(r => r.id),
            targets: instance.targets,
            pool: instance.pool,
            collectionOf: instance.collectionOf,
            popularityOf: popularity
        };
    });
    return metrics.summarize(outcomes);
}

async function main() {
    const { limit, seed, generator } = parseArgs();

    for (const file of [IDF_PATH, QUALITY_PATH]) {
        if (!fs.existsSync(file)) {
            console.error(`Missing ${path.basename(file)}. Run scripts/build-idf.js and `
                + 'scripts/build-quality.js first.');
            process.exit(1);
        }
    }

    const { idf } = JSON.parse(fs.readFileSync(IDF_PATH, 'utf8'));
    const qualityArtifact = JSON.parse(fs.readFileSync(QUALITY_PATH, 'utf8'));

    console.log(`Sweep — generator ${generator}, tune split, seed ${seed}, limit ${limit}\n`);

    const prepared = await prepare({ limit, seed });
    console.log(`\nPrepared ${prepared.length} instances.\n`);

    // LEAKAGE CONTROL: MovieLens averages exclude every evaluated user. Their own rating of a
    // held-out film must not raise that film's quality score -- that is the fact being withheld.
    const evaluatedUsers = new Set(prepared.map(i => i.userId));
    const { byTmdbId, corpusMean } = loadMovieLensRatings({ excludeUsers: evaluatedUsers });
    console.log(`MovieLens quality: ${byTmdbId.size.toLocaleString()} films, `
        + `${evaluatedUsers.size} users excluded, mean ${corpusMean.toFixed(3)}`);

    const awards = new Map(
        Object.entries(qualityArtifact.awards).map(([id, v]) => [Number(id), v])
    );
    console.log(`Awards: ${awards.size.toLocaleString()} films\n`);

    const qualityConfig = { movieLens: byTmdbId, movieLensMean: corpusMean, awards };
    const popularity = loadPopularity();

    // --- Baseline for comparison ------------------------------------------------------------------
    const baseline = evaluate(prepared, legacyModel, popularity);
    const rows = [{
        label: 'legacy (baseline)',
        precision: baseline.overall['precision@30'],
        precisionCi: baseline.overall['precision@30_ci95'],
        hit: baseline.overall['hitRate@30'],
        mrr: baseline.overall.mrr,
        obscure: baseline.byPopularity.obscure['precision@30'],
        collections: baseline.overall['distinctCollections@30'],
        largest: baseline.overall['largestFranchise@30']
    }];

    /**
     * Sweep grid. Deliberately one axis at a time from a sensible centre rather than a full
     * cartesian product: with ~200 instances and overlapping confidence intervals, an exhaustive
     * grid mostly finds noise and invites overfitting the tune split.
     */
    const combos = [];

    // Background-similarity correction. Obscure films carry ~half the keywords of popular ones, so
    // their sparser vectors score systematically lower regardless of relevance. alpha=0 disables the
    // correction entirely, which is why this sweep cannot make things worse than today.
    for (const backgroundAlpha of [0, 0.25, 0.5, 0.75, 1.0]) {
        combos.push({ k: 10, qualityWeight: 0.5, backgroundAlpha,
            label: `alpha=${backgroundAlpha}` });
    }

    for (const combo of combos) {
        const { label, ...params } = combo;
        const model = createModel({ idf, quality: qualityConfig, params });
        const report = evaluate(prepared, model, popularity);
        rows.push({
            label: label || Object.entries(params).map(([key, v]) => `${key}=${v}`).join(' '),
            precision: report.overall['precision@30'],
            precisionCi: report.overall['precision@30_ci95'],
            hit: report.overall['hitRate@30'],
            mrr: report.overall.mrr,
            obscure: report.byPopularity.obscure['precision@30'],
            collections: report.overall['distinctCollections@30'],
            largest: report.overall['largestFranchise@30']
        });
        process.stdout.write('.');
    }

    console.log('\n');
    console.log('='.repeat(84));
    console.log('SWEEP RESULTS (tune split — NOT for reporting; the winner is re-run on test)');
    console.log('='.repeat(84));
    console.log(
        'variant'.padEnd(28)
        + 'precision@30'.padStart(16)
        + 'hitRate@30'.padStart(13)
        + 'MRR'.padStart(10)
        + 'obscure p@30'.padStart(15)
        + 'collections'.padStart(13)
        + 'maxFranch'.padStart(11)
    );
    console.log('-'.repeat(84));

    const defaults = Object.entries(DEFAULTS).map(([k, v]) => `${k}=${v}`).join(' ');
    for (const row of rows) {
        console.log(
            row.label.padEnd(28)
            + `${row.precision.toFixed(4)} ±${row.precisionCi.toFixed(3)}`.padStart(16)
            + row.hit.toFixed(4).padStart(13)
            + row.mrr.toFixed(4).padStart(10)
            + row.obscure.toFixed(4).padStart(15)
            + String(row.collections ?? '-').padStart(13)
            + String(row.largest ?? '-').padStart(11)
        );
    }
    console.log('-'.repeat(84));
    console.log(`defaults: ${defaults}`);

    const best = rows.slice(1).reduce((a, b) => (b.precision > a.precision ? b : a));
    console.log(`\nBest on tune split: ${best.label} (precision@30 ${best.precision.toFixed(4)})`);
    console.log('Re-run the winner on the TEST split before believing it.');
}

main().catch(error => {
    console.error('\nSweep failed:', error);
    process.exit(1);
});

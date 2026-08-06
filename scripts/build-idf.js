#!/usr/bin/env node
/**
 * Computes the IDF table from the frozen TMDB corpus.
 *
 * This is what replaces the hand-tuned scoring weights. A feature's importance becomes `log(N / df)`
 * — how rare it is across the corpus — so sharing "Drama" is automatically near-worthless while
 * sharing an obscure keyword is automatically strong. The numbers are derived, not chosen.
 *
 * Output is `data/idf.json`, committed and loaded at boot. Committing it is deliberate: the
 * alternative is building on Render, which would require the 19,204-file corpus present at build
 * time. A few MB in git is the smaller problem.
 *
 * Usage:
 *   node scripts/build-idf.js [--min-df N] [--out path]
 *
 *   --min-df N   Drop features appearing in fewer than N films. Defaults to 2 — a feature seen once
 *                in the entire corpus can never cause a match between two different films, so it is
 *                pure artifact size with zero effect on any score.
 *
 * Reads only cached data; makes no network requests. Run scripts/build-corpus.js first.
 */

const fs = require('fs');
const path = require('path');

// Read from the frozen corpus. No TTL override needed — entries were frozen for a year.
process.env.CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getMovie, getKeywords, cache } = require('../lib/tmdb');
const { extractFeatures, computeIdf } = require('../lib/features');
const { loadPopularity, isDownloaded } = require('../lib/movielens');

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, fallback) => {
        const i = args.indexOf(flag);
        return i === -1 ? fallback : args[i + 1];
    };
    return {
        minDf: Number(get('--min-df', 2)),
        out: get('--out', path.join(__dirname, '..', 'data', 'idf.json'))
    };
}

async function main() {
    const { minDf, out } = parseArgs();
    const started = Date.now();

    if (!isDownloaded()) {
        console.error('MovieLens data missing. Run: node scripts/fetch-dataset.js');
        process.exit(1);
    }

    const tmdbIds = [...loadPopularity().keys()];
    console.log(`Building IDF from ${tmdbIds.length.toLocaleString()} corpus films...\n`);

    const documents = [];
    const typeCounts = {};
    let missing = 0;

    for (const tmdbId of tmdbIds) {
        let details, keywords;
        try {
            // Both are cached; a miss here means the corpus build skipped this film (typically a
            // TMDB entry that has since been deleted).
            details = await getMovie(String(tmdbId));
            keywords = await getKeywords(String(tmdbId)).catch(() => ({ keywords: [] }));
        } catch {
            missing++;
            continue;
        }

        const { weights } = extractFeatures(details, keywords);
        if (weights.size === 0) continue;

        documents.push(weights);
        for (const key of weights.keys()) {
            const type = key.slice(0, key.indexOf(':'));
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        }

        if (documents.length % 2000 === 0) {
            console.log(`  ${documents.length.toLocaleString()} films processed`);
        }
    }

    const { idf, documentCount } = computeIdf(documents);

    // Prune single-occurrence features. A feature present in exactly one film cannot contribute to
    // any similarity between two films, so keeping it only inflates the artifact.
    const pruned = {};
    let dropped = 0;
    const dfLookup = new Map();
    for (const features of documents) {
        for (const key of features.keys()) dfLookup.set(key, (dfLookup.get(key) || 0) + 1);
    }
    for (const [key, value] of Object.entries(idf)) {
        if ((dfLookup.get(key) || 0) < minDf) { dropped++; continue; }
        pruned[key] = value;
    }

    const artifact = {
        documentCount,
        minDf,
        featureCount: Object.keys(pruned).length,
        builtAt: new Date().toISOString(),
        dataset: 'ml-latest-small',
        note: 'Derived from the frozen TMDB corpus. Rebuild with scripts/build-idf.js after any '
            + 'corpus refresh, and re-record the baseline in the same commit — see docs/CORPUS.md.',
        idf: pruned
    };

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(artifact)}\n`);

    const bytes = fs.statSync(out).size;
    const stats = cache.stats();

    console.log(`\n${'='.repeat(62)}`);
    console.log(`IDF built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  films used:        ${documentCount.toLocaleString()}`);
    console.log(`  films unavailable: ${missing.toLocaleString()}`);
    console.log(`  features kept:     ${Object.keys(pruned).length.toLocaleString()}`);
    console.log(`  features dropped:  ${dropped.toLocaleString()} (df < ${minDf})`);
    console.log(`  artifact:          ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  cache misses:      ${stats.misses} (should be ~0 against a built corpus)`);
    console.log('='.repeat(62));

    console.log('\nFeature occurrences by type:');
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(6)} ${count.toLocaleString()}`);
    }

    // Sanity check: the rarity weighting is the entire point, so show it working.
    const sorted = Object.entries(pruned).sort((a, b) => a[1] - b[1]);
    console.log('\nLowest IDF (most common — should be near-worthless for matching):');
    for (const [key, value] of sorted.slice(0, 5)) console.log(`  ${value.toFixed(3)}  ${key}`);
    console.log('Highest IDF (rarest — should dominate a match):');
    for (const [key, value] of sorted.slice(-3)) console.log(`  ${value.toFixed(3)}  ${key}`);
}

main().catch(error => {
    console.error('\nIDF build failed:', error);
    process.exit(1);
});

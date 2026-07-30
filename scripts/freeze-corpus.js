#!/usr/bin/env node
/**
 * Freezes the evaluation corpus and writes a manifest describing it.
 *
 * Ordinary caching is about freshness. A corpus needs the opposite guarantee — **reproducibility**.
 * If the corpus silently expires and re-fetches, a baseline recorded last month is no longer
 * comparable to a run today, because TMDB's data may have moved underneath it. Comparability is the
 * entire reason the baseline exists, so the corpus is pinned rather than refreshed.
 *
 * This rewrites entry expiry in place rather than re-fetching, which matters: the corpus costs
 * roughly 19,000 TMDB requests to build.
 *
 * Usage:
 *   node scripts/freeze-corpus.js [--years N]
 *
 * @see docs/CORPUS.md for the refresh policy.
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
process.env.CACHE_DIR = CACHE_DIR;

const { createCache, YEAR } = require('../lib/cache');
const { loadLinks, loadPopularity } = require('../lib/movielens');

const MANIFEST = path.join(__dirname, '..', 'data', 'corpus-manifest.json');

function main() {
    const yearsArg = process.argv.indexOf('--years');
    const years = yearsArg === -1 ? 1 : Number(process.argv[yearsArg + 1]);
    const ttlMs = YEAR * years;

    const cache = createCache();
    const before = cache.stats();

    if (before.backend !== 'disk') {
        console.error(`Expected the disk cache but found "${before.backend}". Set CACHE_DIR.`);
        process.exit(1);
    }

    if (before.size === 0) {
        console.error(`No cache entries found in ${CACHE_DIR}. Run scripts/build-corpus.js first.`);
        process.exit(1);
    }

    console.log(`Freezing corpus at ${CACHE_DIR}`);
    console.log(`  entries: ${before.size.toLocaleString()}`);
    console.log(`  new expiry: ${years} year${years === 1 ? '' : 's'} from now\n`);

    const updated = cache.reExpire(ttlMs);

    // The manifest makes any recorded metric traceable to the exact corpus it was measured against.
    // A result without one cannot be trusted, because there is no way to know what it was measured on.
    const links = loadLinks();
    const popularity = loadPopularity();

    const manifest = {
        frozenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        dataset: 'ml-latest-small',
        cacheDir: path.relative(path.join(__dirname, '..'), CACHE_DIR),
        entries: updated,
        moviesWithTmdbId: links.toTmdb.size,
        moviesRated: popularity.size,
        note: 'Frozen for evaluation reproducibility. Refresh deliberately and re-record the baseline '
            + 'in the same commit — see docs/CORPUS.md.'
    };

    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`Froze ${updated.toLocaleString()} entries.`);
    console.log(`Manifest written to ${path.relative(process.cwd(), MANIFEST)}`);
    console.log(`\nExpires ${manifest.expiresAt.slice(0, 10)} — refresh before then, or re-run this script.`);
}

main();

#!/usr/bin/env node
/**
 * Builds the local TMDB corpus the evaluation harness runs against.
 *
 * Fetches details and keywords for every movie the harness will need and writes them through
 * lib/cache.js to disk, so eval runs never re-hit TMDB. This is the expensive step — roughly two
 * requests per movie — and it exists so that everything downstream is fast and repeatable.
 *
 * Usage:
 *   node scripts/build-corpus.js [--limit N] [--dataset ml-latest-small] [--candidates]
 *
 *   --limit N      Fetch only the N most-rated movies. Use for a quick staged validation before
 *                  committing to the full build.
 *   --candidates   Also fetch each movie's similar/recommendations lists. Needed to measure
 *                  candidate recall, but multiplies request count — see below.
 *
 * RESUMABLE: everything is written through the disk cache, so re-running skips whatever is already
 * stored. A build interrupted by Ctrl-C, a network drop, or sustained rate limiting can simply be
 * restarted. It is safe to run repeatedly.
 *
 * RATE LIMITS: TMDB removed its original 40-per-10-seconds limit in December 2019 and now applies a
 * soft ceiling around 40 requests/second, asking callers to respect a 429. lib/tmdb.js caps
 * concurrency well below that and backs off on 429, so this is a well-behaved client.
 */

const path = require('path');

// The corpus must persist, so force the disk cache before anything loads lib/tmdb.js (which creates
// its cache at require time). Without this the build would fill an in-memory cache and lose it all
// on exit.
process.env.CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');

// Freeze corpus entries for a year rather than using the ordinary 24-hour TTL.
//
// A corpus needs reproducibility, not freshness: if it silently expired and re-fetched, a baseline
// recorded earlier would no longer be comparable to a later run, because TMDB's data may have moved
// underneath it. Comparability is the whole point of a baseline. Refresh deliberately instead — see
// docs/CORPUS.md.
process.env.CACHE_TTL_MS = process.env.CACHE_TTL_MS || String(365 * 24 * 60 * 60 * 1000);

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getMovie, getKeywords, getSimilar, getRecommendations, mapWithLimit, cache } =
    require('../lib/tmdb');
const { loadPopularity, loadUserProfiles, isDownloaded } = require('../lib/movielens');

/**
 * Parses command-line flags.
 *
 * @returns {{limit: number|null, dataset: string, candidates: boolean}}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const get = flag => {
        const i = args.indexOf(flag);
        return i === -1 ? null : args[i + 1];
    };
    return {
        limit: get('--limit') ? Number(get('--limit')) : null,
        dataset: get('--dataset') || 'ml-latest-small',
        candidates: args.includes('--candidates')
    };
}

/**
 * Formats elapsed milliseconds as a human-readable duration.
 *
 * @param {number} ms
 * @returns {string}
 */
function duration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function main() {
    const { limit, dataset, candidates } = parseArgs();
    const started = Date.now();

    if (!isDownloaded(dataset)) {
        console.error(`Dataset "${dataset}" is not downloaded.`);
        console.error(`Run: node scripts/fetch-dataset.js ${dataset}`);
        process.exit(1);
    }

    if (!process.env.TMDB_API_KEY) {
        console.error('TMDB_API_KEY is not set. See .env.example.');
        process.exit(1);
    }

    console.log(`Corpus build — dataset ${dataset}`);
    console.log(`Cache: ${process.env.CACHE_DIR}\n`);

    // Order by popularity so a --limit run covers the films most likely to appear in eval samples and
    // candidate lists, rather than an arbitrary slice.
    const popularity = loadPopularity(dataset);
    const profiles = loadUserProfiles({ dataset });

    let movieIds = [...popularity.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tmdbId]) => tmdbId);

    console.log(`Movies with a TMDB id:      ${movieIds.length.toLocaleString()}`);
    console.log(`Users with >= 8 liked films: ${profiles.length.toLocaleString()}`);

    if (limit) {
        movieIds = movieIds.slice(0, limit);
        console.log(`\nStaged run: fetching the ${limit} most-rated movies only.`);
    }

    const perMovie = candidates ? 4 : 2;
    console.log(`\nPlanned: ${movieIds.length.toLocaleString()} movies x ${perMovie} requests`);
    console.log(`         ~${(movieIds.length * perMovie).toLocaleString()} requests (minus anything already cached)\n`);

    let failures = 0;
    let lastReport = 0;

    const results = await mapWithLimit(
        movieIds,
        async tmdbId => {
            const id = String(tmdbId);
            // Details and keywords are the two features the scoring model needs.
            await Promise.all([getMovie(id), getKeywords(id)]);
            if (candidates) {
                await Promise.all([getSimilar(id), getRecommendations(id)]);
            }
            return true;
        },
        {
            onProgress: (done, total) => {
                // Report every 100 completions, plus the final one.
                if (done - lastReport < 100 && done !== total) return;
                lastReport = done;
                const pct = ((done / total) * 100).toFixed(1);
                const stats = cache.stats();
                const elapsed = Date.now() - started;
                const rate = done / (elapsed / 1000);
                const remaining = rate > 0 ? duration(((total - done) / rate) * 1000) : '?';
                console.log(
                    `  ${String(done).padStart(6)}/${total} (${pct.padStart(5)}%) ` +
                    `| cache hit rate ${(stats.hitRate * 100).toFixed(0).padStart(3)}% ` +
                    `| elapsed ${duration(elapsed).padStart(7)} | eta ${remaining}`
                );
            }
        }
    );

    // A handful of MovieLens entries point at TMDB ids that have since been deleted or merged. That
    // is expected and must not fail the build — those films are simply excluded from evaluation.
    const failed = results.filter(r => r.error);
    failures = failed.length;

    const stats = cache.stats();
    console.log(`\n${'='.repeat(66)}`);
    console.log(`Corpus build complete in ${duration(Date.now() - started)}`);
    console.log(`  movies processed: ${results.length.toLocaleString()}`);
    console.log(`  succeeded:        ${(results.length - failures).toLocaleString()}`);
    console.log(`  failed:           ${failures.toLocaleString()} (missing/deleted TMDB entries)`);
    console.log(`  cache entries:    ${stats.size.toLocaleString()}`);
    console.log(`  requests served from cache: ${stats.hits.toLocaleString()}`);
    console.log(`  requests sent to TMDB:      ${stats.misses.toLocaleString()}`);
    console.log('='.repeat(66));

    if (failures > 0) {
        const sample = failed.slice(0, 5)
            .map(f => `    tmdb:${f.item} — ${f.error.message}`)
            .join('\n');
        console.log(`\nFirst few failures:\n${sample}`);
    }

    console.log('\nNext: node eval/harness.js --limit 200');
}

main().catch(error => {
    console.error('\nCorpus build failed:', error);
    process.exit(1);
});

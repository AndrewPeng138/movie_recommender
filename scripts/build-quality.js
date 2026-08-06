#!/usr/bin/env node
/**
 * Builds the quality artifact: per-film MovieLens ratings and award records.
 *
 * ## Why this is an artifact and not a runtime computation
 *
 * `ratings.csv` is gitignored — MovieLens is not redistributable and the file is large — so it does
 * not exist on Render. Reading it at request time works locally and fails in production, which is
 * exactly the class of bug that took this app down twice already (`express.static` and `dotenv` both
 * resolving against the wrong directory). Precomputing sidesteps it entirely: the server loads a
 * small JSON file and never touches the dataset.
 *
 * Awards come from Wikidata via SPARQL, queried once here rather than per request.
 *
 * Usage:
 *   node scripts/build-quality.js [--skip-awards]
 *
 * Output: data/quality.json (committed)
 */

const fs = require('fs');
const path = require('path');

const { loadMovieLensRatings } = require('../lib/quality');
const { loadLinks, isDownloaded } = require('../lib/movielens');

const OUT = path.join(__dirname, '..', 'data', 'quality.json');
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';

/**
 * Fetches award wins and nominations for films, keyed by TMDB id.
 *
 * Wikidata stores TMDB ids as property P4947, and award relationships as:
 *   - P166 (award received)      -> a win
 *   - P1411 (nominated for)      -> a nomination
 *
 * Queried in batches because a single query covering ~9,700 films times out. Failures are tolerated:
 * awards are an enhancement, and a missing batch simply means those films score 0 rather than
 * breaking the build.
 *
 * @param {number[]} tmdbIds
 * @returns {Promise<Map<number, {wins: number, nominations: number}>>}
 */
async function fetchAwards(tmdbIds) {
    const results = new Map();
    const BATCH = 400;
    let batches = 0;
    let failed = 0;

    for (let i = 0; i < tmdbIds.length; i += BATCH) {
        const slice = tmdbIds.slice(i, i + BATCH);
        const values = slice.map(id => `"${id}"`).join(' ');

        // COUNT is done in SPARQL rather than by returning every award row, which keeps responses
        // small and well inside Wikidata's result limits.
        const query = `
SELECT ?tmdb (COUNT(DISTINCT ?win) AS ?wins) (COUNT(DISTINCT ?nom) AS ?noms) WHERE {
  VALUES ?tmdb { ${values} }
  ?film wdt:P4947 ?tmdb .
  OPTIONAL { ?film wdt:P166 ?win . }
  OPTIONAL { ?film wdt:P1411 ?nom . }
}
GROUP BY ?tmdb`.trim();

        batches++;
        process.stdout.write(`  batch ${batches} (${slice.length} films)... `);

        try {
            const response = await fetch(
                `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`,
                {
                    headers: {
                        // Wikidata requires a descriptive User-Agent and will reject generic ones.
                        'User-Agent': 'movie-recommender/1.0 (personal project; awards enrichment)',
                        Accept: 'application/sparql-results+json'
                    }
                }
            );

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const body = await response.json();
            let found = 0;
            for (const row of body.results.bindings) {
                const tmdbId = Number(row.tmdb.value);
                const wins = Number(row.wins?.value || 0);
                const nominations = Number(row.noms?.value || 0);
                if (wins === 0 && nominations === 0) continue;
                results.set(tmdbId, { wins, nominations });
                found++;
            }
            console.log(`${found} with awards`);
        } catch (error) {
            failed++;
            console.log(`FAILED (${error.message})`);
        }

        // Wikidata asks clients to be gentle; this is well within their guidance.
        await new Promise(r => setTimeout(r, 1200));
    }

    if (failed > 0) {
        console.log(`\n  WARNING: ${failed} of ${batches} batches failed. Those films score 0 awards.`);
    }

    return results;
}

async function main() {
    const skipAwards = process.argv.includes('--skip-awards');

    if (!isDownloaded()) {
        console.error('MovieLens data missing. Run: node scripts/fetch-dataset.js');
        process.exit(1);
    }

    console.log('Building quality artifact\n');

    // --- MovieLens ratings ------------------------------------------------------------------------
    // NOTE: no users are excluded here. This artifact serves *production*, where there is no
    // "evaluated user" to leak. The evaluation harness recomputes these itself with the appropriate
    // exclusions -- see lib/quality.js loadMovieLensRatings().
    const { byTmdbId, corpusMean } = loadMovieLensRatings();
    console.log(`MovieLens ratings: ${byTmdbId.size.toLocaleString()} films, corpus mean ${corpusMean.toFixed(3)}`);

    const movielens = {};
    for (const [tmdbId, { mean, count }] of byTmdbId) {
        movielens[tmdbId] = [Number(mean.toFixed(3)), count];
    }

    // --- Awards -----------------------------------------------------------------------------------
    let awards = {};
    let awardCount = 0;

    if (skipAwards) {
        console.log('\nSkipping awards (--skip-awards).');
    } else {
        const ids = [...byTmdbId.keys()];
        console.log(`\nFetching awards from Wikidata for ${ids.length.toLocaleString()} films...`);
        const fetched = await fetchAwards(ids);
        for (const [tmdbId, record] of fetched) {
            awards[tmdbId] = record;
        }
        awardCount = fetched.size;
    }

    const artifact = {
        builtAt: new Date().toISOString(),
        dataset: 'ml-latest-small',
        movieLensCorpusMean: Number(corpusMean.toFixed(4)),
        filmsWithRatings: byTmdbId.size,
        filmsWithAwards: awardCount,
        note: 'Derived aggregates from MovieLens (GroupLens Research) and Wikidata. '
            + 'Rebuild with scripts/build-quality.js and re-record the baseline in the same commit.',
        // [mean, count] pairs keep the file compact versus named objects.
        movielens,
        awards
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(artifact)}\n`);

    const bytes = fs.statSync(OUT).size;
    console.log(`\n${'='.repeat(58)}`);
    console.log(`Quality artifact written to ${path.relative(process.cwd(), OUT)}`);
    console.log(`  films with MovieLens ratings: ${byTmdbId.size.toLocaleString()}`);
    console.log(`  films with award records:     ${awardCount.toLocaleString()}`);
    console.log(`  size:                         ${(bytes / 1024).toFixed(0)} KB`);
    console.log('='.repeat(58));

    if (awardCount > 0) {
        const top = Object.entries(awards)
            .sort((a, b) => (b[1].wins + b[1].nominations) - (a[1].wins + a[1].nominations))
            .slice(0, 5);
        const { toMovieLens } = loadLinks();
        console.log('\nMost-awarded films found:');
        for (const [tmdbId, rec] of top) {
            console.log(`  tmdb:${String(tmdbId).padEnd(7)} ${rec.wins} wins, ${rec.nominations} nominations`
                + (toMovieLens.has(Number(tmdbId)) ? '' : ' (not in MovieLens)'));
        }
    }
}

main().catch(error => {
    console.error('\nQuality build failed:', error);
    process.exit(1);
});

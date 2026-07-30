#!/usr/bin/env node
/**
 * Downloads and extracts a MovieLens dataset.
 *
 * Usage:
 *   node scripts/fetch-dataset.js [dataset]
 *
 *   dataset  ml-latest-small (default) | ml-25m
 *
 * The data is written to data/movielens/<dataset>/ and is gitignored — MovieLens is licensed for
 * research and personal use and may not be redistributed, so it is downloaded rather than committed.
 * The running app never reads it; this is evaluation tooling only.
 *
 * @see https://grouplens.org/datasets/movielens/
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { DATA_DIR, datasetDir, isDownloaded } = require('../lib/movielens');

const DATASETS = {
    'ml-latest-small': {
        url: 'https://files.grouplens.org/datasets/movielens/ml-latest-small.zip',
        note: '100,836 ratings from 610 users across 9,742 movies (~1 MB)'
    },
    'ml-25m': {
        url: 'https://files.grouplens.org/datasets/movielens/ml-25m.zip',
        note: '25 million ratings across 62,000 movies (~250 MB)'
    }
};

async function main() {
    const dataset = process.argv[2] || 'ml-latest-small';
    const spec = DATASETS[dataset];

    if (!spec) {
        console.error(`Unknown dataset "${dataset}". Options: ${Object.keys(DATASETS).join(', ')}`);
        process.exit(1);
    }

    if (isDownloaded(dataset)) {
        console.log(`${dataset} is already present at ${datasetDir(dataset)} — nothing to do.`);
        return;
    }

    console.log(`Downloading ${dataset} — ${spec.note}`);
    console.log(`  from ${spec.url}`);

    const response = await fetch(spec.url);
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`  downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

    fs.mkdirSync(DATA_DIR, { recursive: true });

    // The archive already contains a top-level <dataset>/ directory, so extract into DATA_DIR rather
    // than into datasetDir() or the path would be doubled.
    new AdmZip(buffer).extractAllTo(DATA_DIR, true);

    const dir = datasetDir(dataset);
    if (!isDownloaded(dataset)) {
        throw new Error(`Extraction finished but expected files are missing in ${dir}`);
    }

    console.log(`\nExtracted to ${dir}`);
    for (const file of fs.readdirSync(dir)) {
        const size = fs.statSync(path.join(dir, file)).size;
        console.log(`  ${file.padEnd(16)} ${(size / 1024).toFixed(0).padStart(7)} KB`);
    }

    console.log('\nNext: node scripts/build-corpus.js');
}

main().catch(error => {
    console.error('\nDataset download failed:', error.message);
    process.exit(1);
});

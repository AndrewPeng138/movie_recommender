/**
 * Cache tests — TTL expiry, LRU eviction, and the disk backend the corpus build depends on.
 *
 * Two properties matter more than the rest, because production depends on them and neither is
 * visible from reading the code:
 *
 * - **The memory cap actually holds.** Render's free instance has 512 MB. An LRU whose eviction is
 *   subtly wrong grows without bound and the process is killed, which looks like a random outage
 *   rather than a cache bug. Hence the 5,000-insert test.
 * - **A failed fetch is never cached.** Caching an error would turn one TMDB blip into a
 *   TTL-length outage for that key.
 *
 * The disk backend is exercised too, even though production never uses it: the evaluation corpus is
 * built through it, and a corrupt shard silently reading as a crash rather than a miss would take
 * down a ten-minute build near its end.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { createCache, MemoryStore, DiskStore, Cache } = require('../lib/cache');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Scratch directory for the disk-backend tests, removed at the end of each that creates one. */
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));

test('memory store: stores and retrieves', () => {
    const mem = new MemoryStore(3);
    mem.set('a', { v: 1 }, 10_000);

    assert.equal(mem.get('a').v, 1);
    assert.equal(mem.get('nope'), undefined, 'a missing key should be undefined');
});

test('memory store: entries expire and are removed', async () => {
    const mem = new MemoryStore(3);
    mem.set('short', 'x', 50);
    assert.equal(mem.get('short'), 'x', 'should be present before expiry');

    await sleep(80);

    assert.equal(mem.get('short'), undefined, 'should be gone after expiry');
    // Reading an expired entry must delete it. Leaving it in the map means expired keys still count
    // toward the cap and still occupy memory — an expiring cache that never shrinks.
    assert.equal(mem.map.has('short'), false, 'expired entry should be dropped from the map');
});

test('memory store: evicts the least recently used at the cap', () => {
    const lru = new MemoryStore(3);
    lru.set('k1', 1, 10_000);
    lru.set('k2', 2, 10_000);
    lru.set('k3', 3, 10_000);
    assert.equal(lru.size(), 3);

    lru.get('k1');                 // touch k1, making k2 the least recently used
    lru.set('k4', 4, 10_000);      // forces exactly one eviction

    assert.equal(lru.size(), 3, 'size should stay at the cap');
    assert.equal(lru.get('k1'), 1, 'the recently-used entry should survive');
    assert.equal(lru.get('k2'), undefined, 'the least-recently-used entry should be evicted');
    assert.equal(lru.get('k3'), 3);
    assert.equal(lru.get('k4'), 4);
});

test('memory store: the cap holds under heavy insertion', () => {
    // This is the one that stands between the cache and an OOM kill on a 512 MB instance.
    const big = new MemoryStore(50);
    for (let i = 0; i < 5000; i++) {
        big.set(`key${i}`, { padding: 'x'.repeat(100) }, 10_000);
    }

    assert.equal(big.size(), 50, `size should never exceed the cap, got ${big.size()}`);
});

test('disk store: writes, shards, and leaves no temp files', () => {
    const dir = tmpDir();
    try {
        const disk = new DiskStore(dir);
        disk.set('movie/27205', { title: 'Inception' }, 10_000);

        assert.equal(disk.get('movie/27205').title, 'Inception');
        // Sharded into two-character subdirectories: a flat directory of ~19,000 corpus entries is
        // slow to enumerate on most filesystems.
        assert.ok(fs.readdirSync(dir).some(f => f.length === 2), 'entries should be sharded');
        // Writes go to a .tmp file and are renamed, so a crash mid-write cannot leave a half-written
        // shard that later reads as corrupt.
        assert.ok(!fs.readdirSync(dir, { recursive: true }).some(f => String(f).endsWith('.tmp')),
            'a .tmp file was left behind');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('disk store: data survives a new instance', () => {
    // The entire point of the disk backend — a corpus build must be resumable after an interruption.
    const dir = tmpDir();
    try {
        new DiskStore(dir).set('movie/27205', { title: 'Inception' }, 10_000);

        const reopened = new DiskStore(dir);
        assert.equal(reopened.get('movie/27205').title, 'Inception');
        assert.equal(reopened.size(), 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('disk store: a corrupt shard reads as a miss, not a crash', () => {
    const dir = tmpDir();
    try {
        const disk = new DiskStore(dir);
        disk.set('corrupt', { a: 1 }, 10_000);
        fs.writeFileSync(disk.pathFor('corrupt'), '{ this is not json');

        // Must not throw: a corpus build is ~19,000 requests over ten minutes, and one bad shard
        // taking the whole run down near the end is far worse than re-fetching that one entry.
        assert.equal(disk.get('corrupt'), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('backend is chosen by CACHE_DIR', () => {
    const dir = tmpDir();
    const original = process.env.CACHE_DIR;
    try {
        delete process.env.CACHE_DIR;
        assert.equal(createCache().stats().backend, 'memory',
            'production must get the memory backend — Render\'s filesystem is ephemeral');

        assert.equal(createCache({ dir: path.join(dir, 'sel') }).stats().backend, 'disk',
            'local dev and the corpus build get the disk backend');
    } finally {
        if (original === undefined) delete process.env.CACHE_DIR;
        else process.env.CACHE_DIR = original;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('wrap: the producer runs once, then results are served from cache', async () => {
    const cache = new Cache(new MemoryStore(10));
    let calls = 0;
    const produce = async () => { calls++; return 'value'; };

    await cache.wrap('k', 10_000, produce);
    await cache.wrap('k', 10_000, produce);
    await cache.wrap('k', 10_000, produce);

    assert.equal(calls, 1, `producer should run once, ran ${calls} times`);
    assert.equal(cache.stats().hits, 2);
    assert.equal(cache.stats().misses, 1);
});

test('wrap: failures are never cached', async () => {
    // Caching a rejection would convert a momentary TMDB failure into a TTL-length outage for that
    // key — the cache would keep serving the error long after upstream recovered.
    const cache = new Cache(new MemoryStore(10));
    let attempts = 0;
    const failing = async () => { attempts++; throw new Error('upstream down'); };

    for (let i = 0; i < 3; i++) {
        await assert.rejects(() => cache.wrap('bad', 10_000, failing));
    }

    assert.equal(attempts, 3, 'every call should retry rather than serve a cached error');
    assert.equal(cache.stats().size, 0, 'nothing should be stored for a failed produce');
});

/**
 * TTL cache with pluggable storage.
 *
 * Two consumers with genuinely different needs share this module:
 *
 *   1. **The live server (Render).** The free tier has an *ephemeral* filesystem and spins down when
 *      idle, so nothing written at runtime survives a restart or deploy. Writing cache files there
 *      would be pure overhead. Production therefore uses the in-memory store, which still pays for
 *      itself within a warm window — a single recommendation run reuses many of the same candidate
 *      movies across the user's picks, and re-running after tweaking a pick reuses nearly all of them.
 *
 *   2. **The offline corpus build and evaluation harness (Phase 2).** These run locally and *must*
 *      persist: rebuilding the corpus means thousands of TMDB requests, which cannot be repeated on
 *      every eval run. They use the disk store.
 *
 * Both get the same interface, so calling code never knows which is active.
 *
 * @module lib/cache
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** One hour in milliseconds. */
const HOUR = 60 * 60 * 1000;
/** One day in milliseconds. */
const DAY = 24 * HOUR;

/**
 * Default entry ceiling for the in-memory store.
 *
 * Render's free instance has 512 MB. A TMDB movie-details payload with credits is roughly 10-25 KB
 * as parsed JSON, so 1000 entries is on the order of 10-25 MB — comfortably clear of the limit while
 * still covering several full recommendation runs.
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * In-memory LRU store.
 *
 * Uses a Map for its guaranteed insertion order: re-inserting on read moves an entry to the end, so
 * the oldest key is always first and eviction is O(1).
 */
class MemoryStore {
    /** @param {number} maxEntries - Hard ceiling on stored entries. */
    constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
        this.maxEntries = maxEntries;
        /** @type {Map<string, {value: unknown, expiresAt: number}>} */
        this.map = new Map();
    }

    /**
     * @param {string} key
     * @returns {unknown|undefined} The cached value, or undefined if absent or expired.
     */
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiresAt) {
            this.map.delete(key);
            return undefined;
        }

        // Mark as recently used by reinserting at the end.
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    /**
     * @param {string} key
     * @param {unknown} value
     * @param {number} ttlMs - Lifetime in milliseconds.
     */
    set(key, value, ttlMs) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, expiresAt: Date.now() + ttlMs });

        // Evict oldest entries until back within the cap.
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }

    /** @returns {number} Current entry count. */
    size() {
        return this.map.size;
    }

    /** Removes every entry. */
    clear() {
        this.map.clear();
    }
}

/**
 * Disk-backed store, one JSON file per key.
 *
 * Intended for local development and the offline corpus build, never for Render. Keys are hashed
 * because they contain characters (`/`, `?`, `&`) that are not valid in filenames, and are sharded
 * into subdirectories so no single directory holds tens of thousands of files.
 */
class DiskStore {
    /** @param {string} dir - Root directory for cache files. */
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(this.dir, { recursive: true });
    }

    /**
     * Maps a cache key to a sharded file path.
     *
     * @param {string} key
     * @returns {string} Absolute path to the entry's JSON file.
     */
    pathFor(key) {
        const hash = crypto.createHash('sha1').update(key).digest('hex');
        // Two-character shard prefix keeps directory sizes manageable (256 buckets).
        return path.join(this.dir, hash.slice(0, 2), `${hash}.json`);
    }

    /**
     * @param {string} key
     * @returns {unknown|undefined} The cached value, or undefined if absent, expired, or corrupt.
     */
    get(key) {
        const file = this.pathFor(key);
        try {
            const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Date.now() > entry.expiresAt) {
                fs.unlinkSync(file);
                return undefined;
            }
            return entry.value;
        } catch {
            // Missing file, or a partial write from an interrupted corpus build. Treat as a miss —
            // the caller will refetch and overwrite it.
            return undefined;
        }
    }

    /**
     * @param {string} key
     * @param {unknown} value
     * @param {number} ttlMs - Lifetime in milliseconds.
     */
    set(key, value, ttlMs) {
        const file = this.pathFor(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });

        // Write to a temp file and rename, so an interrupted corpus build cannot leave a half-written
        // JSON file that later reads would have to treat as corrupt.
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }));
        fs.renameSync(tmp, file);
    }

    /** @returns {number} Approximate entry count (counts files across shards). */
    size() {
        try {
            return fs.readdirSync(this.dir)
                .reduce((total, shard) => {
                    const shardPath = path.join(this.dir, shard);
                    if (!fs.statSync(shardPath).isDirectory()) return total;
                    return total + fs.readdirSync(shardPath).filter(f => f.endsWith('.json')).length;
                }, 0);
        } catch {
            return 0;
        }
    }

    /** Removes every entry. */
    clear() {
        fs.rmSync(this.dir, { recursive: true, force: true });
        fs.mkdirSync(this.dir, { recursive: true });
    }
}

/**
 * A TTL cache over one of the stores above, with hit/miss accounting.
 */
class Cache {
    /** @param {MemoryStore|DiskStore} store */
    constructor(store) {
        this.store = store;
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * Returns the cached value for `key`, or computes and stores it.
     *
     * Note this deliberately does *not* deduplicate concurrent in-flight calls for the same key: two
     * simultaneous misses both fetch. That is acceptable here because the fetches are idempotent GETs
     * and the second simply overwrites with identical data.
     *
     * @template T
     * @param {string} key - Cache key.
     * @param {number} ttlMs - Lifetime for a newly stored value.
     * @param {() => Promise<T>} produce - Called only on a miss.
     * @returns {Promise<T>}
     */
    async wrap(key, ttlMs, produce) {
        const cached = this.store.get(key);
        if (cached !== undefined) {
            this.hits++;
            return cached;
        }

        this.misses++;
        const value = await produce();
        // Only cache successful results; `produce` throws on failure, so reaching here means success.
        this.store.set(key, value, ttlMs);
        return value;
    }

    /**
     * @returns {{hits: number, misses: number, size: number, hitRate: number, backend: string}}
     *   Snapshot of cache activity, surfaced by the /api/health endpoint.
     */
    stats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            size: this.store.size(),
            hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
            backend: this.store instanceof DiskStore ? 'disk' : 'memory'
        };
    }

    /** Empties the cache and resets counters. Used by tests. */
    clear() {
        this.store.clear();
        this.hits = 0;
        this.misses = 0;
    }
}

/**
 * Builds a cache using the backend appropriate to the environment.
 *
 * Selection rule: set `CACHE_DIR` to use the disk store (local development, the corpus build, and the
 * eval harness). Leave it unset — as on Render — to use memory. This is why the live server needs no
 * new configuration to deploy safely.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - Overrides `CACHE_DIR`.
 * @param {number} [options.maxEntries] - Overrides the in-memory entry cap.
 * @returns {Cache}
 */
function createCache({ dir = process.env.CACHE_DIR, maxEntries } = {}) {
    if (dir) return new Cache(new DiskStore(dir));

    const cap = maxEntries
        || (process.env.CACHE_MAX_ENTRIES && Number(process.env.CACHE_MAX_ENTRIES))
        || DEFAULT_MAX_ENTRIES;

    return new Cache(new MemoryStore(cap));
}

module.exports = { createCache, Cache, MemoryStore, DiskStore, HOUR, DAY };

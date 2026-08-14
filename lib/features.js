/**
 * Content feature extraction and TF-IDF vectors.
 *
 * ## Why this replaces hand-tuned weights
 *
 * The shipped model assigns fixed points per factor — genre overlap is worth up to 15, a shared
 * director 15, and so on. Those numbers were chosen by trial and error, and they treat every feature
 * within a category as equally informative: two films both being "Drama" scores exactly as much as
 * two films both being "Film-Noir", even though ~4,000 films are Dramas and a few dozen are Film-Noir.
 *
 * TF-IDF removes the need to choose weights at all. A feature's importance is `log(N / df)` — how
 * rare it is in the corpus. Sharing "Drama" is automatically near-worthless; sharing an obscure
 * keyword is automatically strong. **The weights are not invented, they fall out of the data.**
 *
 * ## Namespacing
 *
 * Feature keys are prefixed by type (`g:` genre, `k:` keyword, `c:` cast, ...) so that a genre id and
 * a person id with the same numeric value cannot collide.
 *
 * ## What is deliberately excluded
 *
 * Production company and `belongs_to_collection` are *not* features. They would make sequels and
 * studio output look maximally similar to each other, amplifying franchise flooding — the exact
 * problem MMR is meant to solve. Collection data is still used for diversity, just not for similarity.
 *
 * @module lib/features
 */

/** Cast members retained per film, in billing order. */
const CAST_LIMIT = 10;

/** Crew jobs treated as writing credits. */
const WRITING_JOBS = new Set(['Writer', 'Screenplay', 'Story', 'Author', 'Novel']);

/**
 * Capitalises the first letter, leaving the rest alone.
 *
 * The rest is left alone deliberately: lowercasing would destroy "Lord of the Rings" inside a
 * keyword, and title-casing would mangle ordinary phrases.
 *
 * @param {string} text
 * @returns {string}
 */
function sentenceCase(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Resolves ISO 639-1 codes to English names. Built once — construction is the expensive part. */
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * Names a language from its ISO 639-1 code.
 *
 * TMDB's `original_language` is community-entered and occasionally carries a code Intl does not
 * recognise, which throws rather than returning undefined — hence the fallback to the raw code.
 *
 * @param {string} code - e.g. "fr".
 * @returns {string} e.g. "French".
 */
function languageName(code) {
    try {
        return LANGUAGE_NAMES.of(code) || code;
    } catch {
        return code;
    }
}

/**
 * Extracts a film's content features.
 *
 * Every feature carries weight 1.0. Within-film importance (a lead actor mattering more than the
 * tenth-billed) is deliberately *not* encoded here — that would be another invented weight, which is
 * what this module exists to remove. If billing-order decay turns out to help, the harness can prove
 * it and it can be added as a measured hyperparameter.
 *
 * @param {object} details - TMDB movie details including `credits`.
 * @param {object} [keywords] - Response from the keywords endpoint: `{ keywords: [{id, name}] }`.
 * @returns {{weights: Map<string, number>, labels: Map<string, string>}} Sparse feature weights, plus
 *   human-readable labels used to explain a recommendation.
 */
function extractFeatures(details, keywords) {
    const weights = new Map();
    const labels = new Map();

    const add = (key, label) => {
        weights.set(key, 1);
        labels.set(key, label);
    };

    for (const genre of details.genres || []) {
        add(`g:${genre.id}`, genre.name);
    }

    for (const keyword of keywords?.keywords || []) {
        // TMDB stores keywords lowercase ("based on novel or book"), which reads as unfinished next
        // to genres and names that are already cased. Sentence case, not title case: "Based On Novel
        // Or Book" is worse than what it replaces.
        add(`k:${keyword.id}`, sentenceCase(keyword.name));
    }

    // Billing order is TMDB's own ordering; slicing keeps the principal cast and drops extras, whose
    // presence says little about what a film is.
    for (const person of (details.credits?.cast || []).slice(0, CAST_LIMIT)) {
        add(`c:${person.id}`, person.name);
    }

    for (const person of details.credits?.crew || []) {
        if (person.job === 'Director') add(`d:${person.id}`, person.name);
        else if (WRITING_JOBS.has(person.job)) add(`w:${person.id}`, person.name);
    }

    // Decade rather than year: exact-year matching is far too sparse to be informative, while a
    // decade captures the era signal the previous model approximated with a proximity table.
    const year = details.release_date ? parseInt(details.release_date.substring(0, 4), 10) : 0;
    if (year) {
        const decade = Math.floor(year / 10) * 10;
        add(`dec:${decade}`, `${decade}s`);
    }

    if (details.original_language) {
        // The label is the language's name, not its ISO code — the explanation panel renders it under
        // a "Language" heading, where "language: fr" would read as a stutter and a code at that.
        add(`lang:${details.original_language}`, languageName(details.original_language));
    }

    return { weights, labels };
}

/**
 * Computes inverse document frequency over a corpus.
 *
 * Uses the smoothed form `ln((1 + N) / (1 + df)) + 1`, which is always positive — the unsmoothed
 * `log(N / df)` yields zero for a feature present in every film and would silently delete it, and it
 * divides by zero for an unseen feature.
 *
 * MUST be computed over a fixed corpus, never over a request's ~300-item candidate pool: document
 * frequency measured across 300 films is noise, and would make weights vary per request.
 *
 * @param {Iterable<Map<string, number>>} documents - Feature maps, one per film.
 * @returns {{idf: Object<string, number>, documentCount: number}} Serialisable IDF table.
 */
function computeIdf(documents) {
    const df = new Map();
    let documentCount = 0;

    for (const features of documents) {
        documentCount++;
        for (const key of features.keys()) {
            df.set(key, (df.get(key) || 0) + 1);
        }
    }

    const idf = {};
    for (const [key, count] of df) {
        idf[key] = Number((Math.log((1 + documentCount) / (1 + count)) + 1).toFixed(6));
    }

    return { idf, documentCount };
}

/**
 * Builds an L2-normalised TF-IDF vector.
 *
 * Normalising is what makes cosine similarity meaningful: without it a film with 40 keywords would
 * score higher against everything than one with 8, purely for having more features. After
 * normalisation, similarity measures *direction* — what a film is about — rather than magnitude.
 *
 * @param {Map<string, number>} weights - Raw feature weights from {@link extractFeatures}.
 * @param {Object<string, number>} idf - IDF table.
 * @param {number} [defaultIdf] - Weight for features absent from the table. Unseen features are rare
 *   by definition, so they take the highest plausible weight rather than being discarded.
 * @returns {Map<string, number>} Normalised vector; empty if the film has no usable features.
 */
function buildVector(weights, idf, defaultIdf = 8) {
    const vector = new Map();
    let sumSquares = 0;

    for (const [key, tf] of weights) {
        const value = tf * (idf[key] ?? defaultIdf);
        vector.set(key, value);
        sumSquares += value * value;
    }

    if (sumSquares === 0) return vector;

    const norm = Math.sqrt(sumSquares);
    for (const [key, value] of vector) {
        vector.set(key, value / norm);
    }

    return vector;
}

/**
 * Cosine similarity between two L2-normalised vectors.
 *
 * Both being unit length, cosine reduces to the dot product. Iterating the smaller vector keeps this
 * proportional to the smaller feature count, which matters when scoring ~300 candidates against up to
 * 10 picks on every request.
 *
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number} Between 0 and 1 for non-negative vectors.
 */
function cosine(a, b) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [key, value] of small) {
        const other = large.get(key);
        if (other !== undefined) dot += value * other;
    }
    return dot;
}

/**
 * Returns the features contributing most to a similarity score.
 *
 * This is what preserves the app's best feature — telling the user *why* a film was recommended. It
 * is strictly more informative than the previous fixed five categories, because it names the specific
 * genre, keyword, or person responsible rather than reporting "Genres +10".
 *
 * Cosine decomposes exactly: the score is the sum of per-feature products, so each term's share of
 * the total is directly interpretable rather than an approximation.
 *
 * @param {Map<string, number>} a - Candidate vector.
 * @param {Map<string, number>} b - Reference vector.
 * @param {Map<string, string>} labels - Feature key to display name.
 * @param {number} [limit] - Maximum contributions to return.
 * @returns {Array<{key: string, label: string, type: string, contribution: number}>} Strongest first.
 */
function explain(a, b, labels, limit = 5) {
    const contributions = [];
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    for (const [key, value] of small) {
        const other = large.get(key);
        if (other === undefined) continue;
        contributions.push({
            key,
            label: labels.get(key) || key,
            type: key.slice(0, key.indexOf(':')),
            contribution: value * other
        });
    }

    return contributions
        .sort((x, y) => y.contribution - x.contribution)
        .slice(0, limit);
}

module.exports = {
    CAST_LIMIT,
    WRITING_JOBS,
    extractFeatures,
    computeIdf,
    buildVector,
    cosine,
    explain
};

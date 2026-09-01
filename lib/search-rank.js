/**
 * Search result re-ranking.
 *
 * TMDB's `/search/movie` orders by its `popularity` field, which is a *trending* metric — how much
 * attention a title is getting right now, not how well known it is. That buries recognisable films
 * behind obscure ones that happen to be moving. Measured against the live API for the query "la la":
 *
 *   #1  The Hanged Woman        28 votes
 *   #5  (an unrelated title)     0 votes
 *   #10 La La Land          18,384 votes
 *
 * `vote_count` is the field that tracks "would a user recognise this", so it is what this module
 * sorts by — but never on its own. Two failure modes have to be avoided at once, and they pull in
 * opposite directions:
 *
 *   1. **Votes alone** puts a blockbuster above an exact title match for an obscure film. Searching
 *      "the hanged woman" must return The Hanged Woman (46 votes), not whatever popular film shares
 *      a word with it.
 *   2. **Match quality alone** puts a 2-vote film above the franchise. Measured: ranking by tier
 *      first put Fast and Furious (1927, 2 votes) above The Fast and the Furious, because the
 *      obscure film's title matched exactly and the famous one's did not.
 *
 * So the score adds a match bonus to `log10` of the vote count. The log is what balances them: it
 * treats 46 votes versus 20,000 as a difference of about 2.6 points rather than 20,000, which keeps
 * a genuine exact match ahead of a merely-popular near-match while still letting a large enough
 * popularity gap overcome a weaker match.
 *
 * ## Measured
 *
 * 150 films sampled from MovieLens by rating count (seed 42), four query mutations each, 600 queries
 * total. Titles come from MovieLens rather than TMDB, so the ranker is not scored against the very
 * strings it matches on. Both orderings score the same payload, so the only variable is this file.
 *
 * | mutation | example | right film first, before | after |
 * |---|---|---|---|
 * | as typed | `the godfather` | 94.7% | **99.3%** |
 * | article dropped | `godfather` | 92.7% | **99.3%** |
 * | punctuation dropped | `amelie` | 94.0% | **99.3%** |
 * | spacing dropped | `lalaland` | 22.7% | 28.0% |
 * | **all** | | **76.0%** | **81.5%** |
 *
 * Paired difference in reciprocal rank: **+0.0317 ±0.0115**, which excludes zero. Paired rather than
 * two independent intervals because both numbers score the same query — treating them as independent
 * throws away the pairing and understates the evidence.
 *
 * 36 queries moved up, 3 moved down. All three are the same query: two films share the exact title
 * *Ghost in the Shell*, and the ranker prefers the 2017 remake (8,694 votes) to the 1995 anime
 * (4,013). Title text alone cannot decide that; both are in the top two either way.
 *
 * ## What this cannot fix
 *
 * TMDB returns nothing relevant for `lalaland`, `lal`, `seven` (the film is Se7en), or `wall e` —
 * and for **72% of spacing-dropped queries** in the sample above. **No ranking function can reorder
 * a result that was never in the payload.** That needs a local title index, tracked as A1 Step 2.
 */

/** Match quality bonuses, added to log10(votes). Calibrated against the measured cases above. */
const MATCH_BONUS = {
    /** Normalised title is exactly the query. */
    EXACT: 4,
    /** Every query word appears in the title — catches interior words the query omits. */
    ALL_WORDS: 2.5,
    /** Title begins with the query, e.g. "la la" -> La La Land. */
    PREFIX: 2,
    /** Query appears somewhere in the title. */
    SUBSTRING: 1,
    /** No title match; TMDB returned it for some other reason. */
    NONE: 0
};

/**
 * Reduces a title to a comparable key: letters and digits only, lowercased.
 *
 * Three transformations happen before the strip, each because dropping it measurably broke a real
 * query. A first version did only the strip, and against the live API it pushed six well-known films
 * *down* the list — TMDB had them at #1 and the re-rank buried them:
 *
 * | typed | title | without the fix | why |
 * |---|---|---|---|
 * | `godfather` | The Godfather | #1 -> #5 | "thegodfather" only *contains* the query, so obscure films literally titled "Godfather" outranked it |
 * | `amelie` | Amélie | #1 -> #12 | stripping non-ASCII deleted the é outright, giving "amlie" |
 * | `fast and furious` | Fast & Furious | #1 -> #13 | "&" and the word "and" produced different keys |
 *
 * Order matters: accents come off before the strip would delete them, and the leading article is
 * removed while word boundaries still exist.
 *
 * @param {string} text - Raw title or query.
 * @returns {string} e.g. "The Godfather" -> "godfather", "Amélie" -> "amelie".
 */
function normalise(text) {
    return (text || '')
        // Decompose "é" into "e" + combining accent, then drop the accent, so the letter survives
        // the alphanumeric strip below instead of vanishing with it.
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        // Leading articles are the single most common thing a user omits. Removed from titles and
        // queries alike, so "godfather" and "The Godfather" meet in the middle.
        .replace(/^(?:the|a|an)\s+/, '')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Splits text into normalised words.
 *
 * Word-level matching is what rescues titles carrying a word the user left out. "The Fast and the
 * Furious" has an interior "the" that breaks any comparison of the concatenated forms, but every
 * word of "fast and furious" is present, which is the signal that matters.
 *
 * @param {string} text - Raw title or query.
 * @returns {string[]} Normalised words, empties removed.
 */
function words(text) {
    return (text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Scores how well a title matches the query. Higher is better.
 *
 * @param {object} movie - TMDB search result; `title` and `vote_count` are read.
 * @param {string} nQuery - Query passed through normalise().
 * @param {string[]} qWords - Query passed through words().
 * @returns {number} Match bonus plus log10 of the vote count.
 */
function scoreResult(movie, nQuery, qWords) {
    const nTitle = normalise(movie.title);
    const titleWords = new Set(words(movie.title));

    let bonus = MATCH_BONUS.NONE;
    if (nTitle && nQuery) {
        if (nTitle === nQuery) bonus = MATCH_BONUS.EXACT;
        else if (qWords.length > 0 && qWords.every(w => titleWords.has(w))) bonus = MATCH_BONUS.ALL_WORDS;
        else if (nTitle.startsWith(nQuery)) bonus = MATCH_BONUS.PREFIX;
        else if (nTitle.includes(nQuery)) bonus = MATCH_BONUS.SUBSTRING;
    }

    // +1 so a film with zero votes scores 0 here rather than -Infinity, which would make every
    // unrated film indistinguishable regardless of how well its title matched.
    return bonus + Math.log10(1 + (movie.vote_count || 0));
}

/**
 * Re-orders TMDB search results so recognisable titles surface first.
 *
 * Nothing is added or removed — this is a pure reordering, so a result TMDB did not return still
 * cannot appear.
 *
 * The sort is total (id breaks remaining ties), which keeps the order stable for identical inputs.
 * An unstable order would make the same query return different results across cache misses.
 *
 * @param {Array<object>} results - TMDB search results.
 * @param {string} query - The user's raw search text.
 * @returns {Array<object>} A new array, best match first.
 */
function rankSearchResults(results, query) {
    if (!Array.isArray(results)) return [];

    const nQuery = normalise(query);
    const qWords = words(query);
    if (!nQuery) return [...results];

    const scored = new Map(results.map(m => [m, scoreResult(m, nQuery, qWords)]));

    return [...results].sort((a, b) =>
        scored.get(b) - scored.get(a) ||
        (a.id || 0) - (b.id || 0));
}

module.exports = { rankSearchResults, normalise, words, scoreResult, MATCH_BONUS };

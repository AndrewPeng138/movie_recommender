/**
 * Search re-ranking tests.
 *
 * The fixtures are real measurements, not invented numbers. Querying "la la" against the live API
 * returned The Hanged Woman first on 28 votes and La La Land tenth on 18,384 — TMDB orders by a
 * trending metric, which is not the same thing as "would a user recognise this".
 *
 * Two properties are being protected, and they pull against each other:
 *
 *   1. A well-known film must not sit behind an obscure one that merely trends.
 *   2. An exact title match must win *even when the film is obscure* — searching "the hanged woman"
 *      has to return The Hanged Woman, not whatever blockbuster shares a word with it.
 *
 * Sorting by votes alone breaks (2). Sorting by match quality alone breaks (1) — measured, that put
 * Fast and Furious (1927, 2 votes) above the franchise. Hence the blended score, and hence the pair
 * of tests below that pin each direction.
 *
 * Vote counts in these fixtures stay within the real range (TMDB's most-rated films sit around
 * 30,000). A fixture with 99,999 votes would test a case that cannot occur and would mislead anyone
 * calibrating the bonuses.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rankSearchResults, normalise, words } = require('../lib/search-rank');

/**
 * Builds a minimal TMDB-shaped search result.
 *
 * @param {number} id - TMDB id.
 * @param {string} title - Movie title.
 * @param {number} voteCount - Vote count, the recognisability proxy.
 * @returns {{id: number, title: string, vote_count: number}}
 */
const movie = (id, title, voteCount) => ({ id, title, vote_count: voteCount });

const titles = results => results.map(m => m.title);
const top = (results, query) => rankSearchResults(results, query)[0].title;

test('normalise collapses case, spacing and punctuation', () => {
    assert.equal(normalise('La La Land'), 'lalaland');
    assert.equal(normalise('lala land'), 'lalaland');
    assert.equal(normalise('LALALAND'), 'lalaland');
    assert.equal(normalise('Spider-Man: No Way Home'), 'spidermannowayhome');
    assert.equal(normalise("Ocean's Eleven"), 'oceanseleven');
    assert.equal(normalise(''), '');
    assert.equal(normalise(undefined), '');
});

test('normalise strips accents rather than deleting the letter', () => {
    // The first version stripped every non-ASCII character, so "Amélie" became "amlie" and could
    // never match "amelie". Measured: the film fell from #1 to #12.
    assert.equal(normalise('Amélie'), 'amelie');
    assert.equal(normalise('Léon'), 'leon');
    assert.equal(normalise('Cyrano de Bergerac'), 'cyranodebergerac');
});

test('normalise removes a leading article', () => {
    // The single most common thing a user omits. Removed from both sides so they meet in the middle.
    assert.equal(normalise('The Godfather'), normalise('godfather'));
    assert.equal(normalise('A Star Is Born'), normalise('star is born'));
    assert.equal(normalise('An Education'), normalise('education'));
    // Only leading — an interior "the" is part of the title.
    assert.equal(normalise('The Fast and the Furious'), 'fastandthefurious');
});

test('normalise treats & and "and" as the same word', () => {
    assert.equal(normalise('Fast & Furious'), normalise('fast and furious'));
});

test('words splits on punctuation and normalises each token', () => {
    assert.deepEqual(words('The Fast and the Furious'), ['the', 'fast', 'and', 'the', 'furious']);
    assert.deepEqual(words('Amélie'), ['amelie']);
    assert.deepEqual(words('Fast & Furious'), ['fast', 'and', 'furious']);
    assert.deepEqual(words(''), []);
});

test('a recognisable film outranks a trending obscure one', () => {
    // The measured "la la" case, with the real vote counts.
    const results = [
        movie(1, 'The Hanged Woman', 28),
        movie(2, 'The Marked Woman', 0),
        movie(313369, 'La La Land', 18384)
    ];

    assert.equal(top(results, 'la la'), 'La La Land');
});

test('an exact match wins even when the film is obscure', () => {
    // The guard on the rule above. A plain vote sort would put La La Land first here, which is
    // precisely the failure this must avoid.
    const results = [
        movie(313369, 'La La Land', 18384),
        movie(1, 'The Hanged Woman', 46)
    ];

    assert.equal(top(results, 'the hanged woman'), 'The Hanged Woman');
});

test('a famous film is not buried by a near-unknown exact match', () => {
    // Measured regression from the tier-only version: three films literally titled "Fast and
    // Furious" (1939, 1924, 1927 — 11, 6 and 2 votes) all outranked the franchise, because an
    // unbounded exact-match tier ignores how unknown a film is.
    const results = [
        movie(1, 'Fast and Furious', 11),
        movie(2, 'Fast and Furious', 6),
        movie(3, 'Fast and Furious', 2),
        movie(9799, 'The Fast and the Furious', 8600)
    ];

    assert.equal(top(results, 'fast and furious'), 'The Fast and the Furious');
});

test('a title carrying a word the query omits still matches', () => {
    // "The Fast and the Furious" has an interior "the" that breaks any comparison of the whole
    // strings. Word-level matching is what rescues it.
    const results = [
        movie(1, 'Unrelated Film', 5000),
        movie(9799, 'The Fast and the Furious', 8600)
    ];

    assert.equal(top(results, 'fast and furious'), 'The Fast and the Furious');
});

test('dropping the leading article still finds the film', () => {
    // Measured: without article handling The Godfather fell from #1 to #5, behind obscure films
    // literally titled "Godfather".
    const results = [
        movie(1, 'Godfather', 34),
        movie(2, 'GodFather', 18),
        movie(238, 'The Godfather', 20000)
    ];

    assert.equal(top(results, 'godfather'), 'The Godfather');
});

test('an accented title is found when typed without the accent', () => {
    const results = [
        movie(1, 'Amelie Unrelated', 300),
        movie(194, 'Amélie', 12000)
    ];

    assert.equal(top(results, 'amelie'), 'Amélie');
});

test('exact beats prefix, so a short title is not buried by a longer one', () => {
    const results = [
        movie(1, 'Upgrade', 5000),
        movie(2, 'Up', 21994)
    ];

    assert.equal(top(results, 'up'), 'Up');
});

test('votes break ties between equally good matches', () => {
    const results = [
        movie(1, 'Star Wars: Andor', 100),
        movie(2, 'Star Wars: Rogue One', 9000),
        movie(3, 'Star Wars: Rebels', 500)
    ];

    assert.deepEqual(titles(rankSearchResults(results, 'star wars')),
        ['Star Wars: Rogue One', 'Star Wars: Rebels', 'Star Wars: Andor']);
});

test('spacing-insensitive matching works when TMDB does return the film', () => {
    // TMDB usually returns nothing for "lalaland" — a separate problem this cannot fix. But when the
    // film IS in the payload, normalisation must match it.
    const results = [
        movie(1, 'Lollos 6: Lalaland!', 2),
        movie(313369, 'La La Land', 18384)
    ];

    assert.equal(top(results, 'lalaland'), 'La La Land');
});

test('ranking never adds, removes or duplicates a result', () => {
    // It is a pure reordering. A result TMDB did not return still cannot appear, which is the honest
    // limit of this fix.
    const results = [movie(1, 'A', 5), movie(2, 'B', 10), movie(3, 'C', 1)];
    const ranked = rankSearchResults(results, 'anything');

    assert.equal(ranked.length, 3);
    assert.deepEqual(new Set(ranked.map(m => m.id)), new Set([1, 2, 3]));
});

test('the input array is not mutated', () => {
    // searchMovies ranks the CACHED payload, which is shared with every later read. Sorting it in
    // place would quietly reorder a cache entry.
    const results = [movie(1, 'Zebra', 1), movie(2, 'Apple', 99)];
    const before = titles(results);

    rankSearchResults(results, 'apple');

    assert.deepEqual(titles(results), before, 'the original array was reordered');
});

test('the order is stable for identical input', () => {
    // Ties break on id, so the same query cannot return different orders across cache misses.
    const results = [movie(7, 'Tie', 100), movie(3, 'Tie', 100), movie(5, 'Tie', 100)];

    assert.deepEqual(rankSearchResults(results, 'nomatch').map(m => m.id), [3, 5, 7]);
});

test('a zero-vote film is ranked, not discarded', () => {
    // log10(0) is -Infinity, which would make every unrated film indistinguishable no matter how
    // well its title matched. The +1 is what prevents that.
    const results = [movie(1, 'Unrelated', 500), movie(2, 'Exact Title', 0)];

    assert.equal(top(results, 'exact title'), 'Exact Title');
});

test('degenerate input is handled without throwing', () => {
    assert.deepEqual(rankSearchResults([], 'x'), []);
    assert.deepEqual(rankSearchResults(null, 'x'), [], 'a missing results array should be empty');
    assert.deepEqual(rankSearchResults(undefined, 'x'), []);

    // An all-punctuation query normalises to empty; the original order is the only sensible answer.
    const results = [movie(1, 'A', 5), movie(2, 'B', 10)];
    assert.deepEqual(titles(rankSearchResults(results, '!!!')), ['A', 'B']);

    // Results missing vote_count or title must not throw or sort unpredictably.
    assert.doesNotThrow(() => rankSearchResults([{ id: 1 }, { id: 2, title: 'X' }], 'x'));
});

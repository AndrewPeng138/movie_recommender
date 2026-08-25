/**
 * Frontend DOM tests.
 *
 * Drives the real `public/index.html` in jsdom against stubbed TMDB responses and asserts on the
 * resulting DOM. Lint and `curl` cannot catch a DOM-construction bug: a card that renders with an
 * empty explanation panel, a chip that removes the wrong movie, or a title interpolated into markup
 * all pass both while being broken on screen.
 *
 * These assertions have caught real regressions repeatedly — a stale emoji check after the 6.2
 * redesign, a `sizes` attribute that counted breakpoint widths as rendered widths, and a dialog that
 * failed to return focus to the card that opened it.
 *
 * **The tests share one page and run in order.** Selecting movies, requesting recommendations, and
 * removing a chip are steps in one user session, not independent cases — later tests depend on the
 * state earlier ones leave behind. Node's test runner executes top-level tests in a file
 * sequentially, which is what makes that safe.
 *
 * What this cannot do: jsdom has no layout engine and no device pixel ratio, so anything about
 * *rendered size* — which poster variant a browser picks, whether a 44px target is really 44px — can
 * only be asserted as "the rule is present". Those need a real device.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = path.join(__dirname, '..', 'public', 'index.html');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Clears the 500ms search debounce plus the stubbed fetch. */
const DEBOUNCE_WAIT = 900;

// ---------------------------------------------------------------------------------------------
// Canned TMDB payloads.
//
// "Bad Movie" carries a hostile title — quotes, angle brackets, and a script tag — to verify the
// escaping. If any rendering path still builds innerHTML from API strings, a <script> or stray
// element appears in the DOM and the escaping assertions below fail. TMDB data is community-edited,
// so this is a real attack surface rather than a hypothetical one.
// ---------------------------------------------------------------------------------------------
const HOSTILE = 'Bad "Movie" <img src=x onerror=alert(1)><script>alert(2)</script>';

/**
 * Builds a canned TMDB movie-details payload.
 *
 * @param {number} id - TMDB id.
 * @param {string} title - Movie title.
 * @param {number} year - Release year.
 * @param {string[]} genres - Genre names.
 * @param {string} director - Director name, placed in `credits.crew`.
 * @param {string[]} cast - Cast names, placed in `credits.cast`.
 * @returns {object} A TMDB-shaped details object including `credits`.
 */
function details(id, title, year, genres, director, cast) {
    return {
        id, title,
        release_date: `${year}-01-01`,
        vote_average: 7.5,
        // Odd ids get no poster, so the placeholder path is exercised alongside the real one.
        poster_path: id % 2 === 0 ? `/poster${id}.jpg` : null,
        overview: 'An overview long enough that the card renderer must clamp it, which is what makes '
            + 'the dialog assertion below meaningful: the dialog has to show all of this text.',
        genres: genres.map((g, i) => ({ id: i + 1, name: g })),
        credits: {
            crew: [{ job: 'Director', name: director }],
            cast: cast.map(n => ({ name: n }))
        }
    };
}

const DB = {
    1: details(1, 'Arrival', 2016, ['Sci-Fi', 'Drama'], 'Denis Villeneuve', ['Amy Adams', 'Jeremy Renner']),
    2: details(2, 'Ex Machina', 2014, ['Sci-Fi', 'Thriller'], 'Alex Garland', ['Alicia Vikander']),
    3: details(3, 'Her', 2013, ['Sci-Fi', 'Romance'], 'Spike Jonze', ['Joaquin Phoenix']),
    4: details(4, HOSTILE, 2018, ['Sci-Fi', 'Drama'], 'Alex Garland', ['Natalie Portman']),
    5: details(5, 'Moon', 2009, ['Sci-Fi'], 'Duncan Jones', ['Sam Rockwell'])
};

const searchResults = [DB[1], DB[2], DB[3], DB[4]].map(m => ({
    id: m.id, title: m.title, release_date: m.release_date,
    vote_average: m.vote_average, poster_path: m.poster_path
}));

/**
 * Stands in for the API. Returns TMDB-shaped payloads without a network call, so the suite is
 * deterministic and runnable offline — including in CI, which has no TMDB key.
 *
 * @param {string} url - Requested URL.
 * @param {object} [init] - Fetch options; `body` is read for the recommend POST.
 * @returns {Promise<object>} A minimal Response-alike with `ok`, `status`, and `json()`.
 */
function stubFetch(url, init) {
    const u = String(url);
    let body;

    if (u.includes('/recommend')) {
        // Phase 4 shape: one POST replaces the browser-side fan-out.
        const picked = JSON.parse(init.body).movieIds;
        body = {
            results: [DB[4], DB[5]].map((m, i) => ({
                id: m.id,
                title: m.title,
                year: String(2018 - i),
                poster_path: m.poster_path,
                vote_average: m.vote_average,
                overview: m.overview,
                matchScore: 90 - i * 5,
                // Phase 3 shape: named feature contributions replace fixed category totals.
                contributions: [
                    { label: 'Alex Garland', type: 'd', share: 0.31 },
                    { label: 'Body horror', type: 'k', share: 0.22 },
                    { label: 'Sci-Fi', type: 'g', share: 0.08 }
                ],
                similarTo: ['Arrival', 'Ex Machina', 'Her']
            })),
            meta: {
                generator: 'tmdb', picks: picked.length, candidatePoolSize: 42,
                returned: 2, durationMs: 120, failedPicks: 0, failedCandidates: 0
            }
        };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }

    if (u.includes('/search')) {
        body = { results: searchResults };
    } else if (/\/movie\/\d+\/similar/.test(u)) {
        body = { results: [DB[4], DB[5]] };
    } else if (/\/movie\/\d+\/recommendations/.test(u)) {
        body = { results: [DB[5]] };
    } else {
        const id = Number(u.match(/\/movie\/(\d+)/)?.[1]);
        body = DB[id] || DB[1];
    }

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

// Shared across every test in this file — see the note on ordering at the top.
let dom, window, doc, html, input;
const pageErrors = [];

before(() => {
    html = fs.readFileSync(APP, 'utf8');

    // Route page errors into an array instead of the console: an uncaught error inside the page's
    // own script would otherwise vanish, and several tests assert that none accumulated.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => pageErrors.push(e.message));
    virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

    dom = new JSDOM(html, {
        url: 'http://localhost:3001/',
        runScripts: 'dangerously',
        virtualConsole,
        pretendToBeVisual: true
    });

    ({ window } = dom);
    doc = window.document;
    window.fetch = stubFetch;
    // Not implemented in jsdom; displayRecommendations calls it.
    window.HTMLElement.prototype.scrollIntoView = function () {};
    input = doc.getElementById('searchInput');
});

after(() => dom.window.close());

/**
 * Types into the search box and waits for the debounced request to render.
 *
 * @param {string} text - Query text. The stub ignores it; distinct values only avoid the search
 *   cache returning a previous result.
 */
async function search(text) {
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(DEBOUNCE_WAIT);
}

/** Dispatches a keydown on the search input, as a real keyboard user would produce. */
const press = key => input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** Dispatches a bubbling click, which is what the delegated handlers listen for. */
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

test('page loads without script errors', () => {
    assert.deepEqual(pageErrors, [], 'uncaught errors on load');
    assert.ok(doc.getElementById('searchInput'), 'search input missing');
    assert.equal(doc.getElementById('getRecommendations').disabled, true,
        'button should start disabled below the 3-movie minimum');
});

test('search renders debounced suggestions', async () => {
    await search('sci fi');

    const suggestions = doc.querySelectorAll('#suggestions .suggestion-item');
    assert.equal(suggestions.length, 4, `expected 4 suggestions, got ${suggestions.length}`);
    assert.match(doc.querySelector('.suggestion-title').textContent, /Arrival \(2016\)/);
    assert.ok(doc.querySelectorAll('.suggestion-poster')[0].src.startsWith('data:image/svg+xml'),
        'a null poster_path should fall back to the inline SVG placeholder');
});

test('a hostile title renders as text, never as markup', () => {
    const hostile = [...doc.querySelectorAll('.suggestion-title')]
        .find(el => el.textContent.includes('Bad'));

    assert.ok(hostile, 'hostile title should be present as text');
    assert.equal(doc.querySelectorAll('#suggestions script').length, 0, '<script> was injected');
    assert.ok([...doc.querySelectorAll('#suggestions img')].every(i => !i.getAttribute('onerror')),
        'an onerror handler was injected from the title');
    assert.ok(hostile.textContent.includes('<script>'),
        'the tag should survive verbatim as text rather than being parsed');
});

test('selecting a movie builds a chip', async () => {
    click(doc.querySelectorAll('#suggestions .suggestion-item')[0]);
    await sleep(150);

    assert.equal(doc.querySelectorAll('#selectedMovies .movie-chip').length, 1);
    assert.equal(doc.getElementById('getRecommendations').disabled, true,
        'still below the 3-movie minimum');
});

test('a rapid double-click adds exactly one movie', async () => {
    // The `>= 10` and "already selected" guards both ran before `await fetch`, so two clicks landed
    // before either could see the other. Guarding requires marking the id pending before awaiting.
    await search('again');
    const fresh = doc.querySelectorAll('#suggestions .suggestion-item');

    click(fresh[1]);
    click(fresh[1]);              // deliberately no await between the two
    await sleep(300);

    const count = doc.querySelectorAll('#selectedMovies .movie-chip').length;
    assert.equal(count, 2, `chip count should be 2, got ${count}`);
});

test('the third selection enables the button', async () => {
    await search('third');
    click(doc.querySelectorAll('#suggestions .suggestion-item')[2]);
    await sleep(300);

    assert.equal(doc.querySelectorAll('#selectedMovies .movie-chip').length, 3);
    assert.equal(doc.getElementById('getRecommendations').disabled, false);
    assert.equal(doc.getElementById('count').textContent, '3');
});

test('recommendations render with their explanations', async () => {
    click(doc.getElementById('getRecommendations'));
    await sleep(2500);

    const cards = doc.querySelectorAll('#movieGrid .movie-card');
    assert.ok(cards.length > 0, `no cards rendered (got ${cards.length})`);
    assert.equal(doc.getElementById('recommendationsSection').style.display, 'block');
    assert.match(doc.querySelector('.match-score').textContent, /Match: \d+%/);

    // The try/finally split: anything thrown outside the inner loop used to leave the button
    // permanently disabled.
    const button = doc.getElementById('getRecommendations');
    assert.equal(button.disabled, false, 'button should be re-enabled after the run');
    assert.match(button.textContent, /Get Recommendations/);

    assert.equal(doc.querySelectorAll('#movieGrid script').length, 0, '<script> injected via a card');
    assert.ok(doc.querySelectorAll('.match-similar').length > 0, 'attribution panel missing');

    const breakdown = doc.querySelector('.match-breakdown').textContent;
    assert.match(breakdown, /Alex Garland/, 'named contributions should render');
    // 6.2 replaced per-value emoji with the category stated once. An icon repeated per value cost a
    // glyph each and never said what the category was.
    assert.match(breakdown, /Director/, 'the feature type should be named as a category');
    assert.doesNotMatch(breakdown, /[\u{1F300}-\u{1FAFF}]/u, 'emoji should be gone from explanations');

    // The release year is already on the card, and lang:en carries the lowest IDF in the corpus.
    assert.doesNotMatch(doc.getElementById('movieGrid').textContent, /Era|Language/,
        'decade and English should never be offered as reasons');

    assert.match(doc.querySelector('.match-similar').textContent, /Because you liked/);

    // Phase 3 removed this badge because it saturated at the pick count on every card. It returned in
    // 6.2 driven by similarTo, which the server now filters by relative similarity — so the guard is
    // that it can never claim more picks than were actually selected.
    const picks = doc.querySelectorAll('#selectedMovies .movie-chip').length;
    assert.ok([...doc.querySelectorAll('.match-multi')].every(el =>
        Number(/matches (\d+) of/.exec(el.textContent)?.[1]) <= picks),
    'the multi-match badge claimed more picks than were selected');
});

test('result posters are offered at several widths', () => {
    // jsdom cannot choose a variant — that needs a layout engine and a real pixel density — so these
    // pin the contract rather than the outcome.
    const poster = doc.querySelector('#movieGrid .movie-poster[srcset]');
    assert.ok(poster, 'no poster carries a srcset');

    assert.match(poster.srcset, /\/w185\S+ 185w/);
    assert.match(poster.srcset, /\/w500\S+ 500w/);
    // Offering w780 would let high-density desktops pick something HEAVIER than before the change.
    assert.doesNotMatch(poster.srcset, /w780|original/, 'w780 must not be offered');

    // Asserted literally rather than by count: the media conditions contain px values too (560px,
    // 900px), which would inflate a count and let a wrong rendered width through.
    for (const width of ['96px', '170px', '205px', '283px']) {
        assert.match(poster.sizes, new RegExp(`(^|[,\\s)])${width}(,|$)`),
            `sizes is missing the ${width} breakpoint`);
    }

    assert.match(poster.src, /\/w500\//, 'the no-srcset fallback should be unchanged at w500');
    assert.ok([...doc.querySelectorAll('#movieGrid .movie-poster')].every(i => i.loading === 'lazy'),
        'every poster should be lazily loaded');
    assert.ok([...doc.querySelectorAll('#movieGrid .movie-poster')]
        .filter(i => i.src.startsWith('data:'))
        .every(i => !i.getAttribute('srcset')),
    'placeholder posters have nothing to resize and should carry no srcset');
});

test('a card opens the detail dialog', async () => {
    // 6.2 replaced expand-in-place, which was useless because the card renderer had already cut the
    // overview to 100 characters — "expanding" revealed the same truncated string. Hence the
    // assertion on the FULL text below.
    const overlay = doc.getElementById('detailOverlay');
    const card = doc.querySelector('#movieGrid .movie-card');

    assert.equal(overlay.hidden, true, 'dialog should start hidden');
    assert.equal(card.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(card.getAttribute('role'), 'button');

    click(card);
    await sleep(300);

    assert.equal(overlay.hidden, false, 'clicking a card should open the dialog');
    assert.equal(doc.querySelector('.detail-dialog').getAttribute('aria-modal'), 'true');
    assert.ok(doc.getElementById('detailTitle').textContent.length > 0, 'dialog has no accessible name');

    assert.equal(doc.querySelector('.detail-synopsis').textContent, DB[4].overview,
        'the dialog must show the full synopsis, not the card truncation');

    const body = doc.getElementById('detailBody').textContent;
    assert.match(body, /Why this/, 'the dialog should repeat why the film matched');
    assert.match(body, /Alex Garland/);
    assert.match(body, /Natalie Portman/, 'cast and crew should come from the fetched credits');
    assert.equal(doc.querySelectorAll('#detailOverlay script').length, 0,
        '<script> injected via the dialog — the hostile title is the film being shown');

    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);

    assert.equal(overlay.hidden, true, 'Escape should close the dialog');
    assert.equal(doc.activeElement, card, 'focus should return to the card that opened it');
});

test('the remove button removes the right chip', async () => {
    // Removing the FIRST chip was the fragile case under the old index-based inline onclick.
    const before = doc.querySelectorAll('#selectedMovies .movie-chip').length;
    click(doc.querySelector('#selectedMovies .remove-btn'));
    await sleep(150);

    const after = doc.querySelectorAll('#selectedMovies .movie-chip').length;
    assert.equal(after, before - 1, `chip count went ${before} -> ${after}`);
    assert.equal(doc.getElementById('getRecommendations').disabled, true,
        'button should disable again below the minimum');
    assert.ok(doc.querySelector('#selectedMovies .remove-btn').getAttribute('aria-label'),
        'remove buttons need an accessible label');
});

test('no page errors accumulated across the whole session', () => {
    assert.deepEqual(pageErrors, [], 'uncaught errors during the run');
});

test('search exposes ARIA combobox semantics', async () => {
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), 'suggestions');
    assert.equal(doc.getElementById('suggestions').getAttribute('role'), 'listbox');
    assert.ok(doc.querySelector('label[for="searchInput"]'), 'search input needs a label');

    await search('sci');

    assert.equal(input.getAttribute('aria-expanded'), 'true',
        'aria-expanded should flip when results open');
    assert.ok([...doc.querySelectorAll('.suggestion-item')].every(i => i.getAttribute('role') === 'option'));
});

test('the dropdown is fully keyboard operable', async () => {
    press('ArrowDown');
    assert.ok(doc.querySelectorAll('.suggestion-item')[0].classList.contains('active'));
    // Focus stays in the input; aria-activedescendant is what tells a screen reader which option is
    // highlighted. Moving real focus into the list would break typing.
    assert.equal(input.getAttribute('aria-activedescendant'), 'suggestion-0');

    press('ArrowDown');
    assert.ok(doc.querySelectorAll('.suggestion-item')[1].classList.contains('active'));
    press('ArrowUp');
    assert.ok(doc.querySelectorAll('.suggestion-item')[0].classList.contains('active'));

    press('Escape');
    assert.equal(doc.getElementById('suggestions').style.display, 'none');
    assert.equal(input.getAttribute('aria-expanded'), 'false');

    const before = doc.querySelectorAll('#selectedMovies .movie-chip').length;
    await search('keyboard only');
    press('ArrowDown');
    press('Enter');
    await sleep(250);

    assert.equal(doc.querySelectorAll('#selectedMovies .movie-chip').length, before + 1,
        'Enter should add a movie with no mouse involved');
});

test('picks survive a refresh via localStorage', () => {
    const saved = window.localStorage.getItem('movieRecommender.picks.v1');
    assert.ok(saved, 'picks were not written to localStorage');

    const picks = JSON.parse(saved);
    assert.ok(Array.isArray(picks) && picks.length > 0, `expected a non-empty array, got ${saved}`);
    assert.ok(picks.every(m => typeof m.id === 'number' && typeof m.title === 'string'),
        'stored picks should carry id and title');
    // Storing the full TMDB payload would blow the ~5 MB quota after a few dozen picks.
    assert.ok(saved.length < 4000, `stored payload is ${saved.length} bytes — too large`);
});

test('status is announced politely', () => {
    const region = doc.getElementById('statusRegion');
    assert.ok(region, 'no live region for announcements');
    assert.equal(region.getAttribute('aria-live'), 'polite');
});

test('responsive and accessibility rules are present in the stylesheet', () => {
    // Source assertions, not behaviour: jsdom has no layout engine, so these pin rules that would
    // otherwise disappear in a refactor with nothing failing to notice. Each still needs a device.
    assert.ok((html.match(/@media/g) || []).length >= 2, 'no media queries found');
    assert.match(html, /overflow-x: hidden/, 'horizontal overflow is not prevented');
    assert.match(html, /prefers-reduced-motion/, 'reduced motion is not respected');
    assert.match(html, /@media \(pointer: coarse\)[^}]*\.detail-close\s*\{[^}]*44px/,
        'the dialog close button is not sized for touch');
});

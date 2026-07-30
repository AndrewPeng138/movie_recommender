/**
 * Evaluation metrics for recommendation quality.
 *
 * ## Multi-target evaluation
 *
 * Each instance carries a **set** of held-out films the user liked, not a single one. Single-target
 * evaluation is unfairly brittle: it awards zero credit for recommending 30 films the user would love
 * if none is the one specific title that happened to be withheld. Nobody uses a recommender hoping
 * for one exact film; they want a list where several are good.
 *
 * Single-target evaluation is still expressible — pass a set of size one, and `hitRate@k` reduces
 * exactly to the old `recall@k`. That keeps previously recorded baselines reproducible.
 *
 * ## What each metric answers
 *
 *   - **hitRate@k**   — did at least one film they liked make the top k? The headline number.
 *   - **precision@k** — of the k shown, how many did they actually like? Directly interpretable.
 *   - **recall@k**    — what fraction of everything they liked did we surface? Necessarily small,
 *                       since k is 30 and a user may have liked hundreds.
 *   - **mrr**         — how high was the *first* relevant film? Rewards 3rd over 27th.
 *   - **poolHitRate** — was any relevant film in the candidate pool at all? The ceiling: hitRate@k
 *                       can never exceed it, so it separates a generation problem from a ranking one.
 *
 * @module eval/metrics
 */

/**
 * Whether any target appears within the first `k` ranked results.
 *
 * @param {number[]} ranked - Recommended TMDB ids, best first.
 * @param {Set<number>} targets - Held-out films the user liked.
 * @param {number} k - Cutoff.
 * @returns {boolean}
 */
function hitAt(ranked, targets, k) {
    return ranked.slice(0, k).some(id => targets.has(id));
}

/**
 * Fraction of the top `k` results that the user actually liked.
 *
 * NOTE: this systematically *understates* quality. A user rated only a few hundred of ~9,700 films,
 * so a recommendation they never rated is not necessarily bad — they may simply never have seen it.
 * The bias applies equally to every model, so it remains valid for comparison, just not as an
 * absolute measure of how good the recommendations are.
 *
 * @param {number[]} ranked
 * @param {Set<number>} targets
 * @param {number} k
 * @returns {number} Between 0 and 1.
 */
function precisionAt(ranked, targets, k) {
    const top = ranked.slice(0, k);
    if (top.length === 0) return 0;
    return top.filter(id => targets.has(id)).length / top.length;
}

/**
 * Fraction of the user's held-out likes that appear in the top `k`.
 *
 * Bounded above by `k / |targets|`, so with 30 slots and 190 held-out films the maximum possible is
 * about 0.16. Interpret it relatively, not as a percentage of success.
 *
 * @param {number[]} ranked
 * @param {Set<number>} targets
 * @param {number} k
 * @returns {number}
 */
function recallAt(ranked, targets, k) {
    if (targets.size === 0) return 0;
    return ranked.slice(0, k).filter(id => targets.has(id)).length / targets.size;
}

/**
 * Reciprocal of the rank of the *first* relevant result, or 0 if none appears.
 *
 * @param {number[]} ranked
 * @param {Set<number>} targets
 * @returns {number} Between 0 and 1.
 */
function reciprocalRank(ranked, targets) {
    for (let i = 0; i < ranked.length; i++) {
        if (targets.has(ranked[i])) return 1 / (i + 1);
    }
    return 0;
}

/**
 * Mean of an array, or 0 for an empty one.
 *
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Half-width of the 95% confidence interval for a mean.
 *
 * Reported alongside every metric because at a few hundred instances, differences of a couple of
 * points are noise. Two results differ meaningfully only if their intervals do not overlap.
 *
 * @param {number[]} values
 * @returns {number}
 */
function confidenceInterval95(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return 1.96 * Math.sqrt(variance / values.length);
}

/**
 * Computes every metric over a set of instances against a chosen target subset.
 *
 * @param {Array<object>} instances
 * @param {(instance: object) => Set<number>} pickTargets - Selects which targets to score against,
 *   allowing the same instances to be evaluated on all targets or only popular/obscure ones.
 * @param {number[]} cutoffs
 * @returns {object}
 */
function computeBlock(instances, pickTargets, cutoffs) {
    // Instances with no targets in this subset are excluded rather than counted as failures —
    // a user with no obscure held-out films is not evidence about obscure performance.
    const usable = instances.filter(i => pickTargets(i).size > 0);
    if (usable.length === 0) return { instances: 0 };

    const report = { instances: usable.length };

    for (const k of cutoffs) {
        const hits = usable.map(i => (hitAt(i.ranked, pickTargets(i), k) ? 1 : 0));
        report[`hitRate@${k}`] = Number(mean(hits).toFixed(4));
        report[`hitRate@${k}_ci95`] = Number(confidenceInterval95(hits).toFixed(4));

        const precisions = usable.map(i => precisionAt(i.ranked, pickTargets(i), k));
        report[`precision@${k}`] = Number(mean(precisions).toFixed(4));
        report[`precision@${k}_ci95`] = Number(confidenceInterval95(precisions).toFixed(4));
    }

    const recalls = usable.map(i => recallAt(i.ranked, pickTargets(i), Math.max(...cutoffs)));
    report[`recall@${Math.max(...cutoffs)}`] = Number(mean(recalls).toFixed(4));

    const rrs = usable.map(i => reciprocalRank(i.ranked, pickTargets(i)));
    report.mrr = Number(mean(rrs).toFixed(4));
    report.mrr_ci95 = Number(confidenceInterval95(rrs).toFixed(4));

    // The ceiling. hitRate@k cannot exceed this, because the ranker can only order what generation
    // supplied.
    const pooled = usable.map(i => ([...pickTargets(i)].some(t => i.pool.has(t)) ? 1 : 0));
    report.poolHitRate = Number(mean(pooled).toFixed(4));
    report.poolHitRate_ci95 = Number(confidenceInterval95(pooled).toFixed(4));

    report.meanTargets = Math.round(mean(usable.map(i => pickTargets(i).size)));
    report.meanPoolSize = Math.round(mean(usable.map(i => i.pool.size)));

    // How *dense* the candidate pool is with films the user liked, before any ranking. This measures
    // generation quality on its own terms: poolHitRate only asks whether at least one relevant film
    // got in, which saturates. Density says how hard the ranker's job is once it receives the pool.
    report.poolPrecision = Number(mean(usable.map(i => {
        if (i.pool.size === 0) return 0;
        const targets = pickTargets(i);
        let hits = 0;
        for (const id of i.pool) if (targets.has(id)) hits++;
        return hits / i.pool.size;
    })).toFixed(4));

    // Expected density if the same number of candidates were drawn at random from the corpus. The
    // ratio poolPrecision / randomBaseline is generation's lift over chance.
    report.poolPrecisionRandom = Number(mean(usable.map(i =>
        pickTargets(i).size / (i.corpusSize || 9734)
    )).toFixed(6));

    report.poolLiftOverRandom = report.poolPrecisionRandom > 0
        ? Number((report.poolPrecision / report.poolPrecisionRandom).toFixed(1))
        : 0;

    return report;
}

/**
 * Aggregates per-instance outcomes into a metrics report.
 *
 * @param {Array<{ranked: number[], targets: Set<number>, pool: Set<number>,
 *                popularityOf: Map<number, number>}>} instances
 * @param {object} [options]
 * @param {number[]} [options.cutoffs]
 * @param {number} [options.popularSplit] - MovieLens rating count above which a film is "popular".
 * @returns {object}
 */
function summarize(instances, { cutoffs = [10, 30], popularSplit = 50 } = {}) {
    if (instances.length === 0) return { instances: 0, note: 'No evaluable instances.' };

    // Stratify by splitting each instance's *target set*, rather than by classifying whole instances.
    // This preserves the most valuable question -- does the system work for less-known films? -- which
    // a single blended number hides entirely. Every trivial baseline scored exactly zero here.
    const popularTargets = i => new Set(
        [...i.targets].filter(t => (i.popularityOf.get(t) || 0) >= popularSplit)
    );
    const obscureTargets = i => new Set(
        [...i.targets].filter(t => (i.popularityOf.get(t) || 0) < popularSplit)
    );

    return {
        overall: computeBlock(instances, i => i.targets, cutoffs),
        byPopularity: {
            note: `Target sets split at ${popularSplit} MovieLens ratings. MovieLens carries exposure `
                + 'bias (people only rate films they chose to watch), so blended metrics partly reward '
                + 'popularity; a large gap here means the model is leaning on it.',
            popular: computeBlock(instances, popularTargets, cutoffs),
            obscure: computeBlock(instances, obscureTargets, cutoffs)
        }
    };
}

/**
 * Renders a metrics report as an aligned console table.
 *
 * @param {object} report - Output of {@link summarize}.
 * @param {string} label
 * @returns {string}
 */
function format(report, label) {
    if (!report.overall) return `${label}: ${report.note || 'no data'}`;

    const block = (title, r) => {
        if (!r.instances) return `  ${title}: no instances`;
        const rows = [`  ${title} (n=${r.instances}, mean targets ${r.meanTargets}, pool ${r.meanPoolSize})`];
        for (const key of Object.keys(r)) {
            if (key.endsWith('_ci95') || ['instances', 'meanTargets', 'meanPoolSize'].includes(key)) {
                continue;
            }
            const ci = r[`${key}_ci95`];
            rows.push(
                `    ${key.padEnd(18)} ${String(r[key]).padStart(7)}`
                + (ci !== undefined ? `  +/- ${ci}` : '')
            );
        }
        return rows.join('\n');
    };

    return [
        `\n${'='.repeat(62)}`,
        label,
        '='.repeat(62),
        block('OVERALL', report.overall),
        '',
        block('POPULAR targets', report.byPopularity.popular),
        '',
        block('OBSCURE targets', report.byPopularity.obscure)
    ].join('\n');
}

module.exports = {
    hitAt, precisionAt, recallAt, reciprocalRank,
    mean, confidenceInterval95, summarize, format
};

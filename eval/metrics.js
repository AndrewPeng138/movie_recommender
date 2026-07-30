/**
 * Evaluation metrics for recommendation quality.
 *
 * Every metric here answers a different question, and the distinction between them is the point:
 *
 *   - **Recall@k** — did we surface the film at all, in the top k?
 *   - **MRR** — how *high* did we rank it? Rewards 3rd place over 27th.
 *   - **Candidate recall** — was the film even in the pool to be ranked? This is the diagnostic that
 *     separates a ranking problem from a generation problem, and it is the single most important
 *     number the harness produces. If a film never enters the candidate pool, no scoring change can
 *     ever find it, and effort spent on ranking is wasted.
 *
 * @module eval/metrics
 */

/**
 * Whether the target appears within the first `k` ranked results.
 *
 * @param {number[]} ranked - Recommended TMDB ids, best first.
 * @param {number} targetId - The held-out film's TMDB id.
 * @param {number} k - Cutoff.
 * @returns {boolean}
 */
function recallAt(ranked, targetId, k) {
    return ranked.slice(0, k).includes(targetId);
}

/**
 * Reciprocal of the target's 1-based rank, or 0 if absent.
 *
 * Rank 1 scores 1.0, rank 2 scores 0.5, rank 10 scores 0.1. Averaged across instances this is Mean
 * Reciprocal Rank, which unlike Recall distinguishes "barely made the list" from "top pick".
 *
 * @param {number[]} ranked - Recommended TMDB ids, best first.
 * @param {number} targetId - The held-out film's TMDB id.
 * @returns {number} Between 0 and 1.
 */
function reciprocalRank(ranked, targetId) {
    const index = ranked.indexOf(targetId);
    return index === -1 ? 0 : 1 / (index + 1);
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
 * Reported alongside every metric because with a few hundred instances, differences of a couple of
 * percentage points are noise. A model that "improves" Recall@30 from 0.31 to 0.33 with a ±0.04
 * interval has not been shown to improve anything, and shipping it on that basis is how you convince
 * yourself of a result that is not there.
 *
 * Uses the normal approximation (1.96 standard errors), which is fine at these sample sizes.
 *
 * @param {number[]} values
 * @returns {number} Half-width; the interval is `mean ± this`.
 */
function confidenceInterval95(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return 1.96 * Math.sqrt(variance / values.length);
}

/**
 * Aggregates per-instance outcomes into a metrics report.
 *
 * @param {Array<{ranked: number[], targetId: number, inCandidatePool: boolean,
 *                targetPopularity: number, poolSize: number}>} instances
 * @param {object} [options]
 * @param {number[]} [options.cutoffs] - Recall cutoffs to report.
 * @param {number} [options.popularSplit] - Rating count above which a film counts as "popular",
 *   used to stratify results.
 * @returns {object} Metrics report.
 */
function summarize(instances, { cutoffs = [10, 30], popularSplit = 50 } = {}) {
    if (instances.length === 0) {
        return { instances: 0, note: 'No evaluable instances.' };
    }

    /** @param {typeof instances} subset */
    const compute = subset => {
        const report = { instances: subset.length };

        for (const k of cutoffs) {
            const hits = subset.map(i => (recallAt(i.ranked, i.targetId, k) ? 1 : 0));
            report[`recall@${k}`] = Number(mean(hits).toFixed(4));
            report[`recall@${k}_ci95`] = Number(confidenceInterval95(hits).toFixed(4));
        }

        const rrs = subset.map(i => reciprocalRank(i.ranked, i.targetId));
        report.mrr = Number(mean(rrs).toFixed(4));
        report.mrr_ci95 = Number(confidenceInterval95(rrs).toFixed(4));

        // The ceiling: the fraction of instances where the target was in the pool at all. Recall can
        // never exceed this, no matter how good the ranking is.
        const pooled = subset.map(i => (i.inCandidatePool ? 1 : 0));
        report.candidateRecall = Number(mean(pooled).toFixed(4));
        report.candidateRecall_ci95 = Number(confidenceInterval95(pooled).toFixed(4));

        report.meanPoolSize = Math.round(mean(subset.map(i => i.poolSize)));

        return report;
    };

    const overall = compute(instances);

    // Stratify by popularity. MovieLens carries exposure bias -- users only rate films they chose to
    // watch, which skews popular -- so raw recall partly rewards recommending blockbusters. Splitting
    // the results stops a popularity-chasing model from hiding behind a good average.
    const popular = instances.filter(i => i.targetPopularity >= popularSplit);
    const obscure = instances.filter(i => i.targetPopularity < popularSplit);

    return {
        overall,
        byPopularity: {
            note: `Split at ${popularSplit} MovieLens ratings. Exposure bias means raw recall `
                + 'partly rewards popularity; a large gap here indicates the model is leaning on it.',
            popular: popular.length ? compute(popular) : { instances: 0 },
            obscure: obscure.length ? compute(obscure) : { instances: 0 }
        }
    };
}

/**
 * Renders a metrics report as an aligned console table.
 *
 * @param {object} report - Output of {@link summarize}.
 * @param {string} label - Heading.
 * @returns {string}
 */
function format(report, label) {
    if (!report.overall) return `${label}: ${report.note || 'no data'}`;

    const line = (name, value, ci) =>
        `  ${name.padEnd(20)} ${String(value).padStart(7)}` + (ci !== undefined ? `  +/- ${ci}` : '');

    const block = (title, r) => {
        if (!r.instances) return `  ${title}: no instances`;
        const rows = [`  ${title} (n=${r.instances})`];
        for (const key of Object.keys(r)) {
            if (key.endsWith('_ci95') || key === 'instances') continue;
            rows.push(line(key, r[key], r[`${key}_ci95`]));
        }
        return rows.join('\n');
    };

    return [
        `\n${'='.repeat(58)}`,
        label,
        '='.repeat(58),
        block('OVERALL', report.overall),
        '',
        block('POPULAR targets', report.byPopularity.popular),
        '',
        block('OBSCURE targets', report.byPopularity.obscure)
    ].join('\n');
}

module.exports = { recallAt, reciprocalRank, mean, confidenceInterval95, summarize, format };

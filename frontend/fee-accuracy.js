// ===========================================================================
// fee-accuracy.js — the KPI panel's "Fee accuracy" section (#494), no DOM.
//
// GET /api/fee-accuracy grades every filed job that has both a filing-time quote and a whole,
// settled paid figure, per AHJ/utility and track. This renders it. dashboard.html loads it as a
// classic script (window.FeeAccuracy) ahead of the dashboard module, and
// backend/test/feeAccuracy.test.ts loads the same file through node:vm, so the display rules are
// pinned without a browser. Keep it pure: report in, HTML out, every value escaped.
//
// The display rules, each because a bare number lies:
//   - every jurisdiction shows n beside its median and worst miss: 20% on one job is a lead,
//     not a verdict;
//   - a flagged jurisdiction says which way it misses ("quotes low"), because the fix is
//     opposite for each;
//   - each job links to its project and names where both numbers came from;
//   - jobs left out are counted by reason, so an empty table never reads as "all accurate".
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.FeeAccuracy = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
  const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(1)}%`);

  const QUOTE_SOURCE = {
    learned_history: 'learned history',
    published_schedule: 'published schedule',
    valuation_estimate: 'valuation estimate',
    printed_form: 'printed form',
    payment_row: 'paid quote (before snapshots)',
    unknown: 'unknown',
  };
  const PAID_SOURCE = {
    actual: 'recorded by a person',
    portal_record: 'portal record (read, issued)',
    receipts: 'paid receipts',
    billing_summary: 'billing summaries',
  };
  const EXCLUDED = {
    no_quote: 'No quote kept at filing',
    quote_not_frozen: 'Filed before quotes were kept; quote still open',
    no_researched_figure: 'Quote had no amount',
    no_paid_figure: 'No paid figure yet',
    partial_portal_read: 'Only a partial portal read',
    provisional_portal_read: 'Portal read before issuance',
    receipts_incomplete: 'Receipts do not cover every filed record',
  };

  function directionLabel(g) {
    if (!g.flagged) return 'within threshold';
    return g.direction === 'low' ? 'quotes LOW' : g.direction === 'high' ? 'quotes HIGH' : 'misses both ways';
  }

  function renderJobs(g) {
    return `
      <tr class="fee-accuracy-jobs"><td colspan="6">
        <table>
          <thead><tr><th>Job</th><th>Quoted</th><th>Paid</th><th>Miss</th></tr></thead>
          <tbody>
            ${g.jobs.map((j) => `
              <tr>
                <td><a href="#/project/${esc(encodeURIComponent(j.projectId))}">${esc(j.label)}</a></td>
                <td>${esc(usd(j.quotedUsd))} <span class="muted">${esc(QUOTE_SOURCE[j.quoteSource] || j.quoteSource)}</span></td>
                <td>${esc(usd(j.paidUsd))} <span class="muted">${esc(PAID_SOURCE[j.paidSource] || j.paidSource)}</span></td>
                <td>${esc(pct(j.missPct))} <span class="muted">(${esc(usd(j.missUsd))})</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </td></tr>`;
  }

  function renderFeeAccuracy(report) {
    if (!report) return '';
    const groups = report.groups || [];
    const excluded = report.excluded || [];
    const flagged = groups.filter((g) => g.flagged).length;
    const byReason = {};
    for (const e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
    return `
      <h3 style="margin-top:24px">Fee accuracy <span class="muted" style="font-weight:400">— quoted at filing vs paid, flag over ${esc(report.thresholdPct)}%</span></h3>
      ${groups.length ? `
        <p class="${flagged ? 'kpi-warn' : 'muted'}" style="margin-top:6px;padding:${flagged ? '8px' : '0'};border-radius:4px">
          ${flagged ? `${flagged} jurisdiction(s) miss by more than ${esc(report.thresholdPct)}% — correct their fee quotes.` : `Every jurisdiction with a paid figure is within ${esc(report.thresholdPct)}%.`}
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Jurisdiction</th><th>Track</th><th>n</th><th>Median miss</th><th>Worst miss</th><th></th></tr></thead>
            <tbody>
              ${groups.map((g) => `
                <tr class="${g.flagged ? 'kpi-warn' : ''}">
                  <td>${esc(g.jurisdiction)}${g.state ? ` <span class="muted">${esc(g.state)}</span>` : ''}</td>
                  <td>${esc(g.track === 'nem' ? 'NEM' : 'Permit')}</td>
                  <td>${esc(g.n)}</td>
                  <td>${esc(pct(g.medianMissPct))}</td>
                  <td>${esc(pct(g.worstMissPct))}</td>
                  <td>${esc(directionLabel(g))}</td>
                </tr>
                ${renderJobs(g)}`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted" style="margin-top:6px">No filed job has both a quote and a paid figure yet.</p>'}
      ${excluded.length ? `
        <p class="muted" style="margin-top:6px">${esc(excluded.length)} filed job(s) left out: ${Object.entries(byReason)
          .map(([reason, n]) => `${esc(EXCLUDED[reason] || reason)} (${esc(n)})`).join(' · ')}.</p>` : ''}
      ${(report.notes || []).map((n) => `<p class="muted" style="margin-top:4px;font-size:0.9em">${esc(n)}</p>`).join('')}`;
  }

  return { renderFeeAccuracy };
});

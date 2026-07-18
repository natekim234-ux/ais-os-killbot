// Scenario verification for the link-click CPC switch — imports the REAL
// evaluate() from killbot.mjs (not a copy) so what passes here is what runs.
process.env.META_ACCESS_TOKEN = 'dummy';
process.env.META_AD_ACCOUNT_ID = 'act_dummy';
process.env.GOOGLE_SA_JSON = '{"client_email":"d","private_key":"d"}';

const { evaluate } = await import('./killbot.mjs');

const BREAKEVEN = 16.44; // live KPI sheet G2 value (was 35.31 — stale, hid the Rule1/Rule2 floor gap)

// m shape: { spend, linkClicks, cpcLink, atc, purchases }
const scenarios = [
  ['A. $12 spend, CPC $4.00 (3 clicks), 4h',            { spend: 12.00, linkClicks: 3, cpcLink: 4.00, atc: 0, purchases: 0 }, 4],
  ['B. $16 spend, CPC $2.29 (7 clicks), 6h  [CT83 true]',{ spend: 16.00, linkClicks: 7, cpcLink: 2.29, atc: 0, purchases: 0 }, 6],
  ['C. $26 spend, CPC $3.00 exactly, 6h',                { spend: 26.00, linkClicks: 9, cpcLink: 3.00, atc: 0, purchases: 0 }, 6],
  ['D. $26 spend, CPC $3.01, 6h',                        { spend: 26.00, linkClicks: 9, cpcLink: 3.01, atc: 0, purchases: 0 }, 6],
  ['E. $26.48 spend, CPC $3.07 (9 clicks), 6h [CT82]',   { spend: 26.48, linkClicks: 9, cpcLink: 3.07, atc: 0, purchases: 0 }, 6],
  ['F. $25.00 spend, 0 link clicks, 3h',                 { spend: 25.00, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 3],
  ['G. $24.99 spend, 0 link clicks, 3h',                 { spend: 24.99, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 3],
  ['H. CPC $1.80, $36 spend, 25h, 0 ATC 0 buys',         { spend: 36.00, linkClicks: 20, cpcLink: 1.80, atc: 0, purchases: 0 }, 25],
  ['I. CPC $1.80, $36 spend, 20h, 0 ATC 0 buys',         { spend: 36.00, linkClicks: 20, cpcLink: 1.80, atc: 0, purchases: 0 }, 20],
  ['J. CPC $1.80, $71 spend, 30h, 2 ATC 0 buys',         { spend: 71.00, linkClicks: 39, cpcLink: 1.80, atc: 2, purchases: 0 }, 30],
  ['K. CPC $1.80, $71 spend, 30h, 2 ATC 1 buy',          { spend: 71.00, linkClicks: 39, cpcLink: 1.80, atc: 2, purchases: 1 }, 30],
  ['L. CPC $3.01 but only $20 spend, 2h',                { spend: 20.00, linkClicks: 6,  cpcLink: 3.01, atc: 0, purchases: 0 }, 2],
  ['M. CT89 replay: $40 spend, CPC $2.23, 5h',           { spend: 40.00, linkClicks: 18, cpcLink: 2.23, atc: 0, purchases: 0 }, 5],
  ['N. CT83 replay: $16 spend, CPC $2.29, 6h',           { spend: 16.00, linkClicks: 7,  cpcLink: 2.29, atc: 0, purchases: 0 }, 6],
  // --- Rule1/Rule2 floor-gap regressions (the $16.44-$25 band). Before the
  // 2026-07-18 gate change these were killed by Rule 2: single-strike, no
  // UNKILLED audit. All three must now STAY ON until $25 is actually spent.
  ['O. band: $17 spend, CPC $5.67, 25h, 0 ATC',          { spend: 17.00, linkClicks: 3,  cpcLink: 5.67, atc: 0, purchases: 0 }, 25],
  ['P. band: $20 spend, 0 link clicks, 26h',             { spend: 20.00, linkClicks: 0,  cpcLink: null, atc: 0, purchases: 0 }, 26],
  ['Q. band: $24 spend, CPC $6.00, 26h, 0 ATC',          { spend: 24.00, linkClicks: 4,  cpcLink: 6.00, atc: 0, purchases: 0 }, 26],
  // Throttled adset: 24h elapsed but barely spent. Must NOT die on $12.
  ['R. throttled: $12 spend, CPC $2.00, 30h, 0 ATC',     { spend: 12.00, linkClicks: 6,  cpcLink: 2.00, atc: 0, purchases: 0 }, 30],
  // Once it clears $25 with a full day and no carts, Rule 2 SHOULD fire.
  ['S. $26 spend, CPC $2.00, 25h, 0 ATC',                { spend: 26.00, linkClicks: 13, cpcLink: 2.00, atc: 0, purchases: 0 }, 25],
  // Rule 3 still keyed to 2x breakeven ($32.88), unchanged.
  ['T. $33 spend, CPC $2.00, 30h, 1 ATC, 0 buys',        { spend: 33.00, linkClicks: 16, cpcLink: 2.00, atc: 1, purchases: 0 }, 30],
];

for (const [label, m, hours] of scenarios) {
  const v = evaluate(m, hours, BREAKEVEN);
  console.log(`${label}\n   → ${v ? `KILL (${v.rule}): ${v.reason}` : 'STAYS ON'}\n`);
}

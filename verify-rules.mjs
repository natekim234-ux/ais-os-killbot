// Scenario verification for the link-click CPC switch — imports the REAL
// evaluate() from killbot.mjs (not a copy) so what passes here is what runs.
process.env.META_ACCESS_TOKEN = 'dummy';
process.env.META_AD_ACCOUNT_ID = 'act_dummy';
process.env.GOOGLE_SA_JSON = '{"client_email":"d","private_key":"d"}';

const { evaluate } = await import('./killbot.mjs');

const BREAKEVEN = 35.31;

// m shape: { spend, linkClicks, cpcLink, atc, purchases }
const scenarios = [
  ['A. $12 spend, CPC $4.00 (3 clicks), 4h',            { spend: 12.00, linkClicks: 3, cpcLink: 4.00, atc: 0, purchases: 0 }, 4],
  ['B. $16 spend, CPC $2.29 (7 clicks), 6h  [CT83 true]',{ spend: 16.00, linkClicks: 7, cpcLink: 2.29, atc: 0, purchases: 0 }, 6],
  ['C. $16 spend, CPC $2.50 exactly, 6h',                { spend: 16.00, linkClicks: 6, cpcLink: 2.50, atc: 0, purchases: 0 }, 6],
  ['D. $16 spend, CPC $2.51, 6h',                        { spend: 16.00, linkClicks: 6, cpcLink: 2.51, atc: 0, purchases: 0 }, 6],
  ['E. $21.48 spend, CPC $3.07 (7 clicks), 6h [CT82]',   { spend: 21.48, linkClicks: 7, cpcLink: 3.07, atc: 0, purchases: 0 }, 6],
  ['F. $15.00 spend, 0 link clicks, 3h',                 { spend: 15.00, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 3],
  ['G. $14.99 spend, 0 link clicks, 3h',                 { spend: 14.99, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 3],
  ['H. CPC $1.80, $36 spend, 25h, 0 ATC 0 buys',         { spend: 36.00, linkClicks: 20, cpcLink: 1.80, atc: 0, purchases: 0 }, 25],
  ['I. CPC $1.80, $36 spend, 20h, 0 ATC 0 buys',         { spend: 36.00, linkClicks: 20, cpcLink: 1.80, atc: 0, purchases: 0 }, 20],
  ['J. CPC $1.80, $71 spend, 30h, 2 ATC 0 buys',         { spend: 71.00, linkClicks: 39, cpcLink: 1.80, atc: 2, purchases: 0 }, 30],
  ['K. CPC $1.80, $71 spend, 30h, 2 ATC 1 buy',          { spend: 71.00, linkClicks: 39, cpcLink: 1.80, atc: 2, purchases: 1 }, 30],
  ['L. CPC $2.51 but only $10 spend, 2h',                { spend: 10.00, linkClicks: 4,  cpcLink: 2.51, atc: 0, purchases: 0 }, 2],
];

for (const [label, m, hours] of scenarios) {
  const v = evaluate(m, hours, BREAKEVEN);
  console.log(`${label}\n   → ${v ? `KILL (${v.rule}): ${v.reason}` : 'STAYS ON'}\n`);
}

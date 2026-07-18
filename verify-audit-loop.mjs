// Drives the REAL helpers the audit loop uses, with the REAL argument shapes
// the production code passes them.
//
// Why this file exists: verify-pending.mjs re-implements the production branch
// in a local simulate(). That design let a hard crash ship undetected —
// killbot.mjs called hoursSince(startJ.start_time) with Meta's raw ISO STRING
// while hoursSince() did d.getTime(), which only works on a Date. Every
// inherited audit threw, was swallowed by the audit loop's catch, and the
// adset stayed paused forever. The test suite was green the whole time because
// it passed a hardcoded number for hours and never touched the derivation.
//
// Rule for anything added here: pass the argument in the SAME SHAPE the real
// callsite passes it. Never pre-convert on the test's behalf.
process.env.META_ACCESS_TOKEN = 'dummy';
process.env.META_AD_ACCOUNT_ID = 'act_dummy';
process.env.GOOGLE_SA_JSON = '{"client_email":"d","private_key":"d"}';

const { hoursSince, nonCpcVerdict, evaluate } = await import('./killbot.mjs');

const BREAKEVEN = 16.44;
let failures = 0;

function check(label, fn, expect) {
  let got;
  try {
    got = fn();
  } catch (e) {
    got = `THREW: ${e.message}`;
  }
  const ok = typeof expect === 'function' ? expect(got) : got === expect;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got: ${got}`);
}

console.log('--- hoursSince() must accept every shape production passes it ---\n');

// The exact shape Meta returns from metaGet(adsetId, {fields:'start_time'}).
const META_START_TIME = '2026-07-17T11:00:00-0700';

check(
  'raw Meta start_time STRING (the shape that crashed the audit loop)',
  () => hoursSince(META_START_TIME),
  (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
);

check(
  'new Date(start_time) — the main-loop callsite shape',
  () => hoursSince(new Date(META_START_TIME)),
  (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
);

check(
  'both shapes agree to within a millisecond',
  () => Math.abs(hoursSince(META_START_TIME) - hoursSince(new Date(META_START_TIME))) < 1e-6,
  true,
);

check(
  'unparseable input returns NaN rather than throwing',
  () => Number.isNaN(hoursSince('not-a-date')),
  true,
);

check(
  'epoch ms number also works',
  () => hoursSince(Date.now() - 36e5),
  (v) => Math.abs(v - 1) < 0.01,
);

console.log('\n--- inherited-audit guard, driven end to end ---\n');

// Reproduces the guard block in killbot.mjs: on an AUDIT-INH row whose settled
// CPC recovered, re-check whether the rule that actually executed the kill
// still holds on settled data. Uses the raw string exactly as production does.
function guardDecision(settledMetrics, startTimeString) {
  const sHours = hoursSince(new Date(startTimeString));
  if (!Number.isFinite(sHours)) return 'RETRY (unparseable start_time)';
  const stillCondemned = nonCpcVerdict(settledMetrics, sHours, BREAKEVEN);
  return stillCondemned ? `CONFIRMED (${stillCondemned.rule} still holds)` : 'REACTIVATE';
}

const t26hAgo = new Date(Date.now() - 26 * 36e5).toISOString();
const t6hAgo = new Date(Date.now() - 6 * 36e5).toISOString();

check(
  'CPC recovered but still 0 ATC at 26h and >=$25 → stays dead',
  () => guardDecision({ spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 0, purchases: 0 }, t26hAgo),
  'CONFIRMED (Rule 2 still holds)',
);

check(
  'CPC recovered, 1 ATC, under 2x breakeven → genuine false kill, reactivate',
  () => guardDecision({ spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 1, purchases: 0 }, t26hAgo),
  'REACTIVATE',
);

check(
  'CPC recovered, only 6h old → nothing else holds, reactivate',
  () => guardDecision({ spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 0, purchases: 0 }, t6hAgo),
  'REACTIVATE',
);

check(
  'CPC recovered, 1 ATC, past 2x breakeven, no purchase → Rule 3 holds, stays dead',
  () => guardDecision({ spend: 40, linkClicks: 19, cpcLink: 2.1, atc: 1, purchases: 0 }, t26hAgo),
  'CONFIRMED (Rule 3 still holds)',
);

check(
  'unparseable start_time → retry, never a silent reactivate',
  () => guardDecision({ spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 0, purchases: 0 }, 'garbage'),
  'RETRY (unparseable start_time)',
);

console.log('\n--- audit blank-insights floor guard ---\n');

// The audit loop refuses to confirm on a settled read below the Rule 1 floor,
// because a Rule 1 kill required >=$25 — anything less is a partial response.
check(
  'settled spend below $25 is treated as blank, not as a confirmation',
  () => (evaluate({ spend: 12, linkClicks: 6, cpcLink: 2.0, atc: 0, purchases: 0 }, 30, BREAKEVEN) === null),
  true,
);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);

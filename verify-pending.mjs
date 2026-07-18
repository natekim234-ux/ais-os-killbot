// Verification for the PENDING / audit-entitlement path.
//
// The plain rule table (verify-rules.mjs) only exercises evaluate(). It cannot
// see the bug class that shipped on 2026-07-18: while a Rule 1 (CPC) breach
// sits in its 45-minute confirmation window, the bot re-evaluates with the CPC
// branch muted (nonCpcVerdict) so Rules 2/3 aren't shadowed. If a non-CPC rule
// fires there, the kill executes SINGLE-STRIKE. Before the fix that kill also
// lost the UNKILLED audit, because the audit row was only written for
// verdict.rule === 'Rule 1'. Net effect: an unsettled CPC spike on an adset
// ≥24h old with 0 ATC died instantly with no path back — the exact false-kill
// class the audit exists to reverse.
//
// The fix carries the entitlement: any kill that happens while a Rule 1 breach
// is pending is written as type 'AUDIT-INH' and re-checked on settled data.
// An inherited audit additionally requires the EXECUTING rule to have cleared
// before it will reactivate, so a genuine zero-intent adset is not resurrected
// just because its CPC settled.
process.env.META_ACCESS_TOKEN = 'dummy';
process.env.META_AD_ACCOUNT_ID = 'act_dummy';
process.env.GOOGLE_SA_JSON = '{"client_email":"d","private_key":"d"}';

const { evaluate, nonCpcVerdict } = await import('./killbot.mjs');

const BREAKEVEN = 16.44; // live KPI sheet G2
const CPC_MIN_SPEND = 25;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got: ${actual}\n        want: ${expected}`);
}

// Mirrors the production branch: evaluate() flags Rule 1 → PENDING, then the
// bot asks nonCpcVerdict() whether anything else kills it right now.
function simulate(m, hours) {
  const first = evaluate(m, hours, BREAKEVEN);
  if (first?.rule !== 'Rule 1') {
    return { executed: first ? first.rule : 'STAYS ON', auditType: first ? null : null };
  }
  const other = nonCpcVerdict(m, hours, BREAKEVEN);
  if (!other) return { executed: 'PENDING (no kill yet)', auditType: null };
  // Kill executes under `other.rule`, single-strike, but inherits the audit.
  return { executed: other.rule + ' (single-strike)', auditType: 'AUDIT-INH' };
}

console.log('--- Rule 1 pending, another rule executes: must still earn an audit ---\n');

// The headline case. CPC breach + 24h + 0 ATC. Rule 2 executes single-strike.
// It MUST be written as AUDIT-INH so a settled-CPC recovery can reverse it.
{
  const r = simulate({ spend: 26, linkClicks: 6, cpcLink: 4.0, atc: 0, purchases: 0 }, 25);
  check('$26 / CPC $4.00 / 25h / 0 ATC → executes Rule 2', r.executed, 'Rule 2 (single-strike)');
  check('  ...and inherits the audit', r.auditType, 'AUDIT-INH');
}

// Zero-click variant. nonCpcVerdict fakes linkClicks:1/cpc:0.01 to mute the CPC
// branch, so this also lands on Rule 2. Same entitlement requirement.
{
  const r = simulate({ spend: 26, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 25);
  check('$26 / 0 clicks / 25h / 0 ATC → executes Rule 2', r.executed, 'Rule 2 (single-strike)');
  check('  ...and inherits the audit', r.auditType, 'AUDIT-INH');
}

// Rule 3 variant: CPC breach + ATC present + past 2x breakeven.
{
  const r = simulate({ spend: 40, linkClicks: 10, cpcLink: 4.0, atc: 1, purchases: 0 }, 30);
  check('$40 / CPC $4.00 / 30h / 1 ATC → executes Rule 3', r.executed, 'Rule 3 (single-strike)');
  check('  ...and inherits the audit', r.auditType, 'AUDIT-INH');
}

// Inside 24h with no ATC yet, nothing else holds → stays PENDING, two-strike
// protection intact. This is the case the confirmation window is FOR.
{
  const r = simulate({ spend: 26, linkClicks: 6, cpcLink: 4.0, atc: 0, purchases: 0 }, 5);
  check('$26 / CPC $4.00 / 5h / 0 ATC → stays pending (2-strike holds)', r.executed, 'PENDING (no kill yet)');
}

// A converting adset inside 24h: CPC breach pending, but nothing else fires.
{
  const r = simulate({ spend: 30, linkClicks: 8, cpcLink: 3.75, atc: 2, purchases: 1 }, 10);
  check('$30 / CPC $3.75 / 10h / 2 ATC 1 buy → stays pending', r.executed, 'PENDING (no kill yet)');
}

console.log('\n--- Inherited audit must NOT resurrect a genuine zero-intent adset ---\n');

// Settled data: CPC recovered to $2.10 (below the $3 line) BUT still 0 ATC at
// 25h and ≥$25. The executing rule (Rule 2) still holds → kill stays confirmed.
{
  const settled = { spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 0, purchases: 0 };
  const stillCondemned = nonCpcVerdict(settled, 25, BREAKEVEN);
  check('settled CPC $2.10 but 0 ATC at 25h → Rule 2 still holds', stillCondemned?.rule ?? 'none', 'Rule 2');
}

// Settled data: CPC recovered AND a cart exists, under 2x breakeven. Nothing
// else holds → genuine false kill, reactivate.
{
  const settled = { spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 1, purchases: 0 };
  const stillCondemned = nonCpcVerdict(settled, 25, BREAKEVEN);
  check('settled CPC $2.10, 1 ATC, $30 (<2x BE) → nothing holds, reactivate', stillCondemned?.rule ?? 'none', 'none');
}

// Settled data inside 24h with CPC recovered → nothing holds, reactivate.
{
  const settled = { spend: 30, linkClicks: 14, cpcLink: 2.1, atc: 0, purchases: 0 };
  const stillCondemned = nonCpcVerdict(settled, 6, BREAKEVEN);
  check('settled CPC $2.10, 0 ATC, only 6h → nothing holds, reactivate', stillCondemned?.rule ?? 'none', 'none');
}

console.log('\n--- Floor guard: nothing dies below $25 by any path ---\n');

for (const [label, m, h] of [
  ['$17 / CPC $5.67 / 25h / 0 ATC', { spend: 17, linkClicks: 3, cpcLink: 5.67, atc: 0, purchases: 0 }, 25],
  ['$24 / 0 clicks / 26h', { spend: 24, linkClicks: 0, cpcLink: null, atc: 0, purchases: 0 }, 26],
  ['$12 throttled / 30h / 0 ATC', { spend: 12, linkClicks: 6, cpcLink: 2.0, atc: 0, purchases: 0 }, 30],
]) {
  const direct = evaluate(m, h, BREAKEVEN);
  const muted = nonCpcVerdict(m, h, BREAKEVEN);
  check(`${label} → evaluate()`, direct?.rule ?? 'STAYS ON', 'STAYS ON');
  check(`${label} → nonCpcVerdict()`, muted?.rule ?? 'STAYS ON', 'STAYS ON');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);

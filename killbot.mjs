#!/usr/bin/env node
// Hushlab Killbot — adset-level enforcement of kill rules + auto-population
// of the Hushlab Learnings Google Doc when an adset is paused.
//
// ─────────────────────────────────────────────────────────────────────────────
// KILL RULES (locked 2026-05-25, adset level)
// ─────────────────────────────────────────────────────────────────────────────
//
// Rule 1 — CPC mechanical kill
//   IF adset.spend ≥ $15 AND (link_clicks = 0 OR cpc > $2.50) → PAUSE adset.
//   CPC here = cost per LINK click (Ads Manager's "CPC (cost per link click)"
//   column — the metric Nate's Performance view and the Hit Rate sheet use).
//   Switched from outbound clicks 2026-07-09 after the CT83 false kill: at
//   trigger time Meta had reported only 3 of what settled to 8 clicks, so the
//   bot computed $5.48 while the true CPC was $2.29. Outbound-click reporting
//   lags link-click reporting by up to hours on fresh adsets; link clicks are
//   both the rule's actual definition and the fresher signal.
//   Reasoning: a new adset = a new test. If click economics are broken once
//   $15 is spent, the test is failing fast. Doing this at the adset level
//   (not campaign) prevents a single bad test from hiding inside a healthy
//   CBO's averaged CPC. The $15 floor is half the prior $30 campaign floor —
//   split per-adset, the noise tolerance scales with the spend per test.
//   The zero-click branch (added 2026-06-16) is critical: a dead ad with 0
//   link clicks has a NULL cost-per-link-click, so the cpc > $2.50 test
//   silently skips it — meaning the WORST ads were the most protected. CT41
//   drifted to $53 with 0 clicks before any other rule caught it. Now $15 spent
//   with 0 clicks = infinite effective CPC = immediate kill.
//
//   TWO-STRIKE CONFIRMATION (added 2026-07-10 after the CT84 false kill):
//   a Rule 1 breach no longer kills on first sight. The first breach writes a
//   PENDING flag (Bot Pending tab); the kill executes only if the breach still
//   holds on a later run ≥45 min after the first flag. Why: Meta's insights
//   reporting on FRESH adsets lags real clicks by up to ~1h for link clicks
//   too, not just outbound (CT83: 3 of 8 clicks reported → phantom $5.48 CPC,
//   true $2.29; CT84: 5 of 8 reported → phantom $3.85, true ~$2.40). A single
//   snapshot in hours 1-2 is unreliable; 45 min later the ledger has settled.
//   Cost on a TRUE loser: ~$10-12 extra spend. Rules 2/3 keep single-strike —
//   they're cumulative-spend + time-gated, so lag can't fake them.
//
//   POST-KILL AUDIT (same date): ≥60 min after any Rule 1 kill, the bot
//   re-pulls settled insights for the killed adset. If settled CPC ≤ $2.50
//   with ≥1 link click, the kill was false — the bot reactivates the adset,
//   restores the sheet Status to ACTIVE, clears the Results line, and logs
//   UNKILLED to Bot Log. False kills self-heal within ~2 hours.
//
// Rule 2 — Zero buying intent at 1× breakeven CPP
//   IF adset.spend ≥ 1× breakeven CPP ($14.84 as of 2026-07-10 KPI sheet)
//      AND adset.hours_since_start ≥ 24
//      AND adset.ATC = 0 AND adset.purchases = 0
//   → PAUSE adset.
//   Reasoning: by definition we've spent one full CPP worth of budget and
//   produced zero buying signal across a full 24h cycle. The click→site
//   transition is broken (or the offer/LP is) — the ad is not profitable
//   and not getting more rope.
//
// Rule 3 — Post-ATC bleed at 2× breakeven CPP
//   IF adset.spend ≥ 2× breakeven CPP ($29.69 as of 2026-07-10 KPI sheet)
//      AND adset.ATC ≥ 1 AND adset.purchases = 0
//   → PAUSE adset.
//   Reasoning: an ATC proves click→cart works, so it earns more rope than
//   Rule 2 — but at 2× breakeven with no purchase, the cart is dying at
//   checkout. That's a copy/urgency problem (not a traffic problem) and is
//   very unlikely to flip profitable. Kill the test, iterate the copy.
//
// Rule 4 — REMOVED (was: 7-day verdict). Distracting; not needed now.
//
// All breakeven values pull live from KPI sheet G2. Fixed-dollar values in
// Rule 1 ($15, $2.50) are click economics, not CPP-derived, so they don't
// scale with AOV/COGS changes.
//
// ─────────────────────────────────────────────────────────────────────────────
// SIDE EFFECTS WHEN AN ADSET IS PAUSED
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. Meta API: POST status=PAUSED on the adset.
// 2. Hit Rate sheet (adset's launch-month tab — e.g. May, June): write
//    'PAUSED' to column R for that row.
// 3. Bot Log: append the kill record.
// 4. Learnings Doc: create a new tab named after the adset and pre-fill:
//    - Metrics block (Date Range = adset start → today, spend, ROAS, CPA,
//      Frequency, CPM, CTR, CPC, % of Spend Last 7 Days)
//    - Result: Loser
//    - Old Hypothesis (pulled verbatim from sheet column P)
//    - Empty Learnings + New Hypothesis sections for Nate to fill in
//
// ─────────────────────────────────────────────────────────────────────────────
// AD SET ID AUTO-FILL
// ─────────────────────────────────────────────────────────────────────────────
//
// Sheet column W = Ad Set ID. If a row's W is blank, killbot lists adsets in
// every ACTIVE campaign and prefix-matches by Creative Test # against adset
// name (e.g. row 'CT12' → adset whose name starts with 'CT12'). On match it
// writes the ID back to W. If no match: log a warning, skip the row.

import { google } from 'googleapis';

const SHEET_ID = '1NuOZWgP0mGhJ_MO6vevXj9EEpSxM94iUsFOULsEjehs';
const BOT_LOG_SHEET_ID = 352736976; // 'Bot Log' tab sheetId (for batchUpdate dimension ops)
const KPI_SHEET_ID = '1GWTUjvuYnSrn64nrqfLB9AsAKwDm4JCnk6c4nbhWM1A';
// The active Learnings doc rolls over when it hits Google's 100-tab limit (see
// rolloverLearningsDoc). The current doc ID is the source of truth in
// Bot Control!B7 — main() reads it each run and rewrites it on rollover, so no
// code edit/redeploy is ever needed. The constants below are only fallbacks.
const LEARNINGS_DOC_CELL = 'Bot Control!B7';
const LEARNINGS_DOC_FALLBACK = '1wURgBX75Jo95Q9CZ8F5k5AlLCZKHWLaztaicXm4QDrM'; // fresh CT62+ doc
const LEARNINGS_FOLDER_ID = '1toR3RakgP2VjSidpeqEeG1DWfIzzeWOF'; // "Learning Docs" — archives live here
// Resolved at the top of main() from LEARNINGS_DOC_CELL (falling back to the
// constant above). Mutated in place by rolloverLearningsDoc.
let LEARNINGS_DOC_ID = LEARNINGS_DOC_FALLBACK;
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// Sheet tab per ad is derived from the adset's launch month (e.g. start_time
// 2026-06-01 → 'June' tab). A May-launched adset that gets paused in June still
// writes to its May row. Avoids the prior bug where a hardcoded 'May' silently
// no-op'd every June ad (no rowNum match → no status write, no hypothesis pull,
// no Ad Set ID autofill).
function tabNameForIso(iso) {
  return MONTH_NAMES[new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getUTCMonth()];
}
const META_API = 'https://graph.facebook.com/v25.0';
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const RECONCILE_WINDOW_DAYS = 7; // refresh settled metrics for adsets paused within this many days

const CPC_MIN_SPEND = 15;
const CPC_KILL = 2.5;

// Rule 1 two-strike + post-kill audit (see header). State lives on the
// 'Bot Pending' sheet tab so it survives across runs (bot is stateless).
const PENDING_TAB = 'Bot Pending';
const CONFIRM_MINUTES = 45; // first Rule-1 flag must be at least this old before a kill can execute
const AUDIT_MIN_MINUTES = 60; // re-check settled CPC this long after a Rule 1 kill
const PENDING_STALE_HOURS = 24; // prune state rows older than this (adset gone, manual pause, etc.)

const META_TOKEN = need('META_ACCESS_TOKEN');
const AD_ACCOUNT = need('META_AD_ACCOUNT_ID');
const SA_JSON = JSON.parse(need('GOOGLE_SA_JSON'));

// Hushlab runs the same product/creative across more than one ad account (e.g. a
// 2nd account used to test whether CPMs are throttled at the account level). The
// same rules apply to every account; we just loop over all of them each run.
// Account 1 is required; account 2+ are optional so the bot degrades gracefully
// if the extra env var isn't set. Same BM + same token reaches all of them.
// `label` is what shows in the Bot Log "Account" column so kills are traceable.
const AD_ACCOUNTS = [
  { id: AD_ACCOUNT, label: 'Hushlab Ad Account 1' },
  ...(process.env.META_AD_ACCOUNT_ID_2
    ? [{ id: process.env.META_AD_ACCOUNT_ID_2, label: 'Hushlab Ad Account 2' }]
    : []),
];

function need(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

// Convert a zero-based column index to an A1 column letter (0→A, 25→Z, 26→AA).
// Sheet writes resolve their target column by HEADER NAME via the idx map, then
// convert to a letter here — so inserting/moving a column (e.g. the "Account"
// dropdown between Status and Results) can never misalign a write. Never
// hardcode column letters for row writes.
function colA1(index) {
  let n = index, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const auth = new google.auth.JWT(SA_JSON.client_email, null, SA_JSON.private_key, [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  // drive scope: rename the full doc on rollover + move it into Learning Docs.
  'https://www.googleapis.com/auth/drive',
]);
const sheets = google.sheets({ version: 'v4', auth });
const docs = google.docs({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

// ---------- Meta ----------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Meta rate-limit / transient errors worth retrying. Codes: 4 (app limit),
// 17 (user request limit reached), 32/613 (page/call rate), 80000/80004 (ad acct
// limits), 1 & 2 (transient/unknown). Plus any HTTP 5xx. The 2026-06-25 fatal was
// code 17 ("User request limit reached") from the schedule cron double-firing on
// top of the heartbeat chain — exactly what this retry absorbs.
function isRetryableMetaError(err, httpStatus) {
  if (httpStatus >= 500) return true;
  return [1, 2, 4, 17, 32, 613, 80000, 80004].includes(err?.code);
}

async function metaGet(path, params = {}, attempt = 0) {
  const MAX_RETRIES = 4;
  const u = new URL(`${META_API}/${path}`);
  u.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (j.error) {
    if (isRetryableMetaError(j.error, r.status) && attempt < MAX_RETRIES) {
      const backoff = Math.min(2000 * 2 ** attempt, 30000); // 2s,4s,8s,16s (cap 30s)
      console.log(
        `[retry] Meta GET ${path} hit "${j.error.message}" (code ${j.error.code}); ` +
          `attempt ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms`
      );
      await sleep(backoff);
      return metaGet(path, params, attempt + 1);
    }
    const e = new Error(`Meta GET ${path}: ${j.error.message}`);
    // Retryable error that exhausted all attempts = Meta is throttling us longer
    // than our backoff window. Not a bug — tag it so the top-level handler can
    // SKIP this tick (exit 0) instead of emitting a false GitHub failure email.
    // The next ~14-min tick covers the skipped one; no budget is lost.
    if (isRetryableMetaError(j.error, r.status)) e.transientThrottle = true;
    throw e;
  }
  return j;
}

async function metaPause(objectId) {
  if (DRY_RUN) return { dry_run: true };
  const u = new URL(`${META_API}/${objectId}`);
  const body = new URLSearchParams({ status: 'PAUSED', access_token: META_TOKEN });
  const r = await fetch(u, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(`Meta pause ${objectId}: ${j.error.message}`);
  return j;
}

// Reactivate an adset the bot itself paused (post-kill audit un-kill path).
// Never called for anything the bot didn't pause via Rule 1 this same day.
async function metaActivate(objectId) {
  if (DRY_RUN) return { dry_run: true };
  const u = new URL(`${META_API}/${objectId}`);
  const body = new URLSearchParams({ status: 'ACTIVE', access_token: META_TOKEN });
  const r = await fetch(u, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(`Meta activate ${objectId}: ${j.error.message}`);
  return j;
}

// Current delivery status of a single adset (audit pass checks the adset is
// still PAUSED before un-killing, so it never fights a manual change).
async function fetchAdsetStatus(adsetId) {
  const j = await metaGet(adsetId, { fields: 'status' });
  return j.status;
}

// All ACTIVE adsets in a given ad account, with their parent campaign id/name.
// Each adset is tagged with the account's label so downstream logging can show
// which account it came from. Returns
// [{id, name, campaign_id, campaign_name, start_time, accountId, accountLabel}].
async function getActiveAdsets(account) {
  const adsets = (await metaGet(`${account.id}/adsets`, {
    fields: 'id,name,status,start_time,campaign{id,name,status}',
    limit: '200',
  })).data ?? [];
  return adsets
    .filter((a) => a.status === 'ACTIVE' && a.campaign?.status === 'ACTIVE' && a.start_time)
    .map((a) => ({
      id: a.id,
      name: a.name,
      campaign_id: a.campaign.id,
      campaign_name: a.campaign.name,
      start_time: a.start_time,
      accountId: account.id,
      accountLabel: account.label,
    }));
}

// Adset insights over its own run window (start_time → today).
async function fetchAdsetMetrics(adsetId, sinceDate) {
  const today = new Date().toISOString().slice(0, 10);
  const j = await metaGet(`${adsetId}/insights`, {
    time_range: JSON.stringify({ since: sinceDate, until: today }),
    fields: [
      'spend',
      'impressions',
      'reach',
      'frequency',
      'cpm',
      'ctr',
      'cpc',
      'actions',
      'action_values',
      'cost_per_action_type',
    ].join(','),
    level: 'adset',
  });
  const d = j.data?.[0] ?? {};
  const spend = Number(d.spend ?? 0);
  const impressions = Number(d.impressions ?? 0);
  const linkClicks = sumAction(d.actions, ['link_click']);
  const ctrLink = impressions > 0 ? (linkClicks / impressions) * 100 : null;
  // CPC = cost per LINK click (matches Ads Manager's "CPC (cost per link
  // click)" column and the Hit Rate sheet). Null when no clicks yet.
  const cpcLink = pickCost(d.cost_per_action_type, ['link_click']);
  const atc = pickAction(d.actions, ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart']);
  const purchases = pickAction(d.actions, ['purchase', 'offsite_conversion.fb_pixel_purchase']);
  const cpp = pickCost(d.cost_per_action_type, ['purchase', 'offsite_conversion.fb_pixel_purchase']);
  const revenue = pickActionValue(d.action_values, ['purchase', 'offsite_conversion.fb_pixel_purchase']);
  const roas = spend > 0 ? revenue / spend : 0;
  return {
    spend,
    impressions,
    frequency: Number(d.frequency ?? 0),
    cpm: Number(d.cpm ?? 0),
    ctrLink,
    cpcLink,
    linkClicks,
    atc,
    purchases,
    cpp,
    revenue,
    roas,
  };
}

// Pull the ad copy body from the FIRST ad under an adset. Used for the Copy
// sub-tab. Meta exposes this under creative.object_story_spec.link_data.message
// (link ads) or .video_data.message (video ads) or just .body for the older
// shape. We fetch all candidate fields and prefer in that order.
async function fetchAdCopyBody(adsetId) {
  try {
    const ads = (await metaGet(`${adsetId}/ads`, { fields: 'id,name,creative{body,object_story_spec}', limit: '5' })).data ?? [];
    for (const ad of ads) {
      const c = ad.creative ?? {};
      const story = c.object_story_spec ?? {};
      const candidates = [
        story.link_data?.message,
        story.video_data?.message,
        story.template_data?.message,
        c.body,
      ];
      for (const t of candidates) {
        if (typeof t === 'string' && t.trim().length > 0) return t;
      }
    }
    return '';
  } catch (e) {
    console.log(`  ! Ad copy fetch failed for ${adsetId}: ${e.message}`);
    return '';
  }
}

// Campaign-window adset spend, for "% of Spend (Last 7 Days)" relative to the
// adset's campaign over the last 7 days. Used for the Learnings doc only.
async function fetchPctOfCampaignSpend7d(adsetId, campaignId) {
  try {
    // Meta's `last_7d` preset EXCLUDES today, which silently zeroes adsets that
    // only ran today (e.g. CT16/CT17 launched 5/26 → 0% of last_7d). Use an
    // explicit rolling window: today-6 → today, inclusive of today.
    const until = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const range = JSON.stringify({ since, until });
    const [adsetJ, campJ] = await Promise.all([
      metaGet(`${adsetId}/insights`, { time_range: range, fields: 'spend', level: 'adset' }),
      metaGet(`${campaignId}/insights`, { time_range: range, fields: 'spend', level: 'campaign' }),
    ]);
    const aSpend = Number(adsetJ.data?.[0]?.spend ?? 0);
    const cSpend = Number(campJ.data?.[0]?.spend ?? 0);
    if (cSpend <= 0) return null;
    return (aSpend / cSpend) * 100;
  } catch {
    return null;
  }
}

function sumAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter((a) => types.includes(a.action_type))
    .reduce((s, a) => s + Number(a.value ?? 0), 0);
}

// Meta deduplicates conversions across action_type aliases (e.g. `purchase` and
// `offsite_conversion.fb_pixel_purchase` both report the same count). Summing
// all matching keys double-counts. Use the first match in priority order instead.
function pickAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const type of types) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit != null) return Number(hit.value ?? 0);
  }
  return 0;
}

function pickActionValue(values, types) {
  if (!Array.isArray(values)) return 0;
  for (const type of types) {
    const hit = values.find((a) => a.action_type === type);
    if (hit != null) return Number(hit.value ?? 0);
  }
  return 0;
}

function sumActionValue(values, types) {
  if (!Array.isArray(values)) return 0;
  return values
    .filter((a) => types.includes(a.action_type))
    .reduce((s, a) => s + Number(a.value ?? 0), 0);
}

function pickCost(arr, types) {
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((a) => types.includes(a.action_type));
  return hit ? Number(hit.value) : null;
}

// ---------- Sheets ----------

async function readRange(spreadsheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return data.values ?? [];
}

async function writeCell(spreadsheetId, range, value) {
  // USER_ENTERED (not RAW) so cells with data validation / dropdowns accept the
  // value — column R is a Status dropdown (ACTIVE / PAUSED / SCALED-FLAG /
  // HOLD-FLAG); RAW writes silently fail there.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

async function appendLog(row) {
  // USER_ENTERED for parity with writeCell — RAW silently fails if a dropdown
  // is ever added to Bot Log's columns. No downside here (plain text rows).
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bot Log!A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// ---------- Rule 1 two-strike / audit state (Bot Pending tab) ----------
//
// Row shape: [Adset ID, Type, Timestamp (UTC ISO), Adset Name, CPC, Spend, Note]
//   Type 'PENDING' — Rule 1 breach seen once; kill allowed only ≥CONFIRM_MINUTES later.
//   Type 'AUDIT'   — Rule 1 kill executed; settled re-check due ≥AUDIT_MIN_MINUTES later.
// The tab is tiny (a handful of rows) so each run reads it fully and rewrites
// it fully — no row-index bookkeeping to corrupt.

async function ensurePendingTab() {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: PENDING_TAB, gridProperties: { rowCount: 100, columnCount: 8 } } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${PENDING_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Adset ID', 'Type', 'Timestamp (UTC)', 'Adset Name', 'CPC', 'Spend', 'Note', 'Account']] },
    });
    console.log(`Created '${PENDING_TAB}' state tab.`);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }
}

async function readPendingState() {
  // DRY_RUN never creates the tab — a missing tab just means empty state.
  if (!DRY_RUN) await ensurePendingTab();
  let rows;
  try {
    rows = await readRange(SHEET_ID, `${PENDING_TAB}!A2:H100`);
  } catch (e) {
    if (DRY_RUN) return [];
    throw e;
  }
  return rows
    .filter((r) => String(r?.[0] ?? '').trim())
    .map((r) => ({
      adsetId: String(r[0]).trim(),
      type: String(r[1] ?? '').trim(),
      atIso: String(r[2] ?? '').trim(),
      name: String(r[3] ?? ''),
      cpc: String(r[4] ?? ''),
      spend: String(r[5] ?? ''),
      note: String(r[6] ?? ''),
      account: String(r[7] ?? ''),
    }))
    // A hand-mangled timestamp would otherwise make the row immortal (never
    // confirms, never prunes). Drop it; a live breach simply re-flags fresh.
    .filter((p) => {
      if (Number.isFinite(new Date(p.atIso).getTime())) return true;
      console.log(`! ${PENDING_TAB}: dropping row with unparseable timestamp (${p.adsetId} ${p.type} "${p.atIso}").`);
      return false;
    });
}

async function writePendingState(entries) {
  // One padded update over the full range — atomic, so a quota blip can't
  // land between a clear and a write and wipe every in-flight timer.
  const values = entries.map((p) => [p.adsetId, p.type, p.atIso, p.name, p.cpc, p.spend, p.note, p.account ?? '']);
  while (values.length < 99) values.push(['', '', '', '', '', '', '', '']);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PENDING_TAB}!A2:H100`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

// Rules 2/3 are single-strike and must not be shadowed while a Rule 1 breach
// sits in its pending window — re-evaluate with the CPC branch muted.
function nonCpcVerdict(m, hours, breakeven) {
  return evaluate({ ...m, cpcLink: 0.01, linkClicks: Math.max(1, m.linkClicks) }, hours, breakeven);
}

function minutesSinceIso(iso) {
  const t = new Date(iso).getTime();
  // Unparseable timestamp → treat as brand-new (-1). Fails SAFE: a corrupt
  // PENDING row can never satisfy the ≥45m confirmation and trigger a kill.
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : -1;
}

// ---------- Date helpers ----------

function hoursSince(d) {
  return (Date.now() - d.getTime()) / 36e5;
}

function dateFromIso(iso) {
  return String(iso ?? '').slice(0, 10);
}

// Bot Log timestamp in Eastern time (America/New_York handles EST/EDT
// automatically). Format: "2026-06-02 1:06 PM EDT". Bot Log is for human
// review, not parsing — readable beats ISO precision here.
function easternTimestamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${g('dayPeriod')} ${g('timeZoneName')}`;
}

function formatDateMDY(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

// ---------- Rules ----------

function evaluate(m, hoursSinceAdsetStart, breakeven) {
  // Rule 1a — zero-click kill. A dead ad gets NO link clicks, which means
  // cost-per-link-click is null and the CPC branch below silently skips it
  // (the worst ads were the most protected). If $15 is spent and not a single
  // link click landed, effective CPC is infinite — kill it. (Added 2026-06-16
  // after CT41 drifted to $53 with 0 clicks while invisible to the CPC branch.)
  if (m.spend >= CPC_MIN_SPEND && m.linkClicks === 0) {
    return {
      rule: 'Rule 1',
      reason: `Zero link clicks at $${m.spend.toFixed(2)} spend (≥$${CPC_MIN_SPEND} floor)`,
    };
  }
  // Rule 1b — CPC mechanical kill. Once clicks exist, kill if CPC > $2.50.
  // CPC = cost per link click (see header) — switched from outbound 2026-07-09.
  if (m.spend >= CPC_MIN_SPEND && m.cpcLink != null && m.cpcLink > CPC_KILL) {
    return {
      rule: 'Rule 1',
      reason: `CPC $${m.cpcLink.toFixed(2)} > $${CPC_KILL.toFixed(2)} at $${m.spend.toFixed(2)} spend`,
    };
  }
  if (
    m.spend >= breakeven &&
    hoursSinceAdsetStart >= 24 &&
    m.atc === 0 &&
    m.purchases === 0
  ) {
    return {
      rule: 'Rule 2',
      reason: `Zero buying intent at $${m.spend.toFixed(2)} after ${hoursSinceAdsetStart.toFixed(1)}h (≥1× breakeven $${breakeven.toFixed(2)})`,
    };
  }
  const atcKillLine = 2 * breakeven;
  if (m.spend >= atcKillLine && m.atc >= 1 && m.purchases === 0) {
    return {
      rule: 'Rule 3',
      reason: `Post-ATC bleed: ${m.atc} ATC, 0 purchases at $${m.spend.toFixed(2)} (≥2× breakeven $${atcKillLine.toFixed(2)})`,
    };
  }
  return null;
}

// ---------- Ad Set ID auto-fill ----------

// Sheet column W (zero-indexed 22) = Ad Set ID. Column A (0) = Creative Test #.
// For any row missing W, match by adset name starting with `CT<#>` and write back.
// `tab` is the sheet tab the rows came from (e.g. 'May', 'June') — every write
// targets that same tab.
async function autofillAdSetIds(rows, header, idx, activeAdsets, tab) {
  const adsetById = new Map(activeAdsets.map((a) => [a.id, a]));
  // Match `CT<#>` anywhere in the adset name with word boundaries on both
  // sides. Handles both `CT12 | Breathe | Lead v2` (old convention) and
  // `05.25.26 | CT14 | Breathe` (new dated convention).
  //
  // IMPORTANT (multi-account): the SAME CT# can run in more than one ad account
  // at once (same product/creative across Account 1 and Account 2). So a CT#
  // maps to a LIST of candidate adsets, not one. Auto-fill must never guess
  // across accounts — it disambiguates by the row's "Ad Account" column, and
  // refuses (leaves blank + warns) when the CT# is ambiguous and the row gives
  // no account signal. Picking "last one wins" here would silently write the
  // wrong account's Ad Set ID into a row and corrupt all downstream tracking.
  const adsetsByCt = new Map(); // ct -> [adset, ...]
  for (const a of activeAdsets) {
    const m = a.name.match(/\bCT(\d+)\b/i);
    if (!m) continue;
    if (!adsetsByCt.has(m[1])) adsetsByCt.set(m[1], []);
    adsetsByCt.get(m[1]).push(a);
  }

  // Resolve the single adset a row should map to, given its CT#, the tab it
  // lives on (launch-month guard), and its Ad Account cell. Returns the adset,
  // or null with a logged reason (no match / ambiguous). Never guesses.
  const resolveForRow = (ct, r) => {
    const candidates = (adsetsByCt.get(ct) ?? []).filter(
      (a) => tabNameForIso(a.start_time) === tab,
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    // More than one ACTIVE adset shares this CT# in this month — disambiguate
    // by the row's Ad Account label if we have that column and a value.
    const rowAcct =
      idx.account >= 0 ? String(rows[r]?.[idx.account] ?? '').trim() : '';
    if (rowAcct) {
      const byAcct = candidates.filter((a) => a.accountLabel === rowAcct);
      if (byAcct.length === 1) return byAcct[0];
    }
    console.log(
      `  ! [${tab}] Row ${r + 1} (CT${ct}): CT# is ACTIVE in multiple accounts (${candidates
        .map((a) => a.accountLabel)
        .join(', ')}) and the row's Ad Account ${rowAcct ? `("${rowAcct}") doesn't uniquely match` : 'is blank'} — refusing to auto-fill Ad Set ID (set it by hand to avoid cross-account misattribution).`,
    );
    return null;
  };

  for (let r = 1; r < rows.length; r++) {
    const ct = String(rows[r]?.[idx.test] ?? '').trim();
    const existingId = String(rows[r]?.[idx.adsetId] ?? '').trim();
    if (!ct) continue;
    if (existingId) {
      if (!adsetById.has(existingId)) {
        // Sheet has an ID but Meta says it's not in the ACTIVE set. Two cases:
        //  (a) the adset was legitimately paused and never relaunched — leave
        //      the cell alone (it's the correct historical ID).
        //  (b) the test was RELAUNCHED under a new adset ID (e.g. a 6.4 CT26
        //      duplicated to a 6.5 CT26). The sheet still points at the old,
        //      now-dead ID, so rowByAdset can't map the live adset to this row
        //      and the Learnings doc shows "(no hypothesis on sheet)". When a
        //      live ACTIVE adset matches this row's CT# AND launched in this
        //      tab's month, repoint W at the live ID so the row tracks the
        //      adset that's actually running.
        const relaunch = resolveForRow(ct, r);
        if (relaunch) {
          console.log(`  [${tab}] Row ${r + 1} (CT${ct}): stored Ad Set ID ${existingId} is not active; relaunch ${relaunch.id} (${relaunch.name}, ${relaunch.accountLabel}) found — repointing Ad Set ID.`);
          if (!DRY_RUN) {
            await writeCell(SHEET_ID, `${tab}!${colA1(idx.adsetId)}${r + 1}`, relaunch.id);
          }
          rows[r][idx.adsetId] = relaunch.id; // reflect in-memory for this run
        }
      }
      continue;
    }
    // resolveForRow applies the launch-month guard AND the multi-account
    // disambiguation (by the row's Ad Account column), refusing to guess when
    // a CT# is ambiguous across accounts. It logs its own reason on null.
    const match = resolveForRow(ct, r);
    if (!match) {
      // resolveForRow already logged the specific reason (no match / ambiguous).
      // Keep an explicit "no ACTIVE adset" line for the common single-account case.
      if (!(adsetsByCt.get(ct) ?? []).some((a) => tabNameForIso(a.start_time) === tab)) {
        console.log(`  [${tab}] Row ${r + 1} (CT${ct}): no ACTIVE adset matching prefix CT${ct} in ${tab} — leaving Ad Set ID blank.`);
      }
      continue;
    }
    console.log(`  [${tab}] Row ${r + 1} (CT${ct}): auto-filling Ad Set ID = ${match.id} (${match.name}, ${match.accountLabel})`);
    if (!DRY_RUN) {
      await writeCell(SHEET_ID, `${tab}!${colA1(idx.adsetId)}${r + 1}`, match.id);
    }
    rows[r][idx.adsetId] = match.id; // also reflect in-memory for this run
  }
}

// ---------- Learnings doc ----------

// Find an existing tab by title (walks both top-level and child tabs).
function findTabByTitle(allTabs, title) {
  const flat = [];
  const walk = (t) => {
    flat.push(t);
    for (const c of t.childTabs ?? []) walk(c);
  };
  for (const t of allTabs) walk(t);
  return flat.find((t) => (t.tabProperties?.title ?? '').trim() === title.trim());
}

// Get all tabs in current state.
async function getAllTabs() {
  const docResp = await docs.documents.get({
    documentId: LEARNINGS_DOC_ID,
    includeTabsContent: true,
  });
  return docResp.data.tabs ?? [];
}

// Create a new tab. parentTabId is optional — omit for top-level.
async function createTab(title, parentTabId) {
  const tabProperties = { title };
  if (parentTabId) tabProperties.parentTabId = parentTabId;
  const createResp = await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: {
      requests: [{ addDocumentTab: { tabProperties } }],
    },
  });
  const newTabId = createResp.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
  if (!newTabId) throw new Error('addDocumentTab returned no tabId');
  return newTabId;
}

// True when a Docs batchUpdate error is the 100-tab ceiling.
function isTabLimitError(e) {
  return /limited to 100 tabs/i.test(e?.message ?? '');
}

// Scan every tab title in the doc for "CT<number>" and return the lowest and
// highest CT seen. Used to name the archived doc "(CT12 - CT61)". Walks nested
// tabs (CT tabs live under month parents; Copy sub-tabs also carry the CT#).
async function ctRangeFromDoc(docId) {
  const resp = await docs.documents.get({ documentId: docId, includeTabsContent: true });
  const nums = [];
  const walk = (t) => {
    const m = (t.tabProperties?.title ?? '').match(/CT\s*(\d+)/i);
    if (m) nums.push(Number(m[1]));
    for (const c of t.childTabs ?? []) walk(c);
  };
  for (const t of resp.data.tabs ?? []) walk(t);
  if (nums.length === 0) return null;
  return { first: Math.min(...nums), last: Math.max(...nums) };
}

// Roll the active Learnings doc over when it hits the 100-tab limit:
//   1. Compute the CT range from the full doc's tabs.
//   2. Rename it "Hushlab Learnings Document (CT<first> - CT<last>)".
//   3. Move it into the Learning Docs folder (archive).
//   4. Create a fresh "Hushlab Learnings Document" in that same folder.
//   5. Persist the new doc ID to Bot Control so future runs pick it up.
//   6. Repoint the module-level LEARNINGS_DOC_ID and return the new ID.
// The new doc's month tabs are created lazily by ensureMonthTab on the retry,
// so it inherits the exact same naming + formatting conventions as before.
async function rolloverLearningsDoc(oldDocId) {
  const range = await ctRangeFromDoc(oldDocId);
  const suffix = range ? ` (CT${range.first} - CT${range.last})` : ' (archive)';
  const archiveName = `Hushlab Learnings Document${suffix}`;
  console.log(`  ↻ 100-tab limit hit. Archiving current doc as "${archiveName}".`);

  // Rename the full doc + move it into the Learning Docs folder in one update.
  const cur = await drive.files.get({ fileId: oldDocId, fields: 'parents', supportsAllDrives: true });
  const prevParents = (cur.data.parents ?? []).join(',');
  await drive.files.update({
    fileId: oldDocId,
    requestBody: { name: archiveName },
    addParents: LEARNINGS_FOLDER_ID,
    removeParents: prevParents || undefined,
    supportsAllDrives: true,
  });
  console.log(`  ✓ Archived + moved into Learning Docs folder.`);

  // Create the fresh live doc directly inside the Learning Docs folder so the
  // load-context skill (which globs that folder) picks it up automatically.
  const created = await drive.files.create({
    requestBody: {
      name: 'Hushlab Learnings Document',
      mimeType: 'application/vnd.google-apps.document',
      parents: [LEARNINGS_FOLDER_ID],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const newId = created.data.id;
  if (!newId) throw new Error('rollover: drive.files.create returned no id');

  // Persist + repoint so this and all future runs write to the new doc.
  await writeCell(SHEET_ID, LEARNINGS_DOC_CELL, newId);
  LEARNINGS_DOC_ID = newId;
  console.log(`  ✓ New live Learnings doc created: ${newId} (persisted to ${LEARNINGS_DOC_CELL}).`);
  return newId;
}

// Parse a hypothesis string that may contain numbered items ("1. text\n2. text")
// into an array of plain strings (without the leading "N. "). Single-item or
// un-numbered hypotheses come back as a one-element array.
function parseHypothesisItems(hypothesis) {
  if (!hypothesis) return [];
  // Always split on newlines so each sentence becomes its own list item — the
  // sheet stores the "I think..." sentences one per line, usually WITHOUT a
  // leading "1." digit. Strip any leading numbering if present so we never
  // double-number once createParagraphBullets renders native 1. 2. 3.
  return hypothesis
    .split(/\n+/)
    .map((l) => l.replace(/^\d+[.)]\s+/, '').trim())
    .filter(Boolean);
}

// Build the Learnings body text and all bold/list metadata.
//
// Formatting spec:
//   Bold entire line : "Metrics", "Result: Loser", "Killed by Rule X — ..."
//   Bold label only  : "Old Hypothesis:", "Learnings:", "New Hypothesis:"
//   No blank line between "Learnings:" and learnings content
//   No blank line between "New Hypothesis:" and new hypothesis content
//   Old Hypothesis items → Google Docs numbered list (NUMBERED_DECIMAL_ALPHA_ROMAN)
function buildLearningsTemplate({ dateRange, metrics, oldHypothesis, kill }) {
  const safe = (n, prefix = '', decimals = 2) =>
    n == null || Number.isNaN(n) ? '—' : `${prefix}${Number(n).toFixed(decimals)}`;

  const hypItems = parseHypothesisItems(oldHypothesis);
  const hypLines = hypItems.length > 0 ? hypItems : ['(no hypothesis on sheet)'];

  // No blank line after Learnings: or New Hypothesis:
  const lines = [
    'Metrics',
    `Date Range: ${dateRange}`,
    `Amount Spent: ${safe(metrics.spend, '$')}`,
    `ROAS: ${safe(metrics.roas, '', 2)}`,
    `CPA: ${metrics.purchases >= 1 && metrics.cpp != null ? '$' + metrics.cpp.toFixed(2) : 'N/A (0 purchases)'}`,
    `Frequency: ${safe(metrics.frequency, '', 2)}`,
    `CPM: ${safe(metrics.cpm, '$')}`,
    `CTR: ${metrics.ctrLink != null ? metrics.ctrLink.toFixed(2) + '%' : '—'}`,
    `CPC: ${safe(metrics.cpcLink, '$')}`,
    `% of Spend (Last 7 Days): ${metrics.pctSpend7d != null ? metrics.pctSpend7d.toFixed(1) + '%' : '—'}`,
    '',
    'Result: Loser',
    '',
    `Killed by ${kill.rule} — ${kill.reason}`,
    '',
    'Old Hypothesis:',
    ...hypLines,
    '',
    'Learnings:',
    // no blank line here — Nate's learnings go directly below
    '',
    'New Hypothesis:',
    // no blank line here — Nate's new hypothesis goes directly below
    '',
  ];

  const text = lines.join('\n') + '\n';

  // Compute bold ranges and hypothesis list range.
  // Docs API: tab body starts at index 1.
  const boldRanges = [];
  let cursor = 1;
  let hypStart = -1;
  let hypEnd = -1;
  let inHypItems = false;

  // Labels whose ENTIRE line gets bolded
  const boldFullLine = new Set(['Metrics', 'Result: Loser']);
  // Labels where only the label text (not subsequent content) is bolded
  const boldLabelOnly = new Set(['Old Hypothesis:', 'Learnings:', 'New Hypothesis:']);
  // The Killed by line is identified by prefix
  const killedLine = `Killed by ${kill.rule} — ${kill.reason}`;

  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;

    if (boldFullLine.has(line) || line === killedLine) {
      if (line.length > 0) boldRanges.push({ startIndex: start, endIndex: end });
    } else if (boldLabelOnly.has(line)) {
      if (line.length > 0) boldRanges.push({ startIndex: start, endIndex: end });
      // Mark where hyp items start (right after "Old Hypothesis:" line's \n)
      if (line === 'Old Hypothesis:') {
        inHypItems = true;
        hypStart = end + 1; // +1 for the \n
      }
    } else if (inHypItems) {
      if (line === '') {
        // blank line ends the hyp items block
        hypEnd = start - 1; // end of last hyp item (before this \n)
        inHypItems = false;
      }
    }

    cursor = end + 1; // +1 for the \n after each line
  }

  const useNumberedList = hypItems.length > 0 && hypStart > 0 && hypEnd > hypStart;

  return { text, boldRanges, hypStart, hypEnd, useNumberedList };
}

// Write the Learnings tab body with correct bold and numbered list formatting.
async function writeLearningsTab({ tabId, text, boldRanges, hypStart, hypEnd, useNumberedList }) {
  // Insert text + apply all bold in one call.
  // FIRST force the whole inserted span to bold:false — inserting at index 1
  // inherits the insertion-point text style, so without this clear the entire
  // block renders bold and the per-line bold:true below only re-affirms it
  // (the bug seen on CT27–CT32 and all June tabs). Targeted bold:true then
  // re-bolds only the header/result/killed-by/label lines.
  const requests = [
    { insertText: { location: { index: 1, tabId }, text } },
    {
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 1 + text.length, tabId },
        textStyle: { bold: false },
        fields: 'bold',
      },
    },
    ...boldRanges.map((r) => ({
      updateTextStyle: {
        range: { startIndex: r.startIndex, endIndex: r.endIndex, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    })),
  ];
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: { requests },
  });

  // Apply numbered list to Old Hypothesis items in a second call.
  if (useNumberedList) {
    await docs.documents.batchUpdate({
      documentId: LEARNINGS_DOC_ID,
      requestBody: {
        requests: [{
          createParagraphBullets: {
            range: { startIndex: hypStart, endIndex: hypEnd, tabId },
            bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
          },
        }],
      },
    });
  }
}

// Build a one-line summary for sheet column S (Results). Mirrors the doc's
// Metrics block as plain text. Same content, single line, sheet-friendly.
function buildResultsLine({ metrics, kill, dateRange }) {
  const safe = (n, prefix = '', d = 2) =>
    n == null || Number.isNaN(n) ? '—' : `${prefix}${Number(n).toFixed(d)}`;
  const m = metrics;
  return [
    `Loser — Killed by ${kill.rule} (${kill.reason})`,
    `Ran ${dateRange}`,
    `Spend ${safe(m.spend, '$')}`,
    `ROAS ${safe(m.roas, '', 2)}`,
    `CPA ${m.purchases >= 1 && m.cpp != null ? '$' + m.cpp.toFixed(2) : 'N/A (0 purchases)'}`,
    `Frequency ${safe(m.frequency, '', 2)}`,
    `CPM ${safe(m.cpm, '$')}`,
    `CTR ${m.ctrLink != null ? m.ctrLink.toFixed(2) + '%' : '—'}`,
    `CPC ${safe(m.cpcLink, '$')}`,
    `% of Spend (7d) ${m.pctSpend7d != null ? m.pctSpend7d.toFixed(1) + '%' : '—'}`,
  ].join('. ') + '.';
}

// Write a child "Copy | ..." sub-tab containing the ad's full copy.
async function writeCopySubTab({ parentTabId, parentTitle, body }) {
  if (!body || body.trim().length === 0) return false;
  const subTitle = `Copy | ${parentTitle}`;
  const subTabId = await createTab(subTitle, parentTabId);
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: {
      requests: [
        { insertText: { location: { index: 1, tabId: subTabId }, text: body + '\n' } },
      ],
    },
  });
  return true;
}

// ---------- Doc: month-tab parent + ordered insertion ----------

// Extract the CT# from an adset/tab title (e.g. "05.26.26 | CT16 | Breathe" → 16).
// Returns null if no match.
function ctNumberFromTitle(title) {
  const m = String(title ?? '').match(/\bCT(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

// Find-or-create the month parent tab for a given launch ISO date (e.g. "2026-05-26").
// Reads the doc tabs, returns the matching top-level tab whose title equals the
// month name (e.g. "May"). Creates the tab if missing. Returns {tabId, allTabs}.
async function ensureMonthTab(launchDateIso) {
  const monthName = MONTH_NAMES[new Date(launchDateIso + 'T00:00:00Z').getUTCMonth()];
  const allTabs = await getAllTabs();
  const existing = allTabs.find((t) => (t.tabProperties?.title ?? '').trim() === monthName);
  if (existing) return { tabId: existing.tabProperties.tabId, monthName, allTabs };
  // Create top-level month tab.
  const newId = await createTab(monthName);
  // Re-pull tabs so caller sees the new one in its siblings.
  return { tabId: newId, monthName, allTabs: await getAllTabs() };
}

// Re-sort a month tab's children in ascending CT-number order. The Docs API
// request for this is `updateDocumentTabProperties` (NOT `updateTabProperties`
// — an earlier attempt used the wrong name, got a schema error, and the
// feature was removed as "unsupported"). `index` is sibling-relative.
//
// Requests inside one batchUpdate apply sequentially, so we assign desired
// positions in ascending order: once position 0..i-1 are placed, setting the
// next tab to index i never disturbs the already-correct prefix.
async function reorderMonthTabChildren(monthTabId) {
  const allTabs = await getAllTabs();
  const month = (function find(tabs) {
    for (const t of tabs ?? []) {
      if (t.tabProperties?.tabId === monthTabId) return t;
      const r = find(t.childTabs);
      if (r) return r;
    }
    return null;
  })(allTabs);
  if (!month) return false;
  const children = (month.childTabs ?? []).map((t) => t.tabProperties);
  const sorted = [...children].sort((a, b) => {
    const ca = ctNumberFromTitle(a.title);
    const cb = ctNumberFromTitle(b.title);
    // Non-CT tabs keep their relative position, sorted ahead of CT tabs.
    if (ca == null && cb == null) return (a.index ?? 0) - (b.index ?? 0);
    if (ca == null) return -1;
    if (cb == null) return 1;
    return ca - cb;
  });
  if (sorted.every((tp, i) => tp.index === i)) return false; // already in order
  // Emit a request for every position (not just "moved" ones): earlier moves
  // shift sibling indices, so the snapshot's per-tab index goes stale mid-batch
  // and a skip based on it can leave a tab out of place. No-op sets are cheap.
  const requests = sorted.map((tp, i) => ({
    updateDocumentTabProperties: {
      tabProperties: { tabId: tp.tabId, index: i },
      fields: 'index',
    },
  }));
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: { requests },
  });
  return true;
}

// ---------- Doc: in-place Metrics block update on an existing tab ----------

// Read a tab's plain-text body + element ranges. Returns {text, elements:[{start,end,text}]}.
// Used to locate the Metrics→Killed-by block we want to replace without touching
// Nate's hand-written Learnings + New Hypothesis below.
function readTabBody(tab) {
  const out = { text: '', elements: [] };
  const content = tab?.documentTab?.body?.content ?? [];
  for (const el of content) {
    const para = el.paragraph;
    if (!para) continue;
    for (const e of para.elements ?? []) {
      const tr = e.textRun;
      if (!tr) continue;
      out.elements.push({ start: e.startIndex ?? 0, end: e.endIndex ?? 0, text: tr.content ?? '' });
      out.text += tr.content ?? '';
    }
  }
  return out;
}

// Update the Metrics block + "Killed by Rule N — …" line on an existing tab,
// preserving everything from "Old Hypothesis:" onward (which is user-authored).
// If the existing tab doesn't contain a recognizable Metrics block, no-op.
// Pass `preFetchedTabs` to avoid re-fetching the full doc per call.
async function refreshMetricsBlock({ tabId, metrics, kill, dateRange, preFetchedTabs }) {
  const allTabs = preFetchedTabs ?? (await getAllTabs());
  const tab = (function find(tabs) {
    for (const t of tabs) {
      if (t.tabProperties?.tabId === tabId) return t;
      const r = find(t.childTabs ?? []);
      if (r) return r;
    }
    return null;
  })(allTabs);
  if (!tab) return false;
  const body = readTabBody(tab);
  // Locate the "Metrics" line and the "Old Hypothesis:" line in the doc-index space.
  // We use the elements list (which carries Docs-API start/end indices) to map
  // substring positions back to indices.
  const metricsIdx = body.text.indexOf('Metrics\n');
  const oldHypIdx = body.text.indexOf('Old Hypothesis:');
  if (metricsIdx < 0 || oldHypIdx < 0 || oldHypIdx <= metricsIdx) {
    console.log(`  · refreshMetricsBlock: tab body doesn't match expected layout — skipping.`);
    return false;
  }
  // Translate text offsets to Docs-API indices using the first element's start.
  const base = body.elements[0]?.start ?? 1;
  const replaceStart = base + metricsIdx;
  const replaceEnd = base + oldHypIdx;

  // Build the replacement: the Metrics block + Result + Killed-by + blank line.
  // Same line set as buildLearningsTemplate up through (but NOT including) Old Hypothesis:.
  const safe = (n, prefix = '', d = 2) =>
    n == null || Number.isNaN(n) ? '—' : `${prefix}${Number(n).toFixed(d)}`;
  const lines = [
    'Metrics',
    `Date Range: ${dateRange}`,
    `Amount Spent: ${safe(metrics.spend, '$')}`,
    `ROAS: ${safe(metrics.roas, '', 2)}`,
    `CPA: ${metrics.purchases >= 1 && metrics.cpp != null ? '$' + metrics.cpp.toFixed(2) : 'N/A (0 purchases)'}`,
    `Frequency: ${safe(metrics.frequency, '', 2)}`,
    `CPM: ${safe(metrics.cpm, '$')}`,
    `CTR: ${metrics.ctrLink != null ? metrics.ctrLink.toFixed(2) + '%' : '—'}`,
    `CPC: ${safe(metrics.cpcLink, '$')}`,
    `% of Spend (Last 7 Days): ${metrics.pctSpend7d != null ? metrics.pctSpend7d.toFixed(1) + '%' : '—'}`,
    '',
    'Result: Loser',
    '',
    `Killed by ${kill.rule} — ${kill.reason}`,
    '',
    '',
  ];
  const newText = lines.join('\n');

  // Recompute bold ranges relative to replaceStart.
  const boldTargets = new Set(['Metrics', 'Result: Loser']);
  const boldRanges = [];
  let cursor = replaceStart;
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;
    if (line.length > 0 && (boldTargets.has(line) || line.startsWith('Killed by Rule '))) {
      boldRanges.push({ startIndex: start, endIndex: end });
    }
    cursor = end + 1;
  }

  const requests = [
    { deleteContentRange: { range: { startIndex: replaceStart, endIndex: replaceEnd, tabId } } },
    { insertText: { location: { index: replaceStart, tabId }, text: newText } },
    // Clear bold across the whole re-inserted block first so it can't inherit a
    // stray bold run from the insertion point; targeted bold:true re-applies.
    {
      updateTextStyle: {
        range: { startIndex: replaceStart, endIndex: replaceStart + newText.length, tabId },
        textStyle: { bold: false },
        fields: 'bold',
      },
    },
  ];
  for (const r of boldRanges) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: r.startIndex, endIndex: r.endIndex, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: { requests },
  });
  return true;
}

// ---------- Settled-metrics reconciliation pass ----------

// For every PAUSED row in the given month-tab snapshot within
// RECONCILE_WINDOW_DAYS of pause:
//   1. Re-fetch insights for that adset over its full run window.
//   2. If spend (or any other metric) drifted upward vs what's in sheet col S,
//      rewrite col S + refresh the doc's Metrics block on the matching tab.
//
// This is the long-tail fix for Meta's billing settlement lag — the 60s
// post-pause poll catches most of the drift, but residual ($1–$5) can keep
// trickling in for hours. Running this every hourly tick converges within
// 24h of pause.
async function reconcileSettledMetrics(rows, header, idx, breakeven, tab) {
  const todayIso = new Date().toISOString().slice(0, 10);
  // Fetch the doc tabs ONCE for the whole reconcile pass; refreshMetricsBlock
  // would otherwise re-fetch the entire ~36k-line doc for every paused row.
  let preFetchedTabs = null;
  try { preFetchedTabs = await getAllTabs(); } catch {}
  for (let r = 1; r < rows.length; r++) {
    const status = String(rows[r]?.[idx.status] ?? '').trim().toUpperCase();
    if (status !== 'PAUSED') continue;
    const adsetId = String(rows[r]?.[idx.adsetId] ?? '').trim();
    if (!adsetId) continue;
    const existingResults = String(rows[r]?.[idx.results] ?? '').trim();
    if (!existingResults) continue; // only reconcile rows the bot wrote
    // Existing spend from col S. Format is "Spend $19.40" or "Spend $19.40." or
    // "Amount Spent: $19.40" (doc refresh path). Accept either prefix.
    // Don't let [\d.]+ swallow the sentence period — "Spend $34.00. ROAS"
    // captured "34.00." → Number() = NaN → every row rewrote on every tick.
    const prevSpendMatch = existingResults.match(/(?:Spend|Amount Spent:?)\s*\$(\d+(?:\.\d+)?)/);
    const prevSpend = prevSpendMatch ? Number(prevSpendMatch[1]) : null;

    // Pull start_time + name so we know the run window and which doc tab to update.
    let meta;
    try {
      meta = await metaGet(adsetId, { fields: 'id,name,start_time,campaign{id,name}' });
    } catch (e) {
      console.log(`  · Reconcile: ${adsetId} fetch failed — ${e.message}`);
      continue;
    }
    // Guard against stale / mis-typed Ad Set IDs: the row's CT# must match the
    // adset's CT#. Without this, a row mistakenly holding another test's adsetId
    // would get the wrong test's metrics written into its Results cell.
    const rowCt = String(rows[r]?.[idx.test] ?? '').trim();
    const adsetCt = ctNumberFromTitle(meta.name);
    if (rowCt && adsetCt != null && String(adsetCt) !== rowCt) {
      console.log(`  · Reconcile: row ${r + 1} CT${rowCt} ≠ adset ${meta.name} (CT${adsetCt}) — skipping mismatch.`);
      continue;
    }
    const startTime = meta.start_time;
    if (!startTime) continue;
    const launchDate = dateFromIso(startTime);
    const daysSinceStart = (Date.now() - new Date(startTime).getTime()) / 86400000;
    if (daysSinceStart > RECONCILE_WINDOW_DAYS) continue;

    let m;
    try {
      m = await fetchAdsetMetrics(adsetId, launchDate);
    } catch (e) {
      console.log(`  · Reconcile: ${meta.name}: insights fetch failed — ${e.message}`);
      continue;
    }
    // Skip only when we successfully parsed a prior spend AND it hasn't moved.
    // If prevSpend is null (parse miss), always rewrite — safer than silently skipping.
    if (prevSpend != null && m.spend <= prevSpend + 0.005) continue; // no drift

    const prevLabel = prevSpend != null ? `$${prevSpend.toFixed(2)}` : '(unknown)';
    console.log(`  · Reconcile: ${meta.name} — spend ${prevLabel} → $${m.spend.toFixed(2)}`);

    m.pctSpend7d = await fetchPctOfCampaignSpend7d(adsetId, meta.campaign?.id);
    // When the adset's whole run fits inside the 7d window and it spent money,
    // a 0%/null here is provably wrong — Meta transiently returns an empty
    // insights row sometimes (wrote a false 0.0% on CT33, 2026-06-11). Fall
    // back to the prior recorded value from col S instead of writing the lie.
    if (!m.pctSpend7d && m.spend > 0 && daysSinceStart <= 7) {
      const prevPct = existingResults.match(/% of Spend \(7d\) ([\d.]+)%/);
      if (prevPct) m.pctSpend7d = Number(prevPct[1]);
    }

    // Re-derive the kill verdict using the latest numbers. We do NOT re-pause
    // (already paused) — verdict is just used to rebuild the "Killed by …" line.
    // Keep the duration AT KILL TIME on-record: parse the prior results line's
    // "after X.Xh" and "Ran A – B" rather than recomputing from now(), which
    // would silently inflate the run duration on every reconcile tick.
    const prevHours = existingResults.match(/after ([\d.]+)h/);
    const hours = prevHours ? Number(prevHours[1]) : (new Date() - new Date(startTime)) / 36e5;
    const verdict = evaluate(m, hours, breakeven) ?? {
      rule: 'Rule (post-pause)',
      reason: `Reconciled spend $${m.spend.toFixed(2)}`,
    };

    const prevRan = existingResults.match(/Ran ([\d/]+) – ([\d/]+)/);
    const dateRange = prevRan
      ? `${prevRan[1]} – ${prevRan[2]}`
      : `${formatDateMDY(launchDate)} – ${formatDateMDY(todayIso)}`;
    const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange });
    if (!DRY_RUN) {
      await writeCell(SHEET_ID, `${tab}!${colA1(idx.results)}${r + 1}`, resultsLine);
    }

    // Find the matching doc tab (title === adset name) and refresh metrics block.
    const docTab = preFetchedTabs ? findTabByTitle(preFetchedTabs, meta.name) : null;
    if (docTab && !DRY_RUN) {
      try {
        await refreshMetricsBlock({
          tabId: docTab.tabProperties.tabId,
          metrics: m,
          kill: verdict,
          // Days from the preserved (kill-time) date range when we have it —
          // hours-from-now would inflate the run length for Rule 1/3 kills,
          // whose reasons carry no "after X.Xh" to parse hours back from.
          dateRange: `${dateRange} (${
            prevRan
              ? Math.max(1, Math.round((new Date(prevRan[2]) - new Date(prevRan[1])) / 86400000))
              : Math.max(1, Math.round(hours / 24))
          } days)`,
          preFetchedTabs,
        });
        console.log(`  ✓ Doc Metrics block refreshed: "${meta.name}"`);
      } catch (e) {
        console.log(`  ! Doc refresh failed for ${meta.name}: ${e.message}`);
      }
    }
  }
}

// ---------- Bot Log layout (column widths + alignment) ----------

// Run once per killbot invocation. Idempotent — Google's API just no-ops if the
// widths/alignments already match. Keeps notes/name/spend columns readable so
// rows don't get clipped. Columns: A Timestamp, B Test #, C Ad Set ID, D Ad Set
// Name, E Rule, F Action, G Spend, H ATC, I Purchases, J CPP, K CPC, L Notes.
async function ensureBotLogLayout() {
  const widths = [
    { col: 0, px: 200 }, // A Timestamp
    { col: 1, px: 60 },  // B Test #
    { col: 2, px: 170 }, // C Ad Set ID
    { col: 3, px: 280 }, // D Ad Set Name
    { col: 4, px: 80 },  // E Rule Fired
    { col: 5, px: 120 }, // F Action
    { col: 6, px: 140 }, // G Spend (test window)
    { col: 7, px: 60 },  // H ATC
    { col: 8, px: 80 },  // I Purchases
    { col: 9, px: 60 },  // J CPP
    { col: 10, px: 60 }, // K CPC
    { col: 11, px: 700 }, // L Notes (was getting clipped)
  ];
  const requests = widths.map((w) => ({
    updateDimensionProperties: {
      range: {
        sheetId: BOT_LOG_SHEET_ID,
        dimension: 'COLUMNS',
        startIndex: w.col,
        endIndex: w.col + 1,
      },
      properties: { pixelSize: w.px },
      fields: 'pixelSize',
    },
  }));
  // Left-align every data cell, top-align vertically, enable wrap on Notes column.
  requests.push({
    repeatCell: {
      range: { sheetId: BOT_LOG_SHEET_ID, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
      cell: {
        userEnteredFormat: {
          horizontalAlignment: 'LEFT',
          verticalAlignment: 'TOP',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  });
  // Clear any background highlight on data rows (row 2+). Header row 1 keeps
  // its yellow fill — explicitly not touched. Without this, when a row is
  // appended via INSERT_ROWS Google sometimes inherits the previous row's
  // fill, which was leaving new entries highlighted yellow.
  requests.push({
    repeatCell: {
      range: { sheetId: BOT_LOG_SHEET_ID, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  });
  // Force black foreground text across the whole used range (rows 1..500, A:L)
  // so the yellow header keeps its background but text stays readable, and
  // data rows don't pick up muted/grey text from sheet themes.
  requests.push({
    repeatCell: {
      range: { sheetId: BOT_LOG_SHEET_ID, startRowIndex: 0, endRowIndex: 500, startColumnIndex: 0, endColumnIndex: 12 },
      cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 } } } },
      fields: 'userEnteredFormat.textFormat.foregroundColor',
    },
  });
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
  } catch (e) {
    console.log(`  ! Bot Log layout update failed: ${e.message}`);
  }
}

// ---------- Main ----------

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] killbot start (DRY_RUN=${DRY_RUN})`);

  // Kill switch
  const ks = await readRange(SHEET_ID, 'Bot Control!B1');
  if ((ks[0]?.[0] ?? '').toUpperCase() === 'OFF') {
    console.log('Kill switch OFF — exiting.');
    return;
  }

  // Resolve the active Learnings doc ID from Bot Control (source of truth),
  // falling back to the constant on first run. rolloverLearningsDoc rewrites
  // this cell when the 100-tab limit is hit, so the bot self-heals with no edit.
  const docCell = await readRange(SHEET_ID, LEARNINGS_DOC_CELL);
  const persistedDocId = String(docCell[0]?.[0] ?? '').trim();
  if (persistedDocId) {
    LEARNINGS_DOC_ID = persistedDocId;
  } else {
    await writeCell(SHEET_ID, LEARNINGS_DOC_CELL, LEARNINGS_DOC_FALLBACK);
    console.log(`Seeded ${LEARNINGS_DOC_CELL} with fallback doc ${LEARNINGS_DOC_FALLBACK}.`);
  }
  console.log(`Learnings doc: ${LEARNINGS_DOC_ID}`);

  // Breakeven CPP from KPI sheet (formatted "$35.31").
  const kpi = await readRange(KPI_SHEET_ID, 'KPI calculation!G2');
  const breakevenRaw = String(kpi[0]?.[0] ?? '14.84').replace(/[^0-9.]/g, '');
  const breakeven = Number(breakevenRaw) || 14.84;
  console.log(`Breakeven CPP: $${breakeven.toFixed(2)}`);

  // Live snapshot from Meta — union of ACTIVE adsets across every configured
  // ad account (each adset carries its accountLabel). A per-account fetch
  // failure is logged and skipped so one bad account can't blank the run.
  const liveAdsets = [];
  for (const account of AD_ACCOUNTS) {
    try {
      const found = await getActiveAdsets(account);
      console.log(`  [${account.label}] ${account.id}: ${found.length} ACTIVE adset(s).`);
      liveAdsets.push(...found);
    } catch (e) {
      console.log(`  ! [${account.label}] ${account.id}: adset fetch failed — ${e.message}`);
    }
  }
  console.log(`Found ${liveAdsets.length} ACTIVE adset(s) across ${AD_ACCOUNTS.length} account(s) under ACTIVE campaigns.`);

  // Discover which month tabs exist on the spreadsheet. We load every month
  // tab the spreadsheet has (typically the past few months) so the bot can
  // operate on rows from any of them — no more hardcoded 'May'.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const existingTabTitles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean));
  const monthTabs = MONTH_NAMES.filter((m) => existingTabTitles.has(m));
  console.log(`Month tabs present: ${monthTabs.join(', ') || '(none)'}`);

  // Snapshot each month tab. tabState[tab] = { rows, header, idx }.
  const tabState = {};
  for (const tab of monthTabs) {
    // Read through AD to cover the "Account" column inserted between Status and
    // Results (which pushed Ad Set ID past W) plus any headroom. All column
    // positions are resolved by header name below, never by fixed offset.
    const tRows = await readRange(SHEET_ID, `${tab}!A1:AD500`);
    const tHeader = tRows[0] ?? [];
    const tIdx = {
      test: tHeader.indexOf('Creative Test #'),
      launch: tHeader.indexOf('Launch Date (double click)'),
      status: tHeader.indexOf('Status'),
      account: tHeader.indexOf('Ad Account'),
      results: tHeader.indexOf('Results'),
      hypothesis: tHeader.findIndex((h) => String(h).includes("What's your hypothesis")),
      adsetId: tHeader.indexOf('Ad Set ID'),
    };
    // Status, Results and Ad Set ID are resolved purely by header name — no
    // numeric fallback, because inserting the Account column shifts every
    // position after Status and a hardcoded offset would silently misalign.
    if (tIdx.test < 0 || tIdx.adsetId < 0 || tIdx.status < 0 || tIdx.results < 0) {
      console.log(`  · Skipping tab '${tab}' — missing required columns. idx=${JSON.stringify(tIdx)}`);
      continue;
    }
    tabState[tab] = { rows: tRows, header: tHeader, idx: tIdx };
  }

  // Apply Bot Log column widths + alignment once per run (idempotent).
  if (!DRY_RUN) await ensureBotLogLayout();

  // Auto-fill missing Ad Set IDs across every month tab.
  for (const tab of Object.keys(tabState)) {
    const { rows, header, idx } = tabState[tab];
    await autofillAdSetIds(rows, header, idx, liveAdsets, tab);
  }

  // Build map: Ad Set ID → { tab, rowNum (1-indexed) } across all month tabs.
  // If the same ID somehow lives in two tabs (manual paste error), the last
  // tab in MONTH_NAMES order wins; warn so it gets cleaned up.
  const rowByAdset = new Map();
  for (const tab of Object.keys(tabState)) {
    const { rows, idx } = tabState[tab];
    for (let r = 1; r < rows.length; r++) {
      const id = String(rows[r]?.[idx.adsetId] ?? '').trim();
      if (!id) continue;
      if (rowByAdset.has(id)) {
        const prev = rowByAdset.get(id);
        console.log(`  ! Ad Set ID ${id} appears on both '${prev.tab}' (row ${prev.rowNum}) and '${tab}' (row ${r + 1}). Using '${tab}'.`);
      }
      rowByAdset.set(id, { tab, rowNum: r + 1 });
    }
  }

  // Rule 1 two-strike + audit state (survives across runs on the Bot Pending tab).
  let pendingState = [];
  try {
    pendingState = await readPendingState();
  } catch (e) {
    console.log(`! Bot Pending read failed (${e.message}) — two-strike state unavailable this run; Rule 1 kills DEFERRED, not executed blind.`);
    pendingState = null; // null = state unreadable; never kill on Rule 1 without confirmable state
  }
  let stateDirty = false;

  let actionCount = 0;
  // Evaluate in ascending CT order so that when several adsets die in the same
  // tick, their Learnings tabs are CREATED lowest-CT-first (CT34 was processed
  // before CT33 on 2026-06-11 because Meta returns adsets newest-first).
  liveAdsets.sort(
    (a, b) => (ctNumberFromTitle(a.name) ?? Infinity) - (ctNumberFromTitle(b.name) ?? Infinity),
  );
  for (const adset of liveAdsets) {
    const launchDate = dateFromIso(adset.start_time);
    const launchAt = new Date(adset.start_time);
    const hours = hoursSince(launchAt);
    if (hours < 0) {
      console.log(`Adset ${adset.name}: start_time in future — skipping.`);
      continue;
    }

    let m;
    try {
      m = await fetchAdsetMetrics(adset.id, launchDate);
    } catch (e) {
      console.log(`Adset ${adset.name}: insights fetch failed — ${e.message}`);
      continue;
    }

    console.log(
      `Adset ${adset.name} (${adset.id}) — spend $${m.spend.toFixed(2)}, ${hours.toFixed(1)}h, ATC ${m.atc}, P ${m.purchases}, CPC ${m.cpcLink != null ? '$' + m.cpcLink.toFixed(2) : '—'}, CTR ${m.ctrLink != null ? m.ctrLink.toFixed(2) + '%' : '—'}`,
    );

    let verdict = evaluate(m, hours, breakeven);

    // Rule 1 two-strike: first breach only flags PENDING; the kill executes on
    // a later run once the flag is ≥CONFIRM_MINUTES old AND the breach still
    // holds against fresher data. A breach that clears in between is a
    // reporting-lag phantom — drop the flag and log the save.
    if (pendingState !== null) {
      const pIdx = pendingState.findIndex((p) => p.adsetId === adset.id && p.type === 'PENDING');
      if (verdict?.rule === 'Rule 1') {
        if (pIdx < 0) {
          pendingState.push({
            adsetId: adset.id,
            type: 'PENDING',
            atIso: new Date().toISOString(),
            name: adset.name,
            cpc: m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
            spend: m.spend.toFixed(2),
            note: verdict.reason,
          });
          stateDirty = true;
          console.log(`  → ${verdict.rule} strike 1: PENDING — ${verdict.reason}. Confirm on a run ≥${CONFIRM_MINUTES}m from now.`);
          await appendLog([
            easternTimestamp(),
            String(ctNumberFromTitle(adset.name) ?? ''),
            adset.id,
            adset.name,
            verdict.rule,
            'PENDING' + (DRY_RUN ? ' [DRY]' : ''),
            m.spend.toFixed(2),
            String(m.atc),
            String(m.purchases),
            m.cpp != null ? m.cpp.toFixed(2) : '',
            m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
            `${verdict.reason} — strike 1, confirming in ≥${CONFIRM_MINUTES}m`,
            adset.accountLabel ?? 'Hushlab Ad Account 1',
          ]);
          verdict = nonCpcVerdict(m, hours, breakeven);
          if (!verdict) continue;
          console.log(`  → Rule 1 pending, but ${verdict.rule} holds on its own — proceeding single-strike.`);
        } else {
          const ageMin = minutesSinceIso(pendingState[pIdx].atIso);
          if (ageMin < CONFIRM_MINUTES) {
            console.log(`  → ${verdict.rule} still breached — pending ${ageMin.toFixed(0)}m/${CONFIRM_MINUTES}m, waiting.`);
            verdict = nonCpcVerdict(m, hours, breakeven);
            if (!verdict) continue;
            console.log(`  → Rule 1 pending, but ${verdict.rule} holds on its own — proceeding single-strike.`);
          } else {
            // (2nd strike confirmed. The PENDING row is removed only AFTER the
            // pause call succeeds — a transient pause failure must not reset
            // the 45-minute timer.)
            verdict.confirmNote = ` (confirmed 2nd strike, ${ageMin.toFixed(0)}m after first flag)`;
            verdict.reason += verdict.confirmNote;
          }
        }
      } else if (pIdx >= 0) {
        // Breach cleared before confirmation — reporting lag phantom, saved.
        const saved = pendingState.splice(pIdx, 1)[0];
        stateDirty = true;
        console.log(`  ✓ Rule 1 flag cleared for ${adset.name} — CPC settled to ${m.cpcLink != null ? '$' + m.cpcLink.toFixed(2) : '—'} (was ${saved.cpc ? '$' + saved.cpc : 'no clicks'}). False kill avoided.`);
        await appendLog([
          easternTimestamp(),
          String(ctNumberFromTitle(adset.name) ?? ''),
          adset.id,
          adset.name,
          'Rule 1',
          'RECOVERED' + (DRY_RUN ? ' [DRY]' : ''),
          m.spend.toFixed(2),
          String(m.atc),
          String(m.purchases),
          m.cpp != null ? m.cpp.toFixed(2) : '',
          m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
          `CPC settled under $${CPC_KILL.toFixed(2)} before 2nd strike (flagged at ${saved.cpc ? '$' + saved.cpc : '0 clicks'}/$${saved.spend}) — reporting-lag phantom`,
          adset.accountLabel ?? 'Hushlab Ad Account 1',
        ]);
        if (!verdict) continue;
      }
      if (!verdict) continue;
    } else if (verdict?.rule === 'Rule 1') {
      // State tab unreadable — refuse to kill on a single unconfirmed snapshot.
      console.log(`  ! ${verdict.rule} breach seen but Bot Pending is unreadable — kill deferred to next run.`);
      continue;
    }
    if (!verdict) continue;

    console.log(`  → ${verdict.rule}: PAUSE — ${verdict.reason}`);
    actionCount++;

    // 1) Pause on Meta.
    try {
      await metaPause(adset.id);
    } catch (e) {
      console.log(`  ! Meta pause failed: ${e.message}`);
      continue;
    }

    // Pause succeeded: retire any PENDING flag for this adset (whatever rule
    // fired), and give Rule 1 kills a settled-data audit ≥AUDIT_MIN_MINUTES
    // later — if the settled CPC lands back under the line, the kill
    // self-reverses (UNKILLED).
    if (pendingState !== null) {
      const spent = pendingState.findIndex((p) => p.adsetId === adset.id && p.type === 'PENDING');
      if (spent >= 0) {
        pendingState.splice(spent, 1);
        stateDirty = true;
      }
      if (verdict.rule === 'Rule 1') {
        pendingState.push({
          adsetId: adset.id,
          type: 'AUDIT',
          atIso: new Date().toISOString(),
          name: adset.name,
          cpc: m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
          spend: m.spend.toFixed(2),
          note: `killed: ${verdict.reason}`,
          account: adset.accountLabel ?? 'Hushlab Ad Account 1',
        });
        stateDirty = true;
      }
      // Persist NOW — the doc/sheet steps below can throw, and an unrecorded
      // kill would otherwise never get its false-kill audit.
      if (stateDirty && !DRY_RUN) {
        try {
          await writePendingState(pendingState);
          stateDirty = false;
        } catch (e) {
          console.log(`! Bot Pending write failed post-kill: ${e.message}`);
        }
      }
    }

    // 2) Mirror PAUSED to the Status column via USER_ENTERED writeCell.
    //    Look up the row across all month tabs — adset's row lives on its
    //    launch month's tab (e.g. June ads → June tab). Column resolved by
    //    header index (not a hardcoded letter) so a column insert can't misalign.
    const rowRef = rowByAdset.get(adset.id);
    if (!rowRef) {
      console.log(`  ! Adset ${adset.id} not found on any month tab — sheet writes skipped.`);
    }
    if (rowRef && !DRY_RUN) {
      await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(tabState[rowRef.tab].idx.status)}${rowRef.rowNum}`, 'PAUSED');
      // Stamp which ad account this row's adset ran in (only if the row's Ad
      // Account cell is empty — never clobber a value you set by hand). The
      // dropdown lives between Status and Results.
      const accIdx = tabState[rowRef.tab].idx.account;
      if (accIdx >= 0) {
        const existingAcc = String(tabState[rowRef.tab].rows[rowRef.rowNum - 1]?.[accIdx] ?? '').trim();
        if (!existingAcc) {
          await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(accIdx)}${rowRef.rowNum}`, adset.accountLabel ?? 'Hushlab Ad Account 1');
        }
      }
    }

    // 3) Reconcile final-state metrics. Meta's insights ledger lags actual
    //    delivery by anywhere from a few seconds to ~2 minutes after a pause.
    //    Poll three times with increasing delays and take the snapshot with
    //    the highest spend — since spend is monotonically non-decreasing after
    //    pause, the largest value is the closest to the final billed amount.
    if (!DRY_RUN) {
      let best = m;
      for (const delayMs of [8000, 22000, 30000]) {
        await new Promise((r) => setTimeout(r, delayMs));
        try {
          const snap = await fetchAdsetMetrics(adset.id, launchDate);
          if (snap.spend > best.spend) best = snap;
        } catch (e) {
          console.log(`  ! Insights re-fetch (delay ${delayMs}ms) failed: ${e.message}`);
        }
      }
      const moved = best.spend !== m.spend;
      m = best;
      console.log(`  · Reconciled spend $${m.spend.toFixed(2)}${moved ? ' (post-pause drift settled)' : ''}`);
      // Update the kill reason to reflect the reconciled spend so the doc
      // and the Bot Log don't show stale at-trigger numbers.
      if (verdict.rule === 'Rule 1' && m.cpcLink != null) {
        verdict.reason = `CPC $${m.cpcLink.toFixed(2)} > $${CPC_KILL.toFixed(2)} at $${m.spend.toFixed(2)} spend` + (verdict.confirmNote ?? '');
      } else if (verdict.rule === 'Rule 2') {
        verdict.reason = `Zero buying intent at $${m.spend.toFixed(2)} after ${hours.toFixed(1)}h (≥1× breakeven $${breakeven.toFixed(2)})`;
      } else if (verdict.rule === 'Rule 3') {
        verdict.reason = `Post-ATC bleed: ${m.atc} ATC, 0 purchases at $${m.spend.toFixed(2)} (≥2× breakeven $${(2 * breakeven).toFixed(2)})`;
      }
    }

    // 4) % of campaign spend last 7d (best-effort).
    m.pctSpend7d = await fetchPctOfCampaignSpend7d(adset.id, adset.campaign_id);

    // 5) Write a one-line Results summary to the Results column. Mirrors the
    //    metrics block in the Learnings doc so the sheet is self-sufficient
    //    for quick scanning without opening the doc. Column resolved by header
    //    index (not a hardcoded letter) so a column insert can't misalign.
    if (rowRef && !DRY_RUN) {
      const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange: `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))}` });
      await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(tabState[rowRef.tab].idx.results)}${rowRef.rowNum}`, resultsLine);
    }

    // 6) Build Learnings doc tab + Copy sub-tab, nested under the month parent.
    if (!DRY_RUN) {
      try {
        const tabTitle = adset.name;
        const dateRange = `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))} (${Math.max(1, Math.round(hours / 24))} days)`;
        // Pull hypothesis from the row's home tab snapshot (idx.hypothesis is
        // per-tab now). If the Ad Set ID lookup missed (rowRef null — e.g. a
        // relaunched adset whose new ID wasn't repointed into col W), fall back
        // to matching by CT# parsed from the adset name so the doc still gets
        // the real hypothesis instead of "(no hypothesis on sheet)". Prefer the
        // adset's launch-month tab, then any tab.
        const oldHypothesis = (() => {
          const readFromRef = (ref) => {
            if (!ref) return '';
            const state = tabState[ref.tab];
            if (!state || state.idx.hypothesis < 0) return '';
            return String(state.rows[ref.rowNum - 1]?.[state.idx.hypothesis] ?? '').trim();
          };
          const direct = readFromRef(rowRef);
          if (direct) return direct;
          const ct = ctNumberFromTitle(adset.name);
          if (ct == null) return '';
          const launchTab = tabNameForIso(adset.start_time);
          const tabOrder = [launchTab, ...Object.keys(tabState).filter((t) => t !== launchTab)];
          for (const tab of tabOrder) {
            const state = tabState[tab];
            if (!state || state.idx.hypothesis < 0 || state.idx.test < 0) continue;
            for (let r = 1; r < state.rows.length; r++) {
              if (String(state.rows[r]?.[state.idx.test] ?? '').trim() === String(ct)) {
                const h = String(state.rows[r]?.[state.idx.hypothesis] ?? '').trim();
                if (h) {
                  console.log(`  · Hypothesis: ID lookup missed for ${adset.name}; matched by CT${ct} on '${tab}' row ${r + 1}.`);
                  return h;
                }
              }
            }
          }
          return '';
        })();
        const allTabs = await getAllTabs();
        const existing = findTabByTitle(allTabs, tabTitle);
        if (existing) {
          console.log(`  · Learnings doc tab "${tabTitle}" already exists — left untouched.`);
        } else {
          // The full tab build, wrapped so a 100-tab-limit failure on ANY call
          // triggers a rollover and one clean retry against the fresh doc.
          const writeTabSet = async () => {
            // Find-or-create the month parent (May, June, …). Auto-creates the
            // month tab when the calendar rolls over. Nest the CT tab inside it.
            const { tabId: monthTabId, monthName } = await ensureMonthTab(launchDate);
            const tabId = await createTab(tabTitle, monthTabId);
            // Pass the WHOLE template through — writeLearningsTab needs
            // hypStart/hypEnd/useNumberedList to render the Old Hypothesis as a
            // native numbered list. Destructuring only {text, boldRanges} here
            // silently dropped those fields and the list never got applied
            // (the CT33/CT34 plain-text hypothesis bug, 2026-06-11).
            const tpl = buildLearningsTemplate({
              dateRange,
              metrics: m,
              oldHypothesis,
              kill: verdict,
            });
            await writeLearningsTab({ tabId, ...tpl });
            console.log(`  ✓ Learnings doc tab created under "${monthName}": "${tabTitle}"`);

            // Pull ad copy and create Copy sub-tab as a child of the new CT tab.
            const adBody = await fetchAdCopyBody(adset.id);
            const wrote = await writeCopySubTab({ parentTabId: tabId, parentTitle: tabTitle, body: adBody });
            if (wrote) console.log(`  ✓ Copy sub-tab created: "Copy | ${tabTitle}"`);
            else console.log(`  · No ad copy found for ${adset.id} — no Copy sub-tab.`);

            // Keep the month's CT tabs sorted lowest→highest CT number.
            // addDocumentTab always appends, so a kill that arrives out of CT
            // order (or several kills in one tick) lands wrong without this.
            try {
              const moved = await reorderMonthTabChildren(monthTabId);
              if (moved) console.log(`  ✓ "${monthName}" tabs re-sorted by CT number`);
            } catch (e) {
              console.log(`  ! Tab reorder failed: ${e.message}`);
            }
          };

          try {
            await writeTabSet();
          } catch (e) {
            if (!isTabLimitError(e)) throw e;
            // Doc is full: archive it, spin up a fresh one, retry once. The
            // retry runs against the new (empty) doc, so it can't re-hit the cap.
            await rolloverLearningsDoc(LEARNINGS_DOC_ID);
            await writeTabSet();
          }
        }
      } catch (e) {
        console.log(`  ! Learnings doc write failed: ${e.message}`);
      }
    }

    // 7) Bot Log. Column B = Test # — parse the CT digits from the adset name
    //    so the column actually reflects the creative test number (used to be
    //    a hardcoded 'ADSET' string).
    const ctNumStr = (() => {
      const n = ctNumberFromTitle(adset.name);
      return n == null ? '' : String(n);
    })();
    await appendLog([
      easternTimestamp(),
      ctNumStr,
      adset.id,
      adset.name,
      verdict.rule,
      'PAUSED' + (DRY_RUN ? ' [DRY]' : ''),
      m.spend.toFixed(2),
      String(m.atc),
      String(m.purchases),
      m.cpp != null ? m.cpp.toFixed(2) : '',
      m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
      verdict.reason,
      adset.accountLabel ?? 'Hushlab Ad Account 1', // Account column — which ad account this kill came from
    ]);
  }

  // Post-kill audit: for every Rule 1 kill ≥AUDIT_MIN_MINUTES old, re-pull the
  // settled insights. Settled CPC ≤ $2.50 with ≥1 link click = false kill →
  // reactivate, restore sheet Status, log UNKILLED. Still breached = confirmed,
  // drop the audit row. Never touches an adset that isn't still PAUSED (so a
  // manual reactivation or delete is never fought).
  if (pendingState !== null) {
    for (const entry of [...pendingState]) {
      if (entry.type !== 'AUDIT') continue;
      const ageMin = minutesSinceIso(entry.atIso);
      if (ageMin < AUDIT_MIN_MINUTES) continue;
      const drop = () => {
        const i = pendingState.indexOf(entry);
        if (i >= 0) pendingState.splice(i, 1);
        stateDirty = true;
      };
      if (ageMin > PENDING_STALE_HOURS * 60) { drop(); continue; }
      try {
        const status = await fetchAdsetStatus(entry.adsetId);
        if (status !== 'PAUSED') {
          console.log(`Audit ${entry.name}: adset status is ${status} (not PAUSED) — leaving alone.`);
          drop();
          continue;
        }
        const startJ = await metaGet(entry.adsetId, { fields: 'start_time' });
        const sm = await fetchAdsetMetrics(entry.adsetId, dateFromIso(startJ.start_time));
        // A Rule 1 kill required ≥$15 spend, so a settled read below that is a
        // transient blank/partial insights response (the CT33 false-0% mode) —
        // retry next run instead of "confirming" the kill on bogus data.
        if (sm.spend < CPC_MIN_SPEND) {
          console.log(`! Audit ${entry.name}: settled insights look blank (spend $${sm.spend.toFixed(2)} < $${CPC_MIN_SPEND}) — retrying next run.`);
          continue;
        }
        const falseKill = sm.cpcLink != null && sm.linkClicks > 0 && sm.cpcLink <= CPC_KILL;
        if (!falseKill) {
          console.log(`Audit ${entry.name}: kill CONFIRMED on settled data (CPC ${sm.cpcLink != null ? '$' + sm.cpcLink.toFixed(2) : '— no clicks'} at $${sm.spend.toFixed(2)}).`);
          drop();
          continue;
        }
        console.log(`Audit ${entry.name}: FALSE KILL — settled CPC $${sm.cpcLink.toFixed(2)} ≤ $${CPC_KILL.toFixed(2)}. Reactivating.`);
        await metaActivate(entry.adsetId);
        const ref = rowByAdset.get(entry.adsetId);
        if (ref && !DRY_RUN) {
          await writeCell(SHEET_ID, `${ref.tab}!${colA1(tabState[ref.tab].idx.status)}${ref.rowNum}`, 'ACTIVE');
          await writeCell(SHEET_ID, `${ref.tab}!${colA1(tabState[ref.tab].idx.results)}${ref.rowNum}`, '');
          // Mirror into the in-memory snapshot so reconcileSettledMetrics
          // (which runs next, off this same snapshot) doesn't treat the row as
          // still-paused and rewrite a "Killed by …" Results line we just cleared.
          const snapRow = tabState[ref.tab].rows[ref.rowNum - 1];
          if (snapRow) {
            snapRow[tabState[ref.tab].idx.status] = 'ACTIVE';
            snapRow[tabState[ref.tab].idx.results] = '';
          }
        }
        await appendLog([
          easternTimestamp(),
          String(ctNumberFromTitle(entry.name) ?? ''),
          entry.adsetId,
          entry.name,
          'Rule 1',
          'UNKILLED' + (DRY_RUN ? ' [DRY]' : ''),
          sm.spend.toFixed(2),
          String(sm.atc),
          String(sm.purchases),
          sm.cpp != null ? sm.cpp.toFixed(2) : '',
          sm.cpcLink.toFixed(2),
          `False kill self-reversed: settled CPC $${sm.cpcLink.toFixed(2)} ≤ $${CPC_KILL.toFixed(2)} (was $${entry.cpc || '?'} at kill) — adset reactivated`,
          entry.account || 'Hushlab Ad Account 1',
        ]);
        drop();
        actionCount++;
      } catch (e) {
        console.log(`! Audit for ${entry.name} failed (${e.message}) — will retry next run.`);
      }
    }

    // Prune stale PENDING rows (adset vanished: killed by another rule, ended,
    // or manually paused before confirmation).
    const liveIds = new Set(liveAdsets.map((a) => a.id));
    const before = pendingState.length;
    pendingState = pendingState.filter((p) => p.type !== 'PENDING' || liveIds.has(p.adsetId) || minutesSinceIso(p.atIso) < PENDING_STALE_HOURS * 60);
    if (pendingState.length !== before) stateDirty = true;

    if (stateDirty && !DRY_RUN) {
      try {
        await writePendingState(pendingState);
      } catch (e) {
        console.log(`! Bot Pending write failed: ${e.message}`);
      }
    }
  }

  // Final pass: refresh metrics on already-paused adsets where Meta's billing
  // ledger has continued to settle since the original kill. Self-healing —
  // converges spend/CPC/CTR to true final-state numbers within ~24h of pause.
  // Runs once per month tab against that tab's snapshot.
  for (const tab of Object.keys(tabState)) {
    const { rows, header, idx } = tabState[tab];
    try {
      await reconcileSettledMetrics(rows, header, idx, breakeven, tab);
    } catch (e) {
      console.log(`! Settled-metrics reconciliation failed for '${tab}': ${e.message}`);
    }
  }

  await writeCell(SHEET_ID, 'Bot Control!B3', new Date().toISOString());
  console.log(`Run complete — ${actionCount} action(s) logged.`);
}

// Only auto-run when executed directly (node killbot.mjs), not when imported by
// a one-shot that reuses these helpers (e.g. import-paused-ct.mjs).
import { fileURLToPath } from 'node:url';
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((e) => {
    if (e?.transientThrottle) {
      // Meta held a rate-limit past our retry window. Skip this tick cleanly —
      // exit 0 so GitHub doesn't email a failure for a self-recovering blip.
      console.warn(`SKIP (transient Meta throttle): ${e.message}. Next tick will retry.`);
      process.exit(0);
    }
    console.error('FATAL:', e);
    process.exit(1);
  });
}

export {
  metaGet,
  metaPause,
  fetchAdsetMetrics,
  fetchAdCopyBody,
  fetchPctOfCampaignSpend7d,
  evaluate,
  writeCell,
  appendLog,
  ensureBotLogLayout,
  buildLearningsTemplate,
  writeLearningsTab,
  buildResultsLine,
  writeCopySubTab,
  ensureMonthTab,
  createTab,
  getAllTabs,
  findTabByTitle,
  reorderMonthTabChildren,
  ctNumberFromTitle,
  tabNameForIso,
  dateFromIso,
  formatDateMDY,
  easternTimestamp,
  hoursSince,
  sheets,
  docs,
  drive,
  readRange,
  SHEET_ID,
  LEARNINGS_DOC_ID,
  LEARNINGS_DOC_CELL,
};

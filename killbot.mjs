#!/usr/bin/env node
// Hushlab Killbot — adset-level enforcement of kill rules + auto-population
// of the Hushlab Learnings Google Doc when an adset is paused.
//
// ─────────────────────────────────────────────────────────────────────────────
// KILL RULES (locked 2026-05-25, adset level)
// ─────────────────────────────────────────────────────────────────────────────
//
// Rule 1 — CPC mechanical kill
//   IF adset.spend ≥ $15 AND adset.cpc > $2.50 → PAUSE adset.
//   Reasoning: a new adset = a new test. If click economics are broken once
//   $15 is spent, the test is failing fast. Doing this at the adset level
//   (not campaign) prevents a single bad test from hiding inside a healthy
//   CBO's averaged CPC. The $15 floor is half the prior $30 campaign floor —
//   split per-adset, the noise tolerance scales with the spend per test.
//
// Rule 2 — Zero buying intent at 1× breakeven CPP
//   IF adset.spend ≥ 1× breakeven CPP ($35.31 today)
//      AND adset.hours_since_start ≥ 24
//      AND adset.ATC = 0 AND adset.purchases = 0
//   → PAUSE adset.
//   Reasoning: by definition we've spent one full CPP worth of budget and
//   produced zero buying signal across a full 24h cycle. The click→site
//   transition is broken (or the offer/LP is) — the ad is not profitable
//   and not getting more rope.
//
// Rule 3 — Post-ATC bleed at 2× breakeven CPP
//   IF adset.spend ≥ 2× breakeven CPP ($70.62 today)
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
const LEARNINGS_DOC_ID = '1vl5TQiCdfnbpA711Y5IpFl8ZkwmMvf3KQZu0Pq6Q3RE';
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

const META_TOKEN = need('META_ACCESS_TOKEN');
const AD_ACCOUNT = need('META_AD_ACCOUNT_ID');
const SA_JSON = JSON.parse(need('GOOGLE_SA_JSON'));

function need(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const auth = new google.auth.JWT(SA_JSON.client_email, null, SA_JSON.private_key, [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
]);
const sheets = google.sheets({ version: 'v4', auth });
const docs = google.docs({ version: 'v1', auth });

// ---------- Meta ----------

async function metaGet(path, params = {}) {
  const u = new URL(`${META_API}/${path}`);
  u.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (j.error) throw new Error(`Meta GET ${path}: ${j.error.message}`);
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

// All ACTIVE adsets in the ad account, with their parent campaign id/name.
// Returns [{id, name, campaign_id, campaign_name, start_time}].
async function getActiveAdsets() {
  const adsets = (await metaGet(`${AD_ACCOUNT}/adsets`, {
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
      'cost_per_outbound_click',
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
  const cpcOutbound = pickCost(d.cost_per_outbound_click, ['outbound_click']);
  const atc = sumAction(d.actions, ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart']);
  const purchases = sumAction(d.actions, ['offsite_conversion.fb_pixel_purchase', 'purchase']);
  const cpp = pickCost(d.cost_per_action_type, ['offsite_conversion.fb_pixel_purchase', 'purchase']);
  const revenue = sumActionValue(d.action_values, ['offsite_conversion.fb_pixel_purchase', 'purchase']);
  const roas = spend > 0 ? revenue / spend : 0;
  return {
    spend,
    impressions,
    frequency: Number(d.frequency ?? 0),
    cpm: Number(d.cpm ?? 0),
    ctrLink,
    cpcOutbound,
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

// ---------- Date helpers ----------

function hoursSince(d) {
  return (Date.now() - d.getTime()) / 36e5;
}

function dateFromIso(iso) {
  return String(iso ?? '').slice(0, 10);
}

function formatDateMDY(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

// ---------- Rules ----------

function evaluate(m, hoursSinceAdsetStart, breakeven) {
  if (m.spend >= CPC_MIN_SPEND && m.cpcOutbound != null && m.cpcOutbound > CPC_KILL) {
    return {
      rule: 'Rule 1',
      reason: `CPC $${m.cpcOutbound.toFixed(2)} > $${CPC_KILL.toFixed(2)} at $${m.spend.toFixed(2)} spend`,
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
  // `05.25.26 | CT14 | Breathe` (new dated convention). If multiple adsets
  // somehow share the same CT#, the last one wins; warn in that case.
  const adsetsByCt = new Map();
  for (const a of activeAdsets) {
    const m = a.name.match(/\bCT(\d+)\b/i);
    if (!m) continue;
    if (adsetsByCt.has(m[1])) {
      console.log(`  ! Multiple ACTIVE adsets matched CT${m[1]}: ${adsetsByCt.get(m[1]).name} and ${a.name}. Using the latter.`);
    }
    adsetsByCt.set(m[1], a);
  }

  for (let r = 1; r < rows.length; r++) {
    const ct = String(rows[r]?.[idx.test] ?? '').trim();
    const existingId = String(rows[r]?.[idx.adsetId] ?? '').trim();
    if (!ct) continue;
    if (existingId) {
      if (!adsetById.has(existingId)) {
        // Sheet has an ID but Meta says it's not active. Could be paused legitimately —
        // leave the cell alone but don't try to evaluate.
      }
      continue;
    }
    const match = adsetsByCt.get(ct);
    if (!match) {
      console.log(`  [${tab}] Row ${r + 1} (CT${ct}): no ACTIVE adset matching prefix CT${ct} — leaving Ad Set ID blank.`);
      continue;
    }
    // Only autofill on the row's own launch-month tab. Prevents writing a
    // June-launched adset's ID into a May row that happens to share a CT#.
    const rowLaunch = String(rows[r]?.[idx.launch] ?? '').trim();
    const adsetLaunchTab = tabNameForIso(match.start_time);
    if (adsetLaunchTab !== tab) {
      console.log(`  [${tab}] Row ${r + 1} (CT${ct}): adset ${match.name} launched in ${adsetLaunchTab}, not ${tab} — skipping autofill here.`);
      continue;
    }
    console.log(`  [${tab}] Row ${r + 1} (CT${ct}): auto-filling Ad Set ID = ${match.id} (${match.name})`);
    if (!DRY_RUN) {
      await writeCell(SHEET_ID, `${tab}!W${r + 1}`, match.id);
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

// Build the Learnings body as plain text AND the bold-range list so we can
// style it after insertion. Bold spans we want:
//   - "Metrics" header
//   - "Result: Loser" (entire line)
//   - "Killed by Rule N — ..." (entire line)
//   - "Old Hypothesis:", "Learnings:", "New Hypothesis:" labels
function buildLearningsTemplate({ dateRange, metrics, oldHypothesis, kill }) {
  const safe = (n, prefix = '', decimals = 2) =>
    n == null || Number.isNaN(n) ? '—' : `${prefix}${Number(n).toFixed(decimals)}`;

  const lines = [
    'Metrics',
    `Date Range: ${dateRange}`,
    `Amount Spent: ${safe(metrics.spend, '$')}`,
    `ROAS: ${safe(metrics.roas, '', 2)}`,
    `CPA: ${metrics.purchases >= 1 && metrics.cpp != null ? '$' + metrics.cpp.toFixed(2) : 'N/A (0 purchases)'}`,
    `Frequency: ${safe(metrics.frequency, '', 2)}`,
    `CPM: ${safe(metrics.cpm, '$')}`,
    `CTR: ${metrics.ctrLink != null ? metrics.ctrLink.toFixed(2) + '%' : '—'}`,
    `Cost Per Outbound Click: ${safe(metrics.cpcOutbound, '$')}`,
    `% of Spend (Last 7 Days): ${metrics.pctSpend7d != null ? metrics.pctSpend7d.toFixed(1) + '%' : '—'}`,
    '',
    'Result: Loser',
    '',
    `Killed by ${kill.rule} — ${kill.reason}`,
    '',
    'Old Hypothesis:',
    oldHypothesis || '(no hypothesis on sheet)',
    '',
    'Learnings:',
    '',
    'New Hypothesis:',
    '',
  ];

  // Compute Docs-API indices for each line. Tab body starts at index 1 (the
  // tab's content begins after a hidden section break). After we insert
  // body+'\n', each line ends with a newline; we walk line-by-line tracking
  // the cursor position.
  const boldTargets = new Set([
    'Metrics',
    'Result: Loser',
    'Old Hypothesis:',
    'Learnings:',
    'New Hypothesis:',
  ]);

  const text = lines.join('\n') + '\n';
  const boldRanges = [];
  let cursor = 1; // Docs API: empty tab body starts insertable at index 1.
  for (const line of lines) {
    const start = cursor;
    const end = cursor + line.length;
    if (
      boldTargets.has(line) ||
      line.startsWith('Killed by Rule ')
    ) {
      if (line.length > 0) boldRanges.push({ startIndex: start, endIndex: end });
    }
    cursor = end + 1; // +1 for the newline character that follows
  }

  return { text, boldRanges };
}

// Write the Learnings tab body + apply bold styling in a single batchUpdate
// so the indices we computed against `text` line up exactly.
async function writeLearningsTab({ tabId, text, boldRanges }) {
  const requests = [
    { insertText: { location: { index: 1, tabId }, text } },
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
    `CPC ${safe(m.cpcOutbound, '$')}`,
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

// Reorder a freshly created tab into CT-numeric order among its month siblings.
// Walks all children of the month tab, sorts them by CT# (no-CT entries sort to
// the end), and re-issues updateTabProperties with the corrected index.
async function reorderMonthTabChildren(monthTabId) {
  const allTabs = await getAllTabs();
  const monthTab = (function find(tabs) {
    for (const t of tabs) {
      if (t.tabProperties?.tabId === monthTabId) return t;
      const r = find(t.childTabs ?? []);
      if (r) return r;
    }
    return null;
  })(allTabs);
  if (!monthTab) return;
  const children = [...(monthTab.childTabs ?? [])];
  // Sort: CT# ascending, no-CT to the end (stable by current index).
  children.sort((a, b) => {
    const an = ctNumberFromTitle(a.tabProperties?.title);
    const bn = ctNumberFromTitle(b.tabProperties?.title);
    if (an == null && bn == null) return (a.tabProperties?.index ?? 0) - (b.tabProperties?.index ?? 0);
    if (an == null) return 1;
    if (bn == null) return -1;
    return an - bn;
  });
  const requests = children.map((t, i) => ({
    updateTabProperties: {
      tabProperties: { tabId: t.tabProperties.tabId, index: i },
      fields: 'index',
    },
  }));
  if (requests.length === 0) return;
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: { requests },
  });
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
    `Cost Per Outbound Click: ${safe(metrics.cpcOutbound, '$')}`,
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
    // Existing spend from col S, parsed defensively (allow either "Spend $19.40" or "Spend $19.40.").
    const prevSpendMatch = existingResults.match(/Spend \$([\d.]+)/);
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
    if (prevSpend != null && m.spend <= prevSpend + 0.005) continue; // no drift

    console.log(`  · Reconcile: ${meta.name} — spend $${(prevSpend ?? 0).toFixed(2)} → $${m.spend.toFixed(2)}`);

    m.pctSpend7d = await fetchPctOfCampaignSpend7d(adsetId, meta.campaign?.id);

    // Re-derive the kill verdict using the latest numbers. We do NOT re-pause
    // (already paused) — verdict is just used to rebuild the "Killed by …" line.
    // Recompute hoursSinceAdsetStart at the kill TIME, not now: parse the prior
    // results line's "Ran <dateRange>" to keep the original duration on-record.
    const hours = (new Date() - new Date(startTime)) / 36e5;
    const verdict = evaluate(m, hours, breakeven) ?? {
      rule: 'Rule (post-pause)',
      reason: `Reconciled spend $${m.spend.toFixed(2)}`,
    };

    const dateRange = `${formatDateMDY(launchDate)} – ${formatDateMDY(todayIso)}`;
    const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange });
    if (!DRY_RUN) {
      await writeCell(SHEET_ID, `${tab}!S${r + 1}`, resultsLine);
    }

    // Find the matching doc tab (title === adset name) and refresh metrics block.
    const docTab = preFetchedTabs ? findTabByTitle(preFetchedTabs, meta.name) : null;
    if (docTab && !DRY_RUN) {
      try {
        await refreshMetricsBlock({
          tabId: docTab.tabProperties.tabId,
          metrics: m,
          kill: verdict,
          dateRange: `${dateRange} (${Math.max(1, Math.round(hours / 24))} days)`,
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

  // Breakeven CPP from KPI sheet (formatted "$35.31").
  const kpi = await readRange(KPI_SHEET_ID, 'KPI calculation!G2');
  const breakevenRaw = String(kpi[0]?.[0] ?? '35.31').replace(/[^0-9.]/g, '');
  const breakeven = Number(breakevenRaw) || 35.31;
  console.log(`Breakeven CPP: $${breakeven.toFixed(2)}`);

  // Live snapshot from Meta.
  const liveAdsets = await getActiveAdsets();
  console.log(`Found ${liveAdsets.length} ACTIVE adset(s) under ACTIVE campaigns.`);

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
    const tRows = await readRange(SHEET_ID, `${tab}!A1:W500`);
    const tHeader = tRows[0] ?? [];
    const tIdx = {
      test: tHeader.indexOf('Creative Test #'),
      launch: tHeader.indexOf('Launch Date (double click)'),
      status: tHeader.indexOf('Status'),
      results: tHeader.indexOf('Results'),
      hypothesis: tHeader.findIndex((h) => String(h).includes("What's your hypothesis")),
      adsetId: tHeader.indexOf('Ad Set ID'),
    };
    if (tIdx.test < 0 || tIdx.adsetId < 0) {
      console.log(`  · Skipping tab '${tab}' — missing required columns. idx=${JSON.stringify(tIdx)}`);
      continue;
    }
    // Fall back to canonical positions if header lookup misses. Column R =
    // Status (17), S = Results (18). Defensive — header text can rename.
    if (tIdx.status < 0) tIdx.status = 17;
    if (tIdx.results < 0) tIdx.results = 18;
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

  let actionCount = 0;
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
      `Adset ${adset.name} (${adset.id}) — spend $${m.spend.toFixed(2)}, ${hours.toFixed(1)}h, ATC ${m.atc}, P ${m.purchases}, CPC ${m.cpcOutbound != null ? '$' + m.cpcOutbound.toFixed(2) : '—'}, CTR ${m.ctrLink != null ? m.ctrLink.toFixed(2) + '%' : '—'}`,
    );

    const verdict = evaluate(m, hours, breakeven);
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

    // 2) Mirror PAUSED to sheet column R via USER_ENTERED writeCell.
    //    Look up the row across all month tabs — adset's row lives on its
    //    launch month's tab (e.g. June ads → June tab).
    const rowRef = rowByAdset.get(adset.id);
    if (!rowRef) {
      console.log(`  ! Adset ${adset.id} not found on any month tab — sheet writes skipped.`);
    }
    if (rowRef && !DRY_RUN) {
      await writeCell(SHEET_ID, `${rowRef.tab}!R${rowRef.rowNum}`, 'PAUSED');
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
      if (verdict.rule === 'Rule 1' && m.cpcOutbound != null) {
        verdict.reason = `CPC $${m.cpcOutbound.toFixed(2)} > $${CPC_KILL.toFixed(2)} at $${m.spend.toFixed(2)} spend`;
      } else if (verdict.rule === 'Rule 2') {
        verdict.reason = `Zero buying intent at $${m.spend.toFixed(2)} after ${hours.toFixed(1)}h (≥1× breakeven $${breakeven.toFixed(2)})`;
      } else if (verdict.rule === 'Rule 3') {
        verdict.reason = `Post-ATC bleed: ${m.atc} ATC, 0 purchases at $${m.spend.toFixed(2)} (≥2× breakeven $${(2 * breakeven).toFixed(2)})`;
      }
    }

    // 4) % of campaign spend last 7d (best-effort).
    m.pctSpend7d = await fetchPctOfCampaignSpend7d(adset.id, adset.campaign_id);

    // 5) Write a one-line Results summary to sheet column S. Mirrors the
    //    metrics block in the Learnings doc so the sheet is self-sufficient
    //    for quick scanning without opening the doc.
    if (rowRef && !DRY_RUN) {
      const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange: `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))}` });
      await writeCell(SHEET_ID, `${rowRef.tab}!S${rowRef.rowNum}`, resultsLine);
    }

    // 6) Build Learnings doc tab + Copy sub-tab, nested under the month parent.
    if (!DRY_RUN) {
      try {
        const tabTitle = adset.name;
        const dateRange = `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))} (${Math.max(1, Math.round(hours / 24))} days)`;
        // Pull hypothesis from the row's home tab snapshot (idx.hypothesis is
        // per-tab now).
        const oldHypothesis = (() => {
          if (!rowRef) return '';
          const state = tabState[rowRef.tab];
          if (!state || state.idx.hypothesis < 0) return '';
          return String(state.rows[rowRef.rowNum - 1]?.[state.idx.hypothesis] ?? '').trim();
        })();
        const allTabs = await getAllTabs();
        const existing = findTabByTitle(allTabs, tabTitle);
        if (existing) {
          console.log(`  · Learnings doc tab "${tabTitle}" already exists — left untouched.`);
        } else {
          // Find-or-create the month parent (May, June, …). Auto-creates the
          // month tab when the calendar rolls over. Nest the CT tab inside it.
          const { tabId: monthTabId, monthName } = await ensureMonthTab(launchDate);
          const tabId = await createTab(tabTitle, monthTabId);
          const { text, boldRanges } = buildLearningsTemplate({
            dateRange,
            metrics: m,
            oldHypothesis,
            kill: verdict,
          });
          await writeLearningsTab({ tabId, text, boldRanges });
          console.log(`  ✓ Learnings doc tab created under "${monthName}": "${tabTitle}"`);

          // Pull ad copy and create Copy sub-tab as a child of the new CT tab.
          const adBody = await fetchAdCopyBody(adset.id);
          const wrote = await writeCopySubTab({ parentTabId: tabId, parentTitle: tabTitle, body: adBody });
          if (wrote) console.log(`  ✓ Copy sub-tab created: "Copy | ${tabTitle}"`);
          else console.log(`  · No ad copy found for ${adset.id} — no Copy sub-tab.`);

          // Reorder siblings under the month so CT16 sits before CT17, etc.
          try {
            await reorderMonthTabChildren(monthTabId);
          } catch (e) {
            console.log(`  ! Reorder under "${monthName}" failed: ${e.message}`);
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
      new Date().toISOString(),
      ctNumStr,
      adset.id,
      adset.name,
      verdict.rule,
      'PAUSED' + (DRY_RUN ? ' [DRY]' : ''),
      m.spend.toFixed(2),
      String(m.atc),
      String(m.purchases),
      m.cpp != null ? m.cpp.toFixed(2) : '',
      m.cpcOutbound != null ? m.cpcOutbound.toFixed(2) : '',
      verdict.reason,
    ]);
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

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

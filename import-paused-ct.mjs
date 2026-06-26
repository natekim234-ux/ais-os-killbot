// One-shot: import a manually-paused adset into the sheet + Learnings doc exactly
// as the killbot would have, for an adset the bot never processed because it was
// already PAUSED when the bot ran (getActiveAdsets() only returns ACTIVE adsets).
//
// Reuses killbot.mjs's own helpers so the output is byte-identical to a real kill:
// same metrics fetch, same Results line (col S), same Learnings tab (Metrics block,
// bold ranges, numbered Old Hypothesis, Copy sub-tab), same month-tab nesting +
// reorder, same Bot Log row.
//
// Usage (env: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, GOOGLE_SA_JSON, DRY_RUN):
//   ADSET_ID=120248335723620087 node import-paused-ct.mjs
//
// Does NOT pause on Meta (already paused). Does NOT reactivate. Idempotent on the
// doc (skips if a tab with the adset name already exists). Re-running rewrites the
// sheet R/S cells + Bot Log row — harmless.

import {
  metaGet,
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
  SHEET_ID,
} from './killbot.mjs';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const KPI_SHEET_ID = '1GWTUjvuYnSrn64nrqfLB9AsAKwDm4JCnk6c4nbhWM1A';
const ADSET_ID = process.env.ADSET_ID;
if (!ADSET_ID) throw new Error('Set ADSET_ID env var');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function readRange(spreadsheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return data.values ?? [];
}

(async () => {
  console.log(`[import-paused-ct] start (DRY_RUN=${DRY_RUN}) ADSET_ID=${ADSET_ID}`);

  // Breakeven CPP from KPI sheet (same source the bot uses).
  const kpi = await readRange(KPI_SHEET_ID, 'KPI calculation!G2');
  const breakeven = Number(String(kpi[0]?.[0] ?? '35.31').replace(/[^0-9.]/g, '')) || 35.31;
  console.log(`Breakeven CPP: $${breakeven.toFixed(2)}`);

  // Adset basics — works even though it's PAUSED (we fetch by ID, not the ACTIVE list).
  const adsetMeta = await metaGet(ADSET_ID, {
    fields: 'id,name,status,effective_status,start_time,campaign{id,name,status}',
  });
  const adset = {
    id: adsetMeta.id,
    name: adsetMeta.name,
    start_time: adsetMeta.start_time,
    campaign_id: adsetMeta.campaign?.id,
    campaign_name: adsetMeta.campaign?.name,
  };
  console.log(`Adset: ${adset.name}  status=${adsetMeta.status} effective=${adsetMeta.effective_status}  start=${adset.start_time}`);

  const launchDate = dateFromIso(adset.start_time);
  const hours = hoursSince(new Date(adset.start_time));

  // Metrics over the adset's own run window — same call the bot makes.
  const m = await fetchAdsetMetrics(adset.id, launchDate);
  console.log(`Metrics — spend $${m.spend.toFixed(2)}, ${hours.toFixed(1)}h, ATC ${m.atc}, P ${m.purchases}, outboundCPC ${m.cpcOutbound != null ? '$' + m.cpcOutbound.toFixed(2) : '—'}, outboundClicks ${m.outboundClicks}, CTR ${m.ctrLink != null ? m.ctrLink.toFixed(2) + '%' : '—'}`);

  // Determine the verdict using the bot's exact evaluate(). If it trips a rule,
  // attribute that rule. If it doesn't (a true manual kill that no rule would
  // have caught), record it as a manual kill so the doc is honest.
  let verdict = evaluate(m, hours, breakeven);
  if (!verdict) {
    verdict = {
      rule: 'Manual',
      reason: `Paused manually in Ads Manager at $${m.spend.toFixed(2)} after ${hours.toFixed(1)}h (did not trip an automated kill rule)`,
    };
    console.log(`  → No automated rule tripped. Recording as MANUAL kill.`);
  } else {
    console.log(`  → ${verdict.rule}: ${verdict.reason}`);
  }

  // % of campaign spend last 7d (best-effort, doc + sheet display only).
  m.pctSpend7d = await fetchPctOfCampaignSpend7d(adset.id, adset.campaign_id);

  // ---- Locate the sheet row across month tabs ----
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const existingTabTitles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean));
  const monthTabs = MONTH_NAMES.filter((t) => existingTabTitles.has(t));

  let rowRef = null;
  const tabState = {};
  for (const tab of monthTabs) {
    const rows = await readRange(SHEET_ID, `${tab}!A1:W500`);
    const header = rows[0] ?? [];
    const idx = {
      test: header.indexOf('Creative Test #'),
      launch: header.indexOf('Launch Date (double click)'),
      status: header.indexOf('Status'),
      results: header.indexOf('Results'),
      hypothesis: header.findIndex((h) => String(h).includes("What's your hypothesis")),
      adsetId: header.indexOf('Ad Set ID'),
    };
    if (idx.status < 0) idx.status = 17;
    if (idx.results < 0) idx.results = 18;
    tabState[tab] = { rows, idx };
    for (let r = 1; r < rows.length; r++) {
      if (String(rows[r]?.[idx.adsetId] ?? '').trim() === ADSET_ID) {
        rowRef = { tab, rowNum: r + 1 };
      }
    }
  }
  if (rowRef) console.log(`Sheet row: ${rowRef.tab}!${rowRef.rowNum}`);
  else console.log(`! Adset ${ADSET_ID} not found in any month tab's Ad Set ID column — sheet writes skipped.`);

  // ---- Old hypothesis, read live from the row's col P (verbatim) ----
  let oldHypothesis = '';
  if (rowRef) {
    const st = tabState[rowRef.tab];
    if (st.idx.hypothesis >= 0) {
      oldHypothesis = String(st.rows[rowRef.rowNum - 1]?.[st.idx.hypothesis] ?? '').trim();
    }
  }

  if (!DRY_RUN) await ensureBotLogLayout();

  // ---- 1) Sheet col R = PAUSED, col S = Results line ----
  const dateRangeShort = `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))}`;
  if (rowRef && !DRY_RUN) {
    await writeCell(SHEET_ID, `${rowRef.tab}!R${rowRef.rowNum}`, 'PAUSED');
    const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange: dateRangeShort });
    await writeCell(SHEET_ID, `${rowRef.tab}!S${rowRef.rowNum}`, resultsLine);
    console.log(`  ✓ Sheet R/S written: ${resultsLine}`);
  }

  // ---- 2) Learnings doc tab (+ Copy sub-tab), nested under month parent ----
  const tabTitle = adset.name;
  const dateRange = `${dateRangeShort} (${Math.max(1, Math.round(hours / 24))} days)`;
  const allTabs = await getAllTabs();
  if (findTabByTitle(allTabs, tabTitle)) {
    console.log(`  · Learnings tab "${tabTitle}" already exists — left untouched.`);
  } else if (!DRY_RUN) {
    const { tabId: monthTabId, monthName } = await ensureMonthTab(launchDate);
    const tabId = await createTab(tabTitle, monthTabId);
    const tpl = buildLearningsTemplate({ dateRange, metrics: m, oldHypothesis, kill: verdict });
    await writeLearningsTab({ tabId, ...tpl });
    console.log(`  ✓ Learnings tab created under "${monthName}": "${tabTitle}"`);
    const adBody = await fetchAdCopyBody(adset.id);
    const wrote = await writeCopySubTab({ parentTabId: tabId, parentTitle: tabTitle, body: adBody });
    console.log(wrote ? `  ✓ Copy sub-tab created` : `  · No ad copy found — no Copy sub-tab.`);
    try {
      const moved = await reorderMonthTabChildren(monthTabId);
      if (moved) console.log(`  ✓ "${monthName}" tabs re-sorted by CT number`);
    } catch (e) {
      console.log(`  ! Tab reorder failed: ${e.message}`);
    }
  } else {
    console.log(`  · [DRY] Would create Learnings tab "${tabTitle}" with hypothesis: ${oldHypothesis ? oldHypothesis.slice(0, 80) + '…' : '(none)'}`);
  }

  // ---- 3) Bot Log ----
  const ctNumStr = (() => { const n = ctNumberFromTitle(adset.name); return n == null ? '' : String(n); })();
  await appendLog([
    easternTimestamp(),
    ctNumStr,
    adset.id,
    adset.name,
    verdict.rule,
    'PAUSED (manual import)' + (DRY_RUN ? ' [DRY]' : ''),
    m.spend.toFixed(2),
    String(m.atc),
    String(m.purchases),
    m.cpp != null ? m.cpp.toFixed(2) : '',
    m.cpcOutbound != null ? m.cpcOutbound.toFixed(2) : '',
    verdict.reason,
  ]);
  console.log(`  ✓ Bot Log appended`);
  console.log(`[import-paused-ct] done.`);
})().catch((e) => {
  console.error('IMPORT FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});

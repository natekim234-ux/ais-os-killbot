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
  LEARNINGS_DOC_ID,
  LEARNINGS_DOC_CELL,
} from './killbot.mjs';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const KPI_SHEET_ID = '1GWTUjvuYnSrn64nrqfLB9AsAKwDm4JCnk6c4nbhWM1A';
const ADSET_ID = process.env.ADSET_ID;
if (!ADSET_ID) throw new Error('Set ADSET_ID env var');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || 'Hushlab Ad Account 1';

// A1 column letter from 0-based index (same as killbot.mjs's private colA1).
function colA1(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readRange(spreadsheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return data.values ?? [];
}

(async () => {
  console.log(`[import-paused-ct] start (DRY_RUN=${DRY_RUN}) ADSET_ID=${ADSET_ID}`);

  // Guard: killbot's doc helpers write to LEARNINGS_DOC_ID (the module
  // fallback). After a 100-tab rollover the live doc ID lives in Bot
  // Control!B7 and the fallback goes stale — writing there would resurrect an
  // archived doc. This one-shot can't rebind the import, so refuse to run.
  const docCell = await readRange(SHEET_ID, LEARNINGS_DOC_CELL);
  const liveDocId = String(docCell[0]?.[0] ?? '').trim();
  if (liveDocId && liveDocId !== LEARNINGS_DOC_ID) {
    throw new Error(
      `Active Learnings doc (${LEARNINGS_DOC_CELL} = ${liveDocId}) differs from killbot.mjs fallback (${LEARNINGS_DOC_ID}). Update LEARNINGS_DOC_FALLBACK before importing.`,
    );
  }

  // Breakeven CPP from KPI sheet (same source the bot uses).
  const kpi = await readRange(KPI_SHEET_ID, 'KPI calculation!G2');
  const breakeven = Number(String(kpi[0]?.[0] ?? '16.44').replace(/[^0-9.]/g, '')) || 16.44;
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
  console.log(`Metrics — spend $${m.spend.toFixed(2)}, ${hours.toFixed(1)}h, ATC ${m.atc}, P ${m.purchases}, CPC ${m.cpcLink != null ? '$' + m.cpcLink.toFixed(2) : '—'}, linkClicks ${m.linkClicks}, CTR ${m.ctrLink != null ? m.ctrLink.toFixed(2) + '%' : '—'}`);

  // Determine the verdict using the bot's exact evaluate(). If it trips a rule,
  // attribute that rule. If it doesn't (a true manual kill that no rule would
  // have caught), record it as a manual kill so the doc is honest.
  let verdict = evaluate(m, hours, breakeven);
  if (!verdict) {
    // True manual kill — no automated rule fired. Build an honest reason. If the
    // CPC (cost per link click) was already over the Rule 1 line ($3.00) but
    // spend hadn't yet reached the $25 Rule 1 floor, note that the CPC was
    // trending to a kill — i.e. the bot would have caught it at $25 spent.
    const CPC_KILL = 3.0;
    const CPC_MIN_SPEND = 25;
    const cpcOverLine = m.cpcLink != null && m.cpcLink > CPC_KILL;
    const underFloor = m.spend < CPC_MIN_SPEND;
    let reason = `Paused manually in Ads Manager at $${m.spend.toFixed(2)} after ${hours.toFixed(1)}h (did not trip an automated kill rule)`;
    if (cpcOverLine && underFloor) {
      reason = `Paused manually at $${m.spend.toFixed(2)}/${hours.toFixed(1)}h — CPC $${m.cpcLink.toFixed(2)} was already over the $${CPC_KILL.toFixed(2)} Rule 1 line, just short of the $${CPC_MIN_SPEND} spend floor (CPC trending to kill)`;
    }
    verdict = { rule: 'Manual', reason };
    console.log(`  → No automated rule tripped. Recording as MANUAL kill: ${reason}`);
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
    // Read through AD — the "Ad Account" column inserted between Status and
    // Results pushed Ad Set ID past W. All positions resolve by header name;
    // no numeric fallbacks (a hardcoded offset silently misaligns after a
    // column insert — the exact bug this rewrite removes).
    const rows = await readRange(SHEET_ID, `${tab}!A1:AD500`);
    const header = rows[0] ?? [];
    const idx = {
      test: header.indexOf('Creative Test #'),
      launch: header.indexOf('Launch Date (double click)'),
      status: header.indexOf('Status'),
      account: header.indexOf('Ad Account'),
      results: header.indexOf('Results'),
      hypothesis: header.findIndex((h) => String(h).includes("What's your hypothesis")),
      adsetId: header.indexOf('Ad Set ID'),
    };
    if (idx.status < 0 || idx.results < 0 || idx.adsetId < 0) {
      console.log(`  · Skipping tab '${tab}' — missing required columns. idx=${JSON.stringify(idx)}`);
      continue;
    }
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

  // ---- 1) Sheet Status = PAUSED, Results line, Ad Account stamp ----
  // Columns resolved by header index (never hardcoded letters) — the Ad
  // Account column insert moved Results from S to T.
  const dateRangeShort = `${formatDateMDY(launchDate)} – ${formatDateMDY(new Date().toISOString().slice(0, 10))}`;
  if (rowRef && !DRY_RUN) {
    const st = tabState[rowRef.tab];
    await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(st.idx.status)}${rowRef.rowNum}`, 'PAUSED');
    const resultsLine = buildResultsLine({ metrics: m, kill: verdict, dateRange: dateRangeShort });
    await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(st.idx.results)}${rowRef.rowNum}`, resultsLine);
    if (st.idx.account >= 0) {
      const existingAcc = String(st.rows[rowRef.rowNum - 1]?.[st.idx.account] ?? '').trim();
      if (!existingAcc) {
        await writeCell(SHEET_ID, `${rowRef.tab}!${colA1(st.idx.account)}${rowRef.rowNum}`, ACCOUNT_LABEL);
      }
    }
    console.log(`  ✓ Sheet Status/Results written: ${resultsLine}`);
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
    m.cpcLink != null ? m.cpcLink.toFixed(2) : '',
    verdict.reason,
    ACCOUNT_LABEL, // Account column — parity with killbot main()'s 13-column row
  ]);
  console.log(`  ✓ Bot Log appended`);
  console.log(`[import-paused-ct] done.`);
})().catch((e) => {
  console.error('IMPORT FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});

import { google } from 'googleapis';

const LEARNINGS_DOC_ID = '1vl5TQiCdfnbpA711Y5IpFl8ZkwmMvf3KQZu0Pq6Q3RE';
const SA_JSON = JSON.parse(process.env.GOOGLE_SA_JSON);
const auth = new google.auth.JWT(SA_JSON.client_email, null, SA_JSON.private_key, [
  'https://www.googleapis.com/auth/documents',
]);
const docs = google.docs({ version: 'v1', auth });

// All CT tabs — May and June. Copy subtabs excluded.
const TABS = [
  // June
  { id: 't.q2lwm1halzxn', name: 'CT24' },
  { id: 't.xiphyy68uzo2', name: 'CT25' },
  { id: 't.v17roe775xv7', name: 'CT27' },
  { id: 't.39f4pq5402tr', name: 'CT28' },
  { id: 't.843ing92xt86', name: 'CT29' },
  // May
  { id: 't.0',             name: 'CT12' },
  { id: 't.p6omb01g9pgp',  name: 'CT13' },
  { id: 't.ys0gc1ywqveb',  name: 'CT14' },
  { id: 't.s0wnnd7puybj',  name: 'CT15' },
  { id: 't.rh7v32w927xi',  name: 'CT16' },
  { id: 't.xeiros3dn7fw',  name: 'CT17' },
  { id: 't.wqf2qxvijde1',  name: 'CT18' },
  { id: 't.vtzw2xhk6023',  name: 'CT19' },
  { id: 't.5f76d3ygdcby',  name: 'CT20' },
  { id: 't.sho83d6apqd',   name: 'CT21' },
  { id: 't.enfqg74cswy',   name: 'CT22' },
  { id: 't.1ht99cs5yyb4',  name: 'CT23' },
];

function findTab(allTabs, tabId) {
  for (const t of allTabs) {
    if (t.tabProperties?.tabId === tabId) return t;
    const f = findTab(t.childTabs ?? [], tabId);
    if (f) return f;
  }
  return null;
}

function readTabElements(tab) {
  const elements = [];
  for (const el of tab?.documentTab?.body?.content ?? []) {
    const para = el.paragraph;
    if (!para) continue;
    for (const e of para.elements ?? []) {
      const tr = e.textRun;
      if (!tr) continue;
      elements.push({ start: e.startIndex ?? 0, end: e.endIndex ?? 0, text: tr.content ?? '' });
    }
  }
  const text = elements.map(e => e.text).join('');
  return { elements, text, base: elements[0]?.start ?? 1 };
}

async function fixTab(tabId, tabName, allDocTabs) {
  console.log(`\n${tabName} (${tabId})`);

  const found = findTab(allDocTabs, tabId);
  if (!found) { console.log(`  ! Not found`); return; }

  const { elements, text, base } = readTabElements(found);
  if (!elements.length) { console.log(`  ! Empty tab`); return; }
  const bodyEnd = elements[elements.length - 1]?.end ?? (base + text.length);

  // ── Locate key positions ──────────────────────────────────────────────────

  const metricsPos = text.indexOf('Metrics\n');
  if (metricsPos < 0) { console.log(`  ! No Metrics`); return; }

  const resultPos = text.indexOf('Result: Loser\n');
  if (resultPos < 0) { console.log(`  ! No Result`); return; }

  const killedPos = text.indexOf('Killed by Rule');
  if (killedPos < 0) { console.log(`  ! No Killed line`); return; }
  const killedLineEnd = text.indexOf('\n', killedPos);

  const oldHypPos = text.indexOf('Old Hypothesis:');
  if (oldHypPos < 0) { console.log(`  ! No Old Hypothesis`); return; }
  const oldHypLabelEnd = oldHypPos + 'Old Hypothesis:'.length;

  const learningsPos = text.indexOf('\nLearnings:', oldHypPos);
  if (learningsPos < 0) { console.log(`  ! No Learnings`); return; }
  const learningsLabelStart = learningsPos + 1;
  const learningsLabelEnd = learningsLabelStart + 'Learnings:'.length;

  const newHypPos = text.indexOf('\nNew Hypothesis:', learningsPos);
  if (newHypPos < 0) { console.log(`  ! No New Hypothesis`); return; }
  const newHypLabelStart = newHypPos + 1;
  const newHypLabelEnd = newHypLabelStart + 'New Hypothesis:'.length;

  // ── Hypothesis items: find range for numbered list ────────────────────────
  // Items start right after "Old Hypothesis:\n"
  const hypItemsStart = oldHypLabelEnd + 1; // +1 for \n after label
  // Items end at the blank line before Learnings (or directly at Learnings if no blank)
  let hypItemsEnd = learningsPos; // points at the \n before "Learnings:"
  // Walk back past any blank lines
  while (hypItemsEnd > hypItemsStart && text[hypItemsEnd - 1] === '\n') hypItemsEnd--;

  const hasHypItems = text.slice(hypItemsStart, hypItemsEnd).trim().length > 0;

  // ── Blank lines to delete ─────────────────────────────────────────────────
  // Blank line directly after "Old Hypothesis:\n" if followed by another \n
  const afterOldHypLabel = oldHypLabelEnd + 1; // the \n after label
  const hasBlankAfterOldHyp = text[afterOldHypLabel] === '\n';

  // Blank line directly after "Learnings:\n"
  const afterLearningsLabel = learningsLabelEnd + 1;
  const hasBlankAfterLearnings = text[afterLearningsLabel] === '\n';

  // Blank line directly after "New Hypothesis:\n"
  const afterNewHypLabel = newHypLabelEnd + 1;
  const hasBlankAfterNewHyp = text[afterNewHypLabel] === '\n';

  console.log(`  blankAfterOldHyp=${hasBlankAfterOldHyp} blankAfterLearnings=${hasBlankAfterLearnings} blankAfterNewHyp=${hasBlankAfterNewHyp} hasHypItems=${hasHypItems}`);

  // ── Step 1: strip all bold, re-bold correct spans ─────────────────────────
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: {
      requests: [
        // Strip all bold
        { updateTextStyle: { range: { startIndex: base, endIndex: bodyEnd, tabId }, textStyle: { bold: false }, fields: 'bold' } },
        // Metrics — full word
        { updateTextStyle: { range: { startIndex: base + metricsPos, endIndex: base + metricsPos + 'Metrics'.length, tabId }, textStyle: { bold: true }, fields: 'bold' } },
        // Result: Loser — full line
        { updateTextStyle: { range: { startIndex: base + resultPos, endIndex: base + resultPos + 'Result: Loser'.length, tabId }, textStyle: { bold: true }, fields: 'bold' } },
        // Killed by Rule X — full line
        { updateTextStyle: { range: { startIndex: base + killedPos, endIndex: base + killedLineEnd, tabId }, textStyle: { bold: true }, fields: 'bold' } },
        // Old Hypothesis: — label only
        { updateTextStyle: { range: { startIndex: base + oldHypPos, endIndex: base + oldHypLabelEnd, tabId }, textStyle: { bold: true }, fields: 'bold' } },
        // Learnings: — label only
        { updateTextStyle: { range: { startIndex: base + learningsLabelStart, endIndex: base + learningsLabelEnd, tabId }, textStyle: { bold: true }, fields: 'bold' } },
        // New Hypothesis: — label only
        { updateTextStyle: { range: { startIndex: base + newHypLabelStart, endIndex: base + newHypLabelEnd, tabId }, textStyle: { bold: true }, fields: 'bold' } },
      ],
    },
  });
  console.log(`  ✓ Bold`);

  // ── Step 2: delete blank lines (highest index first to avoid drift) ────────
  // Collect in doc-index space, sort descending
  const blanksToDelete = [];
  if (hasBlankAfterNewHyp)  blanksToDelete.push(base + afterNewHypLabel);
  if (hasBlankAfterLearnings) blanksToDelete.push(base + afterLearningsLabel);
  if (hasBlankAfterOldHyp)  blanksToDelete.push(base + afterOldHypLabel);
  blanksToDelete.sort((a, b) => b - a); // descending

  for (const idx of blanksToDelete) {
    await docs.documents.batchUpdate({
      documentId: LEARNINGS_DOC_ID,
      requestBody: {
        requests: [{ deleteContentRange: { range: { startIndex: idx, endIndex: idx + 1, tabId } } }],
      },
    });
  }
  if (blanksToDelete.length) console.log(`  ✓ Removed ${blanksToDelete.length} blank line(s)`);

  // ── Step 3: apply numbered list to Old Hypothesis items ───────────────────
  // Re-read the tab after deletions to get fresh indices
  if (hasHypItems) {
    const docResp2 = await docs.documents.get({ documentId: LEARNINGS_DOC_ID, includeTabsContent: true });
    const found2 = findTab(docResp2.data.tabs ?? [], tabId);
    const { text: text2, base: base2 } = readTabElements(found2);

    const oldHypPos2 = text2.indexOf('Old Hypothesis:');
    const oldHypLabelEnd2 = oldHypPos2 + 'Old Hypothesis:'.length;
    const hypStart2 = base2 + oldHypLabelEnd2 + 1; // right after label \n

    const learningsPos2 = text2.indexOf('\nLearnings:', oldHypPos2);
    let hypEnd2 = base2 + learningsPos2;
    // Walk back past blank lines in doc-index space
    const textSlice = text2.slice(oldHypLabelEnd2 + 1, learningsPos2);
    const trimmed = textSlice.trimEnd();
    hypEnd2 = base2 + oldHypLabelEnd2 + 1 + trimmed.length;

    if (hypEnd2 > hypStart2) {
      await docs.documents.batchUpdate({
        documentId: LEARNINGS_DOC_ID,
        requestBody: {
          requests: [{
            createParagraphBullets: {
              range: { startIndex: hypStart2, endIndex: hypEnd2, tabId },
              bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
            },
          }],
        },
      });
      console.log(`  ✓ Numbered list applied`);
    }
  }
}

// Fetch doc once, reuse for finding tabs (elements need per-tab fetch for content)
const docResp = await docs.documents.get({ documentId: LEARNINGS_DOC_ID, includeTabsContent: true });
const allDocTabs = docResp.data.tabs ?? [];

for (const tab of TABS) {
  await fixTab(tab.id, tab.name, allDocTabs);
}
console.log('\nAll done.');

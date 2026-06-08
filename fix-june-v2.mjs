import { google } from 'googleapis';

const LEARNINGS_DOC_ID = '1vl5TQiCdfnbpA711Y5IpFl8ZkwmMvf3KQZu0Pq6Q3RE';
const SA_JSON = JSON.parse(process.env.GOOGLE_SA_JSON);
const auth = new google.auth.JWT(SA_JSON.client_email, null, SA_JSON.private_key, [
  'https://www.googleapis.com/auth/documents',
]);
const docs = google.docs({ version: 'v1', auth });

const TABS = [
  { id: 't.q2lwm1halzxn', name: 'CT24' },
  { id: 't.xiphyy68uzo2', name: 'CT25' },
  { id: 't.v17roe775xv7', name: 'CT27' },
  { id: 't.39f4pq5402tr', name: 'CT28' },
  { id: 't.843ing92xt86', name: 'CT29' },
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
  // Returns [{start, end, text}] for every text run, plus full concatenated text.
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

// Translate a text-string offset to a Docs API index using the elements list.
function textOffsetToDocIndex(elements, base, offset) {
  return base + offset;
}

async function fixTab(tabId, tabName) {
  console.log(`\nFixing ${tabName} (${tabId})...`);

  const docResp = await docs.documents.get({
    documentId: LEARNINGS_DOC_ID,
    includeTabsContent: true,
  });

  const found = findTab(docResp.data.tabs ?? [], tabId);
  if (!found) { console.log(`  ! Tab not found`); return; }

  const { elements, text, base } = readTabElements(found);
  const bodyEnd = (elements[elements.length - 1]?.end) ?? (base + text.length);

  // ── Locate key lines ──────────────────────────────────────────────────────

  // "Metrics" — bold the word only (no colon, no newline)
  const metricsPos = text.indexOf('Metrics\n');
  if (metricsPos < 0) { console.log(`  ! No Metrics line`); return; }

  // "Result: Loser" — bold entire line
  const resultPos = text.indexOf('Result: Loser\n');
  if (resultPos < 0) { console.log(`  ! No Result line`); return; }

  // "Killed by Rule" — bold entire line
  const killedPos = text.indexOf('Killed by Rule');
  if (killedPos < 0) { console.log(`  ! No Killed line`); return; }
  const killedEnd = text.indexOf('\n', killedPos);

  // "Old Hypothesis:" — bold label only
  const oldHypPos = text.indexOf('Old Hypothesis:');
  if (oldHypPos < 0) { console.log(`  ! No Old Hypothesis`); return; }

  // "Learnings:" — bold label only
  const learningsPos = text.indexOf('\nLearnings:\n', oldHypPos);
  if (learningsPos < 0) { console.log(`  ! No Learnings`); return; }
  const learningsLabelStart = learningsPos + 1; // skip leading \n
  const learningsLabelEnd = learningsLabelStart + 'Learnings:'.length;

  // blank line immediately after "Learnings:\n" — delete it
  // That blank line is at learningsPos + 1 + "Learnings:\n".length
  const learningsNewline = learningsLabelEnd; // points at the \n of "Learnings:\n"
  // The blank line is the \n at learningsNewline + 1 (i.e., the empty paragraph after)
  // We check if there's a blank line there
  const afterLearningsHeader = learningsLabelEnd + 1; // after the \n
  const hasBlankAfterLearnings = text[afterLearningsHeader] === '\n';

  // "New Hypothesis:" — bold label only
  const newHypPos = text.indexOf('\nNew Hypothesis:\n', learningsPos);
  if (newHypPos < 0) { console.log(`  ! No New Hypothesis`); return; }
  const newHypLabelStart = newHypPos + 1;
  const newHypLabelEnd = newHypLabelStart + 'New Hypothesis:'.length;

  // blank line immediately after "New Hypothesis:\n"
  const afterNewHypHeader = newHypLabelEnd + 1;
  const hasBlankAfterNewHyp = text[afterNewHypHeader] === '\n';

  console.log(`  hasBlankAfterLearnings=${hasBlankAfterLearnings}, hasBlankAfterNewHyp=${hasBlankAfterNewHyp}`);

  // ── Step 1: Strip all bold, then re-bold the right spans ──────────────────
  const boldRequests = [
    // Strip all bold
    {
      updateTextStyle: {
        range: { startIndex: base, endIndex: bodyEnd, tabId },
        textStyle: { bold: false },
        fields: 'bold',
      },
    },
    // "Metrics" — word only
    {
      updateTextStyle: {
        range: { startIndex: base + metricsPos, endIndex: base + metricsPos + 'Metrics'.length, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    // "Result: Loser" — entire line
    {
      updateTextStyle: {
        range: { startIndex: base + resultPos, endIndex: base + resultPos + 'Result: Loser'.length, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    // "Killed by Rule X — ..." — entire line
    {
      updateTextStyle: {
        range: { startIndex: base + killedPos, endIndex: base + killedEnd, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    // "Old Hypothesis:" — label only
    {
      updateTextStyle: {
        range: { startIndex: base + oldHypPos, endIndex: base + oldHypPos + 'Old Hypothesis:'.length, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    // "Learnings:" — label only
    {
      updateTextStyle: {
        range: { startIndex: base + learningsLabelStart, endIndex: base + learningsLabelEnd, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    // "New Hypothesis:" — label only
    {
      updateTextStyle: {
        range: { startIndex: base + newHypLabelStart, endIndex: base + newHypLabelEnd, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
  ];

  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: { requests: boldRequests },
  });
  console.log(`  ✓ Bold applied`);

  // ── Step 2: Delete blank lines after "Learnings:" and "New Hypothesis:" ───
  // Must delete in REVERSE index order to avoid index drift.
  // Each blank line is a single \n character (one empty paragraph).
  // We delete from highest index to lowest.

  const deleteRequests = [];

  if (hasBlankAfterNewHyp) {
    // The blank \n sits at afterNewHypHeader in text-space → base + afterNewHypHeader in doc-space
    deleteRequests.push({
      deleteContentRange: {
        range: {
          startIndex: base + afterNewHypHeader,
          endIndex: base + afterNewHypHeader + 1,
          tabId,
        },
      },
    });
  }

  if (hasBlankAfterLearnings) {
    deleteRequests.push({
      deleteContentRange: {
        range: {
          startIndex: base + afterLearningsHeader,
          endIndex: base + afterLearningsHeader + 1,
          tabId,
        },
      },
    });
  }

  if (deleteRequests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: LEARNINGS_DOC_ID,
      requestBody: { requests: deleteRequests },
    });
    console.log(`  ✓ Blank lines removed (${deleteRequests.length})`);
  } else {
    console.log(`  · No blank lines to remove`);
  }
}

for (const tab of TABS) {
  await fixTab(tab.id, tab.name);
}
console.log('\nDone.');

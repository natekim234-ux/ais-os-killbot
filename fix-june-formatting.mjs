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

function readTabBody(tab) {
  const out = { text: '', elements: [] };
  for (const el of tab?.documentTab?.body?.content ?? []) {
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

function findTab(allTabs, tabId) {
  for (const t of allTabs) {
    if (t.tabProperties?.tabId === tabId) return t;
    const found = findTab(t.childTabs ?? [], tabId);
    if (found) return found;
  }
  return null;
}

async function fixTab(tabId, tabName) {
  console.log(`\nFixing ${tabName} (${tabId})...`);

  const docResp = await docs.documents.get({
    documentId: LEARNINGS_DOC_ID,
    includeTabsContent: true,
  });

  const found = findTab(docResp.data.tabs ?? [], tabId);
  if (!found) { console.log(`  ! Tab not found`); return; }

  const body = readTabBody(found);
  const text = body.text;
  const base = body.elements[0]?.start ?? 1;
  const lastEl = body.elements[body.elements.length - 1];
  const bodyEnd = lastEl?.end ?? (base + text.length);

  // Metrics header
  const metricsPos = text.indexOf('Metrics\n');
  if (metricsPos < 0) { console.log(`  ! No Metrics line`); return; }
  const metricsStart = base + metricsPos;
  const metricsEnd = metricsStart + 'Metrics'.length;

  // Hypothesis range: text between "Old Hypothesis:\n" and the blank line before "Learnings:"
  const oldHypMarker = 'Old Hypothesis:\n';
  const oldHypPos = text.indexOf(oldHypMarker);
  if (oldHypPos < 0) { console.log(`  ! No Old Hypothesis line`); return; }
  const hypTextStart = oldHypPos + oldHypMarker.length;

  // Find end: blank line (\n\n) or "Learnings:" after hypothesis
  const learningsPos = text.indexOf('Learnings:', hypTextStart);
  if (learningsPos < 0) { console.log(`  ! No Learnings section`); return; }
  // Walk back from learningsPos past any blank lines to get the last hyp line end
  let hypTextEnd = learningsPos;
  while (hypTextEnd > hypTextStart && text[hypTextEnd - 1] === '\n') hypTextEnd--;

  const hypStart = base + hypTextStart;
  const hypEnd = base + hypTextEnd;
  const hasHypItems = text.slice(hypTextStart, hypTextEnd).trim().length > 0;

  console.log(`  Strip bold: [${base}, ${bodyEnd})`);
  console.log(`  Re-bold Metrics: [${metricsStart}, ${metricsEnd})`);
  console.log(`  Hypothesis list: [${hypStart}, ${hypEnd}) hasItems=${hasHypItems}`);

  // Step 1: strip all bold, re-bold only Metrics
  await docs.documents.batchUpdate({
    documentId: LEARNINGS_DOC_ID,
    requestBody: {
      requests: [
        {
          updateTextStyle: {
            range: { startIndex: base, endIndex: bodyEnd, tabId },
            textStyle: { bold: false },
            fields: 'bold',
          },
        },
        {
          updateTextStyle: {
            range: { startIndex: metricsStart, endIndex: metricsEnd, tabId },
            textStyle: { bold: true },
            fields: 'bold',
          },
        },
      ],
    },
  });
  console.log(`  ✓ Bold fixed`);

  // Step 2: apply numbered list to hypothesis items
  if (hasHypItems && hypEnd > hypStart) {
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
    console.log(`  ✓ Numbered list applied`);
  }
}

for (const tab of TABS) {
  await fixTab(tab.id, tab.name);
}
console.log('\nDone.');

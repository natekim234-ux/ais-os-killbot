// One-shot budget bump for Hushlab CBO — fires once at 09:00 UTC (5AM EDT) Tue Jun 9 2026.
//
// Rule (set by Nate 2026-06-08):
//   Campaign: "Hushlab | Nasal Dilator | Deviated Septum" (120246737000740087)
//   Ad sets:  CT30 | Sleep   = 120246878123460087
//             CT31 | Athlete = 120246878402960087
//   If AT LEAST ONE of CT30/CT31 is still ACTIVE  -> bump campaign daily_budget 5000 -> 10000 ($50 -> $100)
//   Only if BOTH are paused/off                   -> do nothing, leave at $50.
//
// Auth reuses the killbot's META_ACCESS_TOKEN secret. DRY_RUN var gates the write,
// same convention as killbot.mjs.

import { appendFileSync } from 'node:fs';

const META_API = 'https://graph.facebook.com/v25.0';
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

const CAMPAIGN_ID = '120246737000740087';
const CT30 = { id: '120246878123460087', label: 'CT30 | Sleep' };
const CT31 = { id: '120246878402960087', label: 'CT31 | Athlete' };
const NEW_BUDGET = '10000'; // $100.00 in minor units
const EXPECTED_OLD_BUDGET = '5000'; // $50.00 — sanity check only

function need(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}
const META_TOKEN = need('META_ACCESS_TOKEN');

async function metaGet(path, params = {}) {
  const u = new URL(`${META_API}/${path}`);
  u.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (j.error) throw new Error(`Meta GET ${path}: ${j.error.message}`);
  return j;
}

async function metaPost(objectId, fields) {
  const u = new URL(`${META_API}/${objectId}`);
  const body = new URLSearchParams({ ...fields, access_token: META_TOKEN });
  const r = await fetch(u, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(`Meta POST ${objectId}: ${j.error.message}`);
  return j;
}

// effective_status reflects whether the ad set is truly delivering — it folds in
// parent campaign pause, billing holds, etc. We treat anything other than ACTIVE as "off".
async function adsetActive(adset) {
  const j = await metaGet(adset.id, { fields: 'name,status,effective_status' });
  const live = j.status === 'ACTIVE' && j.effective_status === 'ACTIVE';
  return { ...adset, status: j.status, effective_status: j.effective_status, live };
}

function summary(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    // GitHub renders this on the run page — the "did it fire and what did it decide" record.
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

(async () => {
  const out = [];
  out.push('# Hushlab one-shot budget bump');
  out.push(`Ran at: ${new Date().toISOString()} (DRY_RUN=${DRY_RUN})`);

  const camp = await metaGet(CAMPAIGN_ID, { fields: 'name,status,daily_budget' });
  out.push(`Campaign: ${camp.name} (${CAMPAIGN_ID})`);
  out.push(`Current daily_budget: ${camp.daily_budget} (expected ${EXPECTED_OLD_BUDGET})`);

  const [a30, a31] = await Promise.all([adsetActive(CT30), adsetActive(CT31)]);
  out.push(`- ${a30.label}: status=${a30.status} effective=${a30.effective_status} -> ${a30.live ? 'LIVE' : 'OFF'}`);
  out.push(`- ${a31.label}: status=${a31.status} effective=${a31.effective_status} -> ${a31.live ? 'LIVE' : 'OFF'}`);

  const anyLive = a30.live || a31.live;

  if (!anyLive) {
    out.push('');
    out.push('DECISION: BOTH ad sets OFF — leaving budget at $50. No change made.');
    summary(out);
    return;
  }

  if (camp.daily_budget === NEW_BUDGET) {
    out.push('');
    out.push('DECISION: At least one ad set LIVE, but budget is already $100. Nothing to do.');
    summary(out);
    return;
  }

  if (DRY_RUN) {
    out.push('');
    out.push(`DECISION: At least one ad set LIVE — WOULD bump daily_budget ${camp.daily_budget} -> ${NEW_BUDGET} ($100). [DRY_RUN, no write]`);
    summary(out);
    return;
  }

  const res = await metaPost(CAMPAIGN_ID, { daily_budget: NEW_BUDGET });
  const after = await metaGet(CAMPAIGN_ID, { fields: 'daily_budget' });
  out.push('');
  out.push(`DECISION: At least one ad set LIVE — bumped daily_budget to ${NEW_BUDGET} ($100). API success=${res.success ?? true}. Confirmed now: ${after.daily_budget}.`);
  summary(out);
})().catch((e) => {
  console.error('ONE-SHOT FAILED:', e.message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**FAILED:** ${e.message}\n`);
  }
  process.exit(1);
});

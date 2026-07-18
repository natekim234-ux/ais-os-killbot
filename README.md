# Hushlab Killbot

Hourly GitHub Actions cron that enforces 3 adset-level kill rules on Hushlab's Meta ad sets and auto-populates the Hushlab Learnings Google Doc on every kill.

## Kill rules (locked 2026-05-25, adset level)

| Rule | Trigger | Why |
|---|---|---|
| **1. CPC mechanical** | `spend ≥ $25 AND (link_clicks = 0 OR CPC > $3.00)` — CPC = cost per link click, same metric as the Ads Manager CPC column | A new adset is a new test. If click economics are broken once $25 is spent, kill fast. The zero-click branch is critical: a dead ad has 0 link clicks, so cost-per-link-click is null and the CPC test silently skips it — the worst ads were the most protected (CT41 hit $53 with 0 clicks). Adset-level so a bad test can't hide inside a healthy CBO's averaged CPC. |
| **2. Zero buying intent** | `spend ≥ $25 AND hours ≥ 24 AND ATC = 0 AND purchases = 0` — the 24h clock runs from the **adset's `start_time`** (when ads actually began delivering; launches are scheduled 5am ET), never campaign `created_time`, which is often the prior day | A full day cycle with real spend behind it and zero buying signal → click→site is broken. Gate is the $25 Rule 1 floor, not breakeven (changed 2026-07-18): breakeven ($16.44) sat below the Rule 1 floor, so adsets in the $16.44–$25 band bypassed Rule 1 — the only rule with a two-strike + UNKILLED audit — and died by an un-audited single-strike Rule 2 instead. |
| **3. Post-ATC bleed** | `spend ≥ 2× breakeven CPP AND ATC ≥ 1 AND purchases = 0` | ATC proves click→cart works (earns more rope than Rule 2). At 2× breakeven with no purchase, the cart is dying at checkout — copy/urgency problem, very unlikely to flip profitable. |

Breakeven CPP pulls live from KPI sheet G2 ($16.44 today) and is used by Rule 3 only. Rule 1's $25/$3.00 are fixed click economics. (Floor raised $15 → $25 on 2026-07-18: at $15 the first strike often landed on 6-10 clicks before Meta's attribution settled, causing false kills like CT89 — read $3+, settled $2.23.) CPC line raised $2.50 → $3.00 same day: $2.50 sat on top of the observed CPC band (CT89 $2.23, CT83 $2.29), so jitter alone tripped kills the audit had to reverse.

(Old Rule 4 — 7-day verdict — was removed 2026-05-25.)

## What it does

Every hour:
1. Checks the Bot Control kill switch in the Hit Rate sheet — exits if OFF.
2. Reads breakeven CPP from the KPI sheet (cell G2).
3. Pulls every ACTIVE adset under every ACTIVE campaign in the ad account.
4. **Auto-fills missing `Ad Set ID` values in column W** of the May tab by prefix-matching `CT<#>` against adset names.
5. For each ACTIVE adset: pulls Meta insights over the adset's own run window (`start_time` → today).
6. Applies Rules 1–3. If a rule fires:
   - Pauses the adset via Meta API
   - Polls Meta insights 3× (8s / +22s / +30s ≈ 60s) and takes the highest-spend snapshot — Meta's ledger lags delivery, single re-fetch undercounts spend. Updates `verdict.reason` with the reconciled spend.
   - Writes `PAUSED` to that row's column R (via `USER_ENTERED` — RAW silently fails on the Status dropdown)
   - Writes a one-line results summary to column S (`Loser — Killed by Rule X (…). Spend $. CPC … CTR …% …`)
   - **Creates the CT tab nested under the matching month parent** (May/June/…) in the Hushlab Learnings Google Doc. The month parent is auto-created if missing (e.g. first kill in June creates the `June` tab on the fly). Tab is pre-filled with metrics + **Old Hypothesis read live from sheet col P** (never reconstructed) + empty Learnings/New Hypothesis sections. After creation, siblings under the month are re-sorted in CT-numeric order (CT16 before CT17, etc.). Ad copy pulled from Meta and written into a `Copy | <title>` child sub-tab.
   - Appends a row to the **Bot Log** tab. Column B = the CT number parsed from the adset name (e.g. `16` for `05.26.26 | CT16 | Breathe`).

After all kills are processed, the bot runs a **settled-metrics reconciliation pass**: for every row marked PAUSED within the last 7 days, it re-fetches Meta insights, compares against the spend already written in column S, and if the number has drifted upward (Meta keeps trickling in billed spend for hours after a pause) it rewrites both column S and the doc's Metrics block — preserving Nate's hand-written Learnings + New Hypothesis below. This converges every row to true final-state numbers within ~24h of pause.

Bot Log column widths and left-alignment are re-asserted every run (idempotent) so the Notes / Ad Set Name / Spend columns don't get clipped or visually drift.

Notifications: none for v1 — check the **Bot Log** tab or the Learnings doc to see what the bot did.

## Things that silently break if you forget them

A list of gotchas baked into the code, kept here so future edits don't reintroduce the bug:

1. **`valueInputOption` must be `USER_ENTERED`, not `RAW`** for any cell that has data validation (column R is a dropdown). RAW writes get silently rejected with no error.
2. **Post-pause insights lag.** Meta's `/insights` endpoint can return a stale snapshot for up to ~2 min after a pause. The code polls 3× and keeps the highest-spend snapshot.
3. **CT tabs nest under the month parent** (`May`, `June`, …). Pass `parentTabId = monthTabId` on `addDocumentTab`. The month tab itself is the one created with no parent. After creating a CT tab, call `reorderMonthTabChildren(monthTabId)` so siblings re-sort in CT-numeric order (CT16 before CT17). The Copy sub-tab is `parentTabId = ctTabId`.
4. **Hypothesis text from col P must be re-read live** at write time, never reconstructed from memory or paraphrased — see `~/.claude/projects/-Users-nathankim-Desktop-ais-os/memory/feedback_never_paraphrase_user_content.md`.
5. **CT-number matching** uses `\bCT(\d+)\b` (word boundary), not `^CT(\d+)\b`, because adset names can start with a date prefix like `05.25.26 | CT14 | Breathe`.

## Modes

- **DRY_RUN=true** (default): logs decisions to Bot Log and emails the summary, but does NOT pause any ad set and does NOT flip Status on the May tab.
- **DRY_RUN=false**: live mode. Run for at least 48 hours in DRY_RUN before flipping.

Toggle via repo variable `DRY_RUN` or manual workflow dispatch input.

## Secrets required (GitHub repo → Settings → Secrets and variables → Actions)

| Name | Value |
|---|---|
| `META_ACCESS_TOKEN` | The long-lived Business Manager System User token (same one the local `meta-automation` MCP uses). |
| `META_AD_ACCOUNT_ID` | `act_670009365016170` |
| `GOOGLE_SA_JSON` | Full JSON of a Google Cloud service account with Sheets + Docs API access. **Must share the Hit Rate sheet, the KPI sheet, AND the Hushlab Learnings Doc with this service account's email address (Editor).** |

## Repo variable (optional)

- `DRY_RUN` — set to `false` to go live. Defaults to `true` if unset.

## Manual run

Actions tab → "Hushlab Killbot" → "Run workflow" → choose DRY_RUN value.

## One-time setup for the Google service account

1. https://console.cloud.google.com/ → create or reuse a project.
2. Enable **Google Sheets API** AND **Google Docs API**.
3. IAM & Admin → Service Accounts → Create. Name it `hushlab-killbot`. No roles needed (we authorize at resource level).
4. Keys → Add key → JSON. Download.
5. Paste the entire JSON file's content as the `GOOGLE_SA_JSON` GitHub secret.
6. Share three resources with the service account's `client_email` (`<name>@<project>.iam.gserviceaccount.com`) as **Editor**:
   - Hit Rate sheet (`1NuOZWgP0mGhJ_MO6vevXj9EEpSxM94iUsFOULsEjehs`)
   - KPI sheet (`1GWTUjvuYnSrn64nrqfLB9AsAKwDm4JCnk6c4nbhWM1A`)
   - Hushlab Learnings Doc (`1vl5TQiCdfnbpA711Y5IpFl8ZkwmMvf3KQZu0Pq6Q3RE`)

## Going live

1. Push code + add secrets. Workflow runs hourly automatically.
2. Check Bot Log after first 2–3 runs — confirm logged decisions match what you'd do manually.
3. After 48 hours of clean DRY_RUN behavior: set repo variable `DRY_RUN=false`.

## Killing the bot

- Soft: set `Bot Control!B1` = `OFF` in the Hit Rate sheet. Bot exits immediately on next run.
- Hard: disable the workflow in GitHub Actions.

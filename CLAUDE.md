# CLAUDE.md — OutboundHero Database
> Load this file at the start of every Claude Code / Cursor session.
> This is the single source of truth for architecture, conventions, and decisions.
> Forked from `opslab-database-clean copy` (Renaissance Database) on 2026-06-04.

---

## Project Overview

**What it is:** Internal B2B lead database for OutboundHero. Apollo-style filter + export UI that retains contact data, validates emails on a 45-day TTL, and feeds validated/non-bounced leads into Email Bison campaigns.

**Why we forked Renaissance:** OutboundHero needs the same filtering/export engine but with three new capabilities that don't exist in Renaissance: (a) email-type classification (general vs personal/decision-maker), (b) Reoon→FindEmail email validation with cached re-validation, (c) bounce tracking + auto-exclusion. Plus an iOS-style visual refresh of the entire UI.

**Current state:** LIVE IN PRODUCTION on Railway. All phases shipped: validation,
email-type detection, bounce classification, category enrichment, location
intelligence, client targeting, queued Bison pushes, the Bison lead mirror, and
never-contact suppression. Migrations run to **097**.

**Actual production scale** (measured 2026-09-09 — not estimates):

| Table | Rows | Size |
|---|---|---|
| `leads` | 8.72M | 14 GB |
| `bison_leads` | **12.2M** | 12 GB |
| `lead_history` | 8.71M | 1.6 GB |
| `companies` | **4.68M** | 2.8 GB |
| `push_items` | 3.32M | 1.4 GB |
| `lead_job_titles` | 1.22M | 234 MB |
| `company_locations` | 938k | 143 MB |
| `geo_locations` | 293k | 51 MB |
| `client_tags` / `client_targeting` | 209 / 187 | small |

Enrichment coverage (same measurement): **85.2%** of leads have a category
(6.85M clay / 523k bison / 47k keyword) and **69.3%** have a resolved
`location_id`. See the Bison mirror section — those numbers moved from 27% and
~50% by mirroring Bison's own custom variables back into `leads`.

`leads` carries ~48 indexes, so **any mass UPDATE on it is extremely
write-amplified** — every row rewrite touches every index. This is the single
biggest performance consideration in the codebase.

**Stack:** Next.js 16 (App Router) + Supabase (PostgreSQL + Auth + Storage) + TypeScript.

---

## What's new vs. Renaissance

| Area | Renaissance | OutboundHero |
|---|---|---|
| UI design | shadcn/ui defaults (neutral grays) | iOS-style: iOS Blue accent, frosted top bar, grouped lists, segmented controls, iOS toggles |
| `email_type` column | n/a | `'general' \| 'personal'` — detected at import from "(general)" parenthetical + role-prefix regex |
| `validation_status` + `validated_at` | n/a | `valid \| catch_all \| invalid \| pending`, 45-day TTL, populated by Reoon → FindEmail fallback |
| Bounce tracking | n/a | `is_bounced` + `bounced_at` + `bounce_source`; CSV upload page to ingest Email Bison bounce exports |
| Keyword filter | include only | include + exclude (multi-field across company_name, general_industry, specific_industry, company_overview) |
| Export gating | none | Pre-export validation pass → only `valid` + `catch_all` and non-bounced rows exit |

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16 (App Router, Turbopack) | React Server Components where possible |
| UI Library | shadcn/ui re-skinned to iOS | iOS primitives in `src/components/ui/ios/` |
| Database | Supabase PostgreSQL | Plan size driven by data volume (see Storage) |
| Auth | Supabase Auth | Email invites, password login, forgot password |
| Storage | Supabase Storage | Export files (5 GB bucket limit) |
| Deployment | Railway | URL TBD; set `NEXT_PUBLIC_SITE_URL` env var |
| Email validation | Reoon (primary) → FindEmail (fallback) | 45-day TTL; ~100 emails/batch |
| Filtering | Server-side RPC (`fn_filter_leads_v2`) | JSONB filters, 120s timeout |
| Exports | Streaming CSV (`/api/exports/stream`) | Direct browser download, no storage needed |

---

## Database Schema

### Core tables (inherited from Renaissance, unchanged)

`leads`, `lead_job_titles`, `companies`, `user_profiles`, `export_jobs`, `dashboard_snapshots`, `filter_options_cache`, `api_tokens`, `api_logs`, `audit_logs`, `upload_batches`, `lead_history`.

See migrations 001–027.

### New columns on `leads` (migrations 028–031)

```sql
email_type TEXT CHECK (email_type IN ('general','personal'))
validation_status TEXT CHECK (validation_status IN ('valid','catch_all','invalid','pending'))
validation_provider TEXT  -- 'reoon' | 'findemail'
validated_at TIMESTAMPTZ
validation_response JSONB
is_bounced BOOLEAN DEFAULT false NOT NULL
bounced_at TIMESTAMPTZ
bounce_source TEXT
```

New indexes: `idx_leads_email_type`, `idx_leads_validation_status`, `idx_leads_validated_at`, partial `idx_leads_is_bounced WHERE is_bounced = true`, composite `(validation_status, is_bounced)`.

### New tables

- `validation_jobs` (migration 034) — `id, export_job_id, total, completed, credits_used, status, started_at, completed_at`. Drives the export-time validation progress UI.
- `upload_batches.batch_type` (migration 035) — extends existing table with `'leads' | 'bounces'`.

---

## Email validation — background queue on Reoon daily credits (2026-09-14)

⚠ **The export-time validation pass is GONE.** It ran Reoon on up to 2,000
addresses *before streaming a row* — ~20 min of silence at power-mode speed. On
2026-09-11 an 8,451-lead export had validated 1,400 after 15 min with zero rows
sent when the user cancelled; the largest CSV ever completed through that path
was **50 rows**. Exports now stream immediately and queue their addresses at
priority 1 (fire-and-forget; a queue failure can never delay the download).

**Why a queue at all:** 8.96M of 8.97M leads had never been validated. The Reoon
account is on **daily credits** (balance API 2026-09-14: 84,698 daily, **0
instant**). At ~85k/day the full backlog is ~3 months, so the work is spread
over replenishing credit instead of paid up front (~$7.9k at instant rates).

`scripts/validation-worker.mjs` — Railway cron `validation-worker`, `17 * * * *`:

1. **Reconcile** — poll submitted Reoon bulk tasks; apply finished ones.
2. **Refill** (once per 24h, time-boxed 15 min, resumable) — queue unvalidated
   leads eligible for each of the ~69 active clients via
   `fn_client_eligibility_conditions` (cap `VALIDATION_CLIENT_REFILL_CAP`, 10k).
3. **Submit** — only if no task is in flight and the account holds **zero paid
   instant credits** (hard stop, see below): budget =
   `remaining_daily_credits − VALIDATION_DAILY_RESERVE` (2,000), claim up to
   `VALIDATION_TASK_SIZE` (25k; Reoon max 50k) and create ONE bulk task.

**First production run (2026-09-14 16:19 UTC, 337s, exit 0):** refill took
5.5 min for all 69 clients and **every client hit the 10k cap** — 690,000 queue
rows = **483,141 distinct addresses** (clients overlap). That priority-2 backlog
alone is ~6 days of daily credit; the refill tops it up every 24h. The run then
claimed 25,000 and submitted them as one Reoon task. `leads.validation_status`
count stayed at exactly 2,720 (the pre-existing export-time verdicts).

Claim order: `validation_queue` by priority (1 export, 2 client-eligible,
3 retry), then a **cursor walk over `leads` by id in bounded 100k-id windows**
(priority 4). The bounded window is deliberate — see the location-worker and
Bison-import incidents: a claim that filters a thinning cohort off an unbounded
scan eventually stops completing.

### ⚠ Results go to `email_validations`, NOT `leads.validation_status`

**Client decision 2026-09-14:** campaign push logic stays exactly as it is until
the backfill is complete. The push gate is `is_bounced = false AND
(validation_status IN ('valid','catch_all') OR validation_status IS NULL)`;
writing `invalid`/`unknown` onto leads would silently change who gets emailed
mid-backfill. `email_validations` (keyed on the address, like `suppressed_emails`)
uses the same status vocabulary, so the eventual rule change is a straight swap.
Nothing in the push or export path reads it yet. Done = the backfill cursor
wraps (`validation_worker_state.cursor.wraps ≥ 1`) with the queue empty.

### Reoon facts that shaped this (docs + probes, 2026-09-14)

- **Single-address endpoint: "no more than 5 threads".** The old export path ran
  12. Bulk tasks (≤50,000 addresses) are paced server-side, power mode.
- `GET /api/v1/check-account-balance/?key=` → `remaining_daily_credits`,
  `remaining_instant_credits`.
- ⚠ **HARD RULE (client, 2026-09-15): daily refresh credits ONLY — never paid
  instant credits.** Budget = daily balance, and the worker **refuses to submit
  anything** (exit 1, red Railway card) while `remaining_instant_credits` is
  anything but exactly 0 — including when the field is missing. Capping a task at
  the daily balance is not enough on its own: Reoon does not document which pool
  a task draws from when both are non-zero. Instant credits read 0 on all 27
  balance checks through 2026-09-15, so no paid credit has ever been spent.
  Tested with a mocked balance: instant=5 → refused, field missing → refused,
  instant=0 → normal.
- **Daily credits reset around 00:00 UTC** (1,881 at 23:17 → 92,383 at 00:19 on
  2026-09-15). Allotment is ~**92,000/day**. Measured from `validation_balance_log`.
- **`unknown` verdicts ARE refunded**, after the task completes. A 25,000-address
  task cost ~22,000 credits — the difference matches its unknown count within a
  few hundred (e.g. 84,515 → 62,329 across a task with 2,977 unknowns). That is
  why a 92k allotment validated **102,545** addresses on 2026-09-15.
- **Credits are the bottleneck, not Reoon.** Every 25,000-address task finished
  within its hour, so the day's allotment is spent by ~05:00 UTC and the worker
  then idles until the reset. Raising `VALIDATION_TASK_SIZE` would only spend the
  same credits sooner.
- **This API key is shared.** The balance fell 69 credits (84,698 → 84,629)
  before the worker had submitted anything. On 2026-09-15 the balance reached
  **0** despite the 2,000 `VALIDATION_DAILY_RESERVE`, so the other consumer
  likely used the reserve and then had nothing until the reset. Raise the reserve
  if that other usage matters.
- Bulk statuses `disabled` and `inbox_full` are not in the single endpoint's
  mapper: worker maps disabled → `invalid`, inbox_full → `risky`, role_account →
  `valid`, anything unrecognised → `unknown`.
- Observed verdict mix on the first 24 addresses: safe 9, catch_all 7,
  role_account 5, unknown 3. Tiny sample — re-measure from `email_validations`
  before drawing conclusions about the eventual gate switch.

### Crash safety (each tested)

A task is written as `claimed` before Reoon sees it; a claim older than 15 min
with no Reoon id is **abandoned and its addresses requeued** (attempts counted,
dropped after 5). A crash mid-apply leaves the task `submitted`, so the next run
re-applies — the upsert is idempotent. Only one task is ever in flight. Watchdog
exits 0 at 50 min so an hourly firing is never skipped.

**Env vars:** `REOON_API_KEY`, `DATABASE_URL` (the only two the worker needs),
optional `VALIDATION_DAILY_RESERVE`, `VALIDATION_TASK_SIZE`,
`VALIDATION_REVALIDATE_DAYS` (90), `VALIDATION_CLIENT_REFILL_CAP`,
`VALIDATION_QUEUE_MAX`. Local: `--dry-run` (no writes, no spend), `--max=N`,
`--no-refill`.

The old single-address providers (`src/lib/validation/`) remain for small ad-hoc
checks, now with a 30s per-call timeout and a hard 5-thread cap. `validateLeads`
currently has no callers.

---

## Email-type classification (NEW)

`src/lib/uploads/detect-email-type.ts` runs at import time:

- Role prefixes: `info@`, `contact@`, `hello@`, `sales@`, `support@`, `admin@`, `team@`, `office@`, `marketing@`, `noreply@`, `no-reply@`, `mail@`, `careers@`, `hr@`, `jobs@`, `press@`, `media@`, `billing@`, `accounts@`, `invoices@` → `general`
- "(general)" parenthetical anywhere in `first_name`, `last_name`, or `job_title` → `general`
- Else → `personal`

Backfill: `scripts/backfill-email-type.mjs` (10K-row chunks, idempotent).

---

## iOS design system

**Tokens** in [src/app/globals.css](src/app/globals.css):
- iOS Blue primary (`#007AFF`), iOS Red destructive, iOS Green success
- Card radius 14px, button radius 16px (pill-ish), input radius 12px
- System font stack starting with `-apple-system, BlinkMacSystemFont, "SF Pro Text"`
- Soft two-layer shadows on cards (`0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06)`)

**Primitives** in `src/components/ui/ios/`: `ios-toggle`, `ios-segmented-control`, `ios-list-cell`, `ios-grouped-list`, `ios-sheet`, `ios-toolbar`, `ios-search-field`.

**Re-skinned shadcn** in `src/components/ui/`: button (filled/tinted/ghost iOS variants), input (taller, muted bg), card (soft shadow), tabs (segmented), dropdown/popover (frosted backdrop), dialog (rounded 20px), table (inset dividers), checkbox (iOS Reminders style).

**Layout shell:** sidebar uses grouped-list cells; top nav is a frosted `ios-toolbar`; on mobile, sidebar collapses into a fixed bottom tab bar.

**Dialogs scroll as a whole.** `DialogContent` carries `max-h-[85vh]` +
`overflow-y-auto` in [dialog.tsx](src/components/ui/dialog.tsx), so any dialog
taller than the viewport scrolls instead of clipping its bottom off-screen. Fix
overflow **there**, not per-dialog: the export popup was unreachable below the
fold for months while only `add-lead-modal` had patched it locally. Inner
scrollers (`max-h-[40vh] overflow-y-auto` on long lists) still compose fine.

---

## RPC functions

| Function | Purpose | Timeout |
|---|---|---|
| `fn_filter_leads_v2(p_filters, p_sort_by, p_sort_dir, p_limit, p_offset)` | Main filter — extended for `email_type`, `exclude_keywords`, silent `is_bounced` filter (migration 032); honours `skipCount` inside `p_filters` (086) | 120s |
| `fn_filter_leads_count(p_filters)` | The Leads page's total — its own request since 2026-10-21 (`/api/leads/count`) | 120s, then 57014 (the in-function 15s fallback never fires — see "Leads total is its own request") |
| `fn_cancel_lead_queries(p_tags)` | Cancels running Leads searches tagged `application_name = 'leads-q:<uuid>'` (`queryTag` in `p_filters`, 119); service_role only | n/a |
| `fn_lead_column_values(p_filters, p_column, p_search, p_limit, p_scan_cap)` | Per-column filter dropdown values (088); 20-name allowlist, `'__BLANK__'` sentinel | 25s |
| `fn_export_leads(p_filters, p_cursor, p_limit, p_skip)` | Export — enforces `validation_status IN ('valid','catch_all') AND is_bounced = false` (migration 033) | 300s |
| `fn_lead_filter_conditions(p_filters)` | Shared WHERE builder — browse/export gate, suppression escapable | n/a |
| `fn_client_eligibility_conditions(...)` | Client send gate — suppression NOT escapable, exclusions match by CONTAINS | n/a |
| `fn_sync_companies(p_propagate_limit)` | Upsert companies → seed → propagate; **call in a loop** until under the limit | bounded |
| `fn_dashboard_stats()` | Full GROUP BY for dashboard | 300s |
| `fn_refresh_filter_cache()` | Repopulates `filter_options_cache` | 300s |

---

## Permission Roles

| Role | Permissions |
|---|---|
| `owner` | Everything + bulk delete + user management |
| `admin` | Everything in manager + user management + bulk delete + "Include bounced" override |
| `manager` | View + filter + export + dashboard |
| `viewer` | Filter and view leads only |

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL                  # IPv4 pooler URL (port 6543)
NEXT_PUBLIC_SITE_URL          # Public Railway URL — no hardcoded fallback in code
REOON_API_KEY                 # Email validation primary
FINDEMAIL_API_KEY             # Email validation fallback
VALIDATION_BATCH_SIZE         # default 100
VALIDATION_REVALIDATE_DAYS    # default 45
COSTING_API_KEY               # Bearer key ReplyRouter uses for GET /api/costing (web service only, ≥32 chars; unset/short = every call 500)
COSTING_ENVIRONMENT           # optional; product.environment in the costing feed (default production)
EMAILBISON_KEYS               # JSON: instance domain -> token. FOUR Bison installs
                              #   group 1: app.outboundhero.co   + personal.cleaningoutbound.com
                              #   group 2: app.facilityreach.com + personal.outboundclean.com
                              # (b2b + b2c per group; every client belongs to one group)
EMAILBISON_API_KEY            # single/default Bison token (fallback for any instance)
EMAILBISON_BASE_URL           # optional; default instance domain
OPENAI_API_KEY                # gpt-4o-mini — categorize worker AI tier (preferred)
ANTHROPIC_API_KEY             # claude-haiku-4-5 — alternative categorize provider
CATEGORIZE_PROVIDER           # optional force: openai | anthropic
CATEGORIZE_MODEL              # optional model override
GOOGLE_SERVICE_ACCOUNT_B64    # base64 service-account JSON (Sheets, readonly scope)
CLIENTS_SHEET_ID              # client-groups workbook ("Sheet1" = the two group columns)
CLIENT_TRACKER_SHEET_ID       # roster + statuses + onboarding tabs — needed by the WEB service too
ONBOARDING_SHEET_ID           # optional; Groups-tab workbook for /api/clients/sync-groups
TAXONOMY_SHEET_ID             # category taxonomy workbook
PUSH_RATE / PUSH_CONCURRENCY / PUSH_CLAIM_BATCH / PUSH_BATCH_FOCUS / PUSH_REFRESH_MS
                              # push-worker throughput knobs (see Push throughput)
```

⚠ **Env vars are per-service on Railway.** A var the crons have is not
automatically on the web service — `CLIENT_TRACKER_SHEET_ID` was missing there
until 2026-09-09, which would have made the new full sheet sync silently skip the
roster merge. When a route starts doing work a script used to do, diff the two
services' variables.

---

## Storage & compute

Target scale: 15–20M leads. Currently at **8.72M leads / 14 GB**, plus 1.6 GB
history, 2.8 GB companies, 1.4 GB `push_items` — and **12 GB of `bison_leads`**,
which nearly doubled the database. The mirror is the single largest object after
`leads`; budget for it when sizing the plan, and note that `shared_buffers`
(4,096 MB) is now a far smaller fraction of the working set than when the cache
analysis below was done.

⚠ **Disk I/O budget is the real constraint, not storage.** Supabase compute
tiers have a burst IOPS budget; exhaust it and the whole project — app
included — throttles to baseline until it refills. It has been exhausted at
least once (2026-08-07) by enrichment work. Before running anything that scans
or rewrites `leads` in bulk, check Reports → Database in the Supabase dashboard.

### Index bloat and cache pressure (measured 2026-08-19)

`shared_buffers` is **4,096 MB** against a database of ~11 GB, so the working
set does not fit in cache. Measured heap cache hit ratio was **73%** (healthy is
>99%) — that, not any single slow query, is why the whole app felt slow. Every
MB of index bloat is cache the rest of the database does not get.

`leads` had **7,971 MB of indexes on a 3,979 MB table**. Cause: 7.33M updates of
which only 758k were HOT, so ~90% rewrite all ~39 index entries. With autovacuum
on the global defaults (vacuum only after ~1.64M dead rows) the dead entries
never got reclaimed — `idx_leads_subcategory_trgm` was **62% bloat**,
`idx_leads_created_id` 46.8%, `leads_email_key` 36.2%.

Fixed by migrations **083** (drop 3 prefix-redundant indexes) and **084**
(per-table autovacuum: vacuum 0.2→0.05, analyze 0.1→0.02) plus a full
`REINDEX INDEX CONCURRENTLY` pass. Result: **7,971 MB → 4,340 MB**.

- Check bloat with `pgstatindex('idx_name')` — **btree only**; it errors on GIN.
- `REINDEX INDEX CONCURRENTLY` is safe and cheap (most indexes 10–20s): the old
  index stays valid and serving the whole time. If it is cancelled it leaves an
  INVALID `*_ccnew` index consuming space — always check
  `pg_index WHERE NOT indisvalid` afterwards and drop what you find.
- ⚠ **A zero `idx_scan` does not mean an index is droppable.** It means the
  planner has not chosen it lately. Only drop an index that is a STRICT PREFIX
  of a wider surviving index (`(a)` under `(a,b)`), which is provable, or one
  whose feature is genuinely gone. ~2 GB of zero-scan indexes were deliberately
  KEPT for this reason (name trigrams, annual_revenue, category_pending…).
- ⚠ `ALTER TABLE leads SET (...)` needs a brief ACCESS EXCLUSIVE lock and will
  hit the 2-minute timeout if a `REINDEX CONCURRENTLY` is running. Wait it out.

### statement_timeout DOES survive the SESSION pooler

The role default is **2min**. CLAUDE.md previously said `statement_timeout` does
not survive Supavisor — that is true of the **transaction** pooler (port 6543)
but NOT of **session** mode (port 5432), where `SET statement_timeout = 0` holds.
Use port 5432 for long maintenance (the 1.3 GB GIN reindex needed 205s and was
killed twice on 6543).

Known I/O-heavy patterns to avoid:
- Unbounded `fn_sync_companies()` — fixed in migration 074, keep it bounded
- `scripts/infer-company-locations.mjs` C1 pass uses **OFFSET pagination over a
  GROUP BY**, so every page re-aggregates the whole table. It also sets
  `statement_timeout = 0`, removing the safety net, and loads the entire
  no-location cohort into Node memory with no LIMIT
- `scripts/backfill-lead-locations.mjs` pass 2 loads all city-only leads unbounded

---

## Naming Conventions

- **Database:** snake_case for all tables and columns
- **TypeScript:** camelCase for variables/functions, PascalCase for components/types
- **API routes:** `/api/leads/filter`, `/api/exports/stream`, `/api/admin/invite`
- **Migrations:** `NNN_description.sql` (sequential, additive only)
- **RPC functions:** prefix with `fn_` e.g. `fn_filter_leads_v2`

---

## Key Files

```
src/app/api/leads/filter/route.ts          — Main filter API (fn_filter_leads_v2 RPC); ?count=0 = rows only
src/app/api/leads/count/route.ts           — Leads total (fn_filter_leads_count), separate from the rows; 57014 → {timedOut:true}
src/app/api/leads/cancel/route.ts          — Stops searches the Leads page gave up on (fn_cancel_lead_queries, 119)
src/app/api/costing/route.ts               — ReplyRouter costing feed (Bearer COSTING_API_KEY; reads cost_line_items, 121)
src/lib/costing/feed.ts                    — Costing feed: range/key checks, exact read + totals, integrity backstop
src/lib/costing/db.ts                      — The costing route's own 2-connection pool (fails fast)
scripts/lib/costing-store.mjs              — Costing writers' validation (spec rules) + upsert; BigInt money
scripts/costing-import.mjs                 — Invoice headers + lines -> cost_invoices / cost_line_items (dry run by default)
scripts/lib/fake-pg.mjs                    — Tiny fake Postgres for testing a route's failure paths (used by test-costing-feed)
src/lib/leads/query-cancel.ts              — Query-id registry: refuse/cancel abandoned searches (globalThis, see 119 section)
src/app/api/exports/stream/route.ts        — Streaming CSV export + validation pre-pass
src/app/api/exports/process/route.ts       — Background export (for selected IDs)
src/app/api/dashboard/refresh/route.ts     — Dashboard refresh
src/app/api/admin/invite/route.ts          — User invite (uses NEXT_PUBLIC_SITE_URL)
src/app/api/uploads/process/route.ts       — CSV lead import
src/app/api/uploads/people/route.ts        - An upload's no-email rows: where they stand, add found emails, send by hand (130)
src/app/api/uploads/found/auto/route.ts    - The worker's request to add an upload's found emails (Bearer AIARK_AUTO_ADD_KEY, 130)
src/lib/uploads/found.ts                   - A round of found emails: what it takes, settles and writes (130)
src/lib/uploads/found-run.ts               - Runs a round: the lock, the round's batch, the import in after(), settling (130)
src/components/uploads/upload-people.tsx   - The Uploads page's People box, People column and Send (130)
scripts/lib/enrich/upload-people.mjs       - Shared by the worker and the web: which client, row keys, inputs, found-email SQL (130)
scripts/lib/enrich/upload-move.mjs         - The worker's copy of an upload's no-email rows into the People table (130)
scripts/lib/enrich/upload-found.mjs        - The worker's side of the found-email hand-off (130)
src/app/api/uploads/bounces/route.ts       — CSV bounce import (NEW)
src/app/auth/callback/route.ts             — Auth callback (uses x-forwarded-host)
src/components/filters/filter-bar.tsx      — Filter chip UI
src/components/filters/filter-email-type.tsx — Email type segmented control (NEW)
src/components/exports/export-button.tsx   — Export UI + validation progress sheet
src/components/ui/ios/                     — iOS design primitives (NEW)
src/lib/filters/build-rpc-filters.ts       — Builds RPC filter JSON
src/lib/uploads/normalize-row.ts           — CSV row normalization + email-type detection + state normalization
src/lib/uploads/detect-email-type.ts       — General/personal classifier (NEW)
src/lib/validation/validate-leads.ts       — Reoon→FindEmail orchestrator (NEW)
src/lib/validation/providers/reoon.ts      — Reoon bulk client (NEW)
src/lib/validation/providers/findemail.ts  — FindEmail fallback client (NEW)
src/lib/validation/cache-policy.ts         — 45-day TTL check (NEW)
src/types/filters.ts                       — FilterState (extended for emailType + exclude_keywords + includeBounced)
src/types/database.ts                      — Lead type (extended for new columns)
scripts/backfill-email-type.mjs            — One-off classification backfill (NEW)

── Bison mirror, routing, suppression, coverage ──
scripts/sync-bison-leads.mjs               — THE Bison mirror sync (shards, cursors, watermark, --pace)
scripts/backfill-bison-custom-vars.mjs     — per-email cv fetch (targeted; bulk goes through the mirror)
scripts/refresh-location-coverage.mjs      — precomputes client_location_coverage (npm run coverage-refresh)
src/lib/bison/esp-bucket.ts                — suggestBucketFromName + espBucket (campaign routing)
src/lib/db/pool.ts                         — shared pg pool for routes that bypass PostgREST
src/lib/google/sheets.ts                   — service-account Sheets reader, READONLY scope only
src/app/api/bison/push-batch/route.ts      — queues a push; STAMPS side + bucket on campaigns
src/app/api/bison/push-forecast/route.ts   — net-new vs chosen campaigns (bison_leads.campaign_ids)
src/app/api/bison/push-stats/route.ts      — per-client push memory incl. lifetime block
src/app/api/leads/suppress/route.ts        — never-contact: POST suppress, DELETE unsuppress
src/app/api/clients/sync-sheet/route.ts    — full on-demand client sheet sync (the cron's merge)
src/app/api/clients/location-coverage/route.ts — reads precomputed coverage; ?fresh=1 recomputes
src/components/leads/suppress-leads-dialog.tsx — "Never contact" dialog
```

⚠ **Legacy vs live scripts.** `scripts/` also holds ~20 one-off and
Renaissance-era importers (`import-leads.mjs`, `import-final.mjs`,
`merge-*.mjs`, `update-*.mjs`, `upload-to-staging.mjs`, the `clean-*-column.mjs`
location passes, `location-round2.mjs`, `ai-state-pass.mjs`). They are historical
records of one-time data repairs, **not** maintained entry points — do not treat
their presence as evidence of a live pipeline. The scripts wired to npm/Railway
are the ones in `package.json`.

---

## Bounce classification (NEW)

Bounces are split into contactable vs dead by `scripts/bounce-worker.mjs`, a
**separate Railway cron service in the same project** (same repo; start command
`node scripts/bounce-worker.mjs`, schedule **`0 */6 * * *`** — every 6 hours,
NOT the `*/15` this doc previously claimed).

For every lead with `bounces > 0` not yet checked (or re-bounced since last
check), the worker calls Email Bison
`GET /api/leads/{email}/replies?folder=bounced` (the endpoint accepts the
lead's email as the id) and classifies the NDR text:

| `bounce_type` | Meaning | Effect |
|---|---|---|
| `sender` | Our sending inbox's fault (auth/quota/reputation/rate-limit) | `is_bounced` → **false**, lead restored |
| `gateway` | Recipient security gateway (Proofpoint, Mimecast, Barracuda, EOP…) — migration 063 | `is_bounced` → **false**, lead restored |
| `group` | NDR names other recipients, never the contact — a distribution-list failure — migration 070 | `is_bounced` → **false**, lead restored |
| `policy` | "Blocked by recipient policy" — migration 072 | `is_bounced` → **false**, lead restored |
| `hard` | Recipient genuinely invalid / no such mailbox | stays excluded, never exported |
| `unknown` | No bounce reply found or ambiguous | treated like hard, reviewable |

**Client rule (2026-08-06): only a genuinely invalid address counts as a real
bounce.** Policy blocks and gateway rejections are recoverable, so four of the
six verdicts restore the lead.

Columns (migration 047): `bounce_type`, `bounce_reason` (NDR snippet),
`bounce_checked_at`. The leads-page "Bounced" chip ("Include undeliverable",
visible to all roles) un-hides hard/unknown leads in the table; exports always
exclude them.

⚠ `node scripts/bounce-worker.mjs --test-classifier` currently fails 3/30: the
built-in corpus still expects `hard` for the three policy-block NDRs that
migration 072 deliberately reclassified as `policy`. Production behaviour is
correct; the test expectations are stale.

---

## Category enrichment (NEW)

**Bison is the primary source.** Leads arrive with `category` / `subcategory` /
`additional category` personalization variables (client enriches natively in
Bison); the import ingests them (`category_source='bison'`). The AI layer is a
FALLBACK for leads that arrive without category data, and it is **cached per
company** — a company name categorized once (by Bison or by the worker) is
never re-processed.

**Companies table** (migration 049): unique identity = company name + city +
state (normalized `company_key` generated column). `fn_sync_companies()` —
called after every import and by the worker — (1) upserts companies from
leads, (2) seeds company categories from categorized leads, (3) propagates
cached company categories to uncategorized leads.
Legacy `UNIQUE(domain)` was dropped (many businesses share gmail.com).

⚠ **"Expected ≤50k companies" was wrong by 26×** — and it has grown again. As of
2026-09-09 production has **4.68M** companies, **932k** of them still
uncategorized (that is the AI tier's remaining bill, ~$37 at 4o-mini rates).
Plan cost and runtime against the real number, and re-measure — it moves.

**Precedence is Bison/Clay > keyword > AI.** Current lead coverage: 85.2%
categorized — 6.85M `clay`, 523k `bison`, 47k `keyword`, **0 `ai`** (the tier has
never run in production). The cheap sources did most of the work; run them to
exhaustion *before* paying for AI.

⚠ **`fn_sync_companies` signature history — read before touching it.**
Migration 049 created the 0-arg form; 050 created `(p_propagate_limit integer)`.
`CREATE OR REPLACE` only replaces a MATCHING signature, so 050 added a second
overload instead of replacing, and a no-arg call became ambiguous
(`ERROR: function fn_sync_companies() is not unique`, SQLSTATE 42725). That
silently broke `/api/uploads/process` (error only `console.error`'d, so imports
reported success while never syncing companies) and crash-looped the categorize
worker. **Migration 073 drops the 0-arg overload; 074 changes the default from
NULL to 50000** so no-argument callers get the BOUNDED propagation branch
instead of a single UPDATE across 8.19M leads × 1.32M companies.

**Fallback worker** `scripts/categorize-worker.mjs` (Railway cron, schedule
**`0 3 * * *`**, start command `node scripts/categorize-worker.mjs
--keyword-only` — the AI tier is switched OFF in production), per
still-uncategorized COMPANY:

| Tier | Method | Cost |
|---|---|---|
| 0 | Taxonomy keywords vs company name (weight 3) / domain / sample question; single strict winner | free |
| 1 | AI: `gpt-4o-mini` (default, via `OPENAI_API_KEY`) or `claude-haiku-4-5` (via `ANTHROPIC_API_KEY`), 25 companies/call, strict JSON schema (category enum) | ~$0.00004/company (4o-mini) |

Taxonomy lives in `lead_categories` (seed: `npm run seed-categories file.json
[--replace]`). Manual assignments never overwritten; `Other` = nothing fits.
Filter chips: Category + Subcategory (include/exclude, mirror ESP; migrations
048/049 wired them into `fn_filter_leads_v2` + `fn_export_leads` +
`fn_refresh_filter_cache`).

⚠ **`syncCompanies()` now loops** on `SELECT * FROM fn_sync_companies($1)`
[50000] until a round returns `leads_propagated < LIMIT` (80-round safety cap).
The function returns `TABLE(companies_inserted, companies_seeded,
leads_propagated)` — read the right column. Selecting a nonexistent column
yielded `NaN`, an infinite loop, and an unhandled pg error.

**To turn the AI tier on** (pending client cost approval): drop `--keyword-only`
from the Railway start command, confirm `OPENAI_API_KEY` is set on
`categorize-worker`, then `DELETE FROM worker_locks WHERE key='categorize-worker'`.
The loop fix is already shipped, so the historical blocker is gone.

## Live Bison read (NEW)

`GET /api/bison/campaigns` proxies Email Bison's campaigns API in real time
(30s in-memory cache, `?fresh=1` bypasses) so campaigns created in Bison are
visible immediately for routing/location searches. Session-authenticated;
requires `EMAILBISON_API_KEY`.

## Push leads to Bison campaign (NEW)

The export popup (`column-selector.tsx`) has a destination toggle: **Download
CSV** (existing streaming export) or **Push to Bison campaign** (live campaign
picker). Push = `POST /api/bison/push` → `src/lib/bison/push-leads.ts`, a
two-step flow confirmed against docs.emailbison.com:

1. `POST /api/leads` — create/upsert each lead in Bison (enrichment sent as
   custom_variables: category/subcategory/city/state). Returns the Bison lead id.
2. `POST /api/campaigns/{id}/leads/attach-leads` `{ lead_ids: [...] }` — attach.

Bison lead ids are per-workspace, so leads are always created in the target
campaign's workspace (Bison upserts by email) rather than reusing a stored
`bison_lead_id` from another workspace. Synchronous, capped at 5,000/push
(client "pulls" are targeted). Gated on `EMAILBISON_API_KEY`.

Bison API semantics are aligned with the corofy enrich-worker (runs against
live Bison in production daily): id read `data.id ?? id`, and POST /api/leads
does NOT upsert — duplicate email errors are handled via find-by-search + PUT
refresh in both the sync lib and push-worker. Cross-workspace routing rules
(item 6) are pending the client call.

## ⚠ Bison caps every page at 15 rows — enumerate in PARALLEL (2026-08-25)

`/api/campaigns` ignores `per_page` and `limit` and always returns 15 rows, so
the page COUNT drives the cost. Measured install sizes:

| Install | Campaigns | Pages |
|---|---|---|
| `app.outboundhero.co` | 1,429 | 96 |
| `personal.cleaningoutbound.com` | 457 | 31 |
| `app.facilityreach.com` | 330 | 22 |
| `personal.outboundclean.com` | 315 | 21 |

`/api/bison/campaigns` used to chain `links.next` serially with a 20s
per-instance budget and `MAX_PAGES = 50`. Both limits were hit silently:
facilityreach stopped at page 16 (so its CCGCT campaigns, which sit later, were
absent from the picker entirely — the reported "why do I only see 3 installs?"),
and outboundhero was cut at page 50 of 96. The picker showed 1,777 of 2,531
campaigns and looked complete.

Now: read `meta.last_page` from page 1 and fetch the rest with
`PAGE_CONCURRENCY = 8`. All four installs, 2,531 campaigns, **12s, zero errors**.
Anything still short of `meta.total` is reported per instance and rendered
above the picker list — an incomplete list must never look complete.

**Prefer `?search=<term>`** where possible: it returns every match in ONE page
(9 CCGCT campaigns in 1.8s vs 22 paged requests). Both the client-tag scope and
the picker's free-text box use it, so those paths are always complete regardless
of install size.

## Queued Bison pushes (NEW — the default push path)

The export popup's Bison destination is a **multi-select** (workspace-grouped;
selections keyed `instance_url#id` since ids collide across instances) and
queues instead of pushing synchronously: `POST /api/bison/push-batch` inserts a
`push_batches` row (migration 052) and returns instantly — no 5k cap. Every
selected campaign gets every lead.

`scripts/push-worker.mjs` (always-on Railway service, `npm run push-worker`)
processes batches corofy-style: keyset-paginated gather through
`fn_lead_filter_conditions` + the eligibility gate → `push_items`; per item the
lead is created once per DISTINCT instance (`bison_ids` persisted BEFORE any
attach — crash recovery never duplicates), attached per campaign in chunks of
100, `sent` only when attached to ALL targets; 3 retries (deterministic 4xx
fail immediately), claim-token fencing, stale reclaim (items 10m / stranded
gathers 15m), per-instance 5 req/s throttle. `PUSH_WORKER_ONCE=1` drains and
exits (cron-style testing).

Exports page shows a "Bison pushes" panel (`GET /api/bison/push-batches`, 4s
poll while active) with per-batch progress + cancel
(`POST /api/bison/push-batches/cancel`). The synchronous `/api/bison/push`
remains for API consumers.

### Push throughput — what actually made it fast (2026-08-28)

Sustained rate is **~450–700 leads/min**. Four fixes got it there, in order of
impact; the first two were found only after adding `PUSH_TIMING=1` (per-cycle
breakdown) because **two prior hypotheses were wrong**. Measure before tuning.

1. **The eligibility WHERE is ~23,595 characters** and was re-planned *per lead*
   — 313 ms/lead of pure planning. Batched to one statement per client tag per
   cycle: **5.6 ms/lead**.
2. **FIFO batch focus.** `PUSH_BATCH_FOCUS=3` claims only from the N oldest
   batches. This both clears the old queue first (what the client asked for) and
   fattens the attach payloads — calls went from ~4 leads to ~44 leads each,
   because leads bound for the same campaign now arrive in the same claim.
3. Bounded-concurrency pools (`runPool`) for `processItem` / attach / finalize —
   finalize was serial round-trips.
4. Attach 422 "No leads were added" is a **blanket** error, so per-lead
   separation runs concurrently rather than serially.

Railway vars: `PUSH_RATE=45`, `PUSH_CONCURRENCY=64` (cap 96),
`PUSH_CLAIM_BATCH=400` (cap 1000), `PUSH_BATCH_FOCUS=3`, `PUSH_REFRESH_MS=20000`.

⚠ `Number(undefined) ?? 2` is `NaN`, not `2` — `PUSH_BATCH_FOCUS` was silently
off. Guard env-var defaults with `Number.isFinite`.

## ⚠ Campaign routing: side + bucket (read before touching pushes)

Routing has **two independent axes**, both stamped onto the campaign objects at
**queue time** and matched against the lead at **attach time**. Nothing about
routing is decided by the database, and a lead is never re-homed: no match means
it is skipped with a reason.

| Axis | Means | Decided by |
|---|---|---|
| `side` | which of the client's two installs (b2b / b2c) | the campaign's **install** vs `client_tags.b2b_instance` / `b2c_instance` |
| `bucket` | which campaign inside that install (`seg` / `outlook` / `default`) | the campaign **NAME**, via `suggestBucketFromName` |

**Stamping** — [push-batch/route.ts](src/app/api/bison/push-batch/route.ts) — runs
only inside `if (body.clientTag !== undefined)`. A caller-supplied bucket wins;
otherwise the name is parsed ([esp-bucket.ts](src/lib/bison/esp-bucket.ts)):
`\bsegs?\b|gateway` → `seg`, `outlook|microsoft|o365` → `outlook`,
`google|gmail|custom|gsuite|workspace` → `default`, else **no bucket**. Adding
"Gmail + Others" to the naming convention cut unlabelled main campaigns from
165/1,158 to 34, and those 34 are genuinely bespoke.

**Matching** — [push-worker.mjs](scripts/push-worker.mjs) — the lead's side is
`email_type === "personal" ? "b2c" : "b2b"`; its bucket is `espBucket(lead.esp)`:

```js
targets = allCampaigns
  .filter(c => !sided  || !c.side || c.side === side)
  .filter(c => !routed || (c.bucket ?? "default") === bucket)
```

⚠ **Both flags are per-BATCH, not per-campaign.** If *any* campaign in the batch
carries a bucket, every bucket-less campaign in that batch is treated as
`default`. If *any* carries a side, only side-less campaigns stay open to
everyone. Targets are then de-duplicated by `instance_url|id` — a campaign listed
twice is attached twice and Bison rejects the second as "already in another
sequence", turning a clean push into a partial failure.

**Why this exists:** until 2026-08-26 only the wizard labelled campaigns and the
export popup sent none — and the worker's unlabelled fallback is *attach to every
campaign*. So 100% of those batches' leads landed in **both** workspaces, in
2.33–5.98 campaigns each. The export popup still sends no bucket and no
`emailSide`, only the detected `clientTag`; all inference happens in the route.

⚠ On the `selectedIds` path the worker never re-reads filters, so the route
narrows the id list itself with the freemail split and returns **400** rather
than let an empty subset fall through — empty `selected_ids` + null filters would
gather the ENTIRE table.

## The Bison lead mirror (`bison_leads`) — migrations 089/090/094/095

`scripts/sync-bison-leads.mjs` mirrors every Bison install's `/api/leads` into
`bison_leads` (~12.2M rows across four installs), then promotes into `leads` any
mirrored address we do not already hold. It is deliberately a **mirror, not a
merge** — merging would rewrite 8.7M rows on a disk-I/O-bound instance.

It answers three questions the app could not answer before: which Bison leads we
are missing, which campaigns a lead is *already* in (net-new forecast), and what
enrichment Bison holds that we do not (`cv_*`).

### ⚠ What the Bison API forces on you (measured 2026-08-26)

- **A page is 15 rows and cannot be changed.** `per_page`, `limit`, `page_size`,
  `perPage`, `size`, `count` are all accepted and all **ignored**. Page *count*
  drives cost.
- **Page-NUMBER pagination dies past ~1000 pages** with a 422 telling you to use
  cursors — it cannot enumerate a 7.9M-lead install at all.
- **Cursor pagination needs `pagination_type=cursor`, and Bison drops that
  parameter from its own `links.next`.** Follow the link as given and you get
  nothing usable. Every hop must re-apply it. The campaigns endpoint drops
  `search` the same way — **assume any parameter is dropped** and rebuild the URL
  from scratch, keeping only the `cursor` value out of Bison's link.
- **The cursor is base64 `{"id":N,"_pointsToNextItems":true}` walking DOWNWARD by
  id.** That is what makes it shardable: craft a cursor at any id and a walk
  starts there. 8 shards sustained **569 leads/sec**.
- Installs can switch page-mode ↔ keyset mid-day (`meta.last_page` disappears) —
  follow `links.next` in both modes.
- `GET /api/leads/{email}` is **~0.25s and case-insensitive**; `?search=` on
  leads is 34s+/timeout. Never use `?search=` on the leads endpoint.

### ⚠ Sustained throughput earns a blanket 429

Running ~150 rows/s for hours got **every shard** 429'd at once (the sync died at
188,761 of 8.05M). Three quick retries are not enough — a 429 is an instruction
to *wait*: `getPage` now sleeps **45s per 429, up to 12 times**, and `--pace <ms>`
adds a per-shard gap between pages. At `--pace 800` the same install ran for days
at ~85 rows/s with **zero** 429s. Slower and finishing beats faster and blocked.

### Sharding, resume, and the watermark

`bison_sync_state (instance_url, shard, from_id, to_id, cursor_id, rows_seen,
done, …)` holds one row per (instance, shard), updated after every page;
`--resume` restarts each shard from its stored `cursor_id` and skips shards
already `done`. A shard that throws logs and returns 0 rather than killing the
run — ⚠ **so a summary line can report a large row count while shards silently
failed.** Check for `shard N failed` before trusting a total.

`--incremental` (what the 3-day cron runs) uses shard **`-1`** as a pseudo-row
watermark — negative so it can never collide with real shards. The floor is
`greatest(max(bison_id), watermark)`; because ids only increase, everything above
it is exactly the new leads. **An install nobody has mirrored gets its watermark
seeded to today's top id and fetches nothing** — it collects only genuinely new
leads from the next run on, rather than refusing until someone runs a full sync.
The delta is itself sharded (~1 shard per 20k ids): as a single walk, 382,790 rows
took 2.8 hours.

⚠ `npm run sync-bison-leads` with no flags is a **full** 8-shard sync of all four
installs. The routine job must pass `--incremental` (the Railway service does).

### ⚠ An ORDER BY that half-matches its index is a time bomb

`importNew`'s claim ordered by `instance_url ASC, bison_id DESC` while
`idx_bison_leads_pending_import` is **ascending on both columns**. No btree scan
can serve a mixed direction, so Postgres sorted *every* pending row to return
5,000. At 188k pending that was unnoticeable; at 7.86M it stopped completing at
all (>170s) and killed the run **after** the mirror had finished — the expensive
work was already done and banked, and the cheap step threw it away.

Backward scan (`instance_url DESC, bison_id DESC`) is the same
newest-first-within-instance order and plans as a plain index scan: **46 ms**.

Two lessons worth generalising:

- **A composite index only serves an ORDER BY that is all-same-direction or
  all-reversed.** Mixed directions need a matching mixed index (`(a, b DESC)`).
  `EXPLAIN` any claim query that will run against a growing table — a `Sort` node
  above millions of rows is the tell.
- **A batched claim can be the slow part, not the batch.** The work per batch was
  fine; selecting *which* rows to work on was not.

### Custom variables (`cv_*`) — where the enrichment came from

Bison's `custom_variables` are `[{name, value}]` with **lowercase, mixed-separator**
keys: `city`, `state`, `category`, `"sub-category"` (hyphen), `"additional
category"` (space), `domain`, `address`, `company phone`, `google maps url`,
`question`. Migration 095 flattens them into 10 `cv_*` columns (raw jsonb averages
471 bytes/lead ≈ 1.8 GB).

This reversed 089's decision to skip them, which was wrong: 368,907 Bison-imported
leads had arrived with **no location and no category** — invisible to client
targeting — while Bison held city/state for ~100% of them. Applying the mirror's
`cv_*` back onto blank `leads` rows (set-based, per instance, in id ranges)
filled **916,344 leads**. Category coverage went 27% → 85%.

⚠ Clay's CSV headers for the same concepts are title-cased and *different*:
`Industry` → category, `Company Short Description` → subcategory, `Company SEO
Description` → additional category. Clay's unrelated **"Call Category"** column
must not be confused with them.

## Never-contact suppression (migrations 091/092)

Keyed on the **email address**, not the lead row — that is the whole point: a
suppressed address stays suppressed after the lead is deleted, so the Bison sync
cannot resurrect it on the next run. Verified end-to-end (delete → sync → still
absent).

- `suppressed_emails` (PK `email`) + `leads.is_suppressed` + partial index.
- `trg_leads_apply_suppression` fires BEFORE INSERT OR UPDATE OF email, so
  *anything* that writes a lead is covered — import, sync, manual edit.
- `fn_suppress_email(...)` / `fn_unsuppress_email(...)`, both SECURITY DEFINER,
  `EXECUTE` granted to `service_role` only.
- Enforced in **both** gates, asymmetrically by design: browse/export has an
  `includeSuppressed: true` escape hatch; **client eligibility has none.**
- UI: "Never contact" (Ban icon) beside Delete in the leads toolbar and in the
  lead detail panel; `POST /api/leads/suppress` takes `{emails|ids, reason?,
  delete?}`, `DELETE` unsuppresses.

## Precomputed client location coverage (migration 096)

"Which locations does this client have fewer than 500 leads in?" was a 7–10s
grouped scan of `leads` run **on client select**, and it silently exceeded the
180s statement timeout for the widest clients — swallowed by a `.catch(() => {})`,
so the operator just saw nothing.

Now `client_location_coverage` stores the exact `{locations, low}` payload the
route used to compute, refreshed by `scripts/refresh-location-coverage.mjs` on
the `client-sync` cron (that is the third step appended to its start command).
`/api/clients/location-coverage` reads the stored row; `?fresh=1` computes live
and stores the result back. Live compute uses a `country_code`/`state_code`
pre-filter before the regex conditions (7.6s instead of >180s) inside a
transaction with `set local statement_timeout`. Failures now surface as a red
retry pill instead of nothing.

## Campaign pickers show status, date and size (2026-10-06)

Both pickers (export popup, Send-to-Bison wizard) render each campaign's Bison
`status`, `created_at` and `total_leads` beside its name, sort **newest
first**, and hide **archived** campaigns by default (popup: toggle; wizard:
excluded, and never suggested). Helpers in
[campaign-meta.ts](src/lib/bison/campaign-meta.ts), covered by
`scripts/test-campaign-meta.mts`. Reason: a client whose B2C install was set
up in June carries a second campaign set with the **same names** as its March
B2B set (JPCA: `818` active, 60,916 leads vs `146` draft, 2,918 leads), and
name-only rows made them indistinguishable. Both routes already passed the
whole Bison row through; nothing displayed it.

**The export popup pre-selects the client's campaigns (2026-11-18, client
request).** With a client selected, the popup ticks ALL of its campaigns or
NONE, and says why it ticked none
([campaign-autopick.ts](src/lib/bison/campaign-autopick.ts), covered by
`scripts/test-campaign-autopick.mts`): name `TAG: …` exactly, not Nurture or
archived, on the client's saved installs (else one Bison group), at most one
campaign per install and ESP bucket (two would each get the same leads, and
Bison refuses the second). Checked on the 396 pushes of the 60 days before: it
ticks exactly the operator's choice for 388; the 8 others fall back to manual.
The client scope of the list matches `TAG:` exactly too: the old bare prefix
listed other clients' campaigns (JPC showed JPCA's, JPC&A's and five more; SI
showed SINY's), and "All" would have ticked them. No push ever did.

"Sync campaigns" now reports what it did: `/api/bison/campaigns` returns a
`sync` block (`fetchedAt`, `total`, `perInstance`) and the popup shows it plus
"N new since last sync" after a manual sync. The wizard's step 3 has its own
Sync that re-runs `send-preview` and keeps choices that still exist.

⚠ **A two-install batch is settled at queue time** (`push-batch`): the worker
would refuse every unsided lead later (push-side.mjs) — on 2026-10-05 four
exports (CVJCIN, SCAS, RICS, TTT — 148,550 leads) were queued for clients whose
B2B/B2C mapping had not been synced yet, gathered in full, then skipped
entirely. Campaigns on the client's saved installs take that side; since
2026-11-18 the rest take **their install's fixed side** (OutboundHero and
FacilityReach = B2B, CleaningOutbound and OutboundClean = B2C;
[scripts/lib/bison-groups.mjs](scripts/lib/bison-groups.mjs)) when every install
in the batch belongs to ONE group, and that group is saved on the client
(`source = 'push'`, audit "Client Group Set From Push") after the batch is
queued. Installs spanning both groups are still refused (400), and so is a
two-install batch with no client tag. Before this, a client in no group sheet
could not push at all: the Nov-15 clients (ATOH, JMBCS, CCGSOR, SG, LBJ, JATL)
all got "has no B2B/B2C mapping". Tested by `scripts/test-bison-groups.mts`
(includes the worker's own routing on install-sided campaigns).

⚠ **`sent` overstates what Bison holds.** Bison does not add a lead to a
campaign while the lead is "In Sequence" in another campaign on that install
(its `allow_parallel_sending` flag, which the worker never sends), yet it
returns 2xx for the chunk; the worker then marks the whole chunk attached.
Measured 2026-10-05 on JPCO's draft B2C mains: 13,666 recorded, 10,423 in
Bison — every missing lead already sat in JPCO's own Nurture or another
client's campaign. Leads the push CREATES on the install land 100%. A later
push for the same client skips any lead with a `sent` item, so these are never
retried. Not yet fixed; decision pending on whether a lead already in a
client's Nurture should be forced into main.

## Net-new forecast on export

After choosing campaigns, the export popup shows how many of the selected leads
are **not already in those campaigns** — `POST /api/bison/push-forecast` uses
`bison_leads.campaign_ids && ARRAY[...]` (GIN, migration 094). It reports per
instance and is honest about its own blind spot: coverage is `known` / `unknown`
/ `complete`, because a campaign we have not mirrored cannot be checked. For SBTB
it found 53,764 leads already in the chosen campaigns.

`/api/bison/push-stats` also carries a **lifetime** block (`everPushed`,
`everBatches`, `lastPushCompletedAt`) per client tag — the "did CCHS ever receive
anything?" question.

## Phase 1-3 (Spencer Loom, 2026-07-22)

Filters (migration 053; all in the shared fn_lead_filter_conditions helper —
fn_filter_leads_v2 now delegates to it): additionalCategory (include/exclude),
location.city is now IncludeExclude, keyword.matchMode 'contains'|'exact'
(exact = fn_exact_term_regex whole-phrase word-boundaried, plural-tolerant),
emailContains (include/exclude on email — weebly/.gov purges), tags
(substring on leads.tags), globalSearch (comma-separated OR across
email/company/name/domain/categories), and a special p_filters.emailSide
'b2b'|'b2c' splitting by the freemail_domains table. Hideable filter chips
persist in localStorage (use-hidden-filters.ts). Re-validation TTL is now 90d
(VALIDATION_REVALIDATE_DAYS).

Table: drag-select + shift-select + select-all-filtered; delete-from-database
(owner/admin) via the extended /api/admin/bulk-delete (accepts {ids} or
{filters}, exact server count, audit-logged).

Client routing: client_tags table synced from the client-groups sheet
(CLIENTS_SHEET_ID, npm run sync-clients) — tag -> instance pair (group1:
outboundhero/cleaningoutbound, group2: facilityreach/outboundclean).
Send-to-Bison wizard (send-to-bison-wizard.tsx): pick client tag ->
/api/bison/send-preview returns EXACT b2b/b2c split counts + candidate
campaigns per side (suggested = newest TAG-prefixed non-Nurture) -> reconfirm
-> two /api/bison/push-batch calls (one per side, emailSide + clientTag stored
on push_batches). push-worker attaches the client tag to leads in Bison
(leadPayload tags[], merging existing leads.tags) — UNVERIFIED against live
Bison tag field; confirm on the first real send. Saved searches carry an
optional client_tag (filter_presets.client_tag; PUT to update in place).

Clay category import: scripts/import-clay-categories.mjs (npm run
import-clay-categories <folder>) — one CSV per client, filename=tag, matches by
lead id then email, sets category/subcategory/additional_category with
category_source='clay' (never over 'manual', diff-aware), appends the client
tag to leads.tags. Category enrichment precedence stays Bison/Clay > keyword >
AI (AI fallback still OFF pending green-light).

## Railway services (production topology, verified 2026-09-09)

Railway project `extraordinary-spirit` (`aa4d6c76-7b8b-4f29-9212-3c04c42de333`),
environment `production` (`80ed7802-75ee-453c-a8d6-b92e233de258`). All **9**
services deploy from THIS repo. Single replica everywhere.

| Service | Type | Schedule | Start command |
|---|---|---|---|
| `lead-database` | web | always on | (default Next.js) |
| `push-worker` | worker | always on | `node scripts/push-worker.mjs` |
| `targeting-worker` | worker | always on | `npm run targeting-worker` |
| `bounce-worker` | cron | `0 */6 * * *` | `node scripts/bounce-worker.mjs` |
| `client-sync` | cron | `0 */6 * * *` | `npm run sync-clients && npm run sync-targeting && npm run coverage-refresh` |
| `categorize-worker` | cron | `0 3 * * *` | `node scripts/categorize-worker.mjs --keyword-only` |
| `location-worker` | cron | `*/30 * * * *` | `npm run location-backfill` |
| `bison-sync` | cron | `*/30 * * * *` | `npm run bison-sync-cron` (2026-11-20; was `0 3 */3 * *` + `npm run sync-bison-leads -- --incremental`) |
| `validation-worker` | cron | `17 * * * *` | `npm run validation-worker` (added 2026-09-14) |

**`bison-sync` checks every 30 minutes and usually does nothing** (2026-11-20,
migration 131). [scripts/bison-sync-cron.mjs](scripts/bison-sync-cron.mjs) runs
the same incremental sync as before (`sync-bison-leads.mjs --incremental`, as a
child process) when either the top bar's **Sync now** button left a request in
`bison_sync_runs`, or no run has started since the regular slot (03:00 UTC on
days 1, 4, 7 … 31 — the old cron's calendar). Each run is logged there (start,
heartbeat every minute, finish, rows fetched, new leads, failed shards); a run
with no heartbeat for 10 minutes is marked failed at the next check; a partial
unique index allows one `running` row, so two syncs never overlap. The top bar
(`BisonSyncStatus`, `GET/POST /api/bison/sync`) shows the last run in Pacific
time. A failed run is not retried automatically — the panel shows it, and Sync
now re-runs it. `--dry-run` prints the decision only.

**Incremental slices are never skipped** (fixed 2026-11-20,
[scripts/lib/bison-incremental.mjs](scripts/lib/bison-incremental.mjs)). Until
then a slice that failed was only logged, the watermark jumped to the top id
anyway, and the floor was the GREATER of the watermark and the highest mirrored
id — so that slice was never fetched by any later incremental run. Now: the
floor is the watermark (max mirrored id only for an install with none); a
failing slice is retried twice from where it stopped; the watermark climbs only
over the slices that completed, counted from the bottom, so a slice that still
fails (or stops at `--max`) is fetched by the next run; incremental slices keep
their own progress rows (shard 100+) instead of overwriting the full sync's
0..7; and a `--resume` full sync only trusts a saved row of the same slice
(incremental runs had left "done" rows on shards 0..2, which a resume would
have skipped). A gap scan on 2026-11-20 found no slice already lost: every
10,000-id block of each install's latest million ids held 10,000 leads.
`--shard-size <ids>` (default 20000) sets the slice size. Tested by
`scripts/test-bison-incremental.mts`.

Also scheduled, but NOT a Railway cron:
`.github/workflows/daily-dashboard-refresh.yml` POSTs `/api/dashboard/refresh`
at `0 2 * * *` UTC. It contradicts the standing "crons live in Railway" rule and
is believed to be a silent no-op (see Known issues) — resolve, don't copy it.

### ⚠ A push to `main` does NOT auto-deploy — a workflow does it

Per-service auto-deploy is **off** for this project, and the project token lacks
the account-level permission to turn it on (`serviceInstanceUpdate` →
"Bad Access"). Worker services therefore ran **stale code for days** without any
visible failure. Measured on 2026-09-07: `bison-sync` imported 116,578 leads with
no enrichment from a 5-day-old commit, `location-worker` left 79,943 states
unresolved, and `client-sync` never ran the coverage refresh that had been added
to its start command.

`.github/workflows/railway-deploy.yml` closes this: on push to `main` it
enumerates every service and calls
`serviceInstanceDeploy(environmentId, serviceId, latestCommit: true)` for each,
failing the job if any service fails. It needs repo secret
`RAILWAY_PROJECT_TOKEN`. Full run takes ~20s.

⚠ Use `serviceInstanceDeploy(latestCommit: true)`, **never**
`serviceInstanceRedeploy` — the latter replays the OLD build and looks like a
successful deploy while changing nothing.

### ⚠ The location pass is SPLIT — never put both halves on a frequent cron

`npm run location-worker` still runs both halves and is kept for manual use,
but the cron runs **`npm run location-backfill` only** (geo-reference resolution
of leads that already carry city/state text — cheap, bounded, ~56k rows pending
at the 2026-08-25 measurement, near-zero once caught up).

`npm run location-inference` (`infer-company-locations.mjs`) is the other half
and is **deliberately unscheduled**. It targets the ~2.58M leads with no
location text at all, using the OFFSET-over-GROUP-BY pagination that
re-aggregates the whole table per page with `statement_timeout = 0` — the
pattern that exhausted the disk-I/O budget on 2026-08-07. Give it a schedule
only after that pagination is fixed (open TODO below), and never `*/30`.

### ⚠ Every worker service MUST override the build command

Workers run a single `node` script and never need the Next.js build — but
Railpack auto-detects Next.js and runs `npm run build` unless told otherwise.
That build **fails on any service without the Supabase env vars**, because four
API routes construct their Supabase client at module scope and Next evaluates
every route module during "Collecting page data":

```
Error: supabaseUrl is required.  →  Failed to collect page data for /api/leads/filter
```

Every worker therefore sets Build Command to `echo 'worker service: no next build'`.
`client-sync` was missing it and its build failed for 12 days (2026-08-05 →
2026-08-17), silently freezing the client roster and targeting rules.

The durable fix is to make those four routes lazy like the other 32
(`createAdminClient()` inside the handler, not at module scope):
`api/leads/filter`, `api/exports/stream`, `api/exports/process`,
`api/admin/unknown-stats`. **Not yet done.**

### Pausing a worker without Railway access

`categorize-worker` checks a lease row in `worker_locks` before doing ANY work
([categorize-worker.mjs:387](scripts/categorize-worker.mjs#L387)), so it can be
parked from SQL alone:

```sql
-- park it (exits immediately every run, zero DB work)
INSERT INTO worker_locks (key, owner, locked_until)
VALUES ('categorize-worker', gen_random_uuid(), now() + interval '30 days')
ON CONFLICT (key) DO UPDATE
  SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until;

-- release it
DELETE FROM worker_locks WHERE key = 'categorize-worker';
```

**A lease is currently held (set 2026-08-17, renewed since).** The blocker it was
set for — the unbounded `fn_sync_companies` call — is **fixed**; the worker now
loops until a round returns fewer rows than the limit. The lease is now held for
a different reason: releasing it turns on categorization, and the AI tier is
still awaiting the client's cost green-light. Release it (and drop
`--keyword-only`) only once that decision is made. No other worker uses this table.

⚠ Since migration 097, `worker_locks` has RLS enabled — the lease is reachable
from the `DATABASE_URL` connection (table owner) and the service-role key, but
**not** from a browser session any more.

---

## Migration discipline (learned the hard way)

1. **Never re-run all migrations wholesale against production.** The
   `for f in *.sql; do psql -f $f; done` loop in SETUP.md is what recreated the
   `fn_sync_companies` 0-arg overload and broke uploads + the categorize worker.
   Migrations 073/074 make that sequence self-healing, but the habit is unsafe.
2. **The live database has drifted from this repo.** Confirmed case:
   `fn_sync_companies` had `statement_timeout` raised `600s → 3600s` directly in
   the database, invisible in any migration file. **Always build a function
   migration from `pg_get_functiondef()` of the LIVE definition**, never from the
   repo's previous migration, or you will silently revert production changes.
3. **`CREATE OR REPLACE FUNCTION` does not replace a different signature** — it
   adds an overload. Changing or adding a parameter requires an explicit
   `DROP FUNCTION name(oldsig);`. Audit with:
   ```sql
   SELECT p.proname, count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
    GROUP BY 1 HAVING count(*) > 1;
   ```
4. After DDL, `NOTIFY pgrst, 'reload schema';` so PostgREST picks it up.

---

## Migrations 054–074 (previously undocumented)

| # | What it adds |
|---|---|
| 054 | `client_tags` full roster from the Client Tracker sheet; nullable instances for churned clients |
| 055 | `categorySearch` filter (OR across category/subcategory/additional) |
| 056 | `client_stats` cache + `fn_refresh_client_stats()` |
| 057 | Company include/exclude filter |
| 058 | Category exact-match, Custom Tags, Website filters |
| 059 | Subcategory index fix |
| 060 | City filter dropdown cache |
| 061 | Per-option lead counts in filter dropdowns |
| 062 | Per-side match modes (`includeMode`/`excludeMode`); `commercial_cleaning_excluded_titles` (230 terms) |
| 063 | `gateway` bounce type |
| 064 | Geo reference: `supported_countries`, `geo_admin1`, `geo_locations`, `location_aliases`, `company_locations`, `client_targeting` |
| 065 | State dual-match (code or full name) |
| 066 | `fn_location_entry_condition`, `fn_commercial_cleaning_condition`, `fn_client_eligibility_conditions` |
| 067 | Onboarding-sheet targeting sync provenance (`sheet_raw`, `include_industries`, `include_keywords`) |
| 068 | `push_batches.push_options` — per-client-tag export accounting |
| 069 | `campaign_presets`, `custom_lists` |
| 070 | `group` bounce type |
| 071 | `shared_searches` — shareable `/leads?s=<id>` links |
| 072 | `client_tags.client_type`; `policy` bounce type |
| **073** | **Drops the duplicate 0-arg `fn_sync_companies()`** |
| **074** | **`fn_sync_companies` default `NULL → 50000`** (bounded propagation) |
| **075** | **Empties `client_targeting.include_industries` / `include_keywords`** |
| **076** | Drops un-split comma lists from `exclude_industries` (the `TagInput` paste bug) |

## Migrations 077–097

| # | What it adds |
|---|---|
| 077 | `fn_lead_filter_conditions`: `categorySearch` widens 3 → 7 columns (adds `company`, `general_industry`, `specific_industry`, `company_overview`), include and exclude symmetrically |
| 078 | `client_targeting.exclude_terms` + `include_terms` `text[]`; backfilled as the lower-cased de-duped union of the four old lists |
| 079 | `fn_client_eligibility_conditions` switches to `exclude_terms`: one alternation regex per column across 6 columns |
| 080 | `targeting_sync_jobs` table + `fn_touch_targeting_sync_job()` trigger — queue for on-demand rules syncs (same durability model as `push_batches`) |
| 081 | `targeting_sync_jobs.snapshot` + `reverted_at` — undo for rules syncs |
| **082** | **DROP INDEX CONCURRENTLY on 9 provably-unusable `leads` indexes (reclaims 1,448 MB)** + `ANALYZE leads` |
| **083** | **DROP 3 strict-prefix-redundant `leads` indexes** (~380 MB) |
| **084** | **per-table autovacuum**: `leads` vacuum scale 0.2→0.05, analyze 0.1→0.02 |
| **085** | `fn_lead_filter_conditions` collapses per-term `categorySearch` into one alternation regex per column; the bounded count gets its own subtransaction |
| **086** | new `fn_filter_leads_count(jsonb)`; `skipCount` flag so rows + total run concurrently |
| **087** | data-only: `client_targeting.require_location = true` for every row |
| **088** | `columnFilters` keep-list; sort whitelist 7 → 27 columns; new `fn_lead_column_values(...)` |
| **089** | **new `bison_leads` mirror** (PK `instance_url`,`bison_id`) + `bison_sync_state` |
| **090** | `bison_leads` identity columns + `imported_at`; partial index `idx_bison_leads_pending_import` |
| **091** | **`suppressed_emails` + `leads.is_suppressed`** + trigger + `fn_suppress_email()` / `fn_unsuppress_email()` |
| **092** | Suppression enforced in `fn_lead_filter_conditions` (escapable) and `fn_client_eligibility_conditions` (not) |
| **093** | **Client exclusion terms match by CONTAINS** — `fn_regex_escape` replaces `fn_whole_term_regex` |
| **094** | `bison_leads.campaign_ids` bigint[] + GIN, trigger-maintained |
| **095** | **`bison_leads` gains 10 flattened `cv_*` columns** + `cv_fetched_at` (reverses 089's "skip custom_variables" call) |
| **096** | `client_location_coverage` — precomputed coverage payload per client |
| **097** | **RLS enabled on the last 8 tables**; authenticated-read on `api_logs` / `audit_logs` |

Detail worth carrying forward from these:

- **085/086 — the count path is the slow path.** 91 exclude terms × 7 columns =
  637 regex evaluations per row; collapsing 97 conditions into 7 took an exact
  count from **466s → 4.7s**. And the `SET LOCAL statement_timeout` bound did NOT
  hold. ⚠ It still does not, and never can (measured 2026-10-19): a `SET LOCAL
  statement_timeout` inside a function does not re-arm the timer of the
  statement already running, and `EXCEPTION WHEN OTHERS` cannot catch
  `query_canceled`. So the "degrade to the planner estimate" branches in
  `fn_filter_leads_v2` / `fn_filter_leads_count` are dead code; the function's
  own `SET statement_timeout TO '120s'` (which PostgREST applies before the
  call) is the only limit, and hitting it is an error (57014). `skipCount` rides
  **inside `p_filters`**, not as a new parameter — a new parameter would create a
  second overload instead of replacing the function (the documented trap).
- **087 — `require_location` is a 44× lever.** The `OR l.country_code IS NULL`
  escapes admitted 2.8M unlocated leads; BBS availability went 58,918ms → 1,335ms
  and its advertised count 2,611,332 → 154,406. Reversible with
  `UPDATE client_targeting SET require_location = false`.
- **091 — `is_suppressed` is `NOT NULL DEFAULT false`**, which is metadata-only in
  modern Postgres, so adding it did **not** rewrite the 8.4 GB table. Both
  suppression functions are `SECURITY DEFINER` with `EXECUTE` granted to
  `service_role` only.
- **093 — contains matching has a known, accepted cost.** `"bar"` now matches
  "Barbershop" (~34,000 leads that whole-word kept). That is the client's call, so
  that they get `"cleaning"` catching "drycleaning"/"CleaningCo" for competitor
  exclusion. `fn_commercial_cleaning_condition` deliberately stays **whole-word**
  for its 230 job titles.

---

## Permissions — enforce SERVER-side, always

`useHasPermission` / `AccessDenied` only hide UI. The API route is the boundary.

Two routes shipped with **no authentication at all** while using the service-role
client, and took `performedBy` from the request body (fixed 2026-08-18):
`api/admin/update-role` (any logged-in account — a viewer included — could
promote itself to owner) and `api/admin/reset-password`. Both now follow the
`api/admin/invite` pattern: `auth.getUser()` → look up the caller's role →
gate. **Never trust an actor id from the request body**; derive it from the session.

Extra rules now enforced in `update-role`: only an `owner` may grant `owner` or
change an existing owner's role, and the last remaining owner cannot be demoted.
`delete-user` also refuses self-deletion.

**Exports are `owner`/`admin`/`manager`.** `exports/stream`, `exports/process`
and `exports/log` each check the role — previously any authenticated session
could stream all 8.19M leads, contradicting the `viewer` row in the table above.
`export-button.tsx` hides the control for viewers so the UI matches the server.

When adding a route, copy an existing gated one; the audit above found 16 routes
with role checks and 4 relying on middleware position alone.

### RLS is on for every table (migration 097, 2026-09-09)

All **37** public tables now have `ROW LEVEL SECURITY` enabled. Eight had it off:
`api_logs`, `audit_logs`, `dashboard_top_job_titles`, `filter_presets`,
`freemail_domains`, `lead_job_titles`, `validation_jobs`, `worker_locks` — so any
authenticated browser session could read **and write** them straight through
PostgREST, including parking/unparking the categorize worker and tampering with
the audit trail.

Nothing server-side changed: the service-role client bypasses RLS, and scripts
connect via `DATABASE_URL` as the table owner (RLS is **not** `FORCE`d). Only two
of the eight are read from the browser, so only they got a policy:

```sql
CREATE POLICY "Authenticated read api logs"   ON api_logs   FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read audit logs" ON audit_logs FOR SELECT TO authenticated USING (true);
```

The other six are default-deny outside the server. **When adding a table, enable
RLS in the same migration**; a table with no policy is server-only by default,
which is the safe direction. Verify with:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;
```

⚠ Enabling RLS is invisible to server code, so it will NOT show up in testing
through the app — probe with the anon key to confirm enforcement is real.

---

## Clients page: client status and the sync buttons

**Status lives in the sheet, not the app.** `client_tags.status` is whatever the
sheet says; anything containing "churn" renders as Churned (greyed row, excluded
from the Active filter). Precedence during a sync: **Onboarding Form Responses
col E** (authoritative) > Client Tracker col H (health) > the owner/status tab.

The Active/Churned badge on each row IS a button (`PATCH /api/clients`, writes
"Confirmed Churn" / "Healthy"), but ⚠ **a sheet-stamped status overwrites that
toggle within 6 hours.** The toggle only sticks for tags whose sheet status is
blank. To churn a client permanently, change the sheet.

Three buttons, each doing a *different* amount of work:

| Button | Route | Scope |
|---|---|---|
| **Sync with sheet** | `POST /api/clients/sync-sheet` | **Full** — the same merge as the cron: new clients, names, statuses, types, group mappings |
| Sync groups | `POST /api/clients/sync-groups` | Bison group/instance mappings only — never inserts a tag, never clears a mapping |
| Refresh stats | `POST /api/clients/refresh` | Recomputes lead counts from the DB; touches no sheet |

`sync-sheet` (owner/admin/manager) mirrors `sync-clients-from-sheet.mjs` exactly —
same COALESCE upsert (a roster-only tracker row can never NULL out an instance
mapping), same delete-absent-tags step, one transaction — so running it and the
cron concurrently converges to the same rows. It reports what changed
(`added`, `statusChanged`, `removed`) rather than just "done". It needs
`CLIENT_TRACKER_SHEET_ID` on the **web** service, which was missing until
2026-09-09 (the crons had it, the web service did not).

⚠ Statuses drift in bulk. A single manual sync on 2026-09-09 applied **73**
status flips that had accumulated in the sheet — that is normal, not a bug.

### "Sync groups" specifics

`POST /api/clients/sync-groups` (owner/admin/manager) re-reads the **Groups tab**
of the tracker workbook (gid `239723744`) and applies Bison group changes on
demand, instead of waiting for the 6-hourly `client-sync` cron.

**Since 2026-11-18 the cron and "Sync with sheet" read the Groups tab too**: it
decides the group of every roster tag it lists, and `CLIENTS_SHEET_ID` →
`Sheet1` (which had drifted) only fills tags the tab does not list. Until then
every cron run wrote Sheet1's group back over a Sync-groups move — CCGNWA and
CCHS were group 1 in the tab and in Bison but group 2 in Sheet1. If the tab
cannot be read, a sync writes **no** group at all (COALESCE keeps every saved
one) rather than falling back to Sheet1. All three read the tab through the same
parser (`parseGroupsTab` in scripts/lib/bison-groups.mjs); the cron's `--dry-run`
prints the group changes a real run would make.

Groups only: it updates `group_no` / `b2b_instance` / `b2c_instance`, never
inserts a tag (roster stays the cron's job), and never clears an existing
mapping (`COALESCE` semantics — a tag missing from the sheet keeps what it has).

⚠ **That tab is NOT two adjacent tag columns**:

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| Group 1 tags | Status | Churn Date | Plan | Group 2 tags | Status | Churn Date | Plan |

Reading `A:B` would treat "Active"/"Churned" as client tags and create clients
named `ACTIVE`/`CHURNED` **with real Bison routing**. The route finds the two tag
columns by header regex and rejects any Status/Plan value via `NOT_A_TAG`.
Shared Sheets auth now lives in [src/lib/google/sheets.ts](src/lib/google/sheets.ts)
(readonly scope only).

## Targeting include-lists are empty by design

`client_targeting.include_industries` / `include_keywords` are **always empty**
unless set by hand in the Rules dialog (client request 2026-08-18; migration 075
cleared 960 + 1,960 entries). `sync-client-targeting-from-sheet.mjs` no longer
writes them — Pass D was deleted; Pass B still *asks* the model for the include
side but uses it only to keep a category out of `exclude_industries`.

Neither ever gated pushes. The only behaviour change: selecting a client on the
Leads page no longer pre-fills the Category-search filter.

## Sheet non-answers never change a client's rules (2026-11-20)

A blank or non-answer cell in the onboarding sheet ("N/A", "none", "Already
Provided", "see above", dashes) never reaches the AI and never changes what is
stored: the client keeps its places, or its exclusions (`exclude_terms`
included, so a Rules-dialog edit survives), as they are. The list is
`isNonAnswer` in scripts/lib/targeting-answers.mjs; only the whole cell counts,
so "No restaurants" is still an answer.

Two replies are failed passes (stored values stay, `sheet_raw` does not
advance, the next run tries again): a places reply with no usable place, and a
reply that only repeats a prompt's worked example (the exclusion prompt's 21
terms or the location prompt's 16 West Texas towns, read from the prompts
themselves; `echoesExample`). Before this, "Already Provided" came back as the
21 example terms and blank places were stored as an empty list, which the send
gate reads as the whole country. It stops new damage only: clients already
damaged need a separate repair. Pure test, no AI and no database:
`node scripts/test-targeting-answers.mjs`.

## Client locations apply as city+state PAIRS (2026-08-19)

Selecting a client on the Leads page puts its `include_locations` into the
**`locationTargets`** filter (the "Targeting" chip) as pairs. That chip is what
CONSTRAINS the query. The State chip (distinct states covered) and the City chip
(bare city names) are additionally populated for **visibility only** — operators
want to see the coverage at a glance.

That is safe only because `locationTargets` already restricts to exact pairs, so
the flat chips are a superset that removes nothing except rows whose city/state
TEXT contradicts their resolved `location_id` (23 rows for BBS — e.g. text
"Austin" on a lead resolving to Las Vegas, NV). **Bare city names must never be
the only location filter** — that is precisely the bug below. The regression
test asserts `city.include` is non-empty only when `locationTargets.include` is
too.

⚠ **Targeting is re-checked, not applied once (2026-09-21).** The page used to
`return` early if a tag was already in `appliedRef`, so rules edited in the
Rules dialog — or re-synced from the sheet — never reached a page that already
had the client selected. That is a correctness bug, not just staleness: the
export then runs without the cities added since, i.e. outside the client's
territory. **What it cost:** JPCA's 105 cities were saved at 16:14; a client
export at 16:40 carried the 107 category exclusions but no locations, so it had
nothing to narrow on, scanned all 9M leads and died on the statement timeout
after ~2 min with 0 rows. The same export **with** targeting: **2.1 s, 42,480
rows**. The patch is now stored with the targeting row's `updated_at`; a
re-select or the tab regaining focus compares versions and, when they differ,
removes the old patch before applying the new one (applying over it merges the
two, so dropped cities would keep filtering). Unchanged rules cost one small
request and return before the coverage/availability scans. The focus re-check
fires only for a tag THIS page applied, because a preset/shared link clears
`appliedRef` on purpose.

**Loading a saved search or shared link is the other half of it.** Such a
search carries whatever targeting existed when it was saved — and one saved
from an already-stale page carries none, so the link reproduces the failure for
everyone who opens it. `needsClientTargeting()` (in `src/types/filters.ts`) is
the rule: a search that names a client and has NO `locationTargets` of its own
gets that client's targeting applied on load; one that carries targeting is
left alone, because that is a deliberately hand-narrowed subset of the cities.
Measured on shared search `babb4aff…` (clientTag JPCA, 107 exclusions, zero
locations): as the link loads today the count **times out at 301 s**; with the
rule applied it is **3.4 s**. Covered by the last seven structural cases in
`scripts/test-client-targeting.mts`.

Still open: the export path trusts the page's payload and does not enforce
client eligibility server-side (`applyClientTargeting`, which the push path
does pass). Until it does, a client-scoped export can still leave the territory
if the UI state is wrong — the fixes above close the two known routes to that,
not the class.

⚠ **An exclusion list cannot be indexed — only narrowed.** That export's
category exclusions compile to one 107-alternation case-insensitive regex
tested against **7 columns** (`category`, `subcategory`, `additional_category`,
`company`, `general_industry`, `specific_industry`, `company_overview`), which
measured **~41 s per 300k rows** — ~20 min over the whole table. No index can
answer "does NOT contain any of these", so nothing about the exclusion itself
is fixable that way: it is only ever cheap because a selective *positive*
predicate (the client's cities, indexed) hands it a small set first. Measured
alternatives, identical row sets on a 300k slice: `lower(col) !~ rx` **43.4 s**
(no gain — the cost is the alternation, not case folding), `lower(col) NOT LIKE
ALL (array)` **25.1 s** (1.7×). Condition order makes no difference (41.9 s vs
41.4 s) — Postgres reorders quals itself. `subcategory` alone is half the cost
because uploads map *Company Description* into it (avg 242 chars, max 3,614).

The City chip stays fully usable by hand, which matters for "target the whole
state but drop a few cities": a state-level entry plus a city exclusion works
through either chip — measured on Utah, 125,645 leads → 118,639 after excluding
Provo, identical via `locationTargets.exclude` (geoname id) or the City chip's
exclude (text). No client currently has city-level excludes, so client
auto-apply only ever populates the City chip's INCLUDE side; a bare excluded
city name would drop that city in every covered state.

⚠ **They used to be flattened into the flat City/State chips** (client decision
2026-08-06). Those two chips AND *independently* and cannot express a pair, and
`entryStates` only kept entries with **no** city — so for a list of city+state
pairs the state was **discarded entirely**, leaving the City chip holding bare
city names that match in ANY state. Measured damage before the fix:

| Client | Shown | Correct | Wrong-state leads |
|---|---|---|---|
| BBS | 233,549 | 155,891 | **77,658** (33%) |
| JPCO | 248,732 | 180,149 | 68,583 |
| ABM | 133,571 | 77,471 | 56,100 |

BBS targets `Washington, UT` → it was showing Washington **DC** (29,647),
Rockville **MD**, Syracuse **NY**. The client reported exactly this.

Only the on-screen view was ever wrong. **The send path was always correct** —
`fn_client_eligibility_conditions` resolves entries through
`fn_location_entry_condition`, which turns a city+state entry into geoname ids
and matches `l.location_id`. Nothing incorrect was ever pushed to Bison.

Two consequences worth knowing:

- Matching is by **geoname id**, so the free-text `l.city` column is NOT the
  authority and can disagree with it (BBS has 6 rows whose city text says
  "Austin" but which resolve to Las Vegas, NV). Assert against the resolved
  place, not `l.city`. Only 62.5% of leads have a resolved `location_id`, but
  collateral loss is negligible — at most **4 leads** for any single client.
- It also fixed the header count. Bare-city ILIKE conditions estimated
  4,289,572 rows against a real 233,455, and `fn_filter_leads_v2` only computes
  an exact `COUNT(*)` when the estimate is ≤ 500,000 — so the UI displayed the
  garbage estimate ("~3,780,912", the `~` marks `is_approximate`).
  `location_id = ANY(...)` estimates at 3,551, so the exact count now runs.
  **The underlying threshold issue remains** for genuinely large result sets.

Regression test: `DATABASE_URL=... npx tsx scripts/test-client-targeting.mts`
drives the real reducer + `buildRpcFilters` + `fn_lead_filter_conditions`
against every client with location targeting.

## One lead, many locations (migrations 103/104, 2026-09-18)

A person who covers several offices must be findable under EACH place
(client decision 2026-09-17). Email stays the identity — a second `leads` row
for the same email is impossible (`leads_email_key`) and every `ON CONFLICT
(email)` depends on it — so extra places are rows in **`lead_locations`**
(`city_text`/`state_text` exactly as imported, plus the resolver's
`city/state/state_code/country_code/location_id/location_status`, `source`,
`upload_batch_id`; `UNIQUE (lead_id, location_key)` where the key is
`lower(city_text) | coalesce(state_code, upper(state_text))` — 107 — so
"Lincoln, CA" and "Lincoln, California" are one row; a code-less spelling
("Calif.") is a separate key until the resolver fills `state_code`, and the
resolver must then dedupe against a sibling with the same resulting key). A
side row must carry a city or a state (`lead_locations_has_place`). The PRIMARY
location stays in the existing `leads` columns and is never overwritten by an
import; the merge fills a blank primary only when city and state agree (see
the import engine section).

**How predicates see them — read before touching any location SQL.** A
subquery against the side table inside an OR with the primary predicate was
measured to make the planner abandon the location index and walk 4.2M rows
(24 s for one client). So `trg_lead_locations_sync` keeps denormalised arrays
on `leads` — `alt_location_ids bigint[]`, `alt_state_keys text[]` ('US|TX'),
`alt_cities text[]` (lower-cased), `alt_states text[]` (lower-cased names and
codes), `alt_location_text` — each with a partial GIN index (`WHERE … IS NOT
NULL`, 104). Predicates add one `&&`/`@>`/trigram probe per branch; the arrays
are NULL on the ~9M single-location leads, so the indexes stay tiny. The
side-table write is one non-HOT `UPDATE leads` per location row — bulk loaders
sort by `lead_id`. The trigger locks the `leads` row (`FOR NO KEY UPDATE`)
BEFORE aggregating, otherwise two concurrent writers for the same lead could
each aggregate their own snapshot and the second would drop the first's row
(107). The resolver's cohort index is `idx_lead_locations_pending … WHERE
location_id IS NULL` (a state-only row keeps `state_code` forever, so that
column was the wrong predicate).

Rules (client defaults): exclusions apply if ANY location matches; the primary
is the best-resolved location; a push sends the location that matched the
client's targeting (fallback: primary). **Status of the wiring:** the table,
arrays, trigger and indexes exist and the import writes rows; the filter and
eligibility functions do NOT read the arrays yet (stage 2 — until then an
extra location is stored but not searchable). `lead_locations` has no
`'unresolved'` status by design ("never unknown").

## CSV import engine (2026-09-18) — `src/lib/uploads/import-rows.ts`

The Uploads page used to drive a per-row PostgREST loop (2–3 sequential
US→Sydney round trips per row) that could not finish an 88k-row file inside any
request budget — and `upload_batches` was **empty in production**: the UI
importer had never been used. Every lead arrived via scripts and the Bison
mirror. The engine is now set-based, in chunks of 2,000 rows, one transaction
per chunk (`SET LOCAL` only), sorted by email / lead_id for lock order:

| Row | Becomes |
|---|---|
| no usable email (empty, `N/A`, `--`, no `@…`) | `upload_holdbacks` row, cells verbatim (`raw jsonb`), dense `seq` → `/api/uploads/holdbacks?batch=&part=` streams parts of **49,999** rows (`HOLDBACK_PART_SIZE`, client: "under 50k for Clay"), non-overlapping by construction; one link per part on the Uploads page; managers only for their own batches. Since 130 the worker also copies them into the People table of the upload's client (see "Upload no-email rows (migration 130)"); the download keeps every row |
| new email | `INSERT … jsonb_populate_recordset(null::leads, …) ON CONFLICT (email) DO NOTHING` |
| existing email | `skip` (nothing written, no extra location) / `merge` (fill blanks — **placeholder junk counts as blank**, see below) / `replace` (chosen fields). Only rows where a chosen column actually changes are rewritten (`WHERE … IS DISTINCT FROM`, `RETURNING` drives `lead_history` and the counters) — a re-upload of the same file merges 0 |
| existing email, different city/state | + `lead_locations` row; primary untouched |
| same email twice in one file | second occurrence at another place → `lead_locations`; counted in `in_file_duplicates` |

**City and state are ONE fact** (`decidePlace`/`samePlace`, review finding
2026-09-18 — the first version filled them independently and gave Denver the
state of Lincoln, CA). Merge fills `city` only when the stored state is blank,
junk, or the row's state; fills `state` only when the stored city is blank or
is the row's city; a stored state with no code (`local`, `New`, `North
America`…) counts as blank when the row brings a coded state. Whether the row's
place becomes an extra location is judged against the primary AFTER that
write, so a place that just became the primary is never stored twice.
Cities decide when both sides have one (a code conflict — Portland OR vs ME —
still splits); otherwise states; with nothing comparable the row's place is
kept as an extra rather than dropped. 32 unit cases:
`npx tsx scripts/test-merge-location.mts`.

Also at import: `category_source = 'upload'` when a category is present (105
extends the leads CHECK, **107 the companies one** — `fn_sync_companies` copies
it and would have aborted); **ESP via MX lookup** (`esp-lookup.ts`, 40-way
concurrent, 2.5 s timeout, process-wide cache, same seven labels Bison writes)
— before this every ESP value in the database came from Bison's tags and an
upload left it NULL, which routes Mimecast/Proofpoint mailboxes to the
"default" campaign bucket; websites normalised to bare domains; titles kept
readable; company cut at the first `|`; typed columns (`is_bounced`, dates,
`validation_status`, `category_source`, `category_confidence`, `email_type`)
coerced or dropped per cell, because one bad value would fail a 2,000-row
statement. Counters live on `upload_batches` (`inserted_rows`, `merged_rows`,
`replaced_rows`, `skipped_rows`, `no_email_rows`, `in_file_duplicates`,
`locations_added`, `esp_detected`, `error_rows`, `error_log`).

**Tags to add (client tag).** The wizard's strategy step has a "Tags to add"
field (≤5, `[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}`); the route passes them as
`addTags` and the engine stamps them on every imported row. `leads.tags` is
Bison's comma-separated tag list (ESP tag + client tags attached on push), so
for an existing lead the tags are ADDED — `fn_merge_tags(l.tags, r.tags)`
(109; order kept, case-insensitive, first spelling wins) — under merge and
replace alike, never overwriting what Bison wrote; nothing under skip. The app
never derives a tag from a file name (user decision 2026-09-18: not reliable);
only the one-off folder driver `scripts/import-csv-folder.mts
--tag-from-filename` does, and it refuses any tag not present in
`client_tags`. Used once for the JPDET / CCGHTX / CCGEN / CCGGC delivery.
Since migration 130 the route also records them on the batch:
`upload_batches.add_tags` (trimmed, exactly what the engine gets; `[]` for none) and
`override_fields` (the replace rule's fields); both are null on every batch made
before 130. The worker sends an upload's no-email rows to the People table of the one
client tag among them (see "Upload no-email rows (migration 130)").

**LinkedIn links (2026-10-23).** `person_linkedin` / `company_linkedin` existed on
`leads` but were missing from `LEAD_FIELDS`, so every upload skipped the
files' "LinkedIn" / "Company LinkedIn" columns (the Map-to dropdown had no
option, and the engine only writes `LEAD_FIELDS` keys). Now both are mappable
(auto-matched from those headers), mapped by the delivery scripts, and export
columns. Merge fills them only when blank. Only future imports get them (the
77 batches before 2026-10-23 all carried both columns; no backfill was run).
Finding emails for the people the list's source had none for is NOT this
export: those rows are held back, and each upload's "No-email rows" download
streams them exactly as uploaded — LinkedIn column included (2026-10-23: all
131,787 no-email rows from the 24 uploads since 10-19 had a linkedin.com/in/
link).
Since migration 130 those rows also go to the People table of the upload's
client, where the email finders look for their emails (by name and website, then by
this link), and a found email comes back through this engine with the upload's own
rule, tags and fields (see "Upload no-email rows (migration 130)").

**The route returns `{batchId}` (202) at once and runs the import in Next
`after()`** — ~18 ms/row measured, so a 10k-row file is ~3 min and the 88k set
~26 min; the page and `UploadProgress` follow `upload_batches`. A chunk that
fails on deadlock / serialization / statement timeout / dropped connection is
retried (3×, backoff); a data error bisects the chunk down to 100-row blocks
(counters are deltas applied only after commit, so a rolled-back chunk counts
nothing). The final status write retries; any batch still `processing` after
3 h is marked `error` by the next upload ("stalled"). The route 400s a file
whose columns differ from the mapped file (multi-file uploads reuse file 1's
mapping), takes the browser-detected delimiter, and reads `X-Upload-Config`
URI-encoded (header values must be Latin-1). It has a role gate (it had none)
and **no longer calls `fn_sync_companies` inline** (5 min / 5 GB temp per call —
the categorize worker's job). The Email Bison export format keeps its
original per-row path.

**Rehearse before importing:** `npx tsx --env-file=.env.local
scripts/test-upload-import.mts <file.csv> --rows=10 [--emails=a@x,b@y]
[--strategy=merge|skip|replace] [--override=city,state] [--twice]` runs the
real engine on real rows inside one transaction and rolls back, printing every
stored field (`--twice` re-runs the chunks: the second pass must insert, merge
and add nothing); `--commit` performs the small import for real. Verified
2026-09-18 after the review fixes: merge/skip/replace on the three rows the
review used (Denver stays stateless with Lincoln as an extra; Orangevale
becomes the primary once; one Greater-Sacramento extra), second pass 0/0/0.

**Folder driver for a delivery:** `npx tsx --env-file=.env.local
scripts/import-csv-folder.mts <folder> [--files=a.csv,b.csv] [--only=1,3]
[--tag-from-filename | --tag=X] [--dry]` — one `upload_batches` row per file,
sequential (never run two imports at once), byte-identical files skipped by
checksum, NUL stripped, live counters. Runs on 2026-09-18 (both 0 errors):
the Sep-15 delivery — 18 unique files of 20 (7≡6, 10≡8), 37 min, **46,820 new
· 39,012 merged · 22,001 extra locations · 83,043 no-email held back**; the
client-tagged files (JPDET, CCGHTX, CCGEN, CCGGC) — 10 files, 9 min, **8,532
new · 23,392 merged · 4,009 extra locations · 38,851 no-email**, tags landed
as JPDET 6,279 / CCGHTX 15,263 / CCGEN 7,621 / CCGGC 2,758 leads. `CCGEN
5.csv` was 9,036 no-email rows and 16 leads (a stray no-email export). About
18 ms/row of database work; the first file also pays the MX lookups (cached
afterwards). Everything in one run merges into one Uploads-page history row
per file, each with its own no-email download parts.

⚠ **Placeholder junk in production:** 1,773,590 leads have `company_phone =
'there'` and 11,279 `'--'` — Bison's template fallback for its "company phone"
variable (5,025,020 mirror rows carry it), copied in by the custom-variable
fill. The merge treats these as blank so a real phone from a file replaces
them; a one-off `→ NULL` cleanup is pending (1.77M-row UPDATE: batch it,
off-peak). Mirror addresses carry "(No Address Available)" ×354,157 the same way.

## Titles split, company taglines cut (migration 106)

`fn_sync_lead_job_titles` now splits plain text on `\s*[|;]\s*` (JSON arrays as
before) — `President | CEO` stays readable in `leads.title` (exports, Bison
pushes) and becomes two `lead_job_titles` rows (Title chip, its search, the
cache). **Not** on `/` or `&` (52,039 and 64,673 titles: "Owner/Operator",
"Founder & CEO" are single roles). Backfill added 5,456 title rows for ~4.6k
leads without touching `leads.title`. `fn_clean_company_name` (BEFORE INSERT OR
UPDATE OF company) keeps the first non-empty `|`-part on every write path (107;
the first version turned "| Acme" into NULL) — the client chose this knowing
"Radoslovich | Shapiro, PC" loses its second partner. `companies.name` still
holds the old "X | Y" spellings for those ~1k rows; `fn_sync_companies` keys on
the cleaned lead company, so those rows go stale rather than wrong.

## "Email Ends With" / "Domain Ends With" filters (client request, 2026-09-18)

**Searchable dropdown + free text (2026-09-19).** Both chips render
`FilterMultiSelect` in `plain` mode (no Contains/Exact, OR/AND, "All" or
Unknown rows — one fixed semantic) over the endings that exist, largest first
with lead counts; anything else is typed + Enter (`.co.uk`, `@acme.com`). The
lists are `filter_options_cache` rows `email_suffix` (TLDs, two-level endings
like `.co.uk`, and a FIXED list of mailbox providers as `@gmail.com` …) and
`domain_suffix` (TLDs + two-level endings of the HOST — the exact expression
the filter uses, so a dropdown count is what an include matches before the
visibility gates); ≥25 leads to be listed (~490 / ~480 options). Built by
`fn_refresh_suffix_options()` (112) in ONE scan of leads. **Measured:** as an
`INSERT … SELECT` the regex work over ~9M rows ran serially — 221 s (an
INSERT's SELECT cannot use parallel workers); materialised with `CREATE TEMP
TABLE … AS` it gets a Parallel Seq Scan with 2 workers — 63 s. Use that shape
for any future full-table aggregate written from a function.
`scripts/refresh-filter-cache.mjs` calls it after the main refresh in its OWN
transaction with its OWN 20 h age gate (and the main gate ignores the two
suffix rows), so a slow or failed endings scan can neither roll back the main
cache nor make it look stale; guard: 1–3000 options each. Served by the generic
`distinct_values` / `filter_option_counts` RPCs, loaded when the chip opens.

Two chips next to Email Contains, each include + exclude, typed suffixes
(`.in`, `.org`, `.co`, `@gmail.com`), no modes: `emailSuffix` /
`domainSuffix` in `FilterState` (`SuffixFilter`), sent by
`build-rpc-filters` **only when non-empty**, read by
`fn_lead_filter_conditions` (migrations 110 + 111, rebuilt from the live body)
as `right(lower(l.email), N) = 'v'` (OR within include) and `<> 'v'` (each
exclude AND-ed). `.co` does not match `.com`. NULL / blank / padded values are
skipped in SQL (`right(x, 0) = ''` would match every row) and dropped by
`normalizeFilterState`, so a blank-only suffix is never an "active filter"
(bulk-delete guard); a non-array value is ignored rather than raising.

⚠ **The domain chip judges the HOST, not the column (111).** `leads.domain`
is not clean: ~3.3% of rows (~290k) hold a URL — `https://x.com/`,
`x.com/contact-us`, `x.in/usa/…?srsltid=…` — every one written by the Bison
sync, which inserts `cv_domain` un-normalised (the CSV import normalises). A
raw suffix test missed those on include and, being the exact negation, LET
THEM THROUGH on exclude — and excludes ride `push_batches.filters` into the
push-worker. The expression strips the scheme, cuts at the first `/ ? # :` or
whitespace, drops a trailing dot, and falls back to the email's domain when
the column is NULL/empty (Website-chip rule). Verified on a 200k slice
against an independently written host extraction: 0 disagreements; +4,812
`.com` / +903 `.org` rows recovered. Open follow-up: normalise `cv_domain` on
the Bison write path and clean the existing rows (write-amplified — batch it).
The Website chip's `exact` mode has the same blind spot. Because every wrapper reads that
function, the filters apply to the page, header dropdowns, exports, pushes,
saved searches and the bulk-delete guard alike; old presets/queued batches
simply lack the key. No index: used with targeting the suffix is a cheap
post-filter; alone it is a full scan (same class as Email Contains). If
suffix-only searches over the whole table become common, add a
`reverse(lower(email)) text_pattern_ops` index and rewrite the predicate to a
prefix LIKE on `reverse(lower(l.email))` (it would not help excludes, and
`.org` alone is ~12% of the table). Checks: `npx tsx
scripts/test-suffix-filters.mts` (state/RPC, 14 cases) and the SQL cases run
when 110/111 were applied. The same review found three regression scripts
(`test-esp-default`, `test-client-targeting`, `sweep-client-filters` — the
last with `statement_timeout = 0`) issuing a **session-level SET on the
pooler**; they now run every statement in its own transaction with `SET
LOCAL` (`tq()` helper). Grep for a bare `set statement_timeout` before adding
any new script.

## Leads total is its own request; Ends With includes grouped (2026-10-21)

**Symptom:** a search with ~50 foreign email endings showed "This search is too
heavy and timed out". Measured through PostgREST exactly as the route called
it: rows **2.2 s**, count **121.3 s then 57014**. The route awaited both, the
browser aborts at 100 s, so rows that were ready after 2 s never showed. The
count's own "15 s, then estimate" fallback cannot work (see 085/086 above).

**Page:** rows come from `/api/leads/filter?count=0`, the total from
`/api/leads/count` — separate requests, so the table never waits for the
count. The count is keyed on the filters minus page/pageSize/sortBy/sortDir,
so paging and sorting no longer re-run it (they used to re-run the full count
on every click). Header: Counting… / N contacts / Count timed out (57014 →
`{timedOut:true}`, not an error) / Count unavailable. Without a total,
pagination pages from the rows (next = a full page came back). "Select all" is
offered only once the total is known, because every action downstream shows
that number to confirm what it will touch. The Export menu's "Export Filtered
(N leads)" shows that filtered total (minus rows unchecked out of a
select-all); since 31e5807 it had shown the TICK count while sending every
eligible match (2026-10-23 fix). It is an upper bound: the CSV export also
drops bounced and invalid/unknown leads, and a push also drops leads already
sent for the client tag and the client's rules. It is disabled while the total
is unknown; "Retry" next to "Count timed out" / "Count unavailable" re-runs it. `/api/leads/filter` without
`?count=0` still returns rows + total (old open tabs). A superseded request used
to be aborted in the browser only, with PostgREST running the old query on to
its limit; since 119 it is cancelled in the database (next section).

**Migration 118:** `fn_lead_filter_conditions` groups INCLUDED endings by
length — one `right(<expr>, N) = ANY ('{…}')` per distinct length — instead of
one test per value. Same rows (0 mismatches on two different 2% samples,
including quote/backslash/brace/comma/"null"/unicode values). 2% sample: 50
included endings 8.25 s → 1.12 s. Full table through PostgREST: the 50-ending
search's count **121.3 s (timeout) → 16.2 s, exact** (10,250); rows 2.0 s.
⚠ EXCLUDES deliberately stay one condition per value: Postgres runs those
cheap quals first and the first excluded ending that matches (usually `.com`)
rejects a lead after one `lower()+right()`. Grouped, a 56-value exclude list
measured 1.7× **slower** (0.89 → 1.48 s), as did one `NOT (… OR …)`.

## Leads search speed: host once, capped walk, cancellable searches (119, 2026-10-23)

All three change how a result is found, never which rows: old vs new compared
on every lead (629 condition payloads, 2.9M distinct hosts, synthetic rows from
each payload's own endings) and on 100+ real page queries — 0 differences.

**Domain Ends With** computes the host expression (two `regexp_replace`, ~2.4 µs
a lead) as few times as possible: per side, an ending that ends with another
listed ending is dropped (`.co.uk` with `.uk`), then with N endings over L
lengths it is 118's grouped `right(<host>, len) = ANY` when N ≥ 31·(L−1), else
one `<host> LIKE ANY ('{%…}')` (LIKE costs ~0.078 µs per pattern, so a long
same-length list would be slower as LIKE — all 213 country endings were 2.6×
slower in a first draft). An exclude is `NOT (…)` of the same; 118 ran the host
once per exclude VALUE. Counts, full table, 2 workers: 20 endings / 6 lengths
43.0 → 14.1 s (no worker: 128 → 40 s), 56 excludes 24.2 → 13.5 s, 213 country
endings 22.7 → 16.6 s.

**Rows, page 1 only.** With the created_at sort the planner walks
`idx_leads_created_id` and stops at a page of matches; a rare filter walked all
9.5M rows (`.ci`: 35–48 s). When page 1's plan is a SERIAL walk of that index,
the walk is capped at the newest 1.5M leads (a filtered `ORDER BY … LIMIT
1500000` subquery — an exact prefix of the same order, so a full page found
there is the page, with the old walk's own work); short of a page it re-runs
ordered by `created_at + interval '0'` (no index → parallel scan + sort).
`.ci` 35.8 → ~11 s; a client tag ~570k deep 2.4 → 2.0 s. ⚠ Price: a filter
whose 50th match is 1.5M–3M deep (email `.pt`, `.to`) pays the cap and the
scan, ~1.5× slower (6.6 → ~10.6 s). Deliberately NOT capped: pages after the
first (walk usually finds them soon) and PARALLEL walks (client targeting —
the capped walk runs in one process; one saved search went 8.6 → 14 s in a
first draft). The two-window first draft (250k, then 1.5M) was rejected: a
filter with no match in the newest 250k paid the scan though its matches sat
at 570k (2.2 → 7.3 s).

**Cancellable searches.** The page sends a random id per rows/count request
(`x-lead-query-id`); the routes pass it as `p_filters.queryTag` (like
`skipCount` — a parameter would add an overload); the functions set
`application_name = 'leads-q:<uuid>'` for their transaction (tag appears
~10 ms after the call starts, reverts at commit/abort — checked through
Supavisor); `fn_cancel_lead_queries` cancels exactly those backends
(pg_stat_clear_snapshot first). `src/lib/leads/query-cancel.ts` keeps a
registry on `globalThis` (the build inlines the module into each route chunk):
a search whose id was cancelled earlier, or whose client is gone, is refused
(409) before the RPC; a running one is cancelled until its RPC settles (it may
not have reached Postgres yet). The page batches one tick's cancels into one
POST, sends them from `pagehide` via `sendBeacon` on reload/close, and bumps
its request sequences before the unmount aborts (no false "timed out" toast).
⚠ Never set `req.done` in the fetch `finally`: Chrome rejects in-flight
fetches BEFORE our pagehide runs (Next registers its own listener first), so a
reload would skip the cancel. Measured: cancel → 57014 in one round trip;
parallel workers gone within ~10 ms.

## Costing feed for ReplyRouter (121, 2026-10-27)

ReplyRouter's Costing section pulls `GET /api/costing?from=&to=` (spec "Costing
feed — spec for product endpoints v1.0") with `Authorization: Bearer
COSTING_API_KEY`, daily, re-pulling the last 35 days. EXACT figures only:
`invoice` lines, a provider's billing API (`provider_api`), or our own metering
when it reproduces the charge exactly (`metered`). Never estimates or proration.

- **Read path:** the route is excluded from the session middleware — the key is
  the only auth. `COSTING_API_KEY` unset or shorter than 32 characters makes
  every call a 500 "not configured" (fails closed; the value is trimmed, since
  pasted values often end in a newline); a wrong or missing key is a 401. The
  route has its own 2-connection pool (`src/lib/costing/db.ts`, 5 s connect
  timeout — the shared pool can wait 2 min behind exports, and the spec wants an
  answer in ~10 s) and reads in one READ ONLY REPEATABLE READ transaction with
  `SET LOCAL statement_timeout = '8s'` under a 9 s deadline counted from the
  request, so the wait for a connection comes out of it (a silent half-open
  connection would otherwise hold the request and a pool slot forever: the
  deadline releases the client with an error, which destroys the socket — a
  plain `release()` would hand the stuck client back to the pool). The
  checked-out client gets an `'error'` listener: pg-pool removes its own at
  checkout, so a server that drops the connection mid-query would otherwise
  raise an uncaught exception. It reads
  items with `amount::text` (kept exactly
  as given — unconstrained numeric keeps the scale), totals summed in SQL and
  written trimmed with at least 2 decimals ("40.0595", "52.20"). No money ever
  becomes a JS number. Before answering, the feed re-adds the items in BigInt
  and checks no money field is a number: a feed that would not add up is a 500,
  never a wrong answer. `notes` (COVERAGE_NOTES in src/lib/costing/feed.ts)
  says which sources are missing — update it as each comes online.
- **Tables:** `cost_line_items` (one row per spec item, keyed by its id;
  `origin` = the writer that owns it) and `cost_invoices` (vendor, invoice_id,
  invoice_date, currency, total). The table re-checks what SQL can: scale ≤ 12
  and |amount| < 1e15 (`abs()` first — `scale(NaN)` is NULL and NaN ≥ 0 is
  true, so NaN/Infinity would otherwise pass), sign by billing type, model for
  ai, no blank service/model/description (`cost_text_not_blank`), `final` for
  invoice lines, a metered amount exactly Σ qty × price ÷ per over its priced
  usage (`fn_cost_metered_exact`, cross-multiplied so nothing rounds), and the
  full spec shape of every jsonb field (`fn_cost_usage_ok`,
  `fn_cost_subscription_ok` with real calendar dates via `fn_cost_is_date`,
  `fn_cost_attributes_ok`, `fn_cost_allocations_exact`, `cost_invoice_shape`):
  decimal strings, no JSON number (node-postgres would parse it into a float),
  no nested `null` (it would be served as null, which the spec does not allow),
  no unknown keys, allocations summing exactly per dimension, attribute numbers
  under 1e15 (bigger ones come out of JSON.parse as Infinity, then null). A row
  written by hand cannot break the feed either. ⚠ Those helpers use CASE, not AND/OR,
  wherever a later test would error on the wrong type: SQL does not promise
  left-to-right evaluation. Deferred constraint triggers make every
  invoice's lines exist only with a header, share its currency and date, and add
  up EXACTLY to its total — checked at COMMIT, so a header and its lines go in
  one transaction. A final row's amount/currency/date/status change only under
  `SET LOCAL costing.allow_final_edit = 'on'`. RLS on with no policies and the
  anon/authenticated grants revoked; never read these through supabase-js
  (PostgREST sends numeric as a JSON number). ⚠ CHECKs pass on NULL — write
  them with IS NOT DISTINCT FROM (the invoice rule failed a test this way).
- **Write path:** every writer goes through `scripts/lib/costing-store.mjs`
  (spec validation; BigInt 1e-12 arithmetic; metered = Σ qty × price ÷ per,
  exactly; allocations sum exactly per dimension; an id owned by another writer
  is refused). An explicit `null` inside invoice / usage / subscription is a
  wrong type, not "absent" (a top-level null field is fine: stored as SQL NULL,
  omitted from the feed), and every string rule checks `typeof` first —
  `RegExp.test()` coerces, so `123` passed `/^[0-9a-z]+$/` and numeric ids
  skipped the duplicate check.
- **Invoice lines:** `node --env-file=.env.local scripts/costing-import.mjs
  <file.json> [--commit] [--backfill] [--correct]` — `{ invoices:
  [{vendor,id,date,currency,total,url?}], items: [...] }`. Each invoice line is
  dated its invoice day, is in its currency, and the invoice's lines (file +
  already stored) add up exactly to its total. Dry run by default: it writes,
  runs the database's deferred checks (`SET CONSTRAINTS ALL IMMEDIATE`) and
  rolls back, so a passing dry run means the commit passes. A line dated more
  than 33 days ago (UTC) needs `--backfill` AND a one-off ReplyRouter pull of
  that range: its daily pull re-reads "the last 35 days" at an unknown time, so
  read inclusively tomorrow's pull starts at today − 33. `--correct` = a
  deliberate change to a final line. ⚠ The repo is PUBLIC: a file inside it is
  refused unless git ignores it (and refused if git cannot run) — keep invoice
  files outside the repo, or in its git-ignored `costing-invoices/` folder.
  "Inside" is decided by folder identity (device + inode), not path text: macOS
  reaches one folder by several spellings (letter case,
  `/System/Volumes/Data/…`), and realpath does not undo all of them.
- **Tests:** `npx tsx --env-file=.env.local scripts/test-costing-feed.mts` (302
  checks, ~80 s): builds migration 121 itself as pg_temp copies in one
  rolled-back transaction; every raw refusal names the constraint that must
  fire AND checks the validator refuses the same row; RLS and the anon /
  authenticated revokes are checked; the route's database paths (a connection
  that is slow, never answers, goes silent mid-query or drops) and the importer
  CLI (guard, the statements each mode sends, its own invoice checks) run
  against a local fake Postgres (`scripts/lib/fake-pg.mjs`).

**Where each cost can come from (investigated 2026-10-27):** no vendor gives
exact money through an API we hold today.
- OpenAI (targeting sync gpt-4o / gpt-4o-mini; Locations "AI suggestion"):
  exact only via the Costs API, which needs an org **Admin key** — the
  `sk-svcacct-` key gets 403 "Missing scopes: api.usage.read". Project
  `proj_Q7LMqWQeLhiVayKkUYZqbpPM`. ⚠ Costs amounts are JSON floats with up to
  ~20 decimals vs the spec's 12-decimal cap — ReplyRouter must decide.
- Railway (Hobby workspace "outboundhero's Projects", renews ~19th): invoices
  only — the project token cannot read Customer/invoices, and usage × price does
  not reproduce the bill (float buckets, grouping-dependent memory totals).
- Supabase (project phualuedpmsdkzgsmjsw, XL): invoices only — the Management
  API exposes no invoice or charge.
- Reoon: payment receipts only (the API returns credit counts). Findymail: not
  used here since 2026-09-11 (shared account). Google Sheets, GitHub: $0.
- Bison installs, purchased lead lists, Clay: invoices; which product owns those
  bills is undecided.

## Selection is "everything matching, minus what you unchecked" (2026-09-22)

The Leads page had two disconnected selection states: `rowSelection` (TanStack,
holding only the CURRENT page's checked rows) and a `selectAllFiltered` flag.
Paging through a select-all therefore rendered every checkbox empty while the
toolbar said "All 340 selected", and Export reported "· 100 selected" — the
first page. There was also no way to drop a few rows from a select-all.

A row's checkbox in select-all mode now reads `!excludedIds.has(id)` rather
than `rowSelection` (the page has never seen the rest of the set), unchecking
records an exclusion, and drag/shift ranges and the header checkbox go through
the same path. The ids travel with the ACTION as `excludeIds` in the filter
JSON — **never** in `filters` itself, so a preset or shared link cannot carry
someone's unchecked rows — and `fn_lead_filter_conditions` honours them
(migration 114, `NOT (l.id = ANY (…))`, uuid-guarded, capped at 1,000 =
`EXCLUDE_IDS_MAX`). Because every consumer reads that one function, an export
cannot ship a row the operator unchecked and a delete cannot remove it.
`normalizeFilterState` must PRESERVE the key — the export route normalises
before building its payload, which is where a naive version loses it.
Checked by `scripts/test-selection-exclusions.mts` (13 cases; the live ones
assert the count drops by exactly N and the rows survive).

## Never contact: bulk, and reversible from Admin (2026-09-23)

`fn_suppress_email` / `fn_unsuppress_email` take ONE address and the route
looped them — one Railway→Sydney round trip each, so the route's own 5,000 cap
was unreachable and the UI could only ever suppress the rows checked on one
page ("Never contact 100 leads", which read as a 50/100 limit). Migration 115
adds the set-based twins `fn_suppress_emails` / `fn_unsuppress_emails` (same
upsert, same `is_suppressed` flip, both counts returned): **250 addresses in
one statement, ~4 s**, vs 250 round trips.

`POST /api/leads/suppress` now also takes **`filters`** — the same filters the
table ran, `excludeIds` included — resolves them server-side and writes in
chunks of 5,000, so "select all 42,000 → Never contact" works without the
browser holding a single id. Guards: the same "no active filters" refusal the
bulk delete uses, and a 100,000 ceiling.

**Restoring** (`DELETE`) lifts the block *and* sets `is_suppressed = false`, so
the lead is live again; an address whose row was deleted at suppression time
has nothing to bring back and the reply says so. It is **owner/admin only** —
suppression is a promise to a person, and lifting it is the direction that puts
them back into campaigns. The Admin page lists the block list **grouped by
reason** (reasons are free text: "Out of USA" and "out of USA" fold together,
the most common spelling is shown), with search, per-address restore and
"Restore all" per group. Checked by `scripts/test-suppress-bulk.mts` (16 cases
against real rows, rolled back).

### Suppression reaches Email Bison (2026-09-23)

Suppression used to be local to this database: it stopped OUR exports and
pushes but never touched Bison, so **542 of 1,067** suppressed addresses were
still `in_sequence` on a live install (1,358 lead records across the four).

**Bison's API reference is at `/api/reference`** (spec: `/api/reference.openapi`,
YAML, 180 operations). Guessed paths all 404 — read the spec, do not guess.
The relevant ones:

| Endpoint | Note |
|---|---|
| `PATCH /api/leads/{id}/unsubscribe` | no body; status → `unsubscribed` |
| `PATCH /api/leads/{id}/update-status` | `{status}` ∈ verified, unverified, unknown, unsubscribed, risky, inactive |
| `PATCH /api/leads/bulk-update-status` | `{lead_ids[], status}` |
| `POST /api/leads/{id}/blacklist`, `POST /api/blacklisted-emails/bulk` (CSV), `DELETE /api/blacklisted-emails/{id}` | blacklist, **not used** — client chose unsubscribe only |

⚠ **The docs are wrong about one thing.** The unsubscribe example response shows
`lead_campaign_data: []`, which reads as "campaign membership is wiped". It is
not: verified on three live leads, the campaign rows survive with their ids and
stats intact (`stopped` / `sequence_finished`). Unsubscribe is therefore far
less destructive than the docs imply.

**Round trip, verified live 2026-09-23:** `unsubscribed` →
`update-status {unverified}` → `unverified` (campaigns still there) →
`unsubscribe` → `unsubscribed`. That matters because **Bison refuses to add an
unsubscribed lead to a campaign** (the push-worker already reads that back as a
refusal reason), so clearing the status is what makes a reactivated lead
sendable to FUTURE campaigns — the client's requirement.

⚠ **Bison refuses to unsubscribe a lead it has never emailed** — 422 "This
lead has not been sent any emails yet", 343 of the first 1,358. The worker
falls back to `update-status {unsubscribed}`, which works on a never-emailed
lead (verified live). Either route ends at `status = unsubscribed`, which is
what bars the lead from a sequence.

**Catch-up run 2026-09-23: 1,358 records, 1,015 via unsubscribe + 343 via the
fallback, 0 failed**, sampled live across all four installs.

`bison_unsubscribe_queue` (116) holds one job per address **per install**
(`fn_enqueue_bison_unsubscribe`, reads the mirror so it costs no API calls);
the suppress route enqueues `unsubscribe`, the restore route `reactivate`, and
a later opposite action deletes the pending one. `npm run bison-unsubscribe`
(`scripts/bison-unsubscribe-worker.mjs`, Railway cron `*/15 * * * *`) drains it
at ~2.5 calls/s, waits out a 429 rather than hammering, marks a 404 `gone`
rather than failed, and is lease-locked. A stale mirror id is re-resolved live.

## Mimecast is excluded by default (client request, 2026-09-16)

`DEFAULT_FILTER_STATE.esp` ships as `exclude: ["Mimecast"]`
(`DEFAULT_ESP_EXCLUDE` in [filters.ts](src/types/filters.ts)). That one constant
seeds a fresh Leads page, is what **Reset** restores, and survives selecting,
switching and clearing a client (client selection never touches `esp`). An
operator who wants Mimecast accounts removes the chip (✕ / Clear); nothing
re-seeds it during the session — `mergeIE` keeps an explicit `exclude: []`, so
presets, shared links, exports and queued pushes carry what the chip shows. A
reload starts fresh with Mimecast excluded again. Regression test:
`npx tsx --env-file=.env.local scripts/test-esp-default.mts`.

Facts this relies on (measured 2026-09-16):

- `leads.esp` holds exactly 7 title-case values and no variants — the literal
  must be `"Mimecast"` (263,938 leads). ESP matching is **exact**: the chip's
  Contains/Exact toggle is a no-op for esp (`buildRpcFilters` passes no mode).
- The SQL exclusion is NULL-safe — `(l.esp IS NULL OR l.esp <> ALL(...))` — so
  the **824,501** leads with no ESP are kept. Never hand-write it as
  `esp <> 'Mimecast'`, and never express it with the `__UNKNOWN__` sentinel
  (that sets `includeUnknown`, which drops the NULL rows).
- The default is deliberately **not** in `fn_client_eligibility_conditions`: the
  push-worker re-checks eligibility per lead at send time, so a rule there
  would strip Mimecast even after the operator removed the chip. Consequence:
  the low-availability popup and `client_location_coverage` (eligibility-based,
  no ESP concept) run ~2–3% above the Leads table for the same client.
- `countActiveFilters` counts esp only when it **differs from the default**
  (`isDefaultEsp`). Otherwise a fresh page would report 1 active filter, show
  Reset with nothing to reset, and — the hazard — enable the toolbar Delete with
  no selection in "delete everything matching filters" mode. Removing the chip
  does count, so Reset appears and restores the default. The bulk-delete route
  applies the same test server-side (its `conds.length === 0` guard was already
  dead: the silent gates always append conditions).
- The ESP chip is **not hideable** any more, and a one-time stamp un-hides it
  for anyone who had hidden it — a hidden chip would be a filter the operator
  can neither see nor remove (hiding never clears a value).
- Mimecast heads the **SEG** routing bucket (`espBucket`), ~17% of that bucket.
  With the default on, SEG campaigns receive Mimecast only when the operator
  removes the chip before queueing. Selected-row actions (Export Selected, push
  from a selection) and already-queued batches ignore/keep their own filters.
- Stored payloads are not rewritten: every existing preset, shared search and
  push batch already carries an `esp` key, so `normalizeFilterState` leaves them
  alone; only a payload with **no** esp key gets the default injected.

## `TagInput` splits lists by default

[tag-input.tsx](src/components/ui/ios/tag-input.tsx) splits committed values on
`, ; newline tab` — **including on paste**, which was the actual bug (the `,`
keypress was handled, paste was not, so a pasted list became one chip; production
had a single 588-character entry). De-dupes case-insensitively, `maxTags` is 500
and now warns instead of silently discarding the overflow.

Pass `splitOn={null}` where a comma belongs to the value — the two **location**
fields in the targeting dialog (`"Spokane, WA"` must stay one chip).

## Running long jobs against production (hard-won)

These cost real hours. Read before starting anything that runs longer than a
coffee break.

- ⚠ **NEVER issue a session-level `SET` over `DATABASE_URL` (port 6543).**
  Supavisor's transaction mode hands the backend to the next client WITHOUT
  resetting GUCs, so `SET statement_timeout = '60s'` or
  `SET default_transaction_read_only = on` from any script — an audit runner, a
  one-off, an investigator — lands on the push-worker's next connection. On
  2026-09-16 exactly that took the push-worker down for **51 minutes**
  (`cannot execute UPDATE in a read-only transaction`) and crashed one
  validation-worker and one location-worker run. Always the transaction form:
  `begin; set local statement_timeout = '60s'; …; commit` (or `rollback`).
  Known in-repo offenders that still do session-level `SET statement_timeout = 0`
  on 6543: `scripts/infer-company-locations.mjs`, `scripts/resolve-unresolved-locations.mjs`
  — manual-only, but a manual run leaks `timeout=0` into the shared pool. If a
  leak is suspected, open ~20 connections and `RESET` both GUCs on each
  (`reset default_transaction_read_only; reset statement_timeout`) until every
  live Supavisor backend reads defaults.
- **Use the transaction-pooler pattern for bulk SQL:**
  `begin; set local statement_timeout='560s'; …; commit`. Batch in id ranges
  (`STEP=100000`), and **retry each batch** (3 attempts, `20s × attempt` backoff)
  — a timeout mid-run is normal, not a reason to restart from zero.
- **Retry on TRANSIENT, always.** Connection drops, `deadlock detected`, and
  `statement timeout` all recur under sustained load. `sync-bison-leads.mjs` lost
  7 of 8 shards to "Connection terminated unexpectedly" before it grew a retry
  wrapper + pool `keepAlive` + an `error` handler.
- **Take the lock order seriously.** The cv backfill and the Clay import
  deadlocked against each other until updates were sorted by `lead_id`.
- **`caffeinate -dims`, not `-i`.** `-i` does not stop lid-close sleep, and after
  a sleep Node's timers can hang with the process at 0% CPU — the job looks alive
  and does nothing. If a run flatlines, kill and resume rather than waiting.
- **`dotenv/config` loads `.env`, not `.env.local`.** Either
  `DOTENV_CONFIG_PATH=.env.local` or `node --env-file=.env.local`. Several
  scripts (`sync-clients-from-sheet.mjs`) load no dotenv at all and expect the
  environment to be populated — that is why they work on Railway and fail
  locally with a bare `npm run`.
- **A failed shard returns 0, so summaries lie.** "365,324 rows" was reported by
  a run where 7 of 8 shards had died. Grep the log for failures before believing
  a total.
- **Don't extrapolate from consecutive samples.** 900 consecutive leads ≈ 60
  independent observations; a confidence interval built from them predicted
  225k–335k against an actual 164,644. Sample randomly or don't quote a range.
- **Prefer set-based SQL to per-row API calls.** The custom-variable backfill ran
  at 3 rows/s per-lead; the same work as one `UPDATE … FROM (VALUES …)` per
  batch, sourced from the mirror, did 916,344 rows in an afternoon.
- **Check the plan before a mass UPDATE.** A `lower(email)` join defeated
  `leads_email_key` and timed out at 120s; plain equality (emails are already
  lower-cased) ran in 2.4s.
- **`node --input-type=module /dev/stdin` fails** (`ERR_INPUT_TYPE_NOT_ALLOWED`).
  Use `node - < file.mjs`.

## Performance audit 2026-09-16 — what was found, what is done

Six read-only investigators + adversarial review (every top item challenged by
an independent skeptic). Measured, not guessed:

| Cause | Measured |
|---|---|
| Leads page runs TWO regex-heavy scans per filter change (rows + count) | pair 20.7 s vs 10.7 s single; 24 of 70 sampled requests aborted at 100 s |
| Client select fired a live availability COUNT (full seq scan for the 12 `require_location=false` clients) | median 85 s, max 121 s |
| Push forecast counted all 14.1M `bison_leads` rows for a value never read | 5.65 s/click |
| location-worker (every 30 min): three whole-table passes returning nothing | **66% of all disk reads** since Aug 1 |
| coverage refresh recomputes all 196 clients every 6 h | 12.4% of all exec time, 1.96 TB read |
| `fn_sync_companies` sorts 9M rows twice per call | 5 min, 5.25 GB temp, after every upload |
| `leads` indexes 4.3 GB → 10 GB in 4 weeks (12.7M non-HOT updates) | 85% heap cache hit vs 4 GB shared_buffers / 40 GB DB |
| Supabase is in **ap-southeast-2 (Sydney)**; Railway is in the US | ~1.0–1.6 s floor on every API call |
| `filter_options_cache` last refreshed 2026-07-28 | dropdowns 7 weeks stale; 121 MB unread subcategory row |

**Batch 1 — shipped 2026-09-17** (all app-code/trivial, reversible):
push-forecast existence probe instead of the 14.1M-row count;
`/api/clients/availability` reads `client_location_coverage.total_available`
(live count only behind `?fresh=1`, 30 s `SET LOCAL`; `available: null` when the
client has no coverage row); location-worker's closing `GROUP BY` gated behind
`--verbose`; bison sync keeps the first `cv_fetched_at` (matters for FULL
re-syncs only — the 3-day incremental never reaches the upsert branch) +
migration 100 per-table autovacuum on `bison_leads`; migration 101 rebuilds
`fn_refresh_filter_cache` without the subcategory block; migration 102 adds
**quality gates** to it; `scripts/refresh-filter-cache.mjs` (last step of
`client-sync`, ≥20 h gate on the OLDEST row) restores the dropdown refresh.

⚠ **Lesson from the first refresh (2026-09-17 13:18 UTC):** running the
July-era function against September data pushed **13,156 "states"** into a
chip that renders its whole list locally — phone numbers, street addresses, a
JSON blob, "Калифорния", sales questions — because `leads.state`/`city` now
carry raw Bison custom-variable text and the function had no filter. Caught by
the adversarial review ~40 minutes later, fixed by 102: state restricted to
`geo_admin1` names/codes (**124** options, 98.2% of leads), city ≥5 leads / no
digits / 2–60 chars (**10,296**, 99.5%), title ≥3 leads / ≤120 chars
(**21,921**). The script now refreshes inside a transaction and **rolls back**
if state > 200, city > 20,000 or title > 100,000. Rare values still work by
typing (City/Title chips search the live column). Apply function migrations
BEFORE running `--force`, and never trust a cache refresh you have not sampled.

⚠ **One lead's title silently broke the refresh for days (2026-09-18 → 19).**
The Title branch parsed every title matching `'^\s*\['` as a JSON array
(`title::jsonb`). An upload brought **`[Interim] Chief Operations Officer`**,
and from that moment every daily refresh died with `invalid input syntax for
type json` — no alert, dropdowns just stopped updating; found only because
migration 112 made me run the job end to end. The table holds **zero** valid
JSON-array titles, so the branch was dead code whose only effect was to crash.
Migration 113 guards it with `IS JSON ARRAY` (PG16+), matching what
`fn_sync_lead_job_titles` already did (parse, catch, fall back to plain text).
Lesson: a cron whose only failure signal is its own exit code is invisible —
when a refresh job starts failing, nothing in the UI says the data is stale.

Also fixed from the review: `/api/clients/availability` surfaces PostgREST
errors as 500 (supabase-js returns `{error}` instead of throwing) and treats a
NULL `total_available` as "no popup" (`Number(null)` is 0). Known, accepted:
for the 13 `require_location=false` clients the precomputed number is the
state-filtered total (UJ 767 vs ~209k live) — none is below the 250 popup
threshold today; `?fresh=1` for those clients exceeds its 30 s cap.

**Still open, in recommended order** (the reviewers' corrections applied):
1. Leads filter path: ONE materialized scan feeding both rows and count, plus
   cancelling superseded requests — measured 20.7 s → ~11 s for the heaviest
   clients. Do NOT add the proposed 8 s count cap: it would replace exact totals
   with planner estimates (wrong header, pagination, select-all/export/delete counts).
   **Partly done 2026-10-21:** rows and total are separate requests, the total
   is not re-run on page/sort, superseded requests are aborted in the browser
   (not yet in Postgres). The single shared scan is still open.
2. location-worker stages 2–3: index-driven pass 2/3 and draining the 142k
   junk-state cohort. The proposed `'unrecognized'` status **violates the live
   `leads_location_status_check` constraint** — needs a constraint change and a
   design decision, not a quick edit.
3. coverage refresh: skip clients whose targeting is unchanged; one nightly
   full run. (Not adversarially verified.)
4. `fn_sync_companies(p_since)` incremental seeds + function-local `work_mem`. (Not verified.)
5. REINDEX: only the `leads` btrees after the enrichment backlogs drain and
   only when the I/O budget is healthy. The reviewer **rejected** reindexing
   `bison_leads`' drained partial indexes: ~53 GB of reads to reclaim 0.9 GB.
6. 759 MB of `leads` indexes cover columns that are 100% NULL
   (`annual_revenue`, `company_size`, `general_industry`, `job_title_normalized`,
   `seniority`) — product decision: drop, or rebuild as partial.
7. Region: measure the Railway→Supabase RTT from inside the container before
   spending on a move; free mitigations first (verify the session JWT locally
   instead of `auth.getUser()` per request, dedupe the double client-tags fetch).

## Clay tab and AI Ark tab (migrations 122, 123)

Two manager-only tabs, applied to production 2026-10-31. Only "Add to the database"
(below) writes `leads`.

- **Clay tab** (`/leads/clay`): a client's Clay tables rebuilt as generic
  `enrich_tables` / `enrich_columns` / `enrich_rows` / `enrich_cells`. Column
  definitions (Clay's formulas, waterfalls, run conditions, verbatim) are loaded
  with `node scripts/enrich-seed-table.mjs <spec.json>`; specs hold a client's
  exclusion lists and prompts, so they live in the git-ignored `enrich-specs/`,
  never in this public repo. A hand-seeded table takes rows from a CSV only. A
  client's Google Maps places come from the GMaps Scraper app through the
  client's own inbound URL into its Companies (pipeline) table (see "Inbound
  URLs (migration 129)"). The no-email rows of a client's uploads go to its People
  (pipeline) table, held (see "Upload no-email rows (migration 130)").
- **AI Ark tab** (`/leads/ai-ark`): pick a client, see what AI Ark will be asked
  (locations and exclusion terms from `client_targeting`, job titles / seniority /
  company size from `client_people_filters`), count (People Preview, 1 credit a
  search), then pull. Each pull is an `aiark_runs` row and its own Clay-tab table
  (kind `ai_ark`), where every person gets an Outcome ("Ready to add", "No email",
  "Outside the client's area" …). `aiark_people` keeps single runs from buying
  anyone twice and keeps the newest 100,000 out of export jobs (AI Ark exclusion
  lists); past that an export can pay again for someone, written as "Bought
  before". While an export job is unread, no other run of its mode buys. A person
  whose Export Single answer never arrived stays unregistered, though AI Ark may
  have charged for them.
- **Standard filters for cleaning clients** (`scripts/lib/aiark/cleaning-filters.mjs`;
  AI Ark searches only, never the send gate, `client_targeting`, the Outcome checks
  or Clay tables): the owner's final lists, overlaps included (2026-11-03). A client
  whose `client_tags.client_type` is `Cleaning` searches on 287 titles for the person's
  main job (`experience.latest`, not `current`, which also matches side roles) with
  265 left out (WORD; an exclusion always wins), 8–6,800 employees, 13 industries
  left out (STRICT, exact catalog values), company types `GOVERNMENT_AGENCY` and
  `SELF_EMPLOYED` left out, and 76 keywords left out for companies (NAME, INDUSTRY,
  DESCRIPTION) and people (HEADLINE, SUMMARY). Its onboarding-sheet exclusion terms
  (`client_targeting.exclude_terms`, synced every 6 hours) are added to the company
  keywords as the limit below allows, broadest first; the rest are re-checked by
  the Outcome after the pull, when the person is already paid for. Titles, size and
  industries are defaults: a pull with nothing saved uses them, and a client's
  saved filters replace them. Keywords and company types always apply. AI Ark's size
  filter takes ranges only, so the brief's "plus unknown size" can't be sent.
- ⚠ **AI Ark refuses a request as too large at a limit its docs don't state**
  (`request size must less or equal to {0,number} bytes`, 400, nothing charged).
  Bytes alone don't decide it: live 2026-11-05 it took 9,905 bytes and refused 8,502.
  Sources and places seem to weigh more; 116 company keywords on all 5 sources were
  refused with fewer titles and places than the same list on 3 sources. An empty
  search still costs its credit. So `buildRequests` keeps every list within what it
  held in a request AI Ark accepted (`TITLES_BYTES` and friends), and splits titles
  and places across searches: median client 2 searches, largest 20, each one credit
  on a count. WORD phrases a shorter listed phrase already covers are dropped from
  the request (`condensePhrases`: 287 titles go out as 153, 265 as 180), which
  changes nobody's match. Those are the only sizes tested live; a refusal is free.
- **Where a pull's people go** (`scripts/lib/aiark/add.mjs`): with an email, the
  database; with none, the pipeline. People with a usable email, inside the client's
  area, clear of its exclusions and new to the database are "Ready to add". When a
  pull has finished and its rows are all worked, the worker asks the web app to add
  them (`AIARK_AUTO_ADD_URL`, `AIARK_AUTO_ADD_KEY`, `POST /api/aiark/add/auto`). ⚠
  **Not switched on:** with those unset, and until a worker exists, nothing is added
  automatically and live Start is refused (`Pulls aren't switched on yet`). A cancelled
  pull, and anyone an add could not store, take the button. People with no email stay
  in the pull's table; the email-finding steps (`find_email`, phase 3) are not built.
  When they are, they hand an address to `emailFound()`, which works the person again
  so they go to the database like anyone else. Those steps need a real name and
  company, which only the export strategy should return (a Preview has a masked last
  name and no LinkedIn or domain, and Export Single returns nothing without an email),
  so Export job is the tab's default.
- **Before the pipeline, the database is checked** (`lead_lookup`,
  `scripts/lib/enrich/client-checks.mjs`). Only someone whose Outcome is "No email"
  goes to the pipeline, and that Outcome now comes last: bought before, never contact,
  bounced, already held, outside the area and excluded all come first, so no finder is
  paid for someone who would be refused. Someone with no usable email is looked for by
  13 likely addresses at the company's domain in `leads` and the Bison copy (the name
  on the row must agree, as jsmith@ may be Jane; 87% of 2,165 random leads on a company
  domain had one of these shapes), then by the same name and company in `leads`,
  whatever the case (the trigram index on `company`; a Preview's masked last name fits
  by the letters it shows). Last names are written many ways: what follows a comma or
  bracket doesn't count, and one may start with the other, word by word ("Smith" agrees
  with "Smith, CPA" and "Smith Jones"). ⚠ 38% of `leads` rows have the last name
  `(General Email)` and a company-like first name: general inboxes, never a person, so
  a bracketed last name must not count as blank. Nothing indexes a name or company in the
  Bison copy, and `leads` has almost no `person_linkedin`, so neither is used. Measured
  2026-11-05 on production with the real test people, emails hidden: all 4 of the 6
  exported people held by address were found, and the 2 new ones matched nothing. 32 of
  100 Preview people were found. About 0.1 s median beyond the network, about 0.7 s for a
  common first name at the company with the most leads, and no new index. A miss is safe:
  the finder's address gets the exact check. Someone with a usable email is still matched by that address alone, so
  the same person under a new address is added as a new lead.
- **Add to the database** (a bar above a finished live run's table on the Clay
  tab; `POST /api/aiark/add`, `src/lib/aiark/add-run.ts`, logic in
  `scripts/lib/aiark/add.mjs`): the people whose Outcome is "Ready to add" become
  leads, once each. Anyone who has since
  become a lead, reached the Email Bison copy or the never-contact list is
  skipped at once; the rest go through the Uploads page's engine
  (`importRows`, strategy `skip`, never merged) as one `upload_batches` row, so
  each add is on the Uploads page. Each lead gets the client's tag, `source` =
  `AI Ark`, `validation_status` from AI Ark's check (valid / catch_all), AI Ark's
  first and last name, and the industry in `general_industry`, which
  `fn_client_eligibility_conditions` checks for exclusion terms (the Outcome
  checked the same text) and which isn't sent to Email Bison. That and
  `country` / `seniority` / `company_size` are outside the Uploads page's fields,
  so the import takes them as `ImportConfig.extraFields`. Category stays empty.
  The company description stays in the pull's table, off the lead: the send gate reads
  `specific_industry` and the Leads page's exclusion filter also `company_overview`,
  anywhere in the text, so "pub" would catch "public" and refuse or hide the lead.
  Each person's result is the run table's `add_to_database` cell: running
  (being added), done (Added, or skipped with its reason), error (not stored;
  the next add retries). The engine never works that column (phase 4). A
  batch still `processing` after 3 hours is dead and its people can be added
  again. Demo runs are refused.
- **The worker** `scripts/enrich-worker.mjs` (`npm run enrich-worker`) fills the
  Clay cells and works AI Ark runs. It runs as its own Railway service,
  `enrich-worker` (since 2026-11-12), with the no-op build command
  (`echo 'worker service: no next build'`, see "Every worker service MUST override
  the build command"), `DATABASE_URL`, and a draining time above 90 s
  (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120`): on SIGTERM it waits for the
  AI Ark call in flight to be written, and an Export Single may take 90 s.
  ⚠ The service is **not connected to GitHub** (a project token can't connect a
  repo), so a push to main does not redeploy it: upload the code from a clean clone
  of main with `RAILWAY_TOKEN=<project token> railway up --service enrich-worker
  --environment production --detach`, or connect the repo once in the Railway
  dashboard (Source, Connect Repo).
- **Env:** `AIARK_API_KEY` on **both** the web service (count, balance) and the
  worker (pulls); `AIARK_WEBHOOK_URL` (export runs only) also on **both** — the
  web service offers Export only when it is set, and the worker posts the jobs
  (this app's `/api/aiark/webhook` on its public HTTPS host); `AIARK_AUTO_ADD_URL` (worker) and `AIARK_AUTO_ADD_KEY` (worker and web, 32+
  characters) turn on adding finished pulls; `AIARK_RPS` (worker,
  4) and `AIARK_RPS_WEB` (1) keep one key at AI Ark's 5 a second. ⚠ **Never set
  `AIARK_DEMO` in production**: it turns on made-up demo runs that write into the
  real tables.
- **Live test 2026-11-05 (5 credits, one client):** the standard filters are accepted within
  the limits above (3,377 matches for 110 titles × 40 places). Export job: PENDING →
  DONE in 41 s, statistics, inquiries and the email block all as the client expects,
  full names, LinkedIn and company domain back. Both people had emails, so a no-email
  person from an export is still unseen. Both were already in the database. Short
  exclusions are whole-word: of 100 titles, "it" sat inside 6 and "cto" inside 9, as a
  word in none. `experience.current` means all active roles, so 15 of the 100 had a
  main title on no list (a side role matched): searches now use `experience.latest`. An
  "anywhere in the text" check on company descriptions caught 13 of the 100 on "pub" and
  "bar" inside longer words ("public", "barriers"): descriptions now match as whole words
  (1 of the same 100 is excluded now, on a job title).
- **Second live test, same day (5 more credits, same client):** `experience.latest` is
  accepted. The same request gave 2,992 matches against 3,377 with `current` (11% fewer),
  and main titles on no list fell from 15 of 100 to 1 of 100. An export job built by the
  app's code with an exclusion list was accepted and DONE in 237 s. The list was free and
  worked: none of the 4 were the 2 bought before. The job's POST answers `x-credit: -4.0`
  for 4 people, so it charges 1 a person up front. ⚠ All 4 had emails, 6 of 6 across both
  tests, so what an export returns for someone with no email, and any refund, are
  still unseen. 2 of the 4 and about 30 of 100 on the page were already in the database,
  and an export charges for them too.
- **Before the first live pull:** a small supervised pull of each strategy; Export
  Single's answer has never been read live. Storing AI Ark's data in the lead database
  was approved by the owner on 2026-11-03 (terms §6.2).
- **Tests:** stop the worker, then
  `AIARK_TEST_TAG=<cleaning client tag> node --env-file=.env.local scripts/test-aiark.mjs`
  (local database only; it refuses any other).

### Company pipeline (migration 124, the Companies tab)

Phase 1 of the Clay section restart: for any client tag, companies come from AI Ark's
Company Search into that client's template Companies table on the Clay tab, are
enriched there, and the Companies tab lists only those with a usable email. Since
migration 125 the steps are the original Clay columns (see "Pipeline v2" below).
Nothing in it writes `leads`, Email Bison or a campaign: phase 3 adds that, behind
fit scoring. Seeded **off** (`enrich_settings.company_pipeline.enabled = false`,
`tags: []`).

- **Tables (124):** `aiark_company_runs` (one row per pull, worked a slice at a time,
  cursor in `progress`, as `aiark_runs`); `aiark_companies` (the registry: every
  company any pull bought, keyed by AI Ark's id, a trimmed record with no
  technologies, funding or logo, and `place_keys` such as `US`, `US|IL`,
  `US|IL|springfield` for the head office and every office; `demo` rows never reach
  a live pull); `enrich_memory` (paid answers shared by every row, table and client);
  `enrich_companies` (one summary per template row, written by the worker; `listed`
  rows are the tab); `enrich_settings` (the switch, caps and the model per AI step).
  `enrich_tables.template` (`companies_v1`; one template table per client and kind)
  and the `registry` source kind are new too.
- **The request** (`buildCompanyRequests`, `scripts/lib/aiark/company-filters.mjs`):
  one search per group of places (950 bytes, 300 values each), with the excluded
  places and the same company filters people searches send (`accountFilters()` in
  `filters.mjs`: saved size bands and industries, or a cleaning client's defaults;
  cleaning company types; the exclusion terms as company keywords, 1,900 bytes).
  No titles. Blockers: no rules, no places, more than 50 searches. AI Ark matches
  a company on ANY office, and "City, State" is undocumented, so each row re-checks
  its offices (`client_office`).
- **A pull** (`scripts/lib/aiark/company-runs.mjs`, worked by the enrich-worker's AI
  Ark loop, taking turns with people slices on the one client and throttle): each
  slice (1) copies up to 1,000 registry companies with an office in the client's
  places that pass the pull's company filters (free, they count toward the size),
  or (2) makes AI Ark exclusion lists (`company_id`, free) of the registry companies
  in the client's places and of those its pulls bought, newest first, or (3) buys
  one page (0.1 credit a company; rows, cells, registry, counters and cursor in one
  statement, counted once per page id). ⚠ **The 50 lists a day are shared with
  people runs** (`listsMadeToday()` reads both run tables; 45 used at most). At
  10,000 records a search makes its lists again and starts over, or with no list
  budget moves on and records the cap. Company Search is retried only on a 429; a
  page whose answer was lost may have been charged, so it counts against the brake
  at full price, and 3 in a row stop the pull. Brake: `ceil(size × 0.125) +
  searches + 2` credits, checked before each page. 401/403 and 400 end in an error,
  402 stops. Past the lists (over 100,000 ids, or no budget) a company can be paid
  again: written once, marked "Bought before", counted in `bought_before`.
- **The template** is `companies_v2` since migration 125 (see "Pipeline v2"): phase 1's
  own office, rules and database checks (`client_office`, `client_exclusions`,
  `held_general_email`: 14 role addresses at the domain, then general-inbox leads at
  the same company, city and state, through `idx_leads_company_norm`; never contact
  stops the company, a bounced address is searched past) are kept as they were, and
  every other step is an original Clay column. Phase 1's own template (`companies_v1`),
  its prompts, `pick_emails`, `verify_emails` and `email_checks_per_company` are gone; a
  client that still has a `companies_v1` table can't pull (D24) and its rows are never
  worked. A template change reaches a client's tables on its next pull
  (`ensurePipelineTables()` upserts the columns by key and prunes the ones a template no
  longer has); rows already worked are not re-run.
- ⚠ **Template tables are strict** (`engine.mjs`): a formula, waterfall step, run
  condition or action input that reads a failed cell errors, and one that reads a
  cell waiting on a key waits, so no paid step runs on a guess (a missing Reoon key
  must not make the second email search read "nothing usable" and pay). Other tables
  keep the old rule (only formulas react, to errors); `test-aiark.mjs` C5 checks it.
- **Shared memory:** an action column with `config.memory` and an input
  `memory_key` reuses any row's, table's or client's answer ("Reused: found for TAG
  on DATE", no provider call, no run record). A compiled AI column remembers by its
  model and its rendered prompt (`<setting>_v1`; a key over 200 characters is stored as
  its sha256), so two rows share a paid answer only when the same question goes to the
  same model; Reoon by address (`reoon_v1`). Kept 365 days (C#24, P#27), 90 (the
  others), 30 (nothing found).
- **Settings** (`scripts/lib/enrich/settings.mjs`, read every 30 s by the worker and
  fresh by the routes; every value checked as it is read, the defaults the seeded
  values): the switches and their client lists, the model, reasoning effort and most
  searches for each AI step (`config.model_setting`), so a model is swapped with no
  deploy and no answer already held is paid for again (the cell hash holds the
  setting's name, not the model). A missing model is an error, never a fallback.
- **Keys:** `OPENAI_API_KEY` on the worker (the AI columns); `ENRICH_REOON_API_KEY`,
  the pipeline's Reoon key. In production it is the same account as the validation
  worker's `REOON_API_KEY` (chosen 2026-11-13), so the two share that account's daily
  credits; the validation worker leaves `VALIDATION_DAILY_RESERVE` (2,000 by default)
  for other users of the key, and the pipeline takes at most its own share a UTC day
  (`spend_caps.reoon_checks_per_day`, 1,500). Like the validation worker, it spends
  daily credits only (the balance read again when over a minute old): nothing is
  checked while the account holds any instant credit or has no daily credits left,
  and the cell waits (the row 'waiting'). Without the key, a final rejection already
  in `email_validations` is still reused. `ENRICH_REOON_THREADS` (4, at most 5). Once
  an hour the worker queues waiting template rows again, in pages, each only when what
  made it wait has cleared (`requeueWaitingTemplateRows()`), and the rows whose finder
  or Enrichley steps were skipped for a key it now holds (`requeueRowsForHeldKeys()`).
  The heartbeat carries `capabilities: ["company_runs", "pipeline_v2", "people_runs",
  "fit_scoring"]` (each route refuses a worker without the one it needs), the last Reoon
  balance read, the originals loaded, today's spend, which optional keys are held, and
  the fit loop's state. Since 129 it also offers `held_release` (it releases held Maps
  places) and since 130 `upload_people` (it copies an upload's no-email rows and
  releases held People rows), with `info.upload_people.found_auto` (it asks for found
  emails to be added by itself); the Clay tab and the Uploads page warn while the
  worker running lacks them.
- **The Companies tab** (`/leads/companies`, manager and up; the settings sheet is
  admin): pick a client, see what AI Ark will be asked, its company filters (read
  only: size and industries are saved on the AI Ark tab), count (one Company Search
  page per search: 0.5 credit, plus 0.1 for each further search), pull (at most
  `max_pull_size`), the 10 newest pulls with Cancel, counts by outcome that open the
  Clay section filtered (`?q=`, `?status=`, `?f=col:is.<value>`), and the listed
  companies in keyset pages (no OFFSET, no row limit). Routes under
  `src/app/api/companies/` (setup, count, runs, runs/cancel, list, settings), shared
  code in `src/lib/companies/server.ts`. The pull route refuses (409) while pulls are
  off, the worker is offline or lacks `company_runs`, the client has a pull going,
  there is no count, or the rules or filters changed since the page loaded them.
  The routes read `enrich_settings` fresh, never through the worker's 30-second
  cache, so a saved switch applies at once. In the Clay section a template table
  comes first and takes no CSV (409). Since migration 129 the client's Google Maps
  places land in its Companies (pipeline) table through its inbound URL, held until
  the client is switched on (see "Inbound URLs (migration 129)").
- ⚠ **A company can still be bought twice in one case:** AI Ark matched it to a
  client's place, but the lead database places all its offices elsewhere. It is
  then neither copied to another client of that place nor on that client's
  exclusion lists, so the other client's pull pays for it again (0.1 credit) and its
  row says "Outside the client's area". `test-companies.mjs` B5 checks that this is
  the only case.
- ⚠ **Migration 124 must be in the database before this code runs:** people runs'
  list count and the demo balance read `aiark_company_runs` too.
- ⚠ **Demo pulls' rows are enriched like any other row.** With `OPENAI_API_KEY` or
  `ENRICH_REOON_API_KEY` set locally, the worker spends real money on made-up
  `.example` companies; the tests stub `fetch` instead.
- **Tests:** stop the worker, then `node --env-file=.env.local scripts/test-companies.mjs`
  (local database only, migrations 124 and 125 applied; made-up `CPTEST_` clients, each
  with the made-up Clay originals as its own variant, and `.cptest.example` addresses,
  removed at the end; about 10 s). Nothing reaches a
  network: AI Ark answers through the demo transport, and `fetch` is replaced for
  the run (OpenAI, Reoon and the website checks answer from a stub; any other address
  is refused and counted). The routes run for real through a small TypeScript loader
  in the script, with stand-ins only for the session, the audit log and the worker's
  heartbeat; the real worker is spawned once (`ENRICH_ONCE=1`, `fetch` stubbed, no
  keys). The demo transport's Company Search takes test faults: `companyAnswers`
  (statuses to answer in order, `0` for no answer, `{ status, charge: true }` for a
  charged page whose answer is lost), `searchCap`, `noCreditHeader`,
  `badCreditHeader`, `noContent`, `ignoreLists`; `advanceOneCompanyRun({ searchCap })`
  lowers the engine's cap to match. `test-aiark.mjs` must still pass (shared code
  changed).
- **Before a push:** the two test scripts above, the type check, the linter on the
  changed files and a production build, then a scan of the added lines for client
  tags and names (read from the local `client_tags` into a scratch file outside the
  repo) and for anything shaped like a key.

### Pipeline v2 (migration 125: the original Clay columns, three tables per client)

Phases 2 and 3 of the restart run the original Clay tables' columns, compiled from
the Clay CLI's exports, instead of steps of our own. Every paid or send switch
ships **off** and covers no client until its tag is on the switch's list (D46).

- **The originals** (`enrich_originals`): the three Clay tables exactly as the Clay
  CLI exported them (Companies 68 columns, People 88, General inboxes 76). They hold
  client text (prompts, lists, examples), so they live in the database only and the
  export files stay out of git. Load them with
  `node scripts/enrich-seed-originals.mjs --companies <file> --people <file> --inboxes <file> [--variant default] [--tracks <file>] [--dry]`.
  It refuses another layout (each position's name must fit its key in
  `original-keys.mjs`; a client whose table differs stops here), records each file's
  sha256, derives the people tracks (`enrich_settings.people_tracks`, written for the
  default variant only) and refuses a phrase its cited column doesn't hold, prints
  counts and the models that differ from the settings (never a prompt, list or name),
  and never changes a setting. A client's own exports load as its variant (its tag in
  lower case, `variantName()`); every other client compiles from `default`.
- **The tables** (`ensurePipelineTables()`, `templates.mjs`, run inside the pull route's
  transaction): "Companies (pipeline)" (`companies_v2`), "General inboxes (pipeline)"
  (`inboxes_v1`, one row per general address the company row wrote) and "People
  (pipeline)" (`people_v1`). `compile-original.mjs` rewrites each `{{f_<id>}}` to the
  template's keys (`ORIGINAL_KEYS` with the template's `REFS`) and applies the
  template's changes, each an exact replacement that must match once. The template
  modules (`company-template-v2.mjs`, `inbox-template.mjs`, `people-template.mjs`) hold
  keys, which original each column comes from, our own formulas and the changes:
  never a prompt or a list. ⚠ `enrich_columns.config` is jsonb, which keeps no key
  order, so an AI column keeps Clay's answer field order in `config.answer_order` (its
  first field is the cell's display).
- **A company row:** phase 1's office and rules, C#16 and C#17 verbatim, the database
  first (`held_people`: named usable leads at the company and state; C#13 SAFE TO RUN
  reads it, and it runs whatever the people switch says), the website chain (the paid
  search only without an AI Ark domain), the first general email in Icypeas' place (a
  held inbox, else AI Ark's head-office email once Reoon approves it by G#40's rule),
  C#31 then C#32, C#34 (a named stand-in for Clay's tool: emails only) and C#36, which
  writes each address as its own inbox row, at most `company_pipeline.inboxes_per_company`
  (5). An inbox row: the database check, then G#37 to G#44 verbatim. A People row
  (written by people runs, the AI searches' write-tos and, since 130, the worker's copy
  of an upload's no-email rows; input cells only): P#4 to P#62. Its key says who wrote
  it: `aiark:<person id>`, `w:<company row id>:<writer column>` or
  `upload:<batch id>:<seq>` (`found_by` "upload", see "Upload no-email rows (migration 130)").
- **Switches** (`flagOn()`; a switched-off column is skipped "Switched off: <switch>"
  and read as empty): `company_pipeline` (pulls and counts refuse a client not on
  `company_pipeline.tags`), `people_pipeline` (`people_at_company`, C#41 to C#58, people
  runs, and since 130 the release of the client's held upload rows), `people_pipeline.ai_searches` (C#41, C#48, C#50, C#56), `people_pipeline.auto_buy`
  (Buy without a manager's click), `company_pipeline.linkedin_profile_reads` (C#50, P#27)
  and `personalisation` (P#57 to P#62, G#45 to G#50; also needs the client's own
  originals unless `shared_text_ok`). A sub-switch needs its parent on for the client.
  The question steps P#61 and G#49 wait for how Clay sends their table examples, so no
  question is written yet. Every switch ships off with an empty client list.
- **AI steps:** one setting per column in `enrich_settings.models`, every one
  `gpt-6-luna` (2026-11-13), with the web search tool for the columns whose prompts
  visit pages, `max_tool_calls` from the setting, no reasoning effort, no user
  location, and answers kept as returned ("N/A" included, as in Clay). One send per
  attempt; a cell sent twice with no answer is not sent again (a timed-out request may
  still be billed); OpenAI's billing refusals are never retried.
- **The email finders and Enrichley** (P#46 to P#54, G#41, P#13) run only while their
  key is on the worker: `FINDYMAIL_API_KEY`, `PROSPEO_API_KEY`, `ANYMAIL_FINDER_API_KEY`,
  `ENRICHLEY_API_KEY`. Without one, its steps show "Needs <KEY> (not held)", read as
  empty, and never make a row wait. Adapters: `email-vendors.mjs` (Findymail, Prospeo's
  Enrich Person and Enrichley from the vendors' public docs, cited there; Anymail
  Finder sends the original's own request, its Authorization header the key's whole
  value). ⚠ None has run live: Findymail's not-found answer and Prospeo's email
  statuses are not documented, and the first supervised run reads them. Finder emails
  reach Use Work Email with no Reoon check, as in the original.
- **Spend caps** (`enrich_spend_daily`, `spend.mjs`, the database's UTC day): the
  pipeline's Reoon share (`spend_caps.reoon_checks_per_day`, 1,500), counted in one
  statement before each check, and the OpenAI dollars per loop
  (`spend_caps.openai_usd_per_day`: pipeline $20, fit $25), counted after each answer
  from its usage at `spend_caps.openai_prices` (an unknown model at the dearest prices
  held). Past a cap the cell waits ("Today's Reoon share is used up", "Today's OpenAI
  cap for the pipeline is reached") until the next day's sweep. The email finders and
  Enrichley have daily caps of paid calls too, since migration 129
  (`spend_caps.vendor_calls_per_day`, see "Inbound URLs (migration 129)").
- **Listing** (`enrich_contacts`, `relist()` in `project-contacts.mjs`): one summary
  per inbox and People row; a company is listed when it passes the client's rules, is
  not never-contact or in error, and has a usable general or person email (approved,
  or already held), once per company and office. A listed company shows "General and
  people emails", "Has a general email", "Has people emails" or "Already in the
  database". The worker projects each row by its table's template.
- **People runs** (`scripts/lib/aiark/people-runs.mjs`, `people-requests.mjs`; tables
  `aiark_people_runs`, `aiark_people_run_companies`, `aiark_people_candidates`, all from
  125), the third kind of slice in the worker's AI Ark loop, taking turns with the AI
  Ark tab's runs and the company pulls on the one client and throttle:
  1. **Look:** People Preview by company id (1 credit a page; `ids_per_search` 50
     companies a search, `pages_per_search` 5), with the tracks' title phrases
     (`enrich_settings.people_tracks`, written by the seed script; a run refuses while it
     is missing) and the client's excluded titles. Everyone seen becomes a candidate,
     screened free in the same slice: the database (by name and company), the person's
     own place, the client's exclusions, the track, and the registry (`aiark_people`). A
     person another run bought with an email is copied free as a People row.
  2. **Pick:** one candidate per track (operations, facility and office, CEO or owner, in
     that order), with reserves up to `tries_per_track` (1); a company where anyone
     usable is already held is skipped (`skip_company_when_held`).
  3. **Buy:** with `auto_buy` off (the default) the run waits in `looked` until a manager
     clicks Buy. Export Single per pick (1 credit with an email; whether a miss is free is
     not yet seen live), the picks checked against the registry again just before, so a
     person bought since the Look is copied, never bought twice.
  4. **Settle:** a track settles on a usable email (or one waiting for Enrichley), its
     tries used, or no candidate left, with none of its People rows still being worked;
     a settled company's row is queued again (the second pass of its row).
  Brakes: `searches x pages_per_search + ceil(max_people x 1.25) + 10` credits, lost
  answers counted at full price; AI Ark's balance must stay at or above
  `people_pipeline.min_balance` (500); 3 lost Preview answers in a row stop the run, 5
  lost Export Single answers back it off; switched off for the client mid-run, it stops
  before its next paid call; one run per client. A run never touches `leads` and never
  shows on the AI Ark tab (`pullsToAdd()` reads `aiark_runs` only).
- ⚠ **The AI Ark tab and people the pipeline bought** (D43, `runs.mjs`): the tab's
  exclusion lists leave out people only a people run bought, a tab single run copies
  such a person free with the registry's email, and an export run pays for them.
  `test-aiark.mjs` has a check for it.
- **People settings** (`people_pipeline`): `enabled` and `tags` (off, []), `auto_buy` and
  `ai_searches` (off), `ids_per_search` 50, `pages_per_search` 5, `tries_per_track` 1,
  `max_people_per_run` 300, `recheck_days` 90 (a company looked at since is not eligible),
  `skip_company_when_held` true, `min_balance` 500.
- **The Companies tab, phases 2 and 3:** pills for the originals loaded, the people
  switch and today's spend against the caps; "Steps waiting for keys" (from the
  worker's heartbeat); counts by what each listed company shows, people (looked at,
  held, bought, approved, waiting for Enrichley, no email) and inboxes; the people
  panel (eligible companies, the tracks read only, the estimate, Look, the candidates,
  Buy or Cancel, the 10 newest runs); the fit panel (see "Fit scoring") with a "Fit
  review" link; the list with general emails and up to 3 people inline, the fit score
  and home-office flag (the scorer's reason on hover), and the filters "with people
  emails", "with a general email", "fit score at least" and "home office"; "All N"
  opens one company's inboxes and people (`GET /api/companies/contacts`, keyset).
  Routes (manager and up): `GET /api/companies/people/setup?tag=`, `GET` and `POST
  /api/companies/people/runs` (409 while people runs are off or the client is not on
  their list, without a `people_runs` worker, with a run going, the originals or tracks
  missing, a v1 table, the balance under `min_balance`, or no eligible company),
  `POST /api/companies/people/runs/buy` and `/cancel` `{ id }`, `GET
  /api/companies/people/runs/candidates?id=&after=` (keyset, pages of 100). The
  settings sheet (admin) edits every switch with its client list, the people and
  personalisation blocks, the twelve model settings with their most searches,
  `inboxes_per_company`, `min_balance` and the spend caps; what it doesn't show
  (memory days, prices, `fit_score`) is kept as stored.
- **Keys and environment (the enrich-worker):** `DATABASE_URL`; `OPENAI_API_KEY` (every AI
  step and the fit scorer; best from the worker's own OpenAI project with a monthly
  budget, since other services use the same variable name); `ENRICH_REOON_API_KEY` and
  `ENRICH_REOON_THREADS`; `AIARK_API_KEY`, `AIARK_RPS`; `AIARK_AUTO_ADD_URL` and
  `AIARK_AUTO_ADD_KEY` (the AI Ark tab's auto-add, and promotion's automatic rounds);
  `FIT_POLL_MS` (5000). Optional, set by the owner on the worker only (never print or
  copy their values): `FINDYMAIL_API_KEY`, `PROSPEO_API_KEY`, `ANYMAIL_FINDER_API_KEY`,
  `ENRICHLEY_API_KEY`. When one is set (the worker restarts with it), its first sweep
  queues again the rows that key's steps skipped. The web service needs
  `AIARK_AUTO_ADD_KEY` too (the Bearer of `POST /api/companies/promote/auto`).
- ⚠ **Clay's quirks are kept verbatim** (D2): `.ca` in C#26's blocklist drops every
  Canadian website, C#32 has no URL check, C#24 has no SAFE TO RUN clause, C#58 checks
  Person_2 fields, the write-tos' "||" clause skips their title filters. Each has a
  check in `test-pipeline-v2.mjs`.
- **Tests:** stop the worker, then `node --env-file=.env.local scripts/test-originals.mjs`
  (the compiler, the templates, the seed script, the pull route's refusals, 125's
  settings merges; with `CLAY_ORIGINALS_DIR=<folder>` it also compiles the real exports
  in memory, counts only) and `node --env-file=.env.local scripts/test-pipeline-v2.mjs`
  (company, inbox and People rows end to end; OpenAI, Reoon, Google's DNS, the finders
  and Enrichley stubbed, every other address refused). Both use
  `scripts/fixtures/clay-originals` (made-up exports with the originals' layout and
  logic, never the real files; rebuild with
  `node scripts/fixtures/clay-originals/fixtures.mjs --write`), loaded as each made-up
  client's own variant, so the `default` originals are never changed. Local database
  only; about 3 s together. `node --env-file=.env.local scripts/test-people.mjs` checks
  people runs on the demo transport (by company id, with and without emails, its test
  faults), the routes, the settings route's shape and the compiled People template
  (about 10 s).
- **Before a push:** stop the worker; on the local database with 125 to 127 applied run
  `test-originals.mjs`, `test-pipeline-v2.mjs`, `test-companies.mjs`, `test-people.mjs`,
  `test-fit.mjs` and `AIARK_TEST_TAG=<a local cleaning client> test-aiark.mjs`; then
  `npx tsc --noEmit`, `npx eslint`, `npx next build`; then the scans of the added lines,
  from a scratch folder outside the repo: client names (any case) and tags of 3 or more
  characters (exact case) from `client_tags`, the shorter tags checked by hand, anything
  shaped like a key, and every 40-character run of the exports' prompts, lists and
  examples. The repo is public.

### Fit scoring (migrations 126 and 127)

Phase 3: one fit score (1 to 5) per company, shared by every client, a home-office flag
and a short reason; promotion of approved pipeline emails into `leads`; a gate that
keeps companies under the threshold out of every push and export for the clients it
covers; and, for companies already in campaigns, a review list and removal by a person.
**Everything ships off:** `fit_scoring.enabled` false, `fit_rule.prompt` null (the scorer
waits for the agency's rule; no code, migration, seed or test writes one),
`promotion.promote_to_leads` false and `fit_gate.enabled` false, each with an empty client
list (scoring has no list: it scores companies, not clients). With the gate off, every
push, count and export is exactly as before (127 proves
it for every client when it is applied; `test-fit.mjs` counts before and after).

- **Tables (126):** `company_fit` (one score per company under its key: `domain`, its bare
  domain, never a free-mail, platform or directory domain, `fit_domain_exclusions`; else
  `name`, `lower(company)|lower(city)|STATE`), with its status (`scored`, `unscorable`,
  `manual`), model, rule version and inputs hash; `company_fit_keys` (every key the gate
  reads for a score: its own, its contacts' email domains, the name key promotion writes,
  a campaign lead's other key, each with `blocked` kept in step by triggers);
  `company_fit_queue` (priority 1: pushes waiting and the push-time check; 2: pipeline
  companies that pass; 3: companies in campaigns); `fit_backfill_runs`,
  `fit_review_items`, `fit_review_leads`, `fit_removal_dry_runs`. `enrich_contacts` gains
  `promote_state`, `lead_id`, `batch_id`, `promoted_at`; `enrich_companies` gains
  `fit_reason`, `fit_key_kind`, `fit_key`, `fit_scored_at` (beside 124's `fit_score` and
  `home_office`); `bison_campaign_removals` gains `reason` (`misroute` or `fit`),
  `review_item_id`, `dry_run_id` and the status `fit_held`. **127:** `push_batches` gains
  the status `scoring` and `fit_total`, `fit_scored`, `fit_cursor`, `fit_claim_token`,
  `fit_claimed_at`, `fit_released_by`.
- **Functions:** `fn_bare_domain`, `fn_fit_domain_ok`, `fn_fit_domain_key(email, website)`,
  `fn_fit_name_key(company, city, state)`, `fn_fit_gate_settings()` (security definer),
  `fn_fit_gate_applies(tag)` (the gate on, the client's type in `fit_gate.client_types`,
  its tag or `*` on `fit_gate.tags`), `fn_fit_refresh_blocked()`, `fn_queue_fit_removals`
  (126); `fn_fit_condition()`, `fn_fit_for_leads(ids)` and new bodies of
  `fn_client_eligibility_conditions` and `fn_export_leads`, which append the fit condition
  only while the gate is on (127). ⚠ 127 refuses to run when either live body differs
  from 093's or 050's (a hash of the body; its own body passes, for a re-run), and
  refuses to commit when any client's eligibility would change with the gate off.
- **The scorer** (`scripts/lib/enrich/fit-score.mjs`, the enrich-worker's fit loop, its
  own loop beside the AI Ark loop): `fit_scoring.batch_size` companies a call (25),
  `calls_in_flight` at once (2), on `models.fit_score` (gpt-6-luna, reasoning effort low),
  no tools, one send per attempt; the rule is sent verbatim with a fixed format part (the
  companies as JSON with ids, and the answer format) that says nothing about fit. The
  facts sent are fields we hold (name, domain, place, industry, AI Ark's description, size
  and type, up to 5 titles of people held). A company missing from an answer is tried
  again alone, `unscorable` after 3 tries; an unchanged inputs hash skips the call; a
  manual score is never replaced. Before each call it checks the day's fit cap
  (`spend_caps.openai_usd_per_day.fit`, $25) and after it adds the cost. Idle while scoring
  is off, the rule or the model is unset, or `OPENAI_API_KEY` is missing; a billing
  refusal stops it until scoring is switched off and on again or the worker restarts.
  Scores are copied onto the pipeline's rows (`enrich_companies`), and the Companies
  template's `fit_score` and `home_office` columns (`fit_lookup`, free, never cached) show
  the shared score in the Clay section ("N of 5", "Could not be scored", "Likely a home
  office"); before 126 is applied they stay empty.
- **Promotion** (`scripts/lib/enrich/promote.mjs`, `src/lib/companies/promote-run.ts`;
  switch `promotion.promote_to_leads` with `promotion.tags`): approved, usable, unheld
  contacts of listed companies scored at least `promotion.min_fit_score` (2) and blocked
  under no key, for a client the gate covers, with the rule and model set. A person needs
  the outcome "Approved email" and no "*" in the name (a Preview's masked last name); an
  inbox's first name must not hold "undefined". Only addresses Reoon itself approved are
  promoted (`validation_status = 'valid'`): one approved only by Enrichley, or found by a
  finder, is held back, its `add_to_database` cell says why (how such addresses are marked
  in `leads` is still to be decided). While `promotion.require_question` is on (it ships
  on), only contacts with a question. The Uploads page's engine imports them (strategy
  skip, never merged, `ON CONFLICT (email) DO NOTHING`), source "Companies (AI Ark)", in
  rounds of two batches (inboxes, then people, at most `batch_max`, 1,000, each), one
  round per client at a time. Started by a manager (`POST /api/companies/promote`) or by
  the worker (`POST /api/companies/promote/auto` with Bearer `AIARK_AUTO_ADD_KEY`; checked
  every minute, at most one round per client every 10 minutes; the path skips the session
  middleware).
  Promotion never takes an upload row (130): `projectContact()` writes no contact for
  one, and its found email goes to leads through the upload's own import instead (see
  "Upload no-email rows (migration 130)").
- **The gate** (switch `fit_gate.enabled` with `fit_gate.tags`; `threshold` 2,
  `client_types` Cleaning and Canada Cleaning, `require_scored` true). While it applies to
  a client: its eligibility gains the fit condition (counts, availability, the wizard's
  preview, the push-worker's final gate, retries, re-pushes and the validation worker);
  its pushes start in `scoring` (the push-batch route and `scripts/queue-repush.mts`) and
  the fit loop sets them `pending` once their companies are scored or unscorable; at push
  time, leads whose company has no score or no key are skipped ("company not scored yet",
  "no company key to score") and queued for scoring. While the gate is on at all: a push
  with no client tag is refused (409), the legacy `POST /api/bison/push` answers 410, and
  filtered and selected-row exports leave out bad fits (selected rows gain Fit score and
  Home office columns) unless an owner or admin asks for `includeBadFits`. A threshold or
  `require_scored` change marks `fit_gate_refresh.pending`, and the fit loop brings
  `blocked` up to date in batches of 20,000 ("Refresh pending" on the panel). An owner or
  admin can release a waiting push unscored (`POST /api/bison/push-batches/release`,
  logged); the push-time check still skips its unscored companies.
- **Companies already in campaigns:** a scoring run over every company in the Email Bison
  copy (`bison_leads`), started by an owner or admin after the estimate (companies, calls,
  dollars, days at the cap; `GET` and `POST /api/fit/scoring-run`), paged by key, 2 seconds
  between pages and no page while a push is gathering; it is also the "Re-score" after
  a rule or model change. The review list per client (`POST /api/fit/review/build`,
  `GET /api/fit/review`, `POST /api/fit/review/decide`; manager) groups the blocked
  companies by campaign (from push history and live campaign names; nurture campaigns
  never listed), with leads, sent, replied, interested and the oldest sync date; the copy
  is not re-synced first. `POST /api/fit/review/queue` (owner and admin, refused unless
  the gate covers the client) puts approved items in `bison_campaign_removals` as
  `fit_held` (never `pending`: a CHECK forbids it), leaving out repliers, interested and
  nurture leads.
- ⚠ **Removal is only by a person**, after a dry run:
  `node scripts/bison-campaign-removal-worker.mjs --reason=fit --tag=TAG --lanes=1 --dry-run`
  (reads each lead live, writes a `fit_removal_dry_runs` record, marks nothing), then
  `... --reason=fit --tag=TAG --lanes=1 --confirm=<dry run id>` (under 24 hours old,
  unused, the same client and install, its rows unchanged; each lead read live again
  before its DELETE). The live check fails closed: anything Bison's answer doesn't show
  is "cannot confirm" and skipped. `--reason` is required (the worker exits 1 without it);
  a misroute run needs `--reason=misroute` and never reads `fit_held` rows. The worker
  uses TLS only for a database that is not local.
- **Routes:** `GET /api/fit/state` (manager: the panel's status, never the rule's text);
  `GET`, `PUT /api/fit/settings` (admin: the rule and its version, the scoring switch,
  batch size, model; the only writer of `fit_rule`); `GET`, `PUT /api/fit/gate` (admin:
  logged, marks the refresh pending); `POST /api/fit/score` (admin: a manual score); the
  scoring run, review, promote and release routes above. The fit panel sits on the
  Companies tab and on `/leads/companies/review?client=TAG`; the push batches panel shows
  "N of M companies scored" and Release for a push waiting in `scoring`.
- **Settings (126):** `fit_rule` `{ prompt, version }` (null), `fit_scoring` `{ enabled,
  batch_size, calls_in_flight }`, `models.fit_score` `{ model: "gpt-6-luna",
  reasoning_effort: "low" }`, `promotion` `{ promote_to_leads, tags, min_fit_score,
  batch_max, require_question, source_label }`, `fit_gate` `{ enabled, tags, threshold,
  client_types, require_scored }`, `fit_gate_refresh` `{ pending, since }`, and the fit cap
  in `spend_caps`. The tool stand-ins in `tool-standins.mjs` (company name and phone
  number, for Clay's built-in tools in G#14, G#35, P#18 and P#29) are not used by any
  column until the owner says so.
- **Tests:** stop the worker, then `node --env-file=.env.local scripts/test-fit.mjs`
  (local database only, migrations 125 to 127 applied; made-up `FTTEST_` clients and
  `.fttest.example` domains, removed at the end; about 30 s). No network: OpenAI, Email
  Bison and Google's DNS answer from stubs, the removal worker and the re-push script run
  as child processes with a Bison stub. The rule exists only in memory; the suite checks
  that with every switch off the counts, eligibility (against 093's body), exports
  (against 050's), pushes and the AI Ark tab's auto-add list do not move.
- ⚠ **Rollout order:** 125, then 126, then 127 (run 127's read-only body check first),
  then the web push and the worker upload (its heartbeat must list `fit_scoring`). Put a
  client on `fit_gate.tags` only once the rule is set and scoring is on: until its
  companies are scored, its pushes wait in `scoring`. The gate covers a client before any
  removal or promotion for it, so a removed bad fit can't be pushed straight back.

### LinkedIn sources (migration 128)

Phase 4: each client's two Clay LinkedIn searches ("Find companies" and "Find people")
rebuilt as AI Ark searches with the source `linkedin`: LinkedIn company pulls
(`aiark_company_runs.source`) and LinkedIn people runs (`aiark_people_runs.source`), worked
by the same engine, tables and Companies template as the AI Ark ones. **Ships off:**
`enrich_settings.linkedin_sources` `{ enabled: false, tags: [], people_per_company: 13 }`.
With it off, the AI Ark tab, company pulls, people runs, pushes and exports behave as
before 128; only viewing and editing each client's LinkedIn settings works, and that
spends nothing.

- **The same for every client** (`scripts/lib/aiark/standard-filters.mjs`, `filtersFor` with
  scope `linkedin`): the standard filters of `cleaning-filters.mjs` (titles, excluded
  titles, sizes, excluded industries, company types and keywords) whatever the client's
  type. A client's saved AI Ark people filters (`client_people_filters`) replace the titles,
  sizes and industries; the standard keywords and company types always go. The AI Ark tab
  keeps its own rule (standard filters for `Cleaning` clients only): one function, two scopes.
- **Each client's own, per kind** (people, companies): places to search, places left out
  and excluded keywords in `client_linkedin_settings` (server-only, RLS on, no policy),
  in `client_targeting`'s place format. Seeded from the client's newest Clay search of each
  kind by `scripts/linkedin-seed.mjs --file <normalized.json> [--apply]` (a dry run unless
  `--apply`; the file is the Clay copy, version 3, read from outside the repo, which it
  refuses); Clay values it could not place are kept as "not placed", shown, never searched.
  The seed never writes over a person's save. Every save and seed write is logged with the
  lists before and after in `client_linkedin_settings_log` (server-only); the audit log
  gets one line of counts only, since every signed-in user can read it.
- **A client with no row** (no Clay search, and every later client) searches its rules'
  places (`client_targeting`, read live) and the shared starter keywords
  (`enrich_settings.linkedin_starter_keywords`, written by the seed, empty until then). Its
  first save on the AI Ark tab makes its own row from exactly what was shown. No row and no
  starter list: its searches are blocked.
- **Keywords sent:** the standard ones first, then the client's own, once each (case aside),
  on a company's name, industry and description, as far as AI Ark's request holds them
  (1,900 bytes and 300 values, `accountFilters`). The rest are **checked after the pull (AI
  Ark limit)**, never dropped: every keyword of the union (standard and own) is checked
  after the pull, free, before anything more is spent on a company or person or a row is
  listed. A LinkedIn
  pull or run keeps the union in `filters.linkedin.keywords` (`union`, `sent`,
  `checked_after`); the matcher is AI Ark's own whole-word match (`companyKeywordHit` in
  `client-checks.mjs`, as `hasWords`: the keyword's words, in order and side by side,
  case-insensitive, in the name, industry and description), so a short keyword never
  excludes a longer word that holds it ("pub" is not "Public Safety", "housing" is not
  "Warehousing") and a plural is another word, as in the standard list's pairs ("cleaning
  company", "cleaning companies"). Company rows: `client_exclusions` reads the pull's union through the
  row's `linkedin_run` input and a match is Excluded, naming the keyword, so nothing later
  works it; a row with no `linkedin_run` is judged exactly as before 128. People: a Look
  excludes a person whose Preview company matches, and after a Buy the person's full company
  record (with its description) is checked again, with the sheet terms, before any email
  step: a match ends the person Excluded, with no People row. The sheet's `exclude_terms` are
  not sent on LinkedIn searches; they are checked after the pull, as for every row, with
  their own matcher (`companyTermHit`: anywhere in the name and industry, whole words in the
  description), as the send gate matches them.
- **Places: never outside the sending rules.** A LinkedIn search covers only places the
  client's rules (`client_targeting.include_locations`) allow: an own place the rules cover
  (its city, state or country key) is searched; an own state or country they don't cover
  is searched as the rules' places inside it; an own city they don't cover is **not
  searched** and listed so ("not searched: outside the client's sending rules", on the AI
  Ark tab and in the run's `filters.linkedin`); places the rules leave out are left out. A
  client whose rules hold no places is not narrowed. Nothing left: the search is blocked,
  never sent without places. The stored lists never change for it: adding the places to
  the client's rules (Clients page or the onboarding sheet) brings them in. Rows are still
  judged against `client_targeting` (LinkedIn pull rows by their head office alone,
  `hq_only`; a people candidate outside the area is never bought). The narrowing is
  `narrowPlaces` in `linkedin-settings.mjs` (the resolver's `search`: `include`,
  `notSearched` with why, `replaced`); the builders send `search.include` only, and the run
  keeps `places`, `places_not_searched` and `places_replaced` in `filters.linkedin`.
- **LinkedIn company pulls** (`createCompanyRun(..., { source: "linkedin", targeting })` in
  `company-runs.mjs`, `targeting` = `linkedinTargeting(effective)`): the run's `source`
  column is `linkedin`, the bought rows' source kind `linkedin` (label `LinkedIn company pull
  (AI Ark)`), and the free registry copy takes only companies whose head office
  (`aiark_companies.hq_keys`, filled for rows bought before 128 when first read) is in the
  places searched. Every row it writes carries the inputs `hq_only` and `linkedin_run` (the
  pull's id): `client_office` judges the head office alone ("Outside (head office)" when it
  is outside the client's area, though AI Ark found the company by any office, so such a row
  is paid for) and `client_exclusions` the pull's keywords. **One row per company:** a later
  AI Ark pull that meets a LinkedIn row of the client (its free copy or a bought page) takes
  it over: both inputs cleared and the row queued again, judged from then on as an AI Ark row
  on any office. The Companies tab shows these rows' source as "LinkedIn (AI Ark)".
- **LinkedIn people runs** (by area, `scripts/lib/aiark/linkedin-people.mjs`, reached from
  `people-runs.mjs` through `peopleSourceInfo(source).look === "by_area"`, which hands it its
  own helpers so it never imports `people-runs.mjs` back):
  `createPeopleRun(..., { source: "linkedin", version })` refuses
  (409) unless `linkedin_people` is on for the client, with a run of either source going,
  on a changed version (`changed`) and with plan blockers; it needs no Companies table rows
  or tracks first. **Look:** each search paged up to `pages_per_search` (1 credit a page)
  with exclusion lists of the people this client's LinkedIn runs already looked at and the
  registry's bought people, inside the shared daily list budget (`listsMadeToday`, 45 a
  day, now counting people runs' lists); without the lists it needs, the run stops before
  paying for a page. Free screen: `no_company` (AI Ark gives no company), `outside` (the
  person's own place, or a Preview company whose offices are all outside the area),
  `excluded` (the client's terms or any LinkedIn keyword on the Preview company), held,
  bought before. Candidates keep AI Ark's order (`seq`) and no company row yet; the
  Preview's company objects are kept in `aiark_people_preview_companies` (server-only,
  removed with the run). **Pick:** at most `linkedin_sources.people_per_company` (13) a
  company, less the usable contacts already held there; people with a track phrase first,
  then AI Ark's order, every company's first person before any second; at most `max_people`
  bought (copies of people bought before with an email are free and not counted). **Buy**
  (a manager's click unless `auto_buy`): Export Single per pick after the registry is
  checked again; the full company record is checked again (terms, keywords, offices); the
  company is brought in from the registry, else the person's own company record (with its
  domain), else the Preview's object (no domain), never by a Company Search, labelled
  `LinkedIn people (AI Ark)` and judged on any office (no `hq_only`); the People row gets
  `found_by` `linkedin` and, as D13 says, the city and state of the company's office in the
  client's area (head office first). `PEOPLE_SOURCES` stays `["ai_ark"]`, so the AI searches
  never wait for a LinkedIn run; P#27 stays behind `linkedin_profile_reads` (off). Known
  limit: a company first brought in from a Preview object keeps no domain, and later picks
  at it reuse that row.
- **Versions:** a save sends back the lists' version (409 `changed` when the row, or for a
  client with no row its rules or the starter list, changed since the page loaded them); a
  LinkedIn count, pull or people run sends back the search's version (`linkedinVersion`),
  which also covers the rules and the saved AI Ark filters.
- **The AI Ark tab** (`src/components/aiark/linkedin-settings-card.tsx`, under People
  filters; routes `GET`, `POST` (preview, nothing written) and `PUT
  /api/aiark/linkedin-settings`, manager and up): per kind, where the lists came from (the
  Clay search, copied from the other kind, saved by whom, or the rules and starter list),
  the seed's flags and notes, the editable lists, the values not placed (Use a suggestion,
  or Remove), the standard filters read only, what a search would send (searches, places
  searched, not searched, keywords checked after the pull, blockers), the switch for the
  client, and the log. Edits are kept per client while the page is open.
- **The Companies tab:** a Search control (AI Ark, LinkedIn) on the pull panel and the people
  panel; LinkedIn is disabled with its reason while the switch is off for the client, the
  pipeline it needs is off, or the worker lacks the capability. Counts, pulls and runs send
  `source: "linkedin"` and `linkedinVersion`; the pulls and people runs show their source.
  Refusals are 409s with the reason: LinkedIn off or the client not on its list, company
  pulls (for a company search) or people runs (for a people search) off or the client not
  on their list, a worker without `linkedin_sources`, a pull or run of either source going
  (one of each per client), the search changed, a balance under the people runs' minimum;
  a blocked plan is a 400 for a count or pull and a 409 for a run. A LinkedIn people run
  needs no Companies table or tracks first: it brings each bought person's company in. Its
  Buy (`POST /api/companies/people/runs/buy`) is also refused (409) while LinkedIn is off for
  the client or the worker lacks `linkedin_sources`, and the worker stops a LinkedIn run
  before its next paid call once the switch is off. Switching off does not stop a company
  pull already queued or running (as for AI Ark pulls): cancel it on the tab. A LinkedIn
  candidate not bought yet is listed with its company's name from the Preview.
- **Settings:** the settings sheet (admin) edits the switch, its client list and the people
  a company (1 to 100) for LinkedIn people runs. `linkedin_sources` is optional in `PUT
  /api/companies/settings`: left out, what is stored is kept. A LinkedIn company search also
  needs company pulls on for the client (`linkedin_companies`), a people search people runs
  (`linkedin_people`). The worker's heartbeat lists `linkedin_sources` once it works both.
- **Migration 128** adds `aiark_company_runs.source` (`ai_ark` for every older pull), the
  `linkedin` people run source and source kind, nullable `company_row_id` and `company_id` on
  `aiark_people_candidates` with the `no_company` verdict and `seq`,
  `aiark_people_preview_companies`, `aiark_companies.hq_keys` (GIN index), the
  `enrich_contacts` LinkedIn URL index, `client_linkedin_settings` and its log, and the
  settings rows `linkedin_sources` (off) and `linkedin_starter_keywords` (empty).
- ⚠ **Migration 128 must be in the database before this code runs:** the pulls list reads
  `aiark_company_runs.source`, every company pull writes it, and the worker's people runs
  and copy steps read the new columns. Order: 125, 126, 127, then 128.
- **Tests:** stop the worker, then `LITEST_TMP=<folder outside the repo> node --env-file=.env.local
  scripts/test-linkedin.mjs` (local database only; made-up `LITEST_` clients, invented places
  and keywords, removed at the end; every setting put back). No network: AI Ark answers
  through the demo transport and `fetch` refuses every address. Part R runs the routes for
  real through the TypeScript loader. The six suites of phases 2 and 3 must still pass.

### Inbound URLs (migration 129)

Each client has its own address for the GMaps Scraper app's chunks: `POST
/api/enrich/intake/<token>`. The token decides the client. A chunk's Google Maps
places land in the client's Companies (pipeline) table as **held** rows: nothing runs
or is spent on them until the client is on the Company pulls switch. Decided with the
owner on 2026-11-18. Nothing changed in the scraper app (gmaps-UI) or the external
scraper: a URL is pasted on the client's card there like a Clay URL.

- **The URLs** (`enrich_inbound_urls`, server-only: RLS on, no policy): one live URL per
  client and target (`companies` only; People and General inboxes get one when
  something sends to them). The token is 32 random bytes made on the server
  (`makeToken()`, base64url, 43 characters), kept in plain text as `api_tokens` are, so
  the Clay tab can show the URL again. The full URL is `NEXT_PUBLIC_SITE_URL` +
  `/api/enrich/intake/` + the token, never the request's origin; without the site
  address no URL is made or shown. A rotation revokes the old URL at once (it answers
  404) and carries its accepted names over. Each row also keeps the last delivery
  (`last_used_at`, written at most once a minute), the last Test (time and the name it
  sent, if any), the last refusal (time and why, in plain words) and `refused_name`,
  the client name of the last chunk refused for its name. Shared helpers:
  `src/lib/enrich/inbound.ts` (token, URL, mask, the name check, the answer texts).
- **Receiving** (`src/app/api/enrich/intake/[token]/route.ts`; the session
  middleware lets every path under `/api/enrich/intake` through): the token's shape
  first (a malformed token is refused before any query), then the size (5 MB, by
  Content-Length and by the bytes read), then one of 3 intake slots in the web
  process (a 2 s wait), then one transaction with a 15 s statement timeout: the URL by
  token, the JSON, the Test, the chunk's shape, the name check, the client's Companies
  (pipeline) table (made or brought up to date under a per-client lock when it is
  missing or older than the Maps inputs), the places, then `last_used_at`. Every place of every task and result becomes one row
  (`placeInputs`, `scripts/lib/enrich/maps-place.mjs`): name, place id, website,
  domain, phone, the Maps category as `industry`, one office (the place itself, as
  the head office), `source` "Google Maps", the client tag, and the inputs
  `actual_city`, `actual_state` (the place's own) and `call_city`, `call_state`,
  `call_category` (what the scrape searched). The row key is `maps:` and the place id,
  so a place is stored once per client and never meets an `aiark:` row; a place with
  no place id is skipped and counted. A blank search city, state or category is fine.
  Each chunk is one `enrich_sources` row of kind `maps`, with `inbound_url_id`; its
  repeat key is the scraper app's `<task>-<chunk>` taskId (or taskId and chunkIndex,
  or taskId), so a chunk delivered twice adds nothing. The 200 comes only after the
  commit. Receiving writes no audit line.
- **The answers**, chosen for what the scraper app does with each (gmaps-UI
  `src/lib/clay-pool.ts`): it counts a try for every failed answer except 429, parks
  a chunk after 10 tries, disables a URL for good on 404 or 410, and keeps an answer's
  first 200 characters on the card.

  | Status | When | What the scraper app does |
  |---|---|---|
  | 200 | stored now, or a delivery seen before (`duplicate_delivery`); or a Test | deletes its copy; Test passes |
  | 404 | a malformed, unknown or revoked token | disables the URL for good |
  | 413 | a body over 5 MB | one try used |
  | 422 | not JSON, or no `postbackData.tasks` list | one try used |
  | 429 | no slot within 2 s, or a passing database problem (`isPassingDbError`) | no try used, sent again later |
  | 429 | the chunk's client name does not fit the URL, or there is none | no try used: the chunk waits |
  | 429 | the client's Companies table can't be made (originals missing, a companies_v1 table) | no try used: the chunk waits |
  | 500 | anything else (logged without the token, a URL or the body) | one try used |

  Never 410. No answer holds the scraper app's "full" phrases, the chunk's client name
  or the token. A 429 keeps the client's queue at the head in the scraper app, so a URL
  on the wrong card holds that client's chunks until the card is fixed or a manager
  accepts the name.
- **The name check** (`checkName`): every chunk carries the scraper app's own name for
  the client (`extra.client`), which is not always the tag. It fits when it is the tag,
  a name a manager accepted for the URL (at most 20), or when one of its parts is the
  tag (split on `&`, `/` and the word AND, as the targeting sync splits a sheet tag).
  No name, or no `extra` block, does not fit.
- **The Test**: the scraper app's Test sends `{ test: true }` and shows only the status.
  The intake answers 200 with the client tag, the table and whether the client is
  switched on, notes the time (and a client name, if one is ever sent), and makes
  nothing. So after Test, check that the Clay tab's Inbound URLs show it on this
  client's row: on another client's row, the URL is on the wrong card; on no row, the
  URL is wrong, even though the card said the Test passed (the scraper app follows
  redirects).
- **Held rows** (`enrich_rows.run_status = 'held'`): the worker claims queued rows
  only, so a held row is never worked and costs nothing. Only the worker releases
  held rows (to queued), and only in `companies_v2` tables whose client
  `fn_enrich_company_switch_on(tag)` says is on: the `company_pipeline` switch read
  exactly as `flagOn("company_pipeline", tag)` reads it (each listed tag trimmed and
  upper-cased, as `settingsFrom()` keeps them). The guard
  `trg_enrich_rows_release_guard` refuses any other change from held while the client
  is off (SQLSTATE 23514), whatever code sends it, so every statement that requeues
  rows in bulk must leave held rows out itself: the Run route does, and says how many
  it left alone (`skippedHeld`). Changing other columns of a held row, and deleting
  it, are allowed. A place already in the table is a duplicate and stays as it is.
  Switching a client off later: new places arrive held again, and rows already
  released finish, as AI Ark rows do.
  Since 130 the guard reads the switch of the row's own table: a held row of a People
  (pipeline) table (an upload's no-email row) is released only under `people_pipeline`,
  and a held row of any other table that is not a Companies (pipeline) table never (see
  "Upload no-email rows (migration 130)"). `releaseHeldRows()` still releases Companies
  (pipeline) rows only.
- **The Clay tab** (manager and up): "Inbound URLs" in the header opens a sheet
  (`src/components/clay/inbound-urls.tsx`) listing every client, Active first, with
  its URL masked (the address, the path and the token's first 6 characters), Eye and
  Copy, Rotate and Revoke behind a confirm, when it was made, last delivered to and
  last tested, its last refusal with "Accept this name" when a chunk's name did not
  fit, the accepted names, "Switched off: places wait, held" or "Switched on" with
  the held count, a warning when the client has no targeting rules (its places stop
  at the area check), and Create, which also makes the client's three pipeline tables
  (free, as a first pull does). Above a Companies (pipeline) table a strip shows the
  URL, the held places and why, and the 10 newest Maps deliveries. "Held" is a row
  status pill, and a held row's steps show "Held". Routes: `GET
  /api/enrich/inbound[?tag=]` and `POST /api/enrich/inbound { action, tag, name? }`
  with `create`, `rotate`, `revoke`, `reveal`, `accept_name`, `drop_name`. Each change
  writes one audit line naming the tag, never a token or a URL.
- **The daily caps of the email finders and Enrichley** (decision 9):
  `enrich_settings.spend_caps.vendor_calls_per_day` `{ findymail, prospeo,
  anymail_finder, enrichley }`, whole paid calls a day, 0 to 100,000, counted in
  `enrich_spend_daily` under `<vendor>_calls`. **0, the default, means not set: no
  call is made and those steps wait**, as when today's Reoon share is used up, until
  an admin sets a number. Edited on the Companies tab's settings sheet (admin), under
  the spend caps; optional in `PUT /api/companies/settings` (left out, the stored caps
  are kept; sent, all four are checked, 400 with the reason), one audit line per
  change ("Findymail calls a day 0 to 200").
- **The release** (`scripts/lib/enrich/held.mjs`, `releaseHeldRows()`): the worker's
  60-second block runs it right after the stale sweep. Held rows become queued in
  pages of 5,000, oldest first, at most 20 pages a minute, and only in `companies_v2`
  tables whose client `fn_enrich_company_switch_on()` says is on. The database reads
  the switch live, so the worker's 30-second settings play no part. A client switched
  off just before its page makes the guard refuse that page (23514): the worker
  catches it and releases nothing more for that table this round. Paused tables are
  released too, and the claim still skips them. Before 129 is applied the worker logs
  once that held rows are not released. The worker reports `held_release` in its
  heartbeat's `info.capabilities`; the Clay tab warns while the worker running lacks
  it.
- ⚠ **`UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` can update
  more than n rows.** The planner may run the pick again for each row, and rows the
  statement already updated are skipped as locked, so the page keeps growing (a page
  of 2 released 3 rows locally). `held.mjs` picks its page in a `MATERIALIZED` CTE
  instead.
- **The caps on each keyed step** (`email-vendors.mjs`, `spend.mjs`
  `takeVendorCall()`): right before each request to Findymail, Prospeo, Anymail Finder
  or Enrichley, one call is counted in `enrich_spend_daily` (`findymail_calls`,
  `prospeo_calls`, `anymail_finder_calls`, `enrichley_calls`) in one statement, so two
  workers can't both take the last one. The originals' "Anymail Finder validate"
  steps (P#49, P#54) are Enrichley calls and count against Enrichley's cap. A step that
  sends nothing (no input, no key, an answer already remembered, the lost-send
  refusal) counts nothing. With no cap set the cell waits, noted "No daily cap is set
  for Findymail yet (Companies settings)" (the same for the other three); with
  today's calls used up, "Today's Findymail calls are used up" (Prospeo, Anymail
  Finder alike) or "Today's Enrichley checks are used up". The hourly sweep
  (`requeueWaitingTemplateRows`) knows these notes: it queues such a row again once
  the vendor's calls have room (the next UTC day, or a higher cap), never while the cap
  is 0. The heartbeat's `spend_today` carries the four counts beside Reoon and OpenAI.
  `test-pipeline-v2`'s `HIGH_CAPS` sets the four caps high, since its section E calls
  the vendors' stand-ins.
- **Maps rows in the steps:** the office check (`clientOffice`, T#17, which reads
  `place_id`) judges a Maps row by the place itself, its one office, and its notes
  speak of "the place" and "Google Maps gave ..."; `hq_only` is ignored on a Maps row.
  The Companies tab shows its source as "Google Maps" (`project-company.mjs`).
- **Removed:** the shared-key route `POST /api/enrich/intake` (Bearer
  `ENRICH_INTAKE_KEY`, never set, never called) and `scripts/test-enrich-intake.mjs`.
  `intakeKeyStatus()` stays: it is the `AIARK_AUTO_ADD_KEY` check of `POST
  /api/aiark/add/auto` and `POST /api/companies/promote/auto`. A hand-seeded Companies
  table takes CSV imports only.
- **Per client, by hand:** create the URL on the Clay tab; add it on the client's card
  in the scraper app and click Test; check the Test shows on this client's row; then
  delete the client's Clay URLs from the card at once (while both are there, the
  scraper app splits the client's chunks between them, it never copies). Places then
  arrive held. To work them, switch the client on (Company pulls on, the client on its
  list).
- ⚠ **A chunk that still reaches 10 failed tries** (an outage of several minutes, or a
  bug) stays parked in the scraper app's buffer, and nothing on its screens puts it
  back: that takes one SQL statement in the scraper app's database, with the owner's
  OK. Never set the external scraper's fallback `WEBHOOK_URL` to an inbound URL: its
  chunks come with `extra: null` and are refused. A scraper app name that holds two
  tags fits either client's URL.
- ⚠ **"Maps companies get the company side only"** holds only while the client is off
  people runs with AI searches: C#48 needs no AI Ark people data, so with those
  switches on a Maps row also runs C#48 to C#51, as an AI Ark row does.
- ⚠ **Migration 129 must be in the database before this code runs:** the Clay tab and
  the table route read `enrich_inbound_urls` and `enrich_sources.inbound_url_id`, and
  the intake writes held rows.
- **Tests:** stop the worker, then `node --env-file=.env.local scripts/test-inbound.mjs`
  (local database only, 129 applied; made-up `IBTEST_A` to `IBTEST_C` clients with the
  made-up Clay originals as their own variants, `.ibtest.example` places, removed at
  the end; the settings it changes are put back; about 25 s, one check waits out the
  15 s statement timeout). No network: `fetch` refuses every address. The routes run
  for real through the TypeScript loader (`routeLoader`), whose `call()` passes a
  route's `params` and gives the request `text()`. The worker's side: `node
  --env-file=.env.local scripts/test-held-caps.mjs` (local database only, 129 applied;
  made-up `IBTEST_HA` and `IBTEST_HB` clients; the worker is not started for it: its
  claim runs in a transaction that is rolled back, the release and the sweeps as
  exported). It covers held rows, the guard, the switch check against `flagOn()`, the
  release, Maps rows in the template and the vendor caps. It writes the
  `company_pipeline` switch and today's spend for the run and puts both back, and it
  refuses to run while any row is held or any client is on the switch's list.
  `test-companies.mjs` lost its E1 (the shared-key intake), so it counts 167; the seven
  suites of phases 2 to 4 must still pass.

### Upload no-email rows (migration 130)

An upload's rows with no usable email still go to its "No-email rows" download,
exactly as before. Since 130 they also go into the People (pipeline) table of the
upload's client as **held** rows: nothing is worked or spent on them until the client
is on People runs (the `people_pipeline` switch, with the client on its list). The
email finders then look for each person's email within the daily vendor caps, and a
person whose Outcome is "Approved email" is added to `leads` through the Uploads page's
own import, with the upload's rule for duplicates, its tags and its fields. So a found
person becomes the lead the upload would have made had the row had that email. Built
on 2026-11-18 at the owner's go ("yes and build"); the decisions below still wait for
the owner's OK. Everything ships off.

- **What an upload records** (`src/app/api/uploads/process/route.ts`, and
  `scripts/import-csv-folder.mts`): `upload_batches.add_tags`, the tags the import
  stamps exactly as `importRows` gets them (trimmed; `[]` for none), and
  `override_fields`, the replace rule's fields (text only). Both are null on every batch
  made before 130: unknown, and never guessed from a file name. Nothing else about an
  upload changed. `source_batch_id` links a round of found emails to its upload.
- **Which client** (`routeTagOf()`, `scripts/lib/enrich/upload-people.mjs`): the one tag
  of the upload that is a client tag (`client_tags`, compared trimmed and upper case).
  No client tag, or two, means not sent (`no_tag`, `not_client`, `several`). Only an
  upload counts: `batch_type 'leads'`, no `source_label`, a field mapping (an Email
  Bison export keeps no rows back), a final status and kept-back rows.
- **`upload_people`** (server-only: RLS on, no policy): one row per upload with
  kept-back rows. `state` is `moving` (rows being copied from `next_seq` on; `reason`
  says what the copy waits for: `originals_missing`, `retired_v1`), `moved`, or
  `not_sent` (with its reason, and no client). `table_id` and `source_id` are set null
  when the People table is deleted; `sent_by` is the admin who sent it by hand.
- **The move, the People release and the template gates** (the worker; the detail
  follows). The worker decides each new upload, then copies its
  kept-back rows into the client's People table in chunks of 1,000 (at most 5 a
  minute), each a held row keyed `upload:<batch id>:<seq>` with `found_by` "upload",
  `stage` "uploaded", the Source "Upload: <file>" and the person, company and place
  cells of the row (`uploadPeopleInputs()`), and one `enrich_sources` row of kind
  `upload` per upload (`external_id` the batch id). A row an admin deletes is not put
  back. Held People rows of clients on People runs are released at most 2,000 of a
  table queued, running or waiting at once. 130's guard reads the switch of the row's
  own table: `companies_v2` under `company_pipeline` (as in 129), `people_v1` under
  `people_pipeline`, any other table never. On an upload row the finders and Enrichley
  run only for a person inside the client's area and clear of its rules, Current
  Employer and the personalisation steps never run, Reoon has no email to check, and
  P#51 (Findymail by LinkedIn) never runs (its original needs the company row lookup).
  The worker reports `upload_people` in its heartbeat's capabilities, and
  `info.upload_people.found_auto` when it asks for found emails by itself.

- **The move** (`moveUploadRows()`, `scripts/lib/enrich/upload-move.mjs`), in the
  worker's 60-second block right after the Maps release:
  - **Deciding:** at most 50 finished uploads a round, oldest first. An upload is
    decided when it is `leads`, has no `source_label`, has a field mapping, records
    `add_tags`, is `complete` or `error`, has kept-back rows and has no `upload_people`
    row. With exactly one client tag among its tags (`routeTagOf()`) it becomes
    `moving`; otherwise `not_sent` with `no_tag`, `not_client` or `several`. The worker
    never decides an upload made before 130 (no `add_tags`).
  - **Copying:** the kept-back rows go in as held rows, one chunk of 1,000 a
    transaction, at most 5 chunks a minute, each row with the `uploadPeopleInputs()`
    cells that are input columns of the table. One source row per upload and table
    (kind `upload`, "Upload: <file>", `external_id` the batch id) counts the rows
    received, created and duplicates. `next_seq` marks how far the copy got: a
    deleted row is never put back, and a repeat inserts nothing.
  - **The client's tables** are made or brought up to date once a round per client,
    under the per-client lock and in a savepoint, before any of its rows go in, so the
    upload gates are in the People table's columns before an upload row is worked.
    When they can't be made, the upload stays `moving` with `originals_missing` or
    `retired_v1` and is tried again after 10 minutes, and the other uploads go on. A
    chunk that fails for any other reason is logged and tried again after 10 minutes.
  - It queues nothing, pays nothing and writes no leads.
- **The People release** (`releaseHeldPeopleRows()`, `scripts/lib/enrich/held.mjs`),
  right after the move: People (pipeline) tables whose client
  `fn_enrich_people_switch_on()` says is on, the oldest held row first, pages of 500,
  at most 20 pages a minute, and only while the table has fewer than 2,000 rows
  queued, running or waiting (every row of the table counts, AI Ark rows too). A
  client switched off mid-round makes the guard refuse (23514); the release catches it
  and leaves that table for the round. `releaseHeldRows()` is unchanged and never
  takes a People row.
- **The upload gates** (`people-template.mjs`): a new change on a run condition,
  `{ in: "run_if", and: <clause> }` (`applyChanges()`), makes it `(<original>) &&
  <clause>`, so the clause can't bind to the last term of an original whose top level
  has `||`. Reoon, Enrichley and the six finder steps (`UPLOAD_AREA_GATED`) run on an
  upload row only for a person inside the client's area and clear of its rules; P#27,
  P#58, P#60 and P#61 (`UPLOAD_NEVER`) never run on one. On every other row the
  clause is true without reading the area or the rules: an AI Ark row works as before
  (test-upload-enrich W3). An upload row's `in_database` looks for likely addresses at
  its own website's domain. P#51 never runs on an upload row: its original run
  condition needs the company row lookup.
- **On an upload row:** a person outside the area, excluded by the rules, or with no
  state the check can place ends with no paid call (a row of placeholders only has no
  place, so it ends "Outside the client's area"). A person nobody finds ends "No email
  yet" and stays in the table. `projectContact()` writes nothing for an upload row, so
  the Companies tab and promotion never take one. lead_lookup's notes now say "This
  person came with no usable email" on every row (they named AI Ark before).
- **The hand-off, worker side** (`scripts/lib/enrich/upload-found.mjs`): with
  `AIARK_AUTO_ADD_URL` and `AIARK_AUTO_ADD_KEY` (32 characters or more) set, every
  minute the worker runs `FOUND_DUE_SQL` (uploads with an approved person still to add
  and no live round), then POSTs `{batch}` to the URL's origin +
  `/api/uploads/found/auto`, the key as a Bearer token, waiting at most 30 s. It asks
  at most once per upload every 10 minutes, whatever the answer, so a failed request
  is asked again 10 minutes later. The web's `add_to_database` cell is the once-only
  mark per person. One log line per request; off while either variable is missing.
- **On a database without 130** the worker logs once for each of its three new steps
  (the move, the People release, the found-email timer) and the Maps release goes on.

- **Adding the found emails** (`src/lib/uploads/found.ts`, `src/lib/uploads/found-run.ts`):
  one round of an upload at a time (an advisory lock on the upload). A round takes the
  upload's People rows whose Outcome is "Approved email" and whose `add_to_database`
  cell is not settled (`FOUND_TAKE_SQL`, at most 1,000, oldest first; a row being worked
  is left for later), and makes one `upload_batches` row for them: `source_label`
  "Emails found", `source_batch_id` the upload, the upload's `duplicate_strategy`, its
  tags (the client's added when missing: `foundTags()`) and `override_fields`, its header
  row and mapping, file name "Emails found · <file> · <time> UTC". The answer comes as
  soon as that batch exists; the import runs after it (Next `after()`) through
  `importRows()`, the mail provider lookup on as for uploads. Each row is the kept-back
  row with the found address (lower case) in every email column and the cells that
  described the missing address blank (`validation_status`, `is_bounced`, `esp`,
  `email_type`), so the address gets its own mail provider and email type and no
  validation status. An upload that mapped no email column gets an "Email" column added.
  Then each person's cell is settled (3 tries):

  | Cell | Shows | Means |
  |---|---|---|
  | running `{batch_id}` | Adding… | a round has them |
  | done `{added: true, lead_id, batch_id}` | Added | the round made the lead: its 'created' history line is not older than the round |
  | done `{added: false, reason: "lead", lead_id, batch_id}` | Already in the database | a lead with the address was there; the upload's rule applied to it |
  | error `{batch_id}` | Not added | the import could not store them; only the button takes them again |
  | done `{added: false, reason: "address", batch_id: null}` | Not added | the found address is not one the import stores; never taken again |
  | done `{added: false, reason: "row", batch_id: null}` | Not added | their kept-back row is gone; never taken again |

  "Mine" reads the 'created' history line, not `created_at`: an upload may map a Created
  Date column. A cell that is done is never written over, and only cells still running
  for the round are settled, so a round that finished meanwhile keeps its words.
- **Who starts a round:** the worker (`POST /api/uploads/found/auto {batch}`, Bearer
  `AIARK_AUTO_ADD_KEY`, outside the session middleware; at most one request an upload
  every 10 minutes, and only while `AIARK_AUTO_ADD_URL` and `AIARK_AUTO_ADD_KEY` are set
  on it), or the Uploads page's "Add the found emails now" (`POST /api/uploads/people
  {action: "add_found", batch}`, manager and up, a manager only for their own upload),
  which also takes again the people a round could not store. 409 while a round of the
  upload is live, or when its rows are in no People table (the reason in plain words);
  404 for no such upload. One audit line `upload_found`
  (`<tag>: upload <id>, <n> to add, <m> settled, round <id>`; "(automatic)" for the
  worker's, and none for a worker's round that found nobody). No address is ever logged.
  ⚠ Setting the two variables also starts the automatic add of finished AI Ark pulls.
- **Retries:** a round still `processing` after 3 hours is dead: the next round of the
  upload marks it an error ("Stalled", as the upload route's sweep does), and takes its
  people again, except those whose lead it had already made, which are settled as added
  by it. A dead web process loses nothing: the same rows under the same rule add and
  merge nothing the second time.
- **Sending by hand** (`POST /api/uploads/people {action: "send", batch, tag}`, admin and
  up): an upload made before 130, or one marked not sent, goes to the People table of the
  client the admin picks (a client tag only, compared trimmed and upper case). Never one
  already sent, never one whose tags the worker has still to read, never a file name.
  It writes `upload_people` (`moving`, `sent_by`) and the worker copies the rows like
  any other upload's, held. One audit line `upload_people_send` naming the upload and
  the tag. The found emails of an upload made before 130 get the client's tag only.
- **Where the rows stand** (`GET /api/uploads/people?batch=<id>` or `?batches=<id>,…`,
  at most 20; manager and up, a manager only their own uploads, as the no-email download;
  read only): per upload the state (`moving`, `moved`, `not_sent`, `undecided` (the
  worker reads its tags within a minute), `before` (made before 130), `processing`,
  `none`), the reason and the same in plain words, the client, its People table, whether
  it is on People runs and has targeting rules, the rows kept back and copied, the
  People rows by status (held, queued, running, waiting, done, error), found (an approved
  email, or an add result), not found (worked to the end with none), added, already in
  the database, being added, not added, and the 5 newest rounds; and the worker: online,
  whether it copies upload rows, whether it adds found emails by itself. The counts go
  through the upload's own rows (`enrich_rows_source_status_idx`), the approved-email
  cells (`enrich_cells_approved_idx`) and the table's `add_to_database` cells, never a
  whole table.
- **The Uploads page** (admin, as before): once an upload is final, its progress panel
  has a People box (where the rows went or why not, the counts, the client's switch, a
  warning when the client has no targeting rules (its rows stop at the area check, so
  no finder runs) or the worker can't copy them, the rounds, "Add the found emails now"
  and Send). The "No email" tile and the box under it say the rows also go to the
  client's People table and that the download still has every one; the download links
  are as before. The history leaves the rounds out (no `source_batch_id`, and no
  "Emails found" label, which a round keeps when its upload is deleted; AI Ark adds and
  promotions stay listed) and gains a "People table" column with Send for an upload that
  was not sent. It reads `GET /api/uploads/people` every 2.5 s while something moves and
  every 10 s otherwise, only while the page is visible.
- **The Clay tab:** a held row of a People (pipeline) table says "Held: a no-email row
  of an upload. It is worked once its client is on People runs." (the cell route returns
  the table's `template`, and a held People row's title is the name and company it was
  given). Above a People (pipeline) table a strip lists the uploads that fed it (the
  table route's `uploads`: its 10 newest upload sources, each with its rows still held;
  `deliveries` stay Maps only), the held rows and why, and a warning while the worker
  running lacks `upload_people`. The table picker reads "from people runs and uploads".
  The Companies tab's settings: the People runs hint says the switch also starts the
  no-email rows of the clients' uploads.
- **The decisions** (the owner's OK pending): (1) an upload goes to a People table only
  with exactly one client tag among its tags; (2) none, or two, is not sent, and the page
  says why; (3) finders and Enrichley run on an upload row only inside the client's area
  and clear of its rules (a row with no state the check can place is not searched);
  (4) no OpenAI step runs on an upload row; (5) only "Approved email" goes to leads, and
  the found address gets no validation status (the alternative: mark it valid); (6) the
  found address is not checked against never contact or the Bison copy before the import,
  as an uploaded row isn't; (7) the import uses the upload's own rule, tags and fields,
  with the address cells blank; (8) at most 2,000 rows of a People table in work or
  waiting at once; (9) found emails are added by themselves only with the auto-add
  variables set, else by the button; (10) rows already released finish if the client is
  switched off; (11) one set of daily caps for everything; (12) every kept-back row goes
  in; (13) a person in two uploads is two People rows (answers already paid for are
  reused); (14) a row deleted from the People table is not put back; (15) earlier
  uploads go in only by an admin's Send, never from a file name.
- **Per client, by hand:** after 130 and the deploy, set the four vendor caps (see
  "Inbound URLs (migration 129)"), upload a list with the client's tag, check that the
  Uploads page and the Clay tab show its rows held, then put the client on People runs.
  Press "Add the found emails now", or set the auto-add variables.
- ⚠ **Migration 130 must be in the database before this code runs:** the upload route
  and the folder script write `add_tags` and `override_fields` (an upload fails
  without them), the Uploads page's history filters on `source_batch_id`, and the
  routes read `upload_people`.
- **Tests:** stop the worker, then `node --env-file=.env.local
  scripts/test-upload-enrich-web.mjs` (local database only, 129 and 130 applied; made-up
  `UPTEST_C` and `UPTEST_D` clients, users, uploads and People tables, people under
  `.upweb.uptest.example`, all removed at the end; it turns `people_pipeline` on for
  `UPTEST_C` for one check and puts it back, and refuses to run while any row is held or
  any client is on that switch's list; about 1 s). It runs the upload route (the record
  of the tags, with a stand-in Supabase client), both found-email routes and the Uploads
  page's route through the real import: rounds under merge and skip compared field for
  field with a direct upload of the row with the email typed in, a second round taking
  nobody, a dead round, the button taking again those not stored, Send, the counts, the
  manager rule, the Clay tab's routes, and the history's query through the local
  Supabase API. No network: fetch refuses every address but the local Supabase API, DNS
  is refused, and the mail provider lookup is a stub. The worker side:
  `scripts/test-upload-enrich.mjs` (87 checks: the move, the release per template,
  upload rows worked against stubbed vendors, the hand-off against stand-ins, the
  worker's wiring; made-up `UPTEST_A` and `UPTEST_B`, uploads named `upenrich-…`,
  people under `.uptest.example`; it refuses to run while any row is held, any client
  is on either switch's list, or any upload is in `upload_people` or waiting to be
  decided, and it needs the local `default` originals, as test-people part C does).
  The shared module, 130's objects, the found-email SQL and the same import path:
  `scripts/test-upload-people.mjs` (54 checks). Run the three one at a time: the two
  worker-side suites remove leads under `.uptest.example`, which takes in the web
  suite's.

## Known issues / TODO

- [ ] Reoon bulk endpoint batch size — confirm exact cap from docs before tuning `VALIDATION_BATCH_SIZE`
- [ ] "(general)" field location — voice memo wasn't precise; current detection covers first_name/last_name/job_title. Adjust regex when a sample Email Bison export is available.
- [ ] Email Bison webhook for live bounces — out of scope for v1; CSV upload + bounce-worker polling
- [ ] Initial validation cost — first export of imported leads will validate from scratch. Recommend opt-in per pull rather than bulk run; cap with `VALIDATION_DAILY_BUDGET` if needed.
- [ ] `loadGeo()` (`scripts/lib/aiark/geo.mjs`) sends its three queries at once on one client (`Promise.all`). pg 8 only warns ("already executing a query"), but pg 9 will refuse it, and the AI Ark and Companies routes pass it a transaction's client. Run them one after another before upgrading pg.

### Open after the 2026-08-17 incident

- [x] ~~Loop `categorize-worker` on `fn_sync_companies(p_propagate_limit)`~~ — **DONE.**
      `syncCompanies()` now loops on `SELECT * FROM fn_sync_companies($1)` [50000],
      accumulating until `leads_propagated < LIMIT` (80-round safety cap). ⚠ The
      `worker_locks` lease is **still held** — the worker stays parked until the AI
      tier is green-lit (see Category enrichment).
- [x] ~~Refresh the bounce classifier test corpus~~ — **DONE.** The three
      policy-block NDRs now expect `policy`; `--test-classifier` is 30/30.
- [ ] **Make the 4 module-scope Supabase clients lazy** so no worker service can be
      broken again by a web-route env var (see Railway services above).
- [ ] **Fix `infer-company-locations.mjs` C1 OFFSET-over-GROUP-BY pagination** (keyset
      instead), add a LIMIT to the cohort query, and stop setting `statement_timeout = 0`.
      Lower priority now: the Bison mirror resolved most of the no-location cohort.
- [ ] **`/api/dashboard/refresh` has no auth of its own** and is behind the session
      middleware, so the GitHub Action that curls it gets a 307 to `/login` and silently
      no-ops (`curl --fail` treats a redirect as success). The dashboard is presumably
      kept fresh by pg_cron instead — confirm, then either add token auth or delete the workflow.
- [ ] **`/api/leads/filter` uses the service-role key with no in-route auth check** —
      protected only by middleware position, unlike the other 32 routes. Harden it.

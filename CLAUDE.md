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

## Email validation flow (NEW)

**Trigger:** at export time, NOT at filter preview.

**Logic** (in `/api/exports/stream`):

1. Pre-pass query: `SELECT id, email FROM leads WHERE <filters> AND (validation_status IS NULL OR validated_at < now() - INTERVAL '45 days')`
2. Create a `validation_jobs` row, then call `validateLeads(ids)` in batches of ~100 with `p-limit` concurrency of 5
3. Reoon in POWER mode (real SMTP). Findymail (verify endpoint ONLY, never the finder) is the second layer, called only when Reoon's native status is catch_all / risky / unknown / error — a clean valid/invalid spends no Findymail credit. Findymail verified:true→valid, false→invalid. Genuine double-outage rows are left unwritten to retry. Persist status/provider/validated_at/validation_response
4. Client polls `/api/exports/validation-progress?jobId=...` for the iOS-sheet progress modal
5. Once validation completes, run the existing streaming export — the RPC enforces `validation_status IN ('valid','catch_all') AND is_bounced = false` (admin can override `is_bounced` filter via `includeBounced` flag)

**Env vars:** `REOON_API_KEY`, `FINDEMAIL_API_KEY`, `REOON_MODE` (default `power`), `REOON_CONCURRENCY` (default 12), `VALIDATION_BATCH_SIZE` (default 100), `VALIDATION_REVALIDATE_DAYS` (default 45). Power mode is ~3s/email (SMTP); concurrency hides it.

**Cost guard:** validation is gated by `if (process.env.REOON_API_KEY)`. If no key is set the pre-pass no-ops and export proceeds without validation (dev convenience).

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
| `fn_filter_leads_count(p_filters)` | Total run concurrently with the rows query (086) | 15s, then estimate |
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
src/app/api/leads/filter/route.ts          — Main filter API (fn_filter_leads_v2 RPC)
src/app/api/exports/stream/route.ts        — Streaming CSV export + validation pre-pass
src/app/api/exports/process/route.ts       — Background export (for selected IDs)
src/app/api/dashboard/refresh/route.ts     — Dashboard refresh
src/app/api/admin/invite/route.ts          — User invite (uses NEXT_PUBLIC_SITE_URL)
src/app/api/uploads/process/route.ts       — CSV lead import
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
environment `production` (`80ed7802-75ee-453c-a8d6-b92e233de258`). All **8**
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
| `bison-sync` | cron | `0 3 */3 * *` | `npm run sync-bison-leads -- --incremental` |

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
  hold: the `OTHERS` handler re-ran the same `COUNT` **unbounded**. Both now
  degrade to the planner estimate and never retry unbounded. `skipCount` rides
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
demand, instead of waiting for the 6-hourly `client-sync` cron — which reads a
*different* workbook (`CLIENTS_SHEET_ID` → `Sheet1`) that has drifted.

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

## Known issues / TODO

- [ ] Reoon bulk endpoint batch size — confirm exact cap from docs before tuning `VALIDATION_BATCH_SIZE`
- [ ] "(general)" field location — voice memo wasn't precise; current detection covers first_name/last_name/job_title. Adjust regex when a sample Email Bison export is available.
- [ ] Email Bison webhook for live bounces — out of scope for v1; CSV upload + bounce-worker polling
- [ ] Initial validation cost — first export of imported leads will validate from scratch. Recommend opt-in per pull rather than bulk run; cap with `VALIDATION_DAILY_BUDGET` if needed.

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

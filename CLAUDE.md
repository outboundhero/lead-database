# CLAUDE.md — OutboundHero Database
> Load this file at the start of every Claude Code / Cursor session.
> This is the single source of truth for architecture, conventions, and decisions.
> Forked from `opslab-database-clean copy` (Renaissance Database) on 2026-06-04.

---

## Project Overview

**What it is:** Internal B2B lead database for OutboundHero. Apollo-style filter + export UI that retains contact data, validates emails on a 45-day TTL, and feeds validated/non-bounced leads into Email Bison campaigns.

**Why we forked Renaissance:** OutboundHero needs the same filtering/export engine but with three new capabilities that don't exist in Renaissance: (a) email-type classification (general vs personal/decision-maker), (b) Reoon→FindEmail email validation with cached re-validation, (c) bounce tracking + auto-exclusion. Plus an iOS-style visual refresh of the entire UI.

**Current state:** Phase 0 (bootstrap + rebrand) complete. Schema additions, validation layer, email-type detection, iOS re-skin, and bounce flow in progress. Target scale: 15–20M contacts.

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
3. For each batch: Reoon first. On error / inconclusive, fall back to FindEmail per-email. Persist `validation_status`, `validation_provider`, `validated_at`, `validation_response`
4. Client polls `/api/exports/validation-progress?jobId=...` for the iOS-sheet progress modal
5. Once validation completes, run the existing streaming export — the RPC enforces `validation_status IN ('valid','catch_all') AND is_bounced = false` (admin can override `is_bounced` filter via `includeBounced` flag)

**Env vars:** `REOON_API_KEY`, `FINDEMAIL_API_KEY`, `VALIDATION_BATCH_SIZE` (default 100), `VALIDATION_REVALIDATE_DAYS` (default 45).

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

---

## RPC functions

| Function | Purpose | Timeout |
|---|---|---|
| `fn_filter_leads_v2(p_filters, p_sort_by, p_sort_dir, p_limit, p_offset)` | Main filter — extended for `email_type`, `exclude_keywords`, silent `is_bounced` filter (migration 032) | 120s |
| `fn_export_leads(p_filters, p_cursor, p_limit, p_skip)` | Export — enforces `validation_status IN ('valid','catch_all') AND is_bounced = false` (migration 033) | 300s |
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
EMAILBISON_KEYS               # JSON: instance domain -> token (3 separate Bison installs)
EMAILBISON_API_KEY            # single/default Bison token (fallback for any instance)
EMAILBISON_BASE_URL           # optional; default instance domain
OPENAI_API_KEY                # gpt-4o-mini — categorize worker AI tier (preferred)
ANTHROPIC_API_KEY             # claude-haiku-4-5 — alternative categorize provider
CATEGORIZE_PROVIDER           # optional force: openai | anthropic
CATEGORIZE_MODEL              # optional model override
```

---

## Storage & compute

Target scale: 15–20M leads. Reference: Renaissance ran 6M leads on Supabase XL (16 GB RAM, 4 CPU). Recommended starting tier for OutboundHero: **Supabase 2XL** (~$1099/mo), with headroom to upgrade to 4XL once data passes ~12M rows.

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
```

---

## Bounce classification (NEW)

Bounces are split into contactable vs dead by `scripts/bounce-worker.mjs`, a
**separate Railway cron service in the same project** (same repo; start command
`npm run bounce-worker`, schedule `*/15 * * * *`).

For every lead with `bounces > 0` not yet checked (or re-bounced since last
check), the worker calls Email Bison
`GET /api/leads/{email}/replies?folder=bounced` (the endpoint accepts the
lead's email as the id) and classifies the NDR text:

| `bounce_type` | Meaning | Effect |
|---|---|---|
| `sender` | Our sending inbox's fault (auth/quota/reputation/rate-limit) | `is_bounced` flipped back to **false** — lead re-enters filters + exports |
| `hard` | Recipient invalid / blocked / policy rejection | stays excluded, never exported |
| `unknown` | No bounce reply found or ambiguous | treated like hard, reviewable |

Columns (migration 047): `bounce_type`, `bounce_reason` (NDR snippet),
`bounce_checked_at`. The leads-page "Bounced" chip ("Include undeliverable",
visible to all roles) un-hides hard/unknown leads in the table; exports always
exclude them.

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
cached company categories to uncategorized leads. Expected ≤50k companies.
Legacy `UNIQUE(domain)` was dropped (many businesses share gmail.com).

**Fallback worker** `scripts/categorize-worker.mjs` (Railway cron,
`npm run categorize-worker`), per still-uncategorized COMPANY:

| Tier | Method | Cost |
|---|---|---|
| 0 | Taxonomy keywords vs company name (weight 3) / domain / sample question; single strict winner | free |
| 1 | AI: `gpt-4o-mini` (default, via `OPENAI_API_KEY`) or `claude-haiku-4-5` (via `ANTHROPIC_API_KEY`), 25 companies/call, strict JSON schema (category enum) | ~$0.00004/company (4o-mini) |

Taxonomy lives in `lead_categories` (seed: `npm run seed-categories file.json
[--replace]`). Manual assignments never overwritten; `Other` = nothing fits.
Filter chips: Category + Subcategory (include/exclude, mirror ESP; migrations
048/049 wired them into `fn_filter_leads_v2` + `fn_export_leads` +
`fn_refresh_filter_cache`).

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

⚠️ **Untested against live Bison** — the `/api/leads` response field carrying
the new id is read defensively (data.id / data.data.id / id); confirm with a
real key + test campaign before production. Cross-workspace routing rules
(item 6) are pending the client call.

## Known issues / TODO

- [ ] Reoon bulk endpoint batch size — confirm exact cap from docs before tuning `VALIDATION_BATCH_SIZE`
- [ ] "(general)" field location — voice memo wasn't precise; current detection covers first_name/last_name/job_title. Adjust regex when a sample Email Bison export is available.
- [ ] Email Bison webhook for live bounces — out of scope for v1; CSV upload + bounce-worker polling
- [ ] Initial validation cost — first export of imported leads will validate from scratch. Recommend opt-in per pull rather than bulk run; cap with `VALIDATION_DAILY_BUDGET` if needed.

# CLAUDE.md — Renaissance Database
> Load this file at the start of every Claude Code / Cursor session.
> This is the single source of truth for architecture, conventions, and decisions.
> Last updated: 2026-03-28

---

## Project Overview

**What it is:** Internal B2B lead management system — Apollo-style UI for filtering, exporting, and managing 6M+ leads.
**Current state:** Production. 6M+ leads in Supabase PostgreSQL. Deployed on Railway.
**Stack:** Next.js 16 (App Router) + Supabase (PostgreSQL + Auth + Storage) + TypeScript

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16 (App Router, Turbopack) | React Server Components where possible |
| UI Library | shadcn/ui + Tailwind | Dark/light mode via next-themes |
| Database | Supabase PostgreSQL (XL: 16GB RAM, 4 CPU) | RLS enabled, pg_cron for scheduled jobs |
| Auth | Supabase Auth | Email invites, password login, forgot password |
| Storage | Supabase Storage | Export files (5GB bucket limit) |
| Deployment | Railway | `database-renaissance-production.up.railway.app` |
| Filtering | Server-side RPC (`fn_filter_leads_v2`) | JSONB filters, 120s timeout |
| Exports | Streaming CSV (`/api/exports/stream`) | Direct browser download, no storage needed |

---

## Database Schema

### Core Tables

```sql
-- leads (primary table — 6M+ rows, ~5 GB)
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  job_title TEXT,                    -- raw, may be JSON array: ["CEO","Founder"]
  seniority TEXT,                    -- 'c_suite'|'vp'|'manager'|'director'
  company_name TEXT,
  company_size BIGINT,              -- raw employee count (was TEXT, converted to BIGINT)
  annual_revenue NUMERIC,           -- raw revenue number (was TEXT, converted to NUMERIC)
  general_industry TEXT,            -- from MongoDB 'industry' field (153 clean values)
  specific_industry TEXT,           -- from Clay 'Specific Industry'
  phone TEXT,
  website TEXT,
  person_linkedin TEXT,
  company_linkedin TEXT,
  source TEXT,                      -- 'Apollo'|'Sales Nav'|'ZoomInfo'|'Zoom Info'|'Google Maps'|etc.
  status TEXT,
  esp TEXT,                         -- 'Google'|'Outlook'|'Microsoft'|'Mimecast'|etc.
  keywords TEXT,
  city TEXT,
  state TEXT,
  country TEXT,                     -- normalized: 'United States', 'United Kingdom', etc.
  domain TEXT,                      -- extracted from email
  company_overview TEXT,
  technologies TEXT[],              -- array: ['Gmail','WordPress','Cloudflare']
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- lead_job_titles (junction table for fast job title filtering)
-- Trigger: trg_sync_lead_job_titles auto-syncs on INSERT/UPDATE of job_title
CREATE TABLE lead_job_titles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL
);

-- filter_options_cache (pre-computed dropdown values)
CREATE TABLE filter_options_cache (
  col_name TEXT PRIMARY KEY,
  options TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dashboard_snapshots (pre-aggregated — refreshed by pg_cron daily at 2 AM UTC)
CREATE TABLE dashboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL UNIQUE,
  total_leads BIGINT,
  total_job_titles INT,
  total_general_industries INT,
  total_specific_industries INT,
  leads_by_job_title JSONB,
  leads_by_general_industry JSONB,
  leads_by_company_size JSONB,
  leads_over_time JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- export_jobs (tracks both background and stream exports)
CREATE TABLE export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES auth.users(id),
  filters_used JSONB,
  selected_ids UUID[],
  column_selection TEXT[],
  row_count INT,
  status TEXT DEFAULT 'pending',    -- 'pending'|'processing'|'complete'|'error'|'cancelled'
  file_path TEXT,
  duration_seconds INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- api_tokens + api_logs (for external API access)
CREATE TABLE api_tokens (...);
CREATE TABLE api_logs (...);

-- audit_logs (admin actions)
CREATE TABLE audit_logs (...);

-- user_profiles (extends Supabase auth.users)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',   -- 'owner'|'admin'|'manager'|'viewer'
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- upload_batches, lead_history, filter_presets (supporting tables)
```

### Dropped Columns (no longer exist)
- `raw_data JSONB` — dropped to save 3 GB
- `job_title_normalized TEXT` — was always empty, dropped

### Current Indexes

```sql
-- Active indexes on leads (as of 2026-03-28)
leads_pkey                    -- UUID primary key
leads_email_key               -- UNIQUE on email
idx_leads_created_at          -- B-tree on created_at
idx_leads_source              -- B-tree on source
idx_leads_source_industry     -- Composite: source + general_industry
idx_leads_esp                 -- B-tree on esp
idx_leads_esp_source          -- Composite: esp + source
idx_leads_created_source      -- Composite: created_at + source
idx_leads_general_industry    -- B-tree on general_industry
idx_leads_general_industry_lower -- Functional: LOWER(general_industry)
idx_leads_specific_industry   -- B-tree on specific_industry
idx_leads_company_size        -- B-tree on company_size (BIGINT)
idx_leads_annual_revenue      -- B-tree on annual_revenue (NUMERIC)
idx_leads_seniority           -- B-tree on seniority
idx_leads_country             -- B-tree on country
idx_leads_country_state       -- Composite: country + state
idx_leads_state               -- B-tree on state
idx_leads_first_name          -- B-tree on first_name
idx_leads_company_name        -- B-tree on company_name

-- Junction table indexes
idx_ljt_title                 -- B-tree on title
idx_ljt_lead_id               -- B-tree on lead_id
```

### Key RPC Functions

| Function | Purpose | Timeout |
|---|---|---|
| `fn_filter_leads_v2(p_filters, p_sort_by, p_sort_dir, p_limit, p_offset)` | Main filter query — returns JSONB with data + totalCount | 120s |
| `fn_export_leads(p_filters, p_cursor, p_limit, p_skip)` | Export query with cursor pagination | 300s |
| `fn_dashboard_stats()` | Full GROUP BY stats for dashboard | 300s |
| `fn_refresh_filter_cache()` | Repopulates filter_options_cache | 300s |
| `fn_refresh_dashboard_cron()` | Cron wrapper: calls fn_dashboard_stats + ANALYZE | 300s |
| `fn_handle_company_size(p_filters)` | Helper: builds company size SQL (buckets + custom range) | — |
| `fn_unknown_lead_stats()` | Returns null/empty counts per field | 300s |
| `distinct_values(col_name)` | Reads from filter_options_cache | — |
| `leads_count_estimate()` | Fast count from pg_class | — |

### Cron Jobs

| Schedule | Function | Purpose |
|---|---|---|
| `0 2 * * *` (2 AM UTC daily) | `fn_refresh_dashboard_cron()` | Refresh dashboard + ANALYZE |

### Triggers

| Trigger | Table | Function | Purpose |
|---|---|---|---|
| `trg_sync_lead_job_titles` | leads (AFTER INSERT/UPDATE OF job_title) | `fn_sync_lead_job_titles()` | Auto-sync junction table |
| `trg_merge_esp` | filter_options_cache (BEFORE INSERT/UPDATE) | `fn_merge_esp_cache()` | Merge Microsoft + Outlook |

---

## Data Sources & Field Mapping

### Original Import (leads.json — MongoDB BSON export)

| JSON Field | Leads Column | Notes |
|---|---|---|
| `email` | `email` | Trimmed + lowercased |
| `first_name` | `first_name` | Direct |
| `last_name` | `last_name` | Direct |
| `job_title` | `job_title` | Some are JSON arrays |
| `seniority` | `seniority` | Direct |
| `company_name` | `company_name` | Direct |
| `company_size.$numberInt` / `num_employees` | `company_size` | Stored as BIGINT |
| `annual_revenue` | `annual_revenue` | Stored as NUMERIC |
| `industry` | `general_industry` | 153 clean values |
| `Specific_Industry` | `specific_industry` | Direct |
| `email_service_provider` | `esp` | Direct |
| `phone_number` | `phone` | Direct |
| `website` | `website` | Direct |
| `source` | `source` | Direct |
| `city` / `location.city` | `city` | Flat first, then nested |
| `state` / `location.state` | `state` | Flat first, then nested |
| `country` / `location.country` | `country` | Normalized on import |
| `company_description` | `company_overview` | Direct |
| `technologies` | `technologies` | Array |

### Clay Enriched Data (pending merge)

- 411 CSV files in `~/Downloads/Clay Enriched leads export/`
- Merged + deduplicated to `~/Downloads/clay_deduped.csv` (4,433,015 unique emails, 6.9 GB)
- Merge strategy: fill blanks only, never overwrite existing good data
- Protected fields (keep Supabase): general_industry, seniority, source, website, domain
- Clay wins on: first_name, last_name, job_title, company_name, annual_revenue, specific_industry, phone, esp, country, state, city, company_description

---

## Architecture

### Filter Flow
```
User clicks filter → FilterBar → debounce 300ms → POST /api/leads/filter
→ supabaseAdmin.rpc("fn_filter_leads_v2", { p_filters, p_sort_by, ... })
→ RPC builds dynamic SQL with WHERE conditions
→ Returns JSONB { data: [...leads], totalCount: N }
```

### Export Flow (Streaming)
```
User clicks Export → POST /api/exports/stream
→ Stream CSV directly to browser (no storage)
→ 10K rows per batch via fn_export_leads RPC
→ Browser shows download progress
→ Log entry created in export_jobs table
```

### Dashboard Flow
```
User visits Dashboard → reads from dashboard_snapshots table (cached)
User clicks Refresh → POST /api/dashboard/refresh
→ Calls fn_dashboard_stats() RPC (full GROUP BY queries)
→ Updates dashboard_snapshots for today
→ Cron job auto-refreshes daily at 2 AM UTC
```

### Invite Flow
```
Admin clicks "Add User" → enters email + role (+ optional password)
→ POST /api/admin/invite
→ If password: creates user directly (no email)
→ If no password: supabase.auth.admin.inviteUserByEmail()
→ Email template (hardcoded in Supabase) sends link to Railway URL
→ User clicks link → /auth/callback → /accept-invite → sets name + password
```

---

## Filter Options

All filter dropdowns are **dynamic** from `filter_options_cache` table, except:
- **Company Size** — hardcoded buckets: `1-10 | 11-50 | 51-200 | 201-500 | 501-1000 | 1001-5000 | 5000+` + custom min/max range
- **Revenue** — hardcoded buckets: `<$1M | $1M-$10M | $10M-$50M | $50M-$100M | $100M-$500M | $500M+`

ESP filter merges "Microsoft" and "Outlook" into one "Microsoft / Outlook" option in the UI.

---

## Performance

| Metric | Value |
|---|---|
| Total leads | 6,017,328 |
| Table size | ~5 GB (after VACUUM FULL) |
| Index size | ~1.1 GB |
| Supabase plan | XL (16 GB RAM, 4 CPU) |
| Shared buffers | 4 GB |
| Statement timeout | 120s (authenticated/anon roles) |
| Filter query speed | <1s for most filters |
| Export speed | ~5K rows/s streaming |
| Dashboard refresh | ~30s (full GROUP BY on 6M rows) |

### Key Optimizations Done
1. Junction table for job titles (200x faster than ILIKE on JSON arrays)
2. Dropped unused indexes (freed 1.5 GB cache space)
3. Dropped raw_data column (freed 3 GB)
4. VACUUM FULL (reclaimed 5 GB)
5. Functional index on LOWER(general_industry)
6. Server-side sort only on indexed columns
7. Count estimation via pg_class for unfiltered queries
8. Filter cache for dropdown values (no live DISTINCT on 6M rows)

---

## Environment Variables (Railway)

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
NEXT_PUBLIC_SITE_URL=https://database-renaissance-production.up.railway.app
```

---

## Permission Roles

| Role | Permissions |
|---|---|
| `owner` | Everything + bulk delete + user management |
| `admin` | Everything in manager + user management + bulk delete |
| `manager` | View + filter + export + dashboard |
| `viewer` | Filter and view leads only |

---

## Naming Conventions

- **Database:** snake_case for all tables and columns
- **TypeScript:** camelCase for variables/functions, PascalCase for components/types
- **API routes:** `/api/leads/filter`, `/api/exports/stream`, `/api/admin/invite`
- **Migrations:** `001_create_leads.sql` (sequential)
- **RPC functions:** prefix with `fn_` e.g. `fn_filter_leads_v2`

---

## Key Files

```
src/app/api/leads/filter/route.ts      — Main filter API (calls fn_filter_leads_v2 RPC)
src/app/api/exports/stream/route.ts    — Streaming CSV export
src/app/api/exports/process/route.ts   — Background export (for selected IDs)
src/app/api/dashboard/refresh/route.ts — Dashboard refresh (calls fn_dashboard_stats)
src/app/api/admin/invite/route.ts      — User invite (hardcoded Railway URL)
src/app/api/admin/bulk-delete/route.ts — Bulk delete with safety caps
src/app/auth/callback/route.ts         — Auth callback (uses x-forwarded-host for Railway)
src/components/filters/filter-bar.tsx   — Filter chip UI with dynamic dropdowns
src/components/leads/lead-columns.tsx   — Table column definitions with sort
src/components/leads/lead-table.tsx     — TanStack table with client-side sort
src/lib/filters/query-builder.ts       — PostgREST query builder (fallback, mostly unused)
src/lib/filters/constants.ts           — Company size/revenue buckets, seniority labels
src/lib/db/pool.ts                     — Direct pg Pool (for Railway→Supabase if needed)
src/types/filters.ts                   — FilterState, IncludeExclude, RangeFilter types
src/types/database.ts                  — Lead, ExportJob, DashboardSnapshot types
scripts/import-leads.mjs               — Original BSON→JSON lead import
scripts/update-leads.mjs               — Update general_industry + technologies from JSON
scripts/merge-clay-leads.mjs           — Merge Clay enriched CSVs (fill blanks only)
```

---

## Known Issues / TODO

- [ ] Invite email links may still point to localhost if Supabase caches old redirectTo — fix pending Supabase support response
- [ ] Export merge step (background export) loads all parts into memory — can crash on large exports. Use streaming export instead.
- [ ] Clay enriched data merge pending (4.4M leads in clay_deduped.csv ready to upload)
- [ ] Option C: map industry_category → nearest of 153 industry values for leads without general_industry

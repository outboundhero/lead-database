# New-Client Setup Guide

> **This folder** is a clean snapshot of the codebase at commit `15d14a7`
> (2026-05-08) plus a backfill of database objects that were created directly
> in Supabase (`migrations/027_supplementary_functions.sql`). Use it as the
> starting point for a brand-new client deployment.
>
> Run through the phases in order. Skipping ahead breaks things.

---

## Phase 0 — Prerequisites

You need accounts/access to:
- **Supabase** — for the database (auth, storage, Postgres)
- **Railway** — for hosting the Next.js app (or alternative: Vercel, Fly.io, etc.)
- **A domain registrar** — for the new client's domain
- **Node.js 20+** locally (for testing builds and running data-import scripts)
- **psql** locally (for migrations and DB tuning; comes with Postgres install)

Decide ahead of time:
- New client's app domain (e.g. `crm.acmecorp.com`)
- Supabase region (pick one close to your users / Railway region)
- Railway region (same answer as above)
- Expected data volume (drives Supabase compute size — see Phase 4)

---

## Phase 1 — Rename / sanitize the codebase

The repo was built for one client (Renaissance Database). Strip identifying details.

### 1.1 Find-and-replace hardcoded URLs

Two files have the **old client's Railway URL hardcoded as fallback**:

- `src/app/auth/callback/route.ts` line 13
- `src/app/api/admin/invite/route.ts` line 45

Both contain: `"https://database-renaissance-production.up.railway.app"`

Replace with the new client's domain (e.g. `https://crm.acmecorp.com`). Even though they're env-var-guarded fallbacks, leaving the old URL is a footgun — if `NEXT_PUBLIC_SITE_URL` is ever unset, auth links silently break.

### 1.2 Rewrite `CLAUDE.md`

The current `CLAUDE.md` is entirely Renaissance-specific (data sources, performance numbers, etc.). Either delete it or rewrite for the new client. Stale CLAUDE.md = future Claude/Cursor sessions making decisions on the wrong context.

### 1.3 Rewrite `README.md`

Same — generic-ize or replace with new-client-specific intro.

### 1.4 Update `package.json`

Change the `"name"` field if you want a different project name.

### 1.5 Initialize a fresh git repo (optional but recommended)

```bash
cd /path/to/this/folder
git init
git add .
git commit -m "Initial commit (based on opslab-database snapshot)"
# Then push to a new GitHub repo for the new client
```

---

## Phase 2 — Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Set:
   - **Name** — anything (e.g. `acme-leads-db`)
   - **DB Password** — strong, save it
   - **Region** — match Railway region
   - **Pricing Plan** — start on Free or Pro, upgrade compute when data lands (Phase 4)
3. Wait ~2 minutes for provisioning
4. From the dashboard, collect:
   - **Project URL** (Settings → API → URL) → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (keep secret — never client-side)
   - **Connection string (Transaction-mode pooler, IPv4)** → `DATABASE_URL`. Looks like:
     `postgresql://postgres.xxxxx:PASSWORD@aws-X-REGION.pooler.supabase.com:6543/postgres`

   ⚠️ Use the **IPv4 pooler URL**. The direct `db.xxxxx.supabase.co:5432` URL is IPv6-only and will fail from many environments.

---

## Phase 3 — Run database migrations

Run all 27 migration files in order against the new Supabase project. The order matters — later migrations reference tables/functions from earlier ones.

### 3.1 Via psql (recommended for the initial bulk run)

```bash
cd supabase/migrations
for f in $(ls *.sql | sort); do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

### 3.2 Notes about specific migrations

- **`034_*` and similar** — none in this clean base. The clean version stops at `026`, plus the supplementary `027`.
- **`027_supplementary_functions.sql`** — captures `fn_dashboard_stats`, `search_column_values`, `fn_refresh_top_job_titles`, `dashboard_top_job_titles`. **Must run last** (depends on tables from `007`, `015`, `021`).
- The supplementary file ends with `SELECT fn_refresh_top_job_titles();` — this is fine; it's a no-op on an empty `lead_job_titles`.

### 3.3 Verify

```sql
-- Should return ~20+ tables
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';

-- Should return the 4 backfilled objects
SELECT proname FROM pg_proc
WHERE proname IN ('fn_dashboard_stats','search_column_values','fn_refresh_top_job_titles');
SELECT * FROM dashboard_top_job_titles;
```

---

## Phase 4 — Database tuning (NOT in migrations)

Two settings + compute sizing — apply manually based on data volume.

### 4.1 work_mem and random_page_cost

Defaults are conservative. For analytic / filter workloads:

```sql
ALTER DATABASE postgres SET work_mem = '64MB';
ALTER DATABASE postgres SET random_page_cost = 1.1;
```

`work_mem = 64MB` keeps sorts/joins in RAM. `random_page_cost = 1.1` (vs default 4) tells the planner SSD is cheap, encouraging index scans.

These settings require a reconnect to take effect. Restart any active Railway deployment after applying.

### 4.2 Compute size

| Total rows in `leads` | Recommended Supabase plan |
|---|---|
| < 1M | Free / Small |
| 1M – 5M | Small / Medium |
| 5M – 15M | Large / XL |
| 15M – 30M | 2XL |
| 30M+ | 4XL or higher |

Upgrade before importing data, not after — re-balancing post-upgrade takes hours.

### 4.3 Storage bucket

Migration `012` creates the `exports` bucket. Verify under Supabase → Storage. If missing, create it manually (private, no public access).

---

## Phase 5 — Supabase Auth configuration

These are dashboard-only settings, not in migrations.

### 5.1 Auth → URL Configuration

- **Site URL** → `https://NEW-DOMAIN.com` (the new client's app domain)
- **Redirect URLs** (allowlist) → add `https://NEW-DOMAIN.com/**` and `http://localhost:3000/**` (for local dev)

### 5.2 Auth → Email Templates

Default Supabase emails are usable but generic. Customize at least:
- **Invite** template (sent when admins invite new users)
- **Confirm signup**
- **Reset password**

Replace `{{ .ConfirmationURL }}` etc. with branded copy. Default templates redirect to `localhost`; check the **"redirect to"** value points to your production site URL.

### 5.3 Custom SMTP (optional but recommended for production)

Supabase's default SMTP has low limits and unbranded `From:`. Configure your own (SendGrid, Resend, Postmark, AWS SES) under Auth → SMTP Settings.

### 5.4 First admin user

The app's role system (`owner` | `admin` | `manager` | `viewer`) lives in `user_profiles`. After the first user signs up, manually promote them:

```sql
UPDATE user_profiles SET role = 'owner' WHERE email = 'first.user@acmecorp.com';
```

---

## Phase 6 — Deploy to Railway

### 6.1 Connect repo

1. railway.app → New Project → Deploy from GitHub
2. Pick the new client's repo (the one you `git init`'d in Phase 1.5)
3. Railway auto-detects Next.js

### 6.2 Set environment variables

In Railway → Variables tab:

```
NEXT_PUBLIC_SUPABASE_URL=https://XXXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   ← keep secret
DATABASE_URL=postgresql://postgres.XXXXX:PASS@aws-X-REGION.pooler.supabase.com:6543/postgres
NEXT_PUBLIC_SITE_URL=https://NEW-DOMAIN.com
```

### 6.3 Set region

Settings → Region. Match Supabase region for lowest latency.

### 6.4 Custom domain

Settings → Domains → Add Custom Domain. Set up CNAME/A records per Railway's instructions. Wait for SSL provisioning (5–30 min).

### 6.5 First deploy

Push a commit (or trigger redeploy). Verify build succeeds. Visit the deployed URL.

---

## Phase 7 — Load initial data

The `scripts/` folder has data-loading utilities (`import-leads.mjs`, etc.). Look inside before running — they may have:
- Hardcoded file paths from the original project
- Assumptions about source-file format
- Old Supabase credentials

Recommended order:
1. Import leads (in batches; large imports should chunk to avoid pool exhaustion)
2. After import, run:
   ```sql
   ANALYZE leads;                       -- refresh planner stats
   SELECT fn_refresh_filter_cache();    -- populate filter dropdown values
   SELECT fn_refresh_top_job_titles();  -- populate dashboard job-titles cache
   SELECT fn_dashboard_stats();         -- generate first dashboard snapshot
   ```
3. Verify dashboard and filter dropdowns are populated in the UI.

---

## Phase 8 — pg_cron (scheduled jobs)

The original project ran a daily dashboard refresh via pg_cron. Migrations don't necessarily set this up. After Phase 7, schedule:

```sql
-- Enable pg_cron extension (Supabase → Database → Extensions)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Daily dashboard refresh at 2 AM UTC
SELECT cron.schedule(
  'refresh-dashboard-stats',
  '0 2 * * *',
  $$SELECT fn_dashboard_stats();$$
);

-- Daily job-titles cache refresh at 1 AM UTC (runs before dashboard)
SELECT cron.schedule(
  'refresh-top-job-titles',
  '0 1 * * *',
  $$SELECT fn_refresh_top_job_titles();$$
);

-- Verify
SELECT jobname, schedule, command FROM cron.job;
```

---

## Phase 9 — Smoke test

Visit the deployed app and verify each surface end-to-end:

- [ ] Login flow works (sign-up → email → click link → land in app)
- [ ] Leads grid loads
- [ ] Each filter chip opens and shows options (NOT empty)
- [ ] Searching in Industry / Country / etc. returns results
- [ ] Filter actually narrows results
- [ ] Export button → small CSV downloads correctly
- [ ] Range export (e.g. 500K → 600K) works
- [ ] Dashboard page loads with stats
- [ ] Refresh button on Dashboard works
- [ ] Admin → Invite User → email sends → invite link works

If **anything fails silently in dashboard or filter search**, it's likely another un-migrated object we haven't captured. Check the API route's error in browser DevTools / Railway logs, find the missing function/table, and add it to a new `028_more_supplementary.sql`.

---

## Known gotchas (don't get caught by these)

1. **Migration drift is the recurring trap.** The repo's `supabase/migrations/` is NOT guaranteed to fully describe the database — objects created in the Supabase SQL editor never made it into files. `027_supplementary_functions.sql` backfills the 4 we encountered, but more may exist. Smoke-test rigorously after each major data load.

2. **Don't create schema directly in the SQL editor going forward.** Every change for the new client = a new migration file in `supabase/migrations/`, committed to git. Otherwise you'll be writing another supplementary file in 3 months.

3. **The IPv4 pooler URL matters.** The direct `db.xxxxx.supabase.co` URL is IPv6-only on Supabase Pro+; Railway and many local machines can't reach it. Always use the Transaction-mode pooler URL on port 6543 for `DATABASE_URL`.

4. **`SUPABASE_SERVICE_ROLE_KEY` is god mode.** Never expose it client-side. The codebase uses it only in API routes (server-side). Don't add it to any `NEXT_PUBLIC_*` var.

5. **Supabase Auth caches redirect URLs.** If you change Site URL or Redirect URLs and invites still send the old link, wait 5–10 min and resend. Some configs need a project restart.

6. **`CREATE INDEX CONCURRENTLY` can't run in a transaction.** Don't add `CREATE INDEX CONCURRENTLY` to a regular migration file (Supabase's editor wraps everything in a transaction). Apply those via direct `psql` only.

7. **Large `UPDATE`s on `leads` need batching.** The default 120s statement timeout kills updates touching ~100K+ rows. Use a chunked `DO $$ LOOP ... LIMIT 10000 ... COMMIT ... END $$` block.

---

## Files of interest in this folder

| Path | Purpose |
|---|---|
| `src/app/api/exports/stream/route.ts` | Streaming CSV export endpoint |
| `src/app/api/dashboard/refresh/route.ts` | Dashboard stats refresh API |
| `src/app/api/admin/invite/route.ts` | User invite API (has hardcoded fallback URL — see 1.1) |
| `src/app/auth/callback/route.ts` | Auth callback (has hardcoded fallback URL — see 1.1) |
| `src/components/filters/filter-bar.tsx` | Main filter chip UI |
| `src/lib/db/pool.ts` | Direct pg pool (bypasses Supabase HTTP gateway timeouts) |
| `supabase/migrations/001_create_leads.sql` | Core leads table schema |
| `supabase/migrations/027_supplementary_functions.sql` | Backfilled un-migrated objects |
| `scripts/import-leads.mjs` | Bulk lead import utility |

---

## When you're done

You should have:
- A new GitHub repo with the new client's name
- A new Supabase project with full schema + tuning + auth configured
- A new Railway deployment on the new client's domain
- Cron jobs scheduled
- Data loaded
- Smoke test passing

If something here is unclear or incomplete, fix this doc as you go so the next client setup is smoother.

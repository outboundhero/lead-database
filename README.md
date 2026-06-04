# OutboundHero Database

Internal lead database for OutboundHero — filter, validate, and export B2B contacts for Email Bison campaigns. Forked from the Renaissance Database codebase and extended with email-type classification, Reoon→FindEmail validation (45-day TTL), bounce tracking, and keyword exclusion. iOS-style UI.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- Supabase (PostgreSQL + Auth + Storage)
- shadcn/ui re-skinned to an iOS aesthetic
- Email validation: Reoon (primary) → FindEmail (fallback)

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase + validation keys
npm run dev
```

Open <http://localhost:3000>.

## Required env vars

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
NEXT_PUBLIC_SITE_URL
REOON_API_KEY
FINDEMAIL_API_KEY
```

## Docs

- `CLAUDE.md` — architecture, conventions, decisions (load at session start)
- `SETUP.md` — full setup runbook (Supabase project, migrations, deploy)

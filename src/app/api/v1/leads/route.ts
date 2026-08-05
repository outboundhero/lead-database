import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { validateApiToken } from "@/lib/api/validate-token";
import { logApiRequest } from "@/lib/api/log-request";
import { detectEmailType } from "@/lib/uploads/detect-email-type";

const ENDPOINT = "/api/v1/leads";

// POST /api/v1/leads — inbound lead ingest for Clay / any external platform
// (client req 2026-08-06). Bearer-token auth (API Keys page). Accepts ONE lead
// object or { "leads": [ ... ] } (max 500 per call). Upserts by email:
// existing leads get non-empty fields merged (manual/Clay categories are
// never downgraded), new leads are created with source = the token's name.
//
//   curl -X POST https://<app>/api/v1/leads \
//     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
//     -d '{"email":"jane@acme.com","first_name":"Jane","company":"Acme",
//          "city":"Spokane","state":"WA","category":"Corporate Offices",
//          "tags":"CWSJ"}'

const FIELDS = [
  "first_name", "last_name", "title", "company", "phone", "company_phone",
  "website", "domain", "address", "city", "state", "postal_code", "country",
  "category", "subcategory", "additional_category", "general_industry",
  "specific_industry", "seniority", "person_linkedin", "company_linkedin",
  "notes", "question", "google_maps_url", "tags", "company_size", "annual_revenue",
] as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type LeadInput = Record<string, unknown> & { email?: unknown };

function cleanLead(raw: LeadInput): { email: string; fields: Record<string, string> } | { error: string } {
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return { error: `invalid email: ${JSON.stringify(raw.email ?? null)}` };
  const fields: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) fields[f] = s.slice(0, 2000);
  }
  return { email, fields };
}

export async function POST(request: NextRequest) {
  const start = Date.now();
  const auth = await validateApiToken(request);
  if (!auth.valid) return NextResponse.json({ error: auth.error }, { status: 401 });

  const done = async (status: number, payload: Record<string, unknown>) => {
    await logApiRequest({
      tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST",
      endpoint: ENDPOINT, statusCode: status, durationMs: Date.now() - start,
      error: status >= 400 ? String(payload.error ?? "") : undefined,
    });
    return NextResponse.json(payload, { status });
  };

  let body: unknown;
  try { body = await request.json(); } catch { return done(400, { error: "Invalid JSON body" }); }
  const list: LeadInput[] = Array.isArray((body as { leads?: unknown })?.leads)
    ? ((body as { leads: LeadInput[] }).leads)
    : [body as LeadInput];
  if (list.length === 0) return done(400, { error: "No leads provided" });
  if (list.length > 500) return done(400, { error: `Too many leads (${list.length}) — max 500 per call` });

  const pool = getPool();
  let created = 0, updated = 0;
  const errors: string[] = [];
  for (const raw of list) {
    const c = cleanLead(raw);
    if ("error" in c) { errors.push(c.error); continue; }
    try {
      const emailType = detectEmailType({
        email: c.email,
        first_name: c.fields.first_name,
        last_name: c.fields.last_name,
        job_title: c.fields.title,
      });
      const cols = Object.keys(c.fields);
      const vals = Object.values(c.fields);
      // Upsert by email. Existing rows: non-empty incoming values win EXCEPT
      // category fields, which never overwrite manual/clay-sourced values.
      const setPairs = cols.map((col, i) => {
        const v = `$${i + 4}`;
        if (["category", "subcategory", "additional_category"].includes(col)) {
          return `${col} = case when leads.category_source in ('manual','clay') then leads.${col} else coalesce(${v}, leads.${col}) end`;
        }
        if (col === "tags") {
          return `tags = case when leads.tags is null or leads.tags = '' then ${v}
                              when position(${v} in leads.tags) > 0 then leads.tags
                              else leads.tags || ',' || ${v} end`;
        }
        return `${col} = coalesce(${v}, leads.${col})`;
      }).join(", ");
      const insertCols = ["email", "source", "email_type", ...cols];
      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await pool.query(
        `insert into leads (${insertCols.join(", ")}, created_at, updated_at)
         values (${placeholders}, now(), now())
         on conflict (email) do update set ${setPairs.length ? setPairs + "," : ""} updated_at = now()
         returning (xmax = 0) as inserted`,
        [c.email, `api:${auth.tokenName}`, emailType, ...vals]
      );
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors.push(`${c.email}: ${e instanceof Error ? e.message : "write failed"}`);
    }
  }
  return done(errors.length && !created && !updated ? 400 : 200, {
    created, updated, failed: errors.length,
    ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
  });
}

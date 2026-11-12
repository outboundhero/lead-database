// The Companies tab's rows (enrich_companies, migration 124): one summary per
// row of a template Companies table, written by the worker when the row
// finishes (scripts/enrich-worker.mjs), fenced on the row's claim token.
//
// A row is listed (shown on the tab) when its outcome is "Has a general email"
// or "Already in the database". The same company and office (company_key:
// domain|state|city) is listed once: a second row with that key is stored
// unlisted, as "Listed under another row", and cost nothing (shared answers
// and email_validations). The unique partial index on (client_tag,
// company_key) catches two rows racing for it.
//
// Nothing here reads or writes leads.

import { cityKey } from "../aiark/geo.mjs";
import { LISTED_OUTCOMES } from "./company-template.mjs";
import { bareDomain } from "./domain.mjs";

export const WAITING_OUTCOME = "Waiting for a key";
export const ERROR_OUTCOME = "Error";
export const DUPLICATE_OUTCOME = "Listed under another row";
const FOUND_BY = new Set(["database", "aiark", "search_1", "search_2"]);

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * What enrich_companies holds for one row, from the values runRow worked out.
 * `waiting`: a cell waits on a key (the row is 'waiting'); `failed`: a cell
 * ended in error. Either one sets the outcome and keeps the row off the tab.
 */
export function companySummary(values, { waiting = false, failed = false } = {}) {
  const v = values ?? {};
  const office = v.office?.office ?? {};
  const domain = str(v.use_domain?.normalizedUrl) ?? bareDomain(v.domain) ?? null;
  const city = str(v.use_city) ?? str(office.city);
  const state = str(v.use_state) ?? str(office.state);
  const generalEmail = str(v.general_email)?.toLowerCase() ?? null;
  const verdict = str(v.email_verdict);
  const outcome = waiting ? WAITING_OUTCOME : failed ? ERROR_OUTCOME : str(v.company_outcome) ?? "Not worked out";
  const wanted = !waiting && !failed && LISTED_OUTCOMES.includes(outcome) && Boolean(generalEmail);
  const company = str(v.company);
  return {
    source: "AI Ark",
    aiark_id: str(v.aiark_id),
    company,
    domain,
    website: str(v.use_website),
    city,
    state,
    country: str(office.country),
    address: str(v.use_address),
    phone: str(v.phone),
    industry: str(v.industry),
    employees: str(v.employees),
    general_email: generalEmail,
    email_status: verdict === "Valid" ? "valid" : verdict === "Catch-all" ? "catch_all" : null,
    held: verdict === "In the database",
    found_by: FOUND_BY.has(v.found_by) ? v.found_by : null,
    email_kind: v.email_kind === "General" ? "general" : v.email_kind === "Named" ? "named" : null,
    outcome,
    wanted,
    company_key: domain && state ? `${domain}|${state.toUpperCase()}|${cityKey(city)}` : null,
    search_text: [company, domain, generalEmail, city, state].filter(Boolean).join(" ").toLowerCase().slice(0, 1_000),
  };
}

const UPSERT = `
  WITH ok AS (SELECT 1 FROM enrich_rows WHERE id = $1 AND claim_token = $2),
  x AS (
    SELECT * FROM jsonb_to_record($3::jsonb) AS x(
      table_id uuid, client_tag text, source text, aiark_id text, company text, domain text, website text, city text,
      state text, country text, address text, phone text, industry text, employees text, general_email text,
      email_status text, held boolean, found_by text, email_kind text, outcome text, wanted boolean, company_key text,
      search_text text)
  ),
  taken AS (
    SELECT 1 FROM enrich_companies c, x
     WHERE x.wanted AND x.company_key IS NOT NULL AND c.client_tag = x.client_tag AND c.company_key = x.company_key
       AND c.listed AND c.row_id <> $1
     LIMIT 1
  ),
  v AS (SELECT x.*, x.wanted AND NOT EXISTS (SELECT 1 FROM taken) AS listed,
               CASE WHEN x.wanted AND EXISTS (SELECT 1 FROM taken) THEN $4::text ELSE x.outcome END AS shown
          FROM x)
  INSERT INTO enrich_companies AS e (
    row_id, table_id, client_tag, source, aiark_id, company, domain, website, city, state, country, address, phone,
    industry, employees, general_email, email_status, held, found_by, email_kind, outcome, listed, company_key,
    search_text, found_at, updated_at)
  SELECT $1, v.table_id, v.client_tag, v.source, v.aiark_id, v.company, v.domain, v.website, v.city, v.state, v.country,
         v.address, v.phone, v.industry, v.employees, v.general_email, v.email_status, coalesce(v.held, false), v.found_by,
         v.email_kind, v.shown, v.listed, v.company_key, coalesce(v.search_text, ''),
         CASE WHEN v.listed THEN now() END, now()
    FROM v WHERE EXISTS (SELECT 1 FROM ok)
  ON CONFLICT (row_id) DO UPDATE
    SET table_id = EXCLUDED.table_id, client_tag = EXCLUDED.client_tag, source = EXCLUDED.source,
        aiark_id = EXCLUDED.aiark_id, company = EXCLUDED.company, domain = EXCLUDED.domain, website = EXCLUDED.website,
        city = EXCLUDED.city, state = EXCLUDED.state, country = EXCLUDED.country, address = EXCLUDED.address,
        phone = EXCLUDED.phone, industry = EXCLUDED.industry, employees = EXCLUDED.employees,
        general_email = EXCLUDED.general_email, email_status = EXCLUDED.email_status, held = EXCLUDED.held,
        found_by = EXCLUDED.found_by, email_kind = EXCLUDED.email_kind, outcome = EXCLUDED.outcome,
        listed = EXCLUDED.listed, company_key = EXCLUDED.company_key, search_text = EXCLUDED.search_text,
        found_at = coalesce(e.found_at, EXCLUDED.found_at), updated_at = now()
  RETURNING listed, outcome`;

/**
 * Writes one row's summary, only while the worker still holds the row.
 * Returns { written, listed, outcome }.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ rowId: number | string, claimToken: string, tableId: string, clientTag: string, values: object,
 *           waiting?: boolean, failed?: boolean }} opts
 */
export async function projectCompany(db, { rowId, claimToken, tableId, clientTag, values, waiting = false, failed = false }) {
  const summary = { table_id: tableId, client_tag: clientTag, ...companySummary(values, { waiting, failed }) };
  for (let tries = 0; ; tries++) {
    try {
      const { rows } = await db.query(UPSERT, [rowId, claimToken, JSON.stringify(summary), DUPLICATE_OUTCOME]);
      return rows[0] ? { written: true, listed: rows[0].listed, outcome: rows[0].outcome } : { written: false, listed: false, outcome: null };
    } catch (e) {
      // Two rows for one company and office listed at once: the index lets one
      // in, and this one is stored again, under the other.
      if (e?.code === "23505" && tries < 2) continue;
      throw e;
    }
  }
}

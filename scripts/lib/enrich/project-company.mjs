// The Companies tab's rows (enrich_companies, migrations 124 and 125): one
// summary per row of a client's Companies (pipeline) table (companies_v2),
// written by the worker when the row finishes (scripts/enrich-worker.mjs),
// fenced on the row's claim token.
//
// The company row's own fields are written here: its office, domain and
// website, whether it passes the client's rules, whether it is on the
// never-contact list, and its own outcome (company_outcome, or "Waiting for a
// key" or "Error"). Whether it is listed, and its counts of usable general and
// person emails, are worked out by relist() (project-contacts.mjs) from its
// inboxes and people, here and each time one of them finishes.
//
// A row of phase 1's companies_v1 is never worked again (D24), so it is never
// projected either.
//
// Nothing here reads or writes leads.

import { cityKey } from "../aiark/geo.mjs";
import { isLinkedinSource, LINKEDIN_LABELS } from "../aiark/linkedin-labels.mjs";
import { COMPANY_TEMPLATE_V2 } from "./company-template-v2.mjs";
import { bareDomain } from "./domain.mjs";
import { ERROR_OUTCOME, relist, WAITING_OUTCOME } from "./project-contacts.mjs";

export { ERROR_OUTCOME, WAITING_OUTCOME };
export const DUPLICATE_OUTCOME = "Listed under another row";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** C#24 may answer "N/A", kept as Clay keeps it: never a website or a domain here. */
const NA = /^n\/?a\.?$/i;

/**
 * What enrich_companies holds for one Companies (pipeline) row, from the
 * values runRow worked out. `waiting`: a cell waits on a key or a day's cap
 * (the row is 'waiting'); `failed`: a cell ended in error. Either one is the
 * outcome until the row finishes.
 *
 * @param {Record<string, any>} values
 * @param {{ waiting?: boolean, failed?: boolean }} [state]
 */
export function companySummaryV2(values, { waiting = false, failed = false } = {}) {
  const v = values ?? {};
  const office = v.office?.office ?? {};
  const useDomain = str(v.use_domain);
  const domain = (useDomain && !NA.test(useDomain) ? bareDomain(useDomain) : null) ?? bareDomain(v.domain) ?? null;
  const site = str(v.use_website);
  const city = str(v.use_city) ?? str(office.city);
  const state = str(v.use_state) ?? str(office.state);
  const outcome = waiting ? WAITING_OUTCOME : failed ? ERROR_OUTCOME : str(v.company_outcome) ?? "Not worked out";
  const company = str(v.company);
  return {
    // A LinkedIn pull's row, or a LinkedIn person's company brought in (its source input says which): LinkedIn (AI Ark).
    source: isLinkedinSource(v.source) ? LINKEDIN_LABELS.projection : "AI Ark",
    template: COMPANY_TEMPLATE_V2,
    aiark_id: str(v.aiark_id),
    company,
    domain,
    website: site && !NA.test(site) ? site : null,
    city,
    state,
    country: str(office.country),
    address: str(v.use_address),
    phone: str(v.phone),
    industry: str(v.industry),
    employees: str(v.employees),
    passes: v.passes_filters === true,
    never_contact: v.never_contact === true,
    outcome,
    company_key: domain && state ? `${domain}|${state.toUpperCase()}|${cityKey(city)}` : null,
    search_text: [company, domain, city, state].filter(Boolean).join(" ").toLowerCase().slice(0, 1_000),
  };
}

const UPSERT = `
  WITH ok AS (SELECT 1 FROM enrich_rows WHERE id = $1 AND claim_token = $2),
  x AS (
    SELECT * FROM jsonb_to_record($3::jsonb) AS x(
      table_id uuid, client_tag text, source text, template text, aiark_id text, company text, domain text, website text,
      city text, state text, country text, address text, phone text, industry text, employees text, passes boolean,
      never_contact boolean, outcome text, company_key text, search_text text)
  )
  INSERT INTO enrich_companies AS e (
    row_id, table_id, client_tag, source, template, aiark_id, company, domain, website, city, state, country, address, phone,
    industry, employees, passes, never_contact, outcome, listed, company_key, search_text, updated_at)
  SELECT $1, x.table_id, x.client_tag, x.source, x.template, x.aiark_id, x.company, x.domain, x.website, x.city, x.state,
         x.country, x.address, x.phone, x.industry, x.employees, coalesce(x.passes, false), coalesce(x.never_contact, false),
         x.outcome, false, x.company_key, coalesce(x.search_text, ''), now()
    FROM x WHERE EXISTS (SELECT 1 FROM ok)
  ON CONFLICT (row_id) DO UPDATE
    SET table_id = EXCLUDED.table_id, client_tag = EXCLUDED.client_tag, source = EXCLUDED.source,
        template = EXCLUDED.template, aiark_id = EXCLUDED.aiark_id, company = EXCLUDED.company, domain = EXCLUDED.domain,
        website = EXCLUDED.website, city = EXCLUDED.city, state = EXCLUDED.state, country = EXCLUDED.country,
        address = EXCLUDED.address, phone = EXCLUDED.phone, industry = EXCLUDED.industry, employees = EXCLUDED.employees,
        passes = EXCLUDED.passes, never_contact = EXCLUDED.never_contact, outcome = EXCLUDED.outcome,
        company_key = EXCLUDED.company_key, search_text = EXCLUDED.search_text, updated_at = now()
  RETURNING row_id`;

/**
 * Writes one Companies (pipeline) row's summary, only while the worker still
 * holds the row, then lists or unlists it from its contacts (relist).
 * Returns { written, listed, outcome }: the outcome the tab shows.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ rowId: number | string, claimToken: string, tableId: string, clientTag: string, values: object,
 *           waiting?: boolean, failed?: boolean }} opts
 * @returns {Promise<{ written: boolean, listed: boolean | null, outcome: string | null }>}
 */
export async function projectCompanyV2(db, { rowId, claimToken, tableId, clientTag, values, waiting = false, failed = false }) {
  const summary = { table_id: tableId, client_tag: clientTag, ...companySummaryV2(/** @type {any} */ (values), { waiting, failed }) };
  const { rows } = await db.query(UPSERT, [rowId, claimToken, JSON.stringify(summary)]);
  if (!rows[0]) return { written: false, listed: null, outcome: null };
  const { listed, outcome } = await relist(db, rowId, { base: summary.outcome });
  return { written: true, listed, outcome };
}

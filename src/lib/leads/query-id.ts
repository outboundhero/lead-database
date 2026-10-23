// Leads searches carry a random query id so the database work behind a search
// the page has given up on can be stopped, not just abandoned (migration 119).
// The page sends it in this header; the search routes pass it to the RPC as
// p_filters.queryTag; fn_filter_leads_v2 / fn_filter_leads_count put it in
// application_name ('leads-q:<id>') for their own transaction; and
// fn_cancel_lead_queries cancels by it. Safe to import from client code.

export const QUERY_ID_HEADER = "x-lead-query-id";

const QUERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lowercase uuid — the only shape the database functions accept. */
export function isQueryId(v: unknown): v is string {
  return typeof v === "string" && QUERY_ID_RE.test(v);
}

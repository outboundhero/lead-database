// The fit gate in exports (fit scoring, migration 127; shipped OFF).
//
// Filtered exports: fn_export_leads leaves out bad fits itself while
// fit_gate.enabled is true. An owner or admin may ask for them anyway
// (includeBadFits in the request body); the export routes then add
// includeBadFits: true to p_filters AFTER buildRpcFilters(), so FilterState and
// buildRpcFilters never carry it and nobody else can send it.
//
// Selected-row exports read leads by id with no filter. While the gate is on,
// each chunk of ids also asks fn_fit_for_leads(ids): blocked leads are left out
// (unless an owner or admin asked for them), and "Fit score" and "Home office"
// are added at the end of each row. While the gate is off they are exactly as
// before: no extra column, no extra query beyond reading the gate's switch.

import { gateEnabled } from "../../../scripts/lib/enrich/fit-push.mjs";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export const FIT_HEADERS = ["Fit score", "Home office"] as const;

export interface LeadFit {
  score: number | null;
  home_office: boolean | null;
  blocked: boolean;
}

/** May this caller see bad fits? Only when the body asks and the caller is an owner or admin. */
export function includeBadFitsFor(asked: unknown, role: string | null | undefined): boolean {
  return asked === true && (role === "owner" || role === "admin");
}

/** p_filters with includeBadFits added when allowed (never otherwise, whatever the filters hold). */
export function withBadFits<T extends Record<string, unknown>>(pFilters: T, include: boolean): T & { includeBadFits?: true } {
  const { includeBadFits: _drop, ...rest } = pFilters as T & { includeBadFits?: unknown };
  void _drop;
  return (include ? { ...rest, includeBadFits: true } : rest) as T & { includeBadFits?: true };
}

/** Is the gate switched on (fit_gate.enabled)? False before migration 126 is applied. */
export async function fitGateOn(db: Q): Promise<boolean> {
  return gateEnabled(db);
}

/** Each lead's fit, by id: its company's score, home-office flag, and whether it is blocked. */
export async function fitForLeads(db: Q, ids: string[]): Promise<Map<string, LeadFit>> {
  const out = new Map<string, LeadFit>();
  if (!ids.length) return out;
  const { rows } = await db.query(`SELECT lead_id, score, home_office, blocked FROM public.fn_fit_for_leads($1::uuid[])`, [ids]);
  for (const r of rows) {
    out.set(String(r.lead_id), {
      score: r.score == null ? null : Number(r.score),
      home_office: typeof r.home_office === "boolean" ? r.home_office : null,
      blocked: r.blocked === true,
    });
  }
  return out;
}

/** The two cells added at the end of a row: the score (empty when not scored) and the home-office flag. */
export function fitCells(fit: LeadFit | undefined): [string, string] {
  if (!fit) return ["", ""];
  return [fit.score == null ? "" : String(fit.score), fit.home_office == null ? "" : fit.home_office ? "Yes" : "No"];
}

// Pipeline emails into leads (2B.5), switch promotion.promote_to_leads with its
// client list promotion.tags, set on the Companies tab's settings sheet: ships
// OFF, covering no client. Copied from the AI Ark add (scripts/lib/aiark/add.mjs):
// beginPromote() takes the contacts that may be promoted and settles at once
// those the database already holds; the web app (src/lib/companies/promote-run.ts)
// imports the rest through the Uploads page's engine (strategy skip, never
// merged) as one upload batch; finishPromote() settles each one.
//
// Fit scoring is not a condition (2026-11-20): Clay had no fit score, so the
// fit rule, the scorer, the gate and promotion.min_fit_score are kept for v2,
// built and switched off, and promotion reads none of them.
//
// A contact (enrich_contacts: a General row or a People row) may be
// promoted only when, in the query that takes it:
//   - the switch is on and the client on promotion.tags (the caller checks
//     the settings);
//   - it is usable, approved, not held, and not already promoted (promote_state
//     null, or running on a batch no longer live: 3 hours);
//   - its company is listed, and not blocked under any key (the company's, the
//     address's domain, the website's, the name key). Only a company already
//     scored under the gate's threshold (by the scorer or by hand), or found
//     unscorable, is blocked, so while scoring is off (v2) and nobody scores
//     by hand nothing is; a company with no score is never held back for it;
//   - the brand check is true (G#37 for an inbox, P#10 for a person);
//   - a person's outcome is "Approved email" and no name holds "*" (a
//     Preview's masked last name must never reach leads); an inbox's first
//     name (G#20) does not hold "undefined" (G#20 falls back to "<Company>
//     Team", which needs G#14's company name);
//   - its address can be traced to an approval, as Clay takes it
//     (email-verdict.mjs, 2026-11-21): Reoon's stamp (G#40, P#12 on the very
//     address), Enrichley's (G#42, P#14, or its check of an Anymail Finder
//     address, P#49, P#54), or an email finder's own answer (Findymail,
//     Prospeo, Anymail Finder with "valid"), which Clay sends to Use Work
//     Email with no Reoon check. An address traced to none of them is held
//     back. The lead says which: validation_status valid, or catch_all for an
//     Enrichley catch-all result, or empty (NULL: sendable, no check claimed)
//     for Findymail and an unverified Prospeo answer; and its source is the
//     label with who found or approved the address added ("Companies (AI
//     Ark), found by Findymail"). Reoon's approval adds nothing: that lead is
//     exactly as before;
//   - while promotion.require_question is on (it ships on), its question is
//     filled (D19), as Clay's push required.
// Held back means not added this round: its add_to_database cell says why, and
// promoted_at marks when. The worker's rounds take it again only once its row
// has been worked again (enrich_contacts.updated_at after promoted_at), since
// only that can clear a row check; the button always takes it again. Refused
// (promote_state 'refused') is only for a company on the brand list, which
// does not clear.
//
// Each contact's result is kept in enrich_contacts (promote_state, lead_id,
// batch_id, promoted_at) and shown in its row's add_to_database cell, which
// the engine never works (a later phase's column):
//   running  {batch_id, email}                 being added by that upload batch
//   done     {added: true, lead_id, batch_id}   a new lead
//   done     {added: false, reason, lead_id}    in_database, in_bison, never_contact
//   skipped  {added: false, reason: "refused"} the brand list
//   error    {batch_id}                         not stored; the button tries again
//
// When the company has a score, each promoted contact's email domain and its
// lead's name key become aliases of it (2B.2), so a later re-score or manual
// score reaches the lead at once. A company with no score gets no alias.
//
// While the automatic push is on for the client (promotion.auto_push,
// migration 140), finishPromote also queues each contact it settles 'added'
// for the push into the client's campaigns (auto_push_state 'queued'), in the
// same fenced statement; promote-push.mjs takes it from there.
//
// Then placeAdded places the leads the batch made at once, with the location
// job's own code (../lead-places.mjs), as the cron's next run would place
// them, so the push need not wait for that run (2026-11-26).

import { evaluate, isEmpty, makeContext } from "./formula.mjs";
import { addAliases } from "./fit-keys.mjs";
import { inboxVerdict, personVerdict, VERDICT_CELLS, verdictSource } from "./email-verdict.mjs";
import { placeLeads } from "../lead-places.mjs";

export const PROMOTE_SOURCE = "Companies (AI Ark)";
export const ADD_COLUMN = "add_to_database";

/**
 * The first words of each sentence the automatic push (promote-push.mjs)
 * ends an added contact's add_to_database note with, so a later sentence
 * replaces an earlier one.
 */
export const PUSH_NOTE = Object.freeze({
  queued: "It goes into the client's campaigns",
  pushed: "Pushed into the client's campaigns",
  held: "Not pushed into the client's campaigns",
});
const PUSH_NOTE_TAIL = new RegExp(` (${Object.values(PUSH_NOTE).join("|")})[\\s\\S]*$`);
/** The sentence a queued contact's note ends with. */
export const QUEUED_SENTENCE = `${PUSH_NOTE.queued} by the automatic push, once the location backfill has placed it.`;

/** An added contact's note with the push's sentence in place of any earlier one. */
export function notePush(note, sentence) {
  const base = String(note ?? "").replace(PUSH_NOTE_TAIL, "").trim();
  return base ? `${base} ${sentence}` : sentence;
}

/** A promote batch still 'processing' after this long died with the server; its contacts can be taken again. */
export const PROMOTE_STALE_HOURS = 3;
const PROMOTE_KINDS = ["general", "person"];
const AUTO_KEY_MIN = 32;

/** The import's columns: [header, leads field]. */
export const PROMOTE_COLUMNS = Object.freeze([
  ["Email", "email"],
  ["First Name", "first_name"],
  ["Last Name", "last_name"],
  ["Title", "title"],
  ["Company", "company"],
  ["Domain", "domain"],
  ["City", "city"],
  ["State", "state"],
  ["Country", "country"],
  ["Address", "address"],
  ["Company Phone", "company_phone"],
  ["Google Maps URL", "google_maps_url"],
  ["Person LinkedIn", "person_linkedin"],
  ["Question", "question"],
  ["Seniority", "seniority"],
  ["Industry", "general_industry"],
  ["Email Type", "email_type"],
  ["Validation Status", "validation_status"],
  ["Source", "source"],
]);

/** leads columns the import writes beyond the Uploads page's fields (ImportConfig.extraFields). */
export const PROMOTE_EXTRA_FIELDS = Object.freeze(["country", "seniority", "general_industry"]);

/** The cells read from each kind of row: the original columns of 2B.5, the checks, the address, and what its verdict reads. */
export const PROMOTE_CELLS = Object.freeze({
  general: [...new Set([
    "general_email", "use_first_name", "use_last_name", "normalized_company_name", "company", "use_city", "use_state",
    "use_address", "use_domain", "use_phone_number", "use_google_maps_url", "question", "exclusion_large_company_check",
    "reoon_stamp_of_approval", ...VERDICT_CELLS.general,
  ])],
  person: [...new Set([
    "use_work_email", "email", "use_first_name", "use_last_name", "full_name", "title", "normalized_company_name", "company",
    "use_city", "use_state", "use_address", "use_domain", "use_phone_number", "use_google_maps_url", "person_linkedin_url",
    "question", "seniority", "person_country", "exclusion_large_company_check", "reoon_stamp_of_approval", ...VERDICT_CELLS.person,
  ])],
});

/** The columns whose fallback word is dropped (it is read from the column itself, never written here). */
export const FALLBACK_COLUMNS = Object.freeze(["use_city", "use_state", "use_address", "use_phone_number", "use_google_maps_url"]);

/** Why a contact is held back (not taken this round), or refused. */
export const HOLD = Object.freeze({
  masked: "A name holds \"*\" (a Preview's masked name)",
  first_name: "The first name holds \"undefined\": the company-name step (G#14) has not given a name",
  validation: "No approval this address can be traced to (Reoon, Enrichley or an email finder's own answer)",
  blocked: "Blocked under one of the lead's keys",
  no_email: "No address",
  twin: "Another contact in this round has the same address: it waits for the next round",
});
export const REFUSED_BRAND = "A large company (brand list)";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {import("./settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {"general" | "person"} PromoteKind
 */

const str = (v) => (v == null ? "" : typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

// ── Fallback words ──────────────────────────────────────────────────────────

/**
 * The word a column falls back to when it has nothing to show ("local",
 * "there", ...), read from the column itself: what its formula or waterfall
 * gives when every cell it reads is empty. Null when it gives nothing, or
 * can't be worked out (then nothing is dropped).
 *
 * @param {{ kind?: string, formula?: string | null, waterfall?: Array<string | { formula?: string }> | null }} column
 * @returns {string | null}
 */
export function fallbackOf(column) {
  if (!column) return null;
  const ctx = makeContext();
  const run = (expr) => {
    try {
      return evaluate(ctx, expr, {});
    } catch {
      return undefined;
    }
  };
  if (column.kind === "formula" && typeof column.formula === "string") {
    const v = run(column.formula);
    return typeof v === "string" && v.trim() ? v : null;
  }
  if (column.kind === "waterfall" && Array.isArray(column.waterfall)) {
    for (const step of column.waterfall) {
      const expr = typeof step === "string" ? step : typeof step?.formula === "string" ? step.formula : null;
      if (!expr) continue;
      const v = run(expr);
      if (!isEmpty(v) && v !== false) return typeof v === "string" && v.trim() ? v : null;
    }
  }
  return null;
}

/** The value, or "" when it is empty or its column's own fallback word. */
export function withoutFallback(value, fallback) {
  const v = str(value);
  if (!v) return "";
  return fallback != null && v === String(fallback).trim() ? "" : v;
}

// ── Lead rows ───────────────────────────────────────────────────────────────

/**
 * @typedef {{ fallbacks?: Record<string, string | null>, industry?: string | null, label?: string }} RowContext
 * @typedef {{ row: string[], lead: Record<string, string>, hold: string | null, refuse: string | null }} LeadRow
 */

function toRow(lead) {
  return PROMOTE_COLUMNS.map(([, k]) => String(lead[k] ?? ""));
}

/**
 * What a verdict (email-verdict.mjs) gives the lead: its validation status
 * ("" when the verdict claims none, which the import writes as NULL) and its
 * source, the label with who found or approved the address added. With no
 * verdict the contact is held back, so neither is used.
 *
 * @param {import("./email-verdict.mjs").Verdict | null} v
 * @param {string} label
 */
function verdictFields(v, label) {
  if (!v) return { validation_status: "", source: label };
  const by = verdictSource(v);
  return { validation_status: v.status ?? "", source: by ? `${label}, ${by}` : label };
}

/**
 * An inbox row as a lead (G#13 to G#50, D18): "<Company> Team" as G#20 gives
 * it, "(General Email)" as G#21 gives it, email type general, the place,
 * address, phone and Maps link without their fallback words, the question,
 * the company row's industry, the validation status its verdict gives (valid
 * for Reoon's approval, valid or catch_all for Enrichley's) and the
 * pipeline's source label, with "approved by Enrichley" added for Enrichley's.
 *
 * @param {Record<string, any>} cells  the row's done cells, by key
 * @param {RowContext} [ctx]
 * @returns {LeadRow}
 */
export function inboxLeadRow(cells, { fallbacks = {}, industry = null, label = PROMOTE_SOURCE } = {}) {
  const c = cells ?? {};
  const email = str(c.general_email).toLowerCase();
  const first = str(c.use_first_name);
  const verdict = inboxVerdict(c);
  const lead = {
    email,
    first_name: first,
    last_name: str(c.use_last_name),
    title: "",
    company: str(c.normalized_company_name) || str(c.company),
    domain: str(c.use_domain),
    city: withoutFallback(c.use_city, fallbacks.use_city),
    state: withoutFallback(c.use_state, fallbacks.use_state),
    country: "",
    address: withoutFallback(c.use_address, fallbacks.use_address),
    company_phone: withoutFallback(c.use_phone_number, fallbacks.use_phone_number),
    google_maps_url: withoutFallback(c.use_google_maps_url, fallbacks.use_google_maps_url),
    person_linkedin: "",
    question: str(c.question),
    seniority: "",
    general_industry: str(industry),
    email_type: "general",
    ...verdictFields(verdict, label),
  };
  let hold = null;
  let refuse = null;
  if (!email) hold = HOLD.no_email;
  else if (c.exclusion_large_company_check !== true) refuse = REFUSED_BRAND;
  else if (/undefined/i.test(first)) hold = HOLD.first_name;
  else if (!verdict) hold = HOLD.validation;
  return { row: toRow(lead), lead, hold, refuse };
}

/**
 * A People row as a lead (P#9 to P#62): the address P#55 uses, first and last
 * name (P#41, P#42), title (P#44), company (P#30, else P#28), the place,
 * address, phone and Maps link without their fallback words, LinkedIn (P#45),
 * the question (P#62), AI Ark's seniority and country, the company row's
 * industry, the validation status its verdict gives and the pipeline's source
 * label with who found or approved the address added (email-verdict.mjs).
 * Email type is left to the import's detection.
 *
 * @param {Record<string, any>} cells
 * @param {RowContext} [ctx]
 * @returns {LeadRow}
 */
export function personLeadRow(cells, { fallbacks = {}, industry = null, label = PROMOTE_SOURCE } = {}) {
  const c = cells ?? {};
  const email = str(c.use_work_email).toLowerCase();
  const verdict = personVerdict(c);
  const lead = {
    email,
    first_name: str(c.use_first_name),
    last_name: str(c.use_last_name),
    title: str(c.title),
    company: str(c.normalized_company_name) || str(c.company),
    domain: str(c.use_domain),
    city: withoutFallback(c.use_city, fallbacks.use_city),
    state: withoutFallback(c.use_state, fallbacks.use_state),
    country: str(c.person_country),
    address: withoutFallback(c.use_address, fallbacks.use_address),
    company_phone: withoutFallback(c.use_phone_number, fallbacks.use_phone_number),
    google_maps_url: withoutFallback(c.use_google_maps_url, fallbacks.use_google_maps_url),
    person_linkedin: str(c.person_linkedin_url),
    question: str(c.question),
    seniority: str(c.seniority),
    general_industry: str(industry),
    email_type: "",
    ...verdictFields(verdict, label),
  };
  let hold = null;
  let refuse = null;
  if (!email) hold = HOLD.no_email;
  else if (c.exclusion_large_company_check !== true) refuse = REFUSED_BRAND;
  else if ([lead.first_name, lead.last_name, str(c.full_name)].some((n) => n.includes("*"))) hold = HOLD.masked;
  else if (!verdict) hold = HOLD.validation;
  return { row: toRow(lead), lead, hold, refuse };
}

// ── What may be promoted ────────────────────────────────────────────────────

const LIVE_BATCH = `b.status = 'processing' AND b.created_at > now() - make_interval(hours => ${PROMOTE_STALE_HOURS})`;

/**
 * The SQL that takes a client's contacts that may be promoted ($1 tag, $2
 * kind, $3 limit, $4 the button: also not_added ones, and those held back
 * since their row was last worked, $5 require a question). No fit score is
 * needed: the company's score, when it has one, is read only for its blocked
 * flag and for the aliases (fit_kind and fit_key, null with no score).
 */
const PROMOTABLE_SQL = `
  SELECT c.row_id, c.company_row_id, c.table_id, c.kind, c.email, c.has_question, c.promote_state,
         e.industry, f.key_kind AS fit_kind, f.key AS fit_key
    FROM enrich_contacts c
    JOIN enrich_companies e ON e.row_id = c.company_row_id
    LEFT JOIN company_fit_keys ck ON ck.key_kind = e.fit_key_kind AND ck.key = e.fit_key
    LEFT JOIN company_fit f ON f.key_kind = ck.fit_kind AND f.key = ck.fit_key
    LEFT JOIN upload_batches b ON c.promote_state = 'running' AND b.id = c.batch_id
   WHERE c.client_tag = $1 AND c.kind = $2
     AND c.usable AND c.verdict = 'approved' AND NOT c.held AND c.email IS NOT NULL
     AND ($2 <> 'person' OR c.outcome = 'Approved email')
     AND ((c.promote_state IS NULL AND ($4 OR c.promoted_at IS NULL OR c.updated_at > c.promoted_at))
          OR (c.promote_state = 'running' AND NOT coalesce(${LIVE_BATCH}, false))
          OR ($4 AND c.promote_state = 'not_added'))
     AND e.listed
     AND NOT coalesce(f.blocked, false) AND NOT coalesce(ck.blocked, false)
     AND NOT EXISTS (SELECT 1 FROM company_fit_keys k
                      WHERE k.blocked AND k.key_kind = 'domain' AND k.key = lower(split_part(c.email, '@', 2)))
     AND (NOT $5 OR c.has_question)
   ORDER BY c.row_id
   LIMIT $3`;

/**
 * Is promotion allowed for this client by the settings? { ok, why }: the
 * switch and its client list. Nothing of fit scoring is asked for (kept for
 * v2): not the rule, the model, the gate or a score.
 *
 * @param {PipelineSettings} settings
 * @param {string} tag
 */
export function promotionAllowed(settings, tag) {
  if (!settings.flagOn("promotion", tag)) {
    return {
      ok: false,
      why: "Promotion is off for this client (the switch, or the client is not on its list; an admin sets both in the Companies tab's settings)",
    };
  }
  return { ok: true, why: null };
}

/**
 * The contacts that may be promoted, with their cells.
 *
 * @param {Db} db
 * @param {{ tag: string, kind: PromoteKind, limit: number, settings: PipelineSettings, button?: boolean }} p
 */
export async function promotable(db, { tag, kind, limit, settings, button = false }) {
  if (!PROMOTE_KINDS.includes(kind)) throw new Error(`Unknown contact kind "${kind}"`);
  const { rows } = await db.query(PROMOTABLE_SQL, [
    tag, kind, Math.max(1, Math.min(limit, settings.promotion.batch_max)), button, settings.promotion.require_question,
  ]);
  if (!rows.length) return [];
  const { rows: cells } = await db.query(
    `SELECT row_id, column_key, value FROM enrich_cells
      WHERE row_id = ANY($1::bigint[]) AND column_key = ANY($2::text[]) AND status = 'done'`,
    [rows.map((r) => r.row_id), PROMOTE_CELLS[kind]]
  );
  const byRow = new Map();
  for (const c of cells) {
    const m = byRow.get(String(c.row_id)) ?? {};
    m[c.column_key] = c.value;
    byRow.set(String(c.row_id), m);
  }
  return rows.map((r) => ({ ...r, row_id: Number(r.row_id), company_row_id: Number(r.company_row_id), cells: byRow.get(String(r.row_id)) ?? {} }));
}

/**
 * What the fit panel shows for a client: contacts that would be promoted now,
 * and those held back only for want of a question.
 *
 * @param {Db} db
 * @param {{ tag: string, settings: PipelineSettings }} p
 */
export async function promoteCounts(db, { tag, settings }) {
  const count = async (kind, needQuestion) => {
    const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM (${PROMOTABLE_SQL}) x`, [
      tag, kind, 1_000_000, false, needQuestion,
    ]);
    return r.n;
  };
  const out = {};
  for (const kind of PROMOTE_KINDS) {
    const withQ = await count(kind, true);
    const all = await count(kind, false);
    out[kind] = { ready: settings.promotion.require_question ? withQ : all, no_question: all - withQ };
  }
  return out;
}

/** The fallback words of the columns FALLBACK_COLUMNS of each table, read from enrich_columns. */
async function fallbacksFor(db, tableIds) {
  const ids = [...new Set(tableIds)];
  const { rows } = await db.query(
    `SELECT table_id, key, kind, formula, waterfall FROM enrich_columns WHERE table_id = ANY($1::uuid[]) AND key = ANY($2::text[])`,
    [ids, FALLBACK_COLUMNS]
  );
  const out = new Map(ids.map((id) => [String(id), {}]));
  for (const c of rows) out.get(String(c.table_id))[c.key] = fallbackOf(c);
  return out;
}

/** add_to_database cells, one statement. */
async function writeCells(db, cells) {
  if (!cells.length) return;
  await db.query(
    `INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
     SELECT x.row_id, $2, x.table_id, x.status, x.value, x.display, x.note, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, table_id uuid, status text, value jsonb, display text, note text)
     ON CONFLICT (row_id, column_key) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note, updated_at = now()`,
    [JSON.stringify(cells), ADD_COLUMN]
  );
}

/**
 * The keys a lead row would show, as aliases of the company's score: the
 * address's domain, the website's, and the name key with a 2-letter state.
 */
async function aliasesForRows(db, items) {
  if (!items.length) return 0;
  const { rows } = await db.query(
    `SELECT v.key_kind, v.key, x.fit_kind, x.fit_key
       FROM jsonb_to_recordset($1::jsonb) AS x(email text, domain text, company text, city text, state text, fit_kind text, fit_key text)
       CROSS JOIN LATERAL (VALUES
         ('domain', public.fn_fit_domain_ok(nullif(split_part(x.email, '@', 2), ''))),
         ('domain', public.fn_fit_domain_ok(x.domain)),
         ('name', public.fn_fit_name_key(x.company, x.city, CASE WHEN x.state ~ '^[A-Za-z]{2}$' THEN upper(x.state) END))
       ) AS v(key_kind, key)
      WHERE v.key IS NOT NULL`,
    [JSON.stringify(items)]
  );
  return addAliases(db, rows);
}

/**
 * Starts a promotion of one kind for one client, inside the caller's
 * transaction (which holds the client's lock). Takes the contacts that may
 * be promoted, refuses or holds back those the row checks stop, settles at
 * once those the database already holds (a lead, the Email Bison copy, the
 * never-contact list), makes one upload batch for the rest and marks them
 * running. `busy` while another batch of this client and kind is live.
 *
 * @param {Db} db
 * @param {{ tag: string, kind: PromoteKind, userId: string | null, limit?: number, settings: PipelineSettings,
 *           button?: boolean, filename: string }} p
 */
export async function beginPromote(db, { tag, kind, userId, limit, settings, button = false, filename }) {
  const { rows: live } = await db.query(
    `SELECT 1 FROM enrich_contacts c JOIN upload_batches b ON b.id = c.batch_id AND ${LIVE_BATCH}
      WHERE c.client_tag = $1 AND c.kind = $2 AND c.promote_state = 'running' LIMIT 1`,
    [tag, kind]
  );
  if (live.length) return { busy: true };
  const label = settings.promotion.source_label || PROMOTE_SOURCE;
  const taken = await promotable(db, { tag, kind, limit: limit ?? settings.promotion.batch_max, settings, button });
  const empty = { busy: false, batchId: null, batchAt: null, rows: [], contacts: [], settled: 0, refused: 0, held: {} };
  if (!taken.length) return empty;

  const fallbacks = await fallbacksFor(db, taken.map((t) => t.table_id));
  /** @type {Record<string, number>} */
  const held = {};
  /** @type {Array<{ row_id: number, table_id: string, email: string | null, why: string }>} */
  const heldBack = [];
  const refused = [];
  const ready = [];
  for (const t of taken) {
    const ctx = { fallbacks: fallbacks.get(String(t.table_id)) ?? {}, industry: t.industry, label };
    const built = kind === "general" ? inboxLeadRow(t.cells, ctx) : personLeadRow(t.cells, ctx);
    if (built.refuse) refused.push({ ...t, why: built.refuse });
    else if (built.hold) heldBack.push({ row_id: t.row_id, table_id: t.table_id, email: t.email, why: built.hold });
    else ready.push({ ...t, ...built });
  }

  // Not blocked under any key the lead will show.
  let open = ready;
  if (ready.length) {
    const { rows: blocked } = await db.query(
      `SELECT x.i FROM jsonb_to_recordset($1::jsonb) AS x(i int, email text, domain text, company text, city text, state text)
        WHERE EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.blocked AND (
                (k.key_kind = 'domain' AND k.key IN (lower(split_part(x.email, '@', 2)), public.fn_bare_domain(x.domain)))
             OR (k.key_kind = 'name'
                 AND k.key = public.fn_fit_name_key(x.company, x.city, CASE WHEN x.state ~ '^[A-Za-z]{2}$' THEN upper(x.state) END))))`,
      [JSON.stringify(ready.map((r, i) => ({ i, ...r.lead })))]
    );
    const out = new Set(blocked.map((b) => b.i));
    ready.forEach((r, i) => {
      if (out.has(i)) heldBack.push({ row_id: r.row_id, table_id: r.table_id, email: r.email, why: HOLD.blocked });
    });
    open = ready.filter((_, i) => !out.has(i));
  }

  if (heldBack.length) {
    for (const h of heldBack) held[h.why] = (held[h.why] ?? 0) + 1;
    await db.query(
      `UPDATE enrich_contacts SET promoted_at = now() WHERE row_id = ANY($1::bigint[]) AND kind = $2 AND promote_state IS NULL`,
      [heldBack.map((h) => h.row_id), kind]
    );
    await writeCells(db, heldBack.map((h) => ({
      row_id: h.row_id, table_id: h.table_id, status: "skipped", value: { added: false, reason: "held_back", why: h.why, email: h.email },
      display: "Held back", note: `Not added: ${h.why}. Taken again once the row is worked again, or with the button.`,
    })));
  }
  if (refused.length) {
    await db.query(
      `UPDATE enrich_contacts SET promote_state = 'refused', promoted_at = now() WHERE row_id = ANY($1::bigint[]) AND kind = $2`,
      [refused.map((r) => r.row_id), kind]
    );
    await writeCells(db, refused.map((r) => ({
      row_id: r.row_id, table_id: r.table_id, status: "skipped", value: { added: false, reason: "refused", email: r.email },
      display: "Not added", note: `Refused: ${r.why}. This does not change, so it is not tried again.`,
    })));
  }

  // The database may have moved on since the row was worked.
  const emails = [...new Set(open.map((r) => r.lead.email))];
  const { rows: known } = emails.length
    ? await db.query(
        `SELECT e.email, l.id AS lead_id,
                EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = e.email) AS never_contact,
                EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = e.email) AS in_bison
           FROM unnest($1::text[]) AS e(email) LEFT JOIN leads l ON l.email = e.email`,
        [emails]
      )
    : { rows: [] };
  const byEmail = new Map(known.map((k) => [k.email, k]));
  const settled = [];
  const toAdd = [];
  const seen = new Set();
  for (const r of open) {
    const k = byEmail.get(r.lead.email);
    const state = k?.never_contact ? "never_contact" : k?.lead_id ? "in_database" : k?.in_bison ? "in_bison" : null;
    if (state) settled.push({ ...r, state, lead_id: k?.lead_id ?? null });
    else if (seen.has(r.lead.email)) {
      // A second contact with the same address waits: the next round finds the lead the first one made.
      held[HOLD.twin] = (held[HOLD.twin] ?? 0) + 1;
    } else {
      seen.add(r.lead.email);
      toAdd.push(r);
    }
  }
  if (settled.length) {
    await db.query(
      `UPDATE enrich_contacts c SET promote_state = x.state, lead_id = x.lead_id, promoted_at = now(), batch_id = NULL
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, state text, lead_id uuid)
        WHERE c.row_id = x.row_id`,
      [JSON.stringify(settled.map((s) => ({ row_id: s.row_id, state: s.state, lead_id: s.lead_id })))]
    );
    await writeCells(db, settled.map((s) => ({
      row_id: s.row_id, table_id: s.table_id, status: "done",
      value: { added: false, reason: s.state, lead_id: s.lead_id, email: s.lead.email },
      display: s.state === "never_contact" ? "On the never-contact list" : "Already in the database",
      note: s.state === "never_contact"
        ? "Skipped: the address is on the never-contact list."
        : s.state === "in_bison"
          ? "Skipped: the address is in the copy of Email Bison, which counts as already in the database."
          : "Skipped: a lead with this address is in the database already; it was left as it was.",
    })));
  }
  if (!toAdd.length) return { ...empty, settled: settled.length, refused: refused.length, held };

  // The batch records the client's tag (add_tags), so overlap sharing knows whose import it is.
  const { rows: [batch] } = await db.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, source_label,
                                 add_tags)
     VALUES ($1, $2, $3, 'processing', 'skip', $4::jsonb, $5::jsonb, 'leads', $6, ARRAY[$7::text])
     RETURNING id, created_at`,
    [
      userId, filename, toAdd.length,
      JSON.stringify(Object.fromEntries(PROMOTE_COLUMNS.map(([, k], i) => [i, k]))),
      JSON.stringify(PROMOTE_COLUMNS.map(([h]) => h)),
      label,
      tag,
    ]
  );
  await db.query(
    `UPDATE enrich_contacts SET promote_state = 'running', batch_id = $2, lead_id = NULL WHERE row_id = ANY($1::bigint[])`,
    [toAdd.map((r) => r.row_id), batch.id]
  );
  await writeCells(db, toAdd.map((r) => ({
    row_id: r.row_id, table_id: r.table_id, status: "running", value: { batch_id: batch.id, email: r.lead.email },
    display: "Adding…", note: null,
  })));
  // A company's score, when it has one, reaches the lead under every key it will show, from the moment it exists.
  await aliasesForRows(db, toAdd.filter((r) => r.fit_key).map((r) => ({ ...r.lead, fit_kind: r.fit_kind, fit_key: r.fit_key })));
  return {
    busy: false,
    batchId: batch.id,
    batchAt: batch.created_at instanceof Date ? batch.created_at.toISOString() : String(batch.created_at),
    rows: toAdd.map((r) => r.row),
    // Each contact's own source (the label, with who found or approved its address): finishPromote compares it.
    contacts: toAdd.map((r) => ({ row_id: r.row_id, table_id: r.table_id, email: r.lead.email, label: r.lead.source })),
    settled: settled.length,
    refused: refused.length,
    held,
  };
}

/**
 * Settles each contact a promote batch took, from what the database holds
 * after the import: a lead with the contact's own source (its label, the
 * pipeline's source label with who found or approved the address added;
 * the batch's label for a contact that names none) created since the batch
 * began is this batch's ('added'); a lead otherwise was there first
 * ('in_database'); no lead means the import could not store it ('not_added',
 * which the button tries again). Only contacts still running for this batch
 * are written. Then each lead's keys become aliases of its company's score.
 *
 * With queuePush (the automatic push is on for the client, and migration 140
 * is applied: the caller checks both), each contact settled 'added' is also
 * queued for the push (auto_push_state 'queued') in the same statement, and
 * only one never queued before. A lead that was there first is never queued.
 *
 * @param {Db} db
 * @param {{ batchId: string, batchAt: string, contacts: Array<{ row_id: number, table_id: string, email: string, label?: string }>,
 *           label?: string, queuePush?: boolean }} p
 */
export async function finishPromote(db, { batchId, batchAt, contacts, label = PROMOTE_SOURCE, queuePush = false }) {
  if (!contacts?.length) return { added: 0, in_database: 0, not_added: 0, queued: 0 };
  const queueMine = `m.lead_id IS NOT NULL AND m.mine AND c.auto_push_state IS NULL`;
  const queue = queuePush
    ? `,
            auto_push_state = CASE WHEN ${queueMine} THEN 'queued' ELSE c.auto_push_state END,
            auto_push_at = CASE WHEN ${queueMine} THEN now() ELSE c.auto_push_at END`
    : "";
  const { rows } = await db.query(
    `WITH m AS (
       SELECT x.row_id, x.table_id, x.email, coalesce(x.label, $3) AS label, l.id AS lead_id,
              coalesce(l.source = coalesce(x.label, $3) AND l.created_at >= $2::timestamptz, false) AS mine
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, table_id uuid, email text, label text)
         LEFT JOIN leads l ON l.email = x.email
     )
     UPDATE enrich_contacts c
        SET promote_state = CASE WHEN m.lead_id IS NULL THEN 'not_added' WHEN m.mine THEN 'added' ELSE 'in_database' END,
            lead_id = m.lead_id, promoted_at = now()${queue}
       FROM m
      WHERE c.row_id = m.row_id AND c.promote_state = 'running' AND c.batch_id = $4
     RETURNING c.row_id, c.table_id, m.email, m.label, c.promote_state, c.lead_id${queuePush ? ", c.auto_push_state" : ""}`,
    [JSON.stringify(contacts), batchAt, label, batchId]
  );
  await writeCells(db, rows.map((r) => ({
    row_id: r.row_id, table_id: r.table_id,
    status: r.promote_state === "not_added" ? "error" : "done",
    value: r.promote_state === "not_added"
      ? { batch_id: batchId, email: r.email }
      : {
          added: r.promote_state === "added", reason: r.promote_state === "added" ? null : "in_database", lead_id: r.lead_id, batch_id: batchId, email: r.email,
          ...(r.auto_push_state === "queued" ? { push: "queued" } : {}),
        },
    display: r.promote_state === "added" ? "Added" : r.promote_state === "in_database" ? "Already in the database" : "Not added",
    note: r.promote_state === "added"
      ? `Added to the lead database with source ${r.label ?? label}, tagged with the client.${r.auto_push_state === "queued" ? ` ${QUEUED_SENTENCE}` : ""}`
      : r.promote_state === "in_database"
        ? "Skipped: a lead with this address reached the database while this batch ran; it was left as it was."
        : "The import could not store this contact (the batch's errors on the Uploads page say why). The button tries again.",
  })));
  // The stored lead's own keys, as the gate will read them (only for a company with a score).
  const { rows: keys } = await db.query(
    `SELECT v.key_kind, v.key, ck.fit_kind, ck.fit_key
       FROM enrich_contacts c
       JOIN enrich_companies e ON e.row_id = c.company_row_id
       JOIN company_fit_keys ck ON ck.key_kind = e.fit_key_kind AND ck.key = e.fit_key
       JOIN leads l ON l.id = c.lead_id
       CROSS JOIN LATERAL (VALUES
         ('domain', public.fn_fit_domain_ok(nullif(split_part(l.email, '@', 2), ''))),
         ('domain', public.fn_fit_domain_ok(l.domain)),
         ('name', public.fn_fit_name_key(l.company, l.city,
                    coalesce(l.state_code, CASE WHEN l.state ~ '^[A-Za-z]{2}$' THEN upper(l.state) END)))
       ) AS v(key_kind, key)
      WHERE c.row_id = ANY($1::bigint[]) AND v.key IS NOT NULL`,
    [rows.filter((r) => r.lead_id).map((r) => r.row_id)]
  );
  await addAliases(db, keys);
  return {
    added: rows.filter((r) => r.promote_state === "added").length,
    in_database: rows.filter((r) => r.promote_state === "in_database").length,
    not_added: rows.filter((r) => r.promote_state === "not_added").length,
    queued: rows.filter((r) => r.auto_push_state === "queued").length,
  };
}

/**
 * Places the leads a promote batch made, at once, with the location job's own
 * code (../lead-places.mjs): each lead of a contact the batch settled 'added'
 * gets what the location cron's next run would write for it, so the
 * automatic push of the round need not wait for that run (promote-push.mjs
 * pushes a round once nothing is left for the job to write). Only those
 * leads: one that was there first is the cron's, as before. The contacts are
 * read again, so a settle that took a retry is placed all the same. The web
 * app calls it after the settle and before the batch's final status, in a
 * transaction of its own; a failure there changes nothing else (the cron
 * places them, and the push waits for it as before).
 *
 * @param {Db} db  the caller's transaction
 * @param {{ batchId: string, contacts: Array<{ row_id: number }> }} p
 */
export async function placeAdded(db, { batchId, contacts }) {
  if (!contacts?.length) return placeLeads(db, []);
  const { rows } = await db.query(
    `SELECT lead_id::text AS lead_id FROM enrich_contacts
      WHERE row_id = ANY($1::bigint[]) AND batch_id = $2 AND promote_state = 'added' AND lead_id IS NOT NULL`,
    [contacts.map((c) => c.row_id), batchId]
  );
  return placeLeads(db, rows.map((r) => r.lead_id));
}

// ── The worker's trigger ────────────────────────────────────────────────────

/**
 * The clients whose approved contacts wait to be promoted: on the switch's
 * list, with at least one contact the query would take (the button's
 * not_added ones aside). No fit rule, model, gate or score is needed.
 *
 * @param {Db} db
 * @param {PipelineSettings} settings
 * @returns {Promise<string[]>}
 */
export async function promoteDue(db, settings) {
  if (!settings?.promotion?.promote_to_leads) return [];
  const out = [];
  for (const tag of settings.promotion.tags) {
    if (!promotionAllowed(settings, tag).ok) continue;
    for (const kind of PROMOTE_KINDS) {
      const { rows } = await db.query(PROMOTABLE_SQL, [tag, kind, 1, false, settings.promotion.require_question]);
      if (rows.length) {
        out.push(tag);
        break;
      }
    }
  }
  return out;
}

/** Where the worker asks for a round: the auto-add address's origin, the same key (AIARK_AUTO_ADD_URL, AIARK_AUTO_ADD_KEY). */
export function promoteAutoConfig(env = process.env) {
  const base = String(env.AIARK_AUTO_ADD_URL ?? "").trim();
  const key = String(env.AIARK_AUTO_ADD_KEY ?? "").trim();
  if (!base || key.length < AUTO_KEY_MIN) return null;
  try {
    return { url: new URL("/api/companies/promote/auto", base).toString(), key };
  } catch {
    return null;
  }
}

/**
 * Asks the web app for one promotion round for a client (the import engine
 * is TypeScript the worker can't load). Never throws.
 *
 * @param {{ url: string, key: string }} config
 * @param {string} tag
 * @param {typeof fetch} [fetchImpl]
 */
export async function requestPromote(config, tag, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, why: res.ok ? null : String(json?.error ?? "no reason given").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, why: String(e?.name === "TimeoutError" ? "no answer in time" : e?.cause?.code ?? e?.message ?? e).slice(0, 300) };
  }
}

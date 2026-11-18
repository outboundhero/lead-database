// An upload's no-email rows in the client's People table (migration 130).
//
// An upload's rows with no usable email are kept back (upload_holdbacks, 105)
// for the "No-email rows" download, as before. They also go into the client's
// People (pipeline) table (people_v1) as held rows, one row per kept-back row,
// keyed "upload:<batch id>:<seq>". A held row costs nothing. The worker
// releases them only while the client is on the people_pipeline switch, and
// the email finders then look for each person's email within the daily caps.
// A person whose Outcome is "Approved email" is added to leads by the web app,
// through the Uploads page's own import (src/lib/uploads/import-rows.ts), as a
// new upload batch with the first upload's duplicate rule, tags and fields.
//
// Plain JavaScript with no database code of its own, so the worker, the web
// app and the tests share it: the constants, the row key, which client an
// upload goes to, a kept-back row as People inputs, a found person as an
// import row, and the SQL terms both sides must read the same way.

import { bareDomain } from "./domain.mjs";
import { normTag } from "./settings.mjs";

// ── Constants ───────────────────────────────────────────────────────────────

/** found_by on an upload's People row (PEOPLE_INPUTS found_by). */
export const UPLOAD_FOUND_BY = "upload";
/** stage on an upload's People row. Not "no_email": the Outcome would then read "No email (AI Ark found none)". */
export const UPLOAD_STAGE = "uploaded";
/** enrich_sources.kind of an upload's rows (130): one source row per upload and People table, external_id the batch id. */
export const UPLOAD_SOURCE_KIND = "upload";
/** An upload's People row key is this, the batch id, ":" and the kept-back row's seq. */
export const UPLOAD_KEY_PREFIX = "upload:";
/** upload_batches.source_label of a batch of found emails (the sweep never takes a batch with a source label). */
export const FOUND_SOURCE_LABEL = "Emails found";
/** The People Outcome that sends a person to leads (people-template.mjs PERSON_OUTCOMES). */
export const APPROVED_OUTCOME = "Approved email";
/** The People column that says what happened when a found person went to leads (phase 4: the engine never works it). */
export const ADD_COLUMN = "add_to_database";
/** The worker's heartbeat capability: it moves no-email rows, releases held People rows and asks for found emails to be added. */
export const UPLOAD_CAPABILITY = "upload_people";

/** upload_people.state (130). */
export const UPLOAD_PEOPLE_STATES = Object.freeze(["moving", "moved", "not_sent"]);

/** upload_people.reason for a not_sent upload, in plain words for the Uploads page. */
export const NOT_SENT_WHY = Object.freeze({
  no_tag: "The upload had no tag, so no client's People table takes its no-email rows.",
  not_client: "None of the upload's tags is a client tag, so no client's People table takes its no-email rows.",
  several: "The upload has more than one client tag, so no single client's People table takes its no-email rows.",
});
/** upload_people.reason while a moving upload waits, in plain words. */
export const WAIT_WHY = Object.freeze({
  originals_missing: "The client's People table can't be made yet: the Clay originals are not loaded.",
  retired_v1: "The client's People table can't be made yet: the client still has an old companies_v1 table.",
});

/** Copying no-email rows into a People table: rows a transaction, transactions a minute. */
export const MOVE_CHUNK = 1000;
export const MOVE_MAX_CHUNKS = 5;
/** A moving upload whose client's tables can't be made now is tried again after this long. */
export const MOVE_RETRY_MINUTES = 10;
/**
 * Releasing held People rows: rows a page, and the most rows of a People table
 * that may be queued, running or waiting at once. Held rows wait (free) until
 * the table has room, so a big upload never fills the worker's queue, and rows
 * that wait on a daily cap hold the rest back until the cap has room again.
 */
export const RELEASE_PAGE = 500;
export const RELEASE_OPEN_MAX = 2000;
/** Adding found emails: people a round, one round per upload at most this often (the worker), and when a round counts as dead. */
export const FOUND_ROUND_MAX = 1000;
export const FOUND_EVERY_MS = 10 * 60_000;
export const FOUND_STALE_HOURS = 3;

// ── The People template's gates on upload rows (people-template.mjs) ────────

/** True on every row that is not an upload row. */
export const NOT_UPLOAD_ROW = `{{found_by}} !== "${UPLOAD_FOUND_BY}"`;
/**
 * A paid step on an upload row runs only for a person inside the client's area
 * and clear of its rules: an upload never checked them, and a person outside
 * them can't become "Approved email". On every other row it is true without
 * reading either cell.
 */
export const UPLOAD_SPEND_GATE = `(${NOT_UPLOAD_ROW} || ({{in_area}} === true && !{{rule_match}}))`;
/** The People columns whose run condition takes UPLOAD_SPEND_GATE: Reoon (P#11), Enrichley (P#13, P#49, P#54) and the finders (P#46 to P#48, P#51 to P#53). */
export const UPLOAD_AREA_GATED = Object.freeze([
  "reoon_validation", "enrichly_validation",
  "find_work_email_findymail", "find_work_email_prospeo", "find_work_email_anymail_finder",
  "validate_email_anymail_finder_find_work_email",
  "find_work_email_from_linkedin_url_findymail", "find_work_email_and_enrich_person_from_linkedin_url",
  "find_work_email_from_linkedin_url_anymail_finder", "validate_email_anymail_finder_from_linkedin",
]);
/**
 * The People columns that never run on an upload row (NOT_UPLOAD_ROW): Current
 * Employer (P#27, OpenAI) and the personalisation steps (P#58, P#60, P#61).
 * Their answers never reach the lead the found email becomes: that lead is made
 * from the uploaded cells and the found email only.
 */
export const UPLOAD_NEVER = Object.freeze(["current_employer", "email_provider_check_api", "claygent", "question_ai"]);

// ── SQL terms both sides read the same way ──────────────────────────────────

/** The People row's Outcome cell (alias o) is "Approved email": exactly the terms enrich_cells_approved_idx (130) is built on. */
export const approvedCell = (o = "o") =>
  `${o}.column_key = 'person_outcome' AND ${o}.status = 'done' AND ${o}.value = '"${APPROVED_OUTCOME}"'::jsonb`;

/** A batch of found emails (alias b) still being imported: processing, and made less than FOUND_STALE_HOURS ago. */
export const liveFoundBatch = (b = "b") =>
  `${b}.status = 'processing' AND ${b}.created_at > now() - make_interval(hours => ${FOUND_STALE_HOURS})`;

/**
 * The People rows of one upload with an approved email still to add, oldest
 * first. $1 the People table, $2 the upload's source row (upload_people.source_id),
 * $3 at most this many, $4 true to take again the people an earlier round could
 * not store (the button), false for the worker's rounds. Still to add: no
 * add_to_database cell yet, or one left running by a round that is no longer
 * live. Rows being worked (queued, running) are left for later.
 * Columns: row_id, row_key, email (use_work_email, trimmed, lower case), add_status, add_batch.
 */
export const FOUND_TAKE_SQL = `
  SELECT r.id AS row_id, r.row_key, lower(btrim(w.value #>> '{}')) AS email,
         a.status AS add_status, a.value->>'batch_id' AS add_batch
    FROM enrich_cells o
    JOIN enrich_rows r ON r.id = o.row_id AND r.source_id = $2::uuid AND r.run_status IN ('done', 'waiting')
                      AND r.row_key LIKE '${UPLOAD_KEY_PREFIX}%'
    JOIN enrich_cells w ON w.row_id = r.id AND w.column_key = 'use_work_email' AND w.status = 'done'
    LEFT JOIN enrich_cells a ON a.row_id = r.id AND a.column_key = '${ADD_COLUMN}'
    LEFT JOIN upload_batches b ON a.status = 'running' AND b.id::text = a.value->>'batch_id'
   WHERE o.table_id = $1::uuid AND ${approvedCell("o")}
     AND (a.row_id IS NULL
          OR (a.status = 'running' AND NOT coalesce(${liveFoundBatch("b")}, false))
          OR ($4::boolean AND a.status = 'error'))
   ORDER BY r.id
   LIMIT $3`;

/**
 * The worker's question: which uploads have a found person still to add (as
 * FOUND_TAKE_SQL with $4 false), with no round of theirs under way. $1 at most
 * this many uploads, oldest first. Columns: batch_id, client_tag.
 */
export const FOUND_DUE_SQL = `
  SELECT p.batch_id, p.client_tag
    FROM upload_people p
   WHERE p.source_id IS NOT NULL AND p.table_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM upload_batches f WHERE f.source_batch_id = p.batch_id AND ${liveFoundBatch("f")})
     AND EXISTS (
       SELECT 1
         FROM enrich_cells o
         JOIN enrich_rows r ON r.id = o.row_id AND r.source_id = p.source_id AND r.run_status IN ('done', 'waiting')
                           AND r.row_key LIKE '${UPLOAD_KEY_PREFIX}%'
         JOIN enrich_cells w ON w.row_id = r.id AND w.column_key = 'use_work_email' AND w.status = 'done'
         LEFT JOIN enrich_cells a ON a.row_id = r.id AND a.column_key = '${ADD_COLUMN}'
         LEFT JOIN upload_batches b ON a.status = 'running' AND b.id::text = a.value->>'batch_id'
        WHERE o.table_id = p.table_id AND ${approvedCell("o")}
          AND (a.row_id IS NULL OR (a.status = 'running' AND NOT coalesce(${liveFoundBatch("b")}, false))))
   ORDER BY p.created_at, p.batch_id
   LIMIT $1`;

// ── Text ────────────────────────────────────────────────────────────────────

/**
 * Cells that mean "nothing here": the same list as src/lib/uploads/constants.ts
 * BLANKISH_VALUES (scripts/test-upload-people.mjs checks they stay the same).
 */
export const BLANKISH_VALUES = Object.freeze(["", "--", "-", "there", "#ERROR!", "N/A", "n/a", "NA", "null", "NULL", "None", "none"]);
const BLANKISH = new Set(BLANKISH_VALUES.map((v) => v.toLowerCase()));
export const isBlankish = (v) => v == null || BLANKISH.has(String(v).trim().toLowerCase());

/** A cell as text: NULs taken out, trimmed, at most 5,000 characters (as insertRows keeps an input). */
const cell = (v) => (v == null || typeof v === "object" ? "" : String(v).replace(/\u0000/g, "").trim().slice(0, 5000));
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/** The company as the lead database holds it: the first non-empty "|" part, spaces made single (cleanCompanyName). */
export const companyAsUploaded = (v) => cell(v).split("|").map(oneLine).find(Boolean) ?? "";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** An address the import stores as an email (src/lib/uploads/import-rows.ts isImportableEmail), after trimming and lower-casing. */
export function isUsableAddress(email) {
  const e = cell(email).toLowerCase();
  return Boolean(e) && !isBlankish(e) && EMAIL_RE.test(e);
}

// ── Which client's People table ─────────────────────────────────────────────

/**
 * Which client's People table an upload's no-email rows go to: the one tag of
 * the upload that is a client tag. Tags that are not client tags don't count.
 * why, when there is none: "before" (the batch was made before 130, its tags
 * are unknown), "no_tag", "not_client" or "several" (NOT_SENT_WHY).
 *
 * @param {readonly string[] | null | undefined} addTags  upload_batches.add_tags
 * @param {Iterable<string>} clientTags  every client_tags.tag
 * @returns {{ tag: string | null, why: null | "before" | "no_tag" | "not_client" | "several" }}
 */
export function routeTagOf(addTags, clientTags) {
  if (addTags == null) return { tag: null, why: "before" };
  const known = new Set([...(clientTags ?? [])].map(normTag).filter(Boolean));
  const tags = [...new Set([...addTags].map(normTag).filter(Boolean))];
  if (!tags.length) return { tag: null, why: "no_tag" };
  const clients = tags.filter((t) => known.has(t));
  if (!clients.length) return { tag: null, why: "not_client" };
  if (clients.length > 1) return { tag: null, why: "several" };
  return { tag: clients[0], why: null };
}

/**
 * The tags a batch of found emails stamps: the upload's own, then the client's
 * tag unless it is there already (in any case), as fn_merge_tags joins tags:
 * order kept, the first spelling wins.
 *
 * @param {readonly string[] | null | undefined} addTags
 * @param {string | null | undefined} clientTag
 * @returns {string[]}
 */
export function foundTags(addTags, clientTag) {
  const seen = new Map();
  for (const t of [...(addTags ?? []), clientTag ?? ""]) {
    const v = cell(t);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

// ── A kept-back row as a People row ─────────────────────────────────────────

/** An upload's People row key. */
export function uploadRowKey(batchId, seq) {
  const s = Number(seq);
  if (!batchId || !Number.isInteger(s) || s < 0) throw new Error(`uploadRowKey: a batch id and a whole seq are needed (got ${batchId}, ${seq})`);
  return `${UPLOAD_KEY_PREFIX}${String(batchId).toLowerCase()}:${s}`;
}

const ROW_KEY = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,9})$/;
/** { batchId, seq } from an upload's People row key, or null for any other key. */
export function parseUploadRowKey(key) {
  const m = ROW_KEY.exec(String(key ?? ""));
  if (!m) return null;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) && seq <= 2_147_483_647 ? { batchId: m[1], seq } : null;
}

/** The Source a People row shows for an upload. */
export const uploadSourceLabel = (filename) => `Upload: ${oneLine(cell(filename)) || "a file"}`.slice(0, 300);

/**
 * The upload's fields in one kept-back row, by the batch's field mapping, as
 * normalizeRow reads them: each mapped column's cell, trimmed, placeholders
 * left out, and a later column of the same field winning over an earlier one.
 *
 * @param {readonly unknown[]} raw  upload_holdbacks.raw
 * @param {Record<string, string> | null | undefined} fieldMapping  upload_batches.field_mapping ({ index: field })
 * @returns {Record<string, string>}
 */
export function uploadedFields(raw, fieldMapping) {
  const out = {};
  const cells = Array.isArray(raw) ? raw : [];
  for (const [index, field] of Object.entries(fieldMapping ?? {})) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || typeof field !== "string" || !field) continue;
    const v = cell(cells[i]);
    if (!v || isBlankish(v)) continue;
    out[field] = v;
  }
  return out;
}

/**
 * One kept-back row as the input cells of a People row: the person's name,
 * title, company, LinkedIn link and place, and the company's website, phone,
 * address and categories, from the uploaded cells; the client's tag; found_by
 * "upload", stage "uploaded" and the Source "Upload: <file>". Only cells with a
 * value are given. The email input stays empty: the row was kept back for not
 * having a usable one.
 *
 * @param {{ raw: readonly unknown[], fieldMapping: Record<string, string> | null | undefined, clientTag: string, filename: string }} row
 * @returns {Record<string, string>}
 */
export function uploadPeopleInputs({ raw, fieldMapping, clientTag, filename }) {
  const f = uploadedFields(raw, fieldMapping);
  const first = f.first_name ?? "";
  const last = f.last_name ?? "";
  const inputs = {
    client_tag: normTag(clientTag),
    found_by: UPLOAD_FOUND_BY,
    stage: UPLOAD_STAGE,
    source: uploadSourceLabel(filename),
    person_first_name: first,
    person_last_name: last,
    written_full_name: oneLine([first, last].filter(Boolean).join(" ")),
    written_title: oneLine(f.title ?? ""),
    written_company: companyAsUploaded(f.company),
    company_website: bareDomain(f.domain) ?? "",
    written_person_linkedin_url: f.person_linkedin ?? "",
    written_city: f.city ?? "",
    written_state: f.state ?? "",
    written_company_address: f.address ?? "",
    written_company_phone_number: f.company_phone ?? "",
    written_category: f.category ?? "",
    written_sub_category: f.subcategory ?? "",
  };
  return Object.fromEntries(Object.entries(inputs).filter(([, v]) => v));
}

/** The People inputs a row's search text is made of before it is worked (pipeline-actions.mjs SEARCH_CELLS.people). */
export const PEOPLE_SEARCH_INPUTS = Object.freeze(["written_full_name", "written_title", "written_company", "company_website", "written_city", "written_state"]);
/** A People row's search text from its inputs: lower case, at most 2,000 characters. */
export function peopleSearchText(inputs) {
  return PEOPLE_SEARCH_INPUTS.map((k) => inputs?.[k]).filter(Boolean).join(" ").toLowerCase().slice(0, 2000);
}

// ── A found person as an import row ─────────────────────────────────────────

/**
 * Upload fields that describe the kept-back address rather than the person:
 * blank in a found person's import row, so the found address gets its own
 * (the import detects the mail provider and the email type again; no
 * validation status or bounce is claimed for it).
 */
export const ADDRESS_FIELDS = Object.freeze(["validation_status", "is_bounced", "esp", "email_type"]);

/**
 * How a batch of found emails is imported: the upload's own header row and
 * field mapping, with every column mapped to email given the found address,
 * an "Email" column added at the end when the upload mapped none, and the
 * ADDRESS_FIELDS columns blank. One layout per upload, so every row of a round
 * has the same width.
 *
 * @param {readonly unknown[] | null | undefined} sourceHeaders  upload_batches.source_headers
 * @param {Record<string, string> | null | undefined} fieldMapping  upload_batches.field_mapping
 * @returns {{ headers: string[], fieldMapping: Record<number, string>, width: number, emailIdx: number[], clearIdx: number[], appended: boolean }}
 */
export function foundImportLayout(sourceHeaders, fieldMapping) {
  const headers = (Array.isArray(sourceHeaders) ? sourceHeaders : []).map((h) => (h == null ? "" : String(h)));
  /** @type {Record<number, string>} */
  const mapping = {};
  for (const [index, field] of Object.entries(fieldMapping ?? {})) {
    const i = Number(index);
    if (Number.isInteger(i) && i >= 0 && typeof field === "string" && field) mapping[i] = field;
  }
  let width = Math.max(headers.length, 0, ...Object.keys(mapping).map((k) => Number(k) + 1));
  const emailIdx = Object.keys(mapping).map(Number).filter((i) => mapping[i] === "email");
  let appended = false;
  if (!emailIdx.length) {
    mapping[width] = "email";
    emailIdx.push(width);
    width++;
    appended = true;
  }
  while (headers.length < width) headers.push("");
  if (appended) headers[width - 1] = "Email";
  const clearIdx = Object.keys(mapping).map(Number).filter((i) => ADDRESS_FIELDS.includes(mapping[i]));
  return { headers, fieldMapping: mapping, width, emailIdx: emailIdx.sort((a, b) => a - b), clearIdx: clearIdx.sort((a, b) => a - b), appended };
}

/**
 * A found person's import row: the kept-back row's cells, padded or cut to the
 * layout's width as the download does, the found address (trimmed, lower case)
 * in every email column, and the ADDRESS_FIELDS columns blank.
 *
 * @param {ReturnType<typeof foundImportLayout>} layout
 * @param {readonly unknown[]} raw  upload_holdbacks.raw
 * @param {string} email
 * @returns {string[]}
 */
export function foundImportRow(layout, raw, email) {
  const cells = Array.isArray(raw) ? raw : [];
  const row = Array.from({ length: layout.width }, (_, i) => (cells[i] == null ? "" : String(cells[i])));
  for (const i of layout.clearIdx) row[i] = "";
  const address = cell(email).toLowerCase();
  for (const i of layout.emailIdx) row[i] = address;
  return row;
}

/** A batch of found emails' file name, as the Uploads page shows it. */
export function foundBatchFilename(filename, at = new Date()) {
  const stamp = new Date(at).toISOString().slice(0, 16).replace("T", " ");
  return `${FOUND_SOURCE_LABEL} · ${oneLine(cell(filename)) || "an upload"} · ${stamp} UTC`.slice(0, 500);
}

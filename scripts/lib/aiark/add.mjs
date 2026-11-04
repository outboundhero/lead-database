// Where a pull's people go. With an email: the database. Their Outcome is "Ready
// to add" and they become leads, once each. The web app (src/lib/aiark/add-run.ts)
// starts an add here, runs the import through the Uploads page's engine
// (src/lib/uploads/import-rows.ts, duplicates skipped, never merged) and then
// settles each person here. With no email: the pipeline. They wait in the pull's
// table for the email-finding steps, and emailFound() brings them back: a person
// given an address is worked again, and goes to the database like anyone else.
//
// The worker starts an add when a pull has finished (pullsToAdd, requestAdd), if
// AIARK_AUTO_ADD_URL and AIARK_AUTO_ADD_KEY are set on it and the key on the web
// service. Until then, and for a cancelled pull, it takes the button on the Clay
// tab. Plain JavaScript so the worker and the test script can reach it.
//
// Each person's add_to_database cell says what happened to them:
//   running  {batch_id}                         being added by that upload batch
//   done     {added: true, lead_id, batch_id}   a new lead
//   done     {added: false, reason, lead_id}    skipped: already a lead or in the
//                                               Email Bison copy (reason lead /
//                                               bison), or never contact
//   error    {batch_id}                         the import could not store them;
//                                               the next add tries again
// The engine never works that column (phase 4), so nothing else writes it.

export const ADD_COLUMN = "add_to_database";
export const SOURCE = "AI Ark";
const READY = "Ready to add";
const NO_EMAIL = "No email";
const AUTO_ADD_KEY_MIN = 32; // the web route refuses a shorter one
const AUTO_ADD_WAIT_MS = 30_000;
/** An add whose upload batch is still 'processing' after this long died with the server; its people can be added again. */
export const STALE_HOURS = 3;

/** The cells an add reads for each person. */
export const ADD_INPUT_KEYS = [
  "email", "first_name", "last_name", "full_name", "title", "seniority", "company", "domain", "company_industry",
  "company_size", "city", "state", "country", "linkedin", "company_linkedin", "company_description", "email_verdict",
];

/**
 * The import's columns: [header, leads field]. AI Ark's industry and company
 * description go to general_industry and specific_industry: both are among the
 * columns the send gate checks for the client's exclusion terms (the Outcome
 * checked the same two texts), and neither is sent to Email Bison. Category
 * stays empty: AI Ark's industries are not the database's categories.
 */
export const IMPORT_COLUMNS = [
  ["Email", "email"],
  ["First Name", "first_name"],
  ["Last Name", "last_name"],
  ["Title", "title"],
  ["Company", "company"],
  ["Domain", "domain"],
  ["City", "city"],
  ["State", "state"],
  ["Country", "country"],
  ["Person LinkedIn", "person_linkedin"],
  ["Company LinkedIn", "company_linkedin"],
  ["Seniority", "seniority"],
  ["Industry", "general_industry"],
  ["Company Description", "specific_industry"],
  ["Employees", "company_size"],
  ["Validation Status", "validation_status"],
  ["Source", "source"],
];

/** leads columns the import writes that the Uploads page doesn't offer (ImportConfig.extraFields). */
export const EXTRA_FIELDS = ["country", "seniority", "general_industry", "specific_industry", "company_size"];

/** First and last name: AI Ark's own when the row has them, else the full name split at its first space. */
export function names(c) {
  const first = (c.first_name ?? "").trim();
  const last = (c.last_name ?? "").trim();
  if (first || last) return [first, last];
  const full = (c.full_name ?? "").trim().replace(/\s+/g, " ");
  const at = full.indexOf(" ");
  return at < 0 ? [full, ""] : [full.slice(0, at), full.slice(at + 1)];
}

/** AI Ark's headcount, only when it gave one ("1,234 (1,001–5,000)"): a band alone is not a number of employees. */
export function headcount(size) {
  const m = /^(\d[\d,]*)(?:\s|$)/.exec((size ?? "").trim());
  return m ? m[1].replace(/,/g, "") : "";
}

/**
 * One person as an import row, in IMPORT_COLUMNS order. A Ready to add person's
 * email passed AI Ark's check, as Valid or Catch-all.
 * @param {Record<string, string>} c the person's cells
 * @returns {string[]}
 */
export function importRow(c) {
  const [first, last] = names(c);
  const v = {
    email: c.email,
    first_name: first,
    last_name: last,
    title: c.title,
    company: c.company,
    domain: c.domain,
    city: c.city,
    state: c.state,
    country: c.country,
    person_linkedin: c.linkedin,
    company_linkedin: c.company_linkedin,
    seniority: c.seniority,
    general_industry: c.company_industry,
    specific_industry: c.company_description,
    company_size: headcount(c.company_size),
    validation_status: c.email_verdict === "Catch-all" ? "catch_all" : "valid",
    source: SOURCE,
  };
  return IMPORT_COLUMNS.map(([, k]) => String(v[k] ?? ""));
}

// An add is under way while its batch is still processing, for STALE_HOURS at most.
const LIVE_BATCH = `b.status = 'processing' AND b.created_at > now() - make_interval(hours => ${STALE_HOURS})`;

/**
 * Where a run table's people stand. `ready` is who an add would take now: Ready
 * to add and not settled, which includes anyone an earlier add could not store.
 * `pipeline` is who has no email, waiting for the email-finding steps.
 * @param {{ query: Function }} db
 * @param {string} tableId
 * @returns {Promise<{ ready: number, added: number, skipped: number, adding: number, failed: number, pipeline: number }>}
 */
export async function addState(db, tableId) {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE x.ready AND x.status IS DISTINCT FROM 'done' AND NOT x.adding)::int AS ready,
            count(*) FILTER (WHERE x.status = 'done' AND x.added)::int AS added,
            count(*) FILTER (WHERE x.status = 'done' AND NOT x.added)::int AS skipped,
            count(*) FILTER (WHERE x.adding)::int AS adding,
            count(*) FILTER (WHERE x.status = 'error')::int AS failed,
            count(*) FILTER (WHERE x.no_email)::int AS pipeline
       FROM (SELECT (o.value #>> '{}') = $2 AS ready, (o.value #>> '{}') = $4 AS no_email, a.status,
                    coalesce((a.value->>'added')::boolean, false) AS added,
                    coalesce(a.status = 'running' AND ${LIVE_BATCH}, false) AS adding
               FROM enrich_rows r
               JOIN enrich_cells o ON o.row_id = r.id AND o.column_key = 'outcome' AND o.status = 'done'
               LEFT JOIN enrich_cells a ON a.row_id = r.id AND a.column_key = $3
               LEFT JOIN upload_batches b ON a.status = 'running' AND b.id::text = a.value->>'batch_id'
              WHERE r.table_id = $1) x`,
    [tableId, READY, ADD_COLUMN, NO_EMAIL]
  );
  return r;
}

/**
 * Finished live pulls with someone to send to the database: a person Ready to
 * add who has not been tried, or whose add died with the server. Someone an add
 * could not store is left to the button, so one bad person can't repeat forever.
 * A pull is taken only once its rows are all worked, so it makes one upload. A
 * cancelled pull is left to the button too: someone stopped it on purpose.
 * @param {{ query: Function }} db
 * @returns {Promise<{ id: string, client_tag: string }[]>}
 */
export async function pullsToAdd(db, limit = 5) {
  const { rows } = await db.query(
    `SELECT r.id, r.client_tag
       FROM aiark_runs r
      WHERE r.mode = 'live' AND r.finished_at IS NOT NULL AND r.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM enrich_rows q WHERE q.table_id = r.table_id AND q.run_status IN ('queued', 'running'))
        AND EXISTS (
          SELECT 1 FROM enrich_cells o
            LEFT JOIN enrich_cells a ON a.row_id = o.row_id AND a.column_key = $2
            LEFT JOIN upload_batches b ON a.status = 'running' AND b.id::text = a.value->>'batch_id'
           WHERE o.table_id = r.table_id AND o.column_key = 'outcome' AND o.status = 'done' AND o.value #>> '{}' = $1
             AND (a.row_id IS NULL OR (a.status = 'running' AND NOT coalesce(${LIVE_BATCH}, false))))
      ORDER BY r.finished_at
      LIMIT $3`,
    [READY, ADD_COLUMN, limit]
  );
  return rows;
}

/** The address and key that let the worker start adds, or null: then pulls wait for the button. */
export function autoAddConfig(env = process.env) {
  const url = String(env.AIARK_AUTO_ADD_URL ?? "").trim();
  const key = String(env.AIARK_AUTO_ADD_KEY ?? "").trim();
  return url && key.length >= AUTO_ADD_KEY_MIN ? { url, key } : null;
}

/**
 * Asks the web app to add one pull's people. The import engine is TypeScript the
 * worker can't load, and uploads run there too. Never throws: the worker asks
 * again on its next round.
 * @returns {Promise<{ ok: boolean, status: number | null, why: string | null }>}
 */
export async function requestAdd(config, runId, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ run: runId }),
      signal: AbortSignal.timeout(AUTO_ADD_WAIT_MS),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, why: res.ok ? null : String(json?.error ?? "no reason given").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, why: String(e?.name === "TimeoutError" ? "no answer in time" : e?.cause?.code ?? e?.message ?? e).slice(0, 300) };
  }
}

/**
 * The way back from the pipeline. An email-finding step hands over the address
 * it found for someone with no email; the person's email cells take it and the
 * row is worked again, like a person AI Ark found the address for: the same
 * checks and Outcome, and Ready to add goes to the database. Only someone whose
 * Outcome is still "No email", and whose row isn't being worked, is changed.
 * @param {{ query: Function }} db
 * @param {{ rowId: number, email: string, status?: string, domainType?: string }} found
 * @returns {Promise<boolean>} whether the person was changed
 */
export async function emailFound(db, { rowId, email, status = "VALID", domainType = "SMTP" }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return false;
  const cells = { email: address, email_status: status, email_domain_type: domainType };
  const { rows: [r] } = await db.query(
    `WITH target AS (
       SELECT q.id, q.table_id FROM enrich_rows q
         JOIN enrich_cells o ON o.row_id = q.id AND o.column_key = 'outcome' AND o.status = 'done' AND o.value #>> '{}' = $3
        WHERE q.id = $1 AND q.run_status <> 'running'
          FOR UPDATE OF q
     ), c AS (
       INSERT INTO enrich_cells AS e (row_id, column_key, table_id, status, value, display, updated_at)
       SELECT t.id, kv.key, t.table_id, 'done', to_jsonb(kv.value), left(kv.value, 300), now()
         FROM target t CROSS JOIN LATERAL jsonb_each_text($2::jsonb) AS kv
       ON CONFLICT (row_id, column_key) DO UPDATE
         SET status = 'done', value = EXCLUDED.value, display = EXCLUDED.display, note = NULL, updated_at = now()
     ), p AS (
       UPDATE aiark_people SET email = $4, email_status = $5 WHERE row_id = (SELECT id FROM target)
     )
     UPDATE enrich_rows q
        SET run_status = 'queued', next_run_at = now(), attempts = 0, claim_token = NULL, claimed_at = NULL, last_error = NULL, updated_at = now()
       FROM target t WHERE q.id = t.id
     RETURNING q.id`,
    [rowId, JSON.stringify(cells), NO_EMAIL, address, status]
  );
  return Boolean(r);
}

/**
 * Starts an add, inside the caller's transaction (which holds the run's lock).
 * Takes the people ready to add; settles at once anyone who has since become a
 * lead, reached the Email Bison copy or the never-contact list; creates the
 * upload batch for the rest and marks their cells running. `busy` when another
 * add of this table is still under way.
 * @param {{ query: Function }} db
 * @param {{ tableId: string, userId: string | null, filename: string }} opts
 * @returns {Promise<{ busy: true } | { busy: false, batchId: string | null, batchAt: string | null, rows: string[][], people: { row_id: number, email: string }[], skipped: number }>}
 */
export async function beginAdd(db, { tableId, userId, filename }) {
  const { rows: live } = await db.query(
    `SELECT 1 FROM enrich_rows r
       JOIN enrich_cells a ON a.row_id = r.id AND a.column_key = $2 AND a.status = 'running'
       JOIN upload_batches b ON b.id::text = a.value->>'batch_id' AND ${LIVE_BATCH}
      WHERE r.table_id = $1 LIMIT 1`,
    [tableId, ADD_COLUMN]
  );
  if (live.length) return { busy: true };

  const { rows: ready } = await db.query(
    `SELECT r.id AS row_id,
            (SELECT jsonb_object_agg(c.column_key, c.value #>> '{}') FROM enrich_cells c
              WHERE c.row_id = r.id AND c.status = 'done' AND c.column_key = ANY ($3::text[])) AS cells
       FROM enrich_rows r
       JOIN enrich_cells o ON o.row_id = r.id AND o.column_key = 'outcome' AND o.status = 'done' AND o.value #>> '{}' = $2
       LEFT JOIN enrich_cells a ON a.row_id = r.id AND a.column_key = $4
      WHERE r.table_id = $1 AND a.status IS DISTINCT FROM 'done'
      ORDER BY r.id`,
    [tableId, READY, ADD_INPUT_KEYS, ADD_COLUMN]
  );
  const people = ready
    .map((r) => ({ row_id: Number(r.row_id), cells: r.cells ?? {} }))
    .filter((p) => p.cells.email)
    .map((p) => ({ ...p, email: String(p.cells.email).trim().toLowerCase() }));
  if (!people.length) return { busy: false, batchId: null, batchAt: null, rows: [], people: [], skipped: 0 };

  // The outcome was worked out when the person was pulled; the database may have moved on since.
  const { rows: known } = await db.query(
    `SELECT e.email, l.id AS lead_id,
            EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = e.email) AS never_contact,
            EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = e.email) AS in_bison
       FROM unnest($1::text[]) AS e(email) LEFT JOIN leads l ON l.email = e.email`,
    [[...new Set(people.map((p) => p.email))]]
  );
  const byEmail = new Map(known.map((k) => [k.email, k]));
  const settled = [];
  const toAdd = [];
  for (const p of people) {
    const k = byEmail.get(p.email);
    const reason = k?.never_contact ? "never_contact" : k?.lead_id ? "lead" : k?.in_bison ? "bison" : null;
    if (reason) settled.push({ row_id: p.row_id, lead_id: k.lead_id ?? null, reason });
    else toAdd.push(p);
  }
  if (settled.length) {
    await db.query(
      `INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
       SELECT x.row_id, $2, $3, 'done', jsonb_build_object('added', false, 'reason', x.reason, 'lead_id', x.lead_id),
              CASE x.reason WHEN 'never_contact' THEN 'On the never-contact list' ELSE 'Already in the database' END,
              CASE x.reason
                WHEN 'never_contact' THEN 'Skipped: the address went on the never-contact list after this person was pulled.'
                WHEN 'lead' THEN 'Skipped: a lead with this address reached the database after this person was pulled; it was left as it was.'
                ELSE 'Skipped: the address reached the copy of Email Bison after this person was pulled, which counts as already in the database.'
              END,
              now()
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, lead_id uuid, reason text)
       ON CONFLICT (row_id, column_key) DO UPDATE
          SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note, updated_at = now()`,
      [JSON.stringify(settled), ADD_COLUMN, tableId]
    );
  }
  if (!toAdd.length) return { busy: false, batchId: null, batchAt: null, rows: [], people: [], skipped: settled.length };

  const { rows: [batch] } = await db.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, source_label)
     VALUES ($1, $2, $3, 'processing', 'skip', $4::jsonb, $5::jsonb, 'leads', $6)
     RETURNING id, created_at`,
    [
      userId, filename, toAdd.length,
      JSON.stringify(Object.fromEntries(IMPORT_COLUMNS.map(([, k], i) => [i, k]))),
      JSON.stringify(IMPORT_COLUMNS.map(([h]) => h)),
      SOURCE,
    ]
  );
  await db.query(
    `INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
     SELECT id, $2, $3, 'running', jsonb_build_object('batch_id', $4::text), 'Adding…', NULL, now() FROM unnest($1::bigint[]) AS id
     ON CONFLICT (row_id, column_key) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = NULL, updated_at = now()`,
    [toAdd.map((p) => p.row_id), ADD_COLUMN, tableId, batch.id]
  );
  return {
    busy: false,
    batchId: batch.id,
    batchAt: batch.created_at instanceof Date ? batch.created_at.toISOString() : String(batch.created_at),
    rows: toAdd.map((p) => importRow(p.cells)),
    people: toAdd.map(({ row_id, email }) => ({ row_id, email })),
    skipped: settled.length,
  };
}

/**
 * Settles each person an add's batch took, from what the database holds after
 * the import: a lead with source AI Ark created since the batch began is this
 * add's; a lead otherwise was there first (another writer won the race); no
 * lead means the import could not store the person. Only cells still marked
 * running for this batch are written.
 * @param {{ query: Function }} db
 * @param {{ tableId: string, batchId: string, batchAt: string, people: { row_id: number, email: string }[] }} opts
 */
export async function finishAdd(db, { tableId, batchId, batchAt, people }) {
  if (!people.length) return;
  await db.query(
    `WITH m AS (
       SELECT x.row_id, l.id AS lead_id, coalesce(l.source = $5 AND l.created_at >= $4::timestamptz, false) AS mine
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, email text)
         LEFT JOIN leads l ON l.email = x.email
     )
     INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
     SELECT m.row_id, $2, $3,
            CASE WHEN m.lead_id IS NULL THEN 'error' ELSE 'done' END,
            CASE WHEN m.lead_id IS NULL THEN jsonb_build_object('batch_id', $6::text)
                 WHEN m.mine THEN jsonb_build_object('added', true, 'lead_id', m.lead_id, 'batch_id', $6::text)
                 ELSE jsonb_build_object('added', false, 'reason', 'lead', 'lead_id', m.lead_id, 'batch_id', $6::text) END,
            CASE WHEN m.lead_id IS NULL THEN 'Not added' WHEN m.mine THEN 'Added' ELSE 'Already in the database' END,
            CASE WHEN m.lead_id IS NULL THEN 'The import could not store this person (the batch''s errors on the Uploads page say why). The next add tries again.'
                 WHEN m.mine THEN 'Added to the lead database with source AI Ark, tagged with the client.'
                 ELSE 'Skipped: a lead with this address reached the database while this add ran; it was left as it was.' END,
            now()
       FROM m
     ON CONFLICT (row_id, column_key) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note, updated_at = now()
      WHERE c.status = 'running' AND c.value->>'batch_id' = $6`,
    [JSON.stringify(people), ADD_COLUMN, tableId, batchAt, SOURCE, batchId]
  );
}

// Which leads a question job writes (139), and the export popup's readiness
// counts.
//
// The job's leads are the leads the export popup's push batch for the same
// selection would gather, minus the leads that already hold a current value
// (a done value of the variable's current prompt version) unless the job
// rewrites them, capped at the job's max_leads, else 250,000.
//
// THE PUSH SET IS MIRRORED FROM scripts/push-worker.mjs gatherCycle (read
// only, never imported: importing it starts the worker). A selection is stored
// the way POST /api/bison/push-batch stores a batch (selectionOf: filters as
// filters as buildRpcFilters makes them, selected_ids, range_from, range_to, max_leads, client_tag,
// email_side, push_options), and the set is built the same way:
//   - selected ids: the ids that pass the eligibility gate (ELIGIBLE); range
//     and max_leads are not read, as the push reads neither on that path;
//   - filters: fn_lead_filter_conditions(filters), the eligibility gate and
//     the client's accounting (already sent for the client left out unless
//     includeAlreadyPushed; onlyNewSinceLast; retryFailed), in l.id order,
//     the range's offset on the first page only and the range or max_leads as
//     the most leads, in keyset pages of 5,000.
// One difference, which changes nothing: before a push is queued no item
// belongs to it, so the push's "pi.batch_id <> <the batch>" and "id <> <the
// batch>" hold for every row and are left out.
//
// PUSH_GATHER_PINS are the lines of push-worker.mjs this file copies.
// scripts/test-question-variables.mjs fails when any of them is no longer in
// the push-worker (whitespace aside): then read gatherCycle again, bring this
// file in line, and update the pins. The same suite runs the push-worker's own
// gatherCycle, cut out of its source, against this file on made-up leads.
//
// Every statement here is bounded (a page of 5,000 at most) and runs in its
// own transaction with SET LOCAL statement_timeout: never a session-level SET
// (CLAUDE.md, "Running long jobs against production").

/** The push's eligibility gate, as gatherCycle reads it. */
export const ELIGIBLE =
  `l.email is not null and l.email <> '' and l.is_bounced = false ` +
  `and (l.validation_status in ('valid','catch_all') or l.validation_status is null)`;

/** The push's keyset page, and the job's snapshot chunk. */
export const GATHER_CHUNK = 5000;
/** The most leads one job writes when it sets no max_leads. */
export const JOB_CAP = 250_000;
/** Each gather statement's time limit (the enrich-worker's pool gives up at 70 s). */
export const GATHER_STATEMENT_MS = 60_000;

/** The lines of scripts/push-worker.mjs this file mirrors (compared whitespace aside). */
export const PUSH_GATHER_PINS = Object.freeze([
  "const GATHER_CHUNK = 5000;",
  "if (batch.selected_ids?.length) {",
  "const skipSent = batch.push_options?.skipAlreadySent === true && Boolean(batch.client_tag);",
  "`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}${skipSent ? ` and ${NOT_SENT_FOR_CLIENT}` : \"\"}`,",
  "`select fn_lead_filter_conditions($1::jsonb) as conds`,",
  "[JSON.stringify(batch.filters ?? {})]",
  "const opts = batch.push_options ?? {};",
  "if (batch.client_tag) {",
  "const tagLit = `'${String(batch.client_tag).replace(/'/g, \"''\")}'`;",
  "if (opts.includeAlreadyPushed !== true) {",
  "accounting.push(`not exists ( select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id where pb.client_tag = ${tagLit} and pi.lead_id = l.id and pi.status = 'sent' and pi.batch_id <> '${batch.id}')`);",
  "if (opts.onlyNewSinceLast === true) {",
  "`select max(created_at) as at from push_batches where client_tag = $1 and id <> $2 and status in ('processing','complete')`,",
  "if (last?.at) accounting.push(`l.created_at > '${new Date(last.at).toISOString()}'::timestamptz`);",
  "if (opts.retryFailed === true) {",
  "accounting.push(`exists ( select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id where pb.client_tag = ${tagLit} and pi.lead_id = l.id and pi.status = 'failed')`);",
  "const where = [...(c?.conds ?? []), ELIGIBLE, ...accounting].join(\" and \");",
  "const from = batch.range_from;",
  "const span = batch.range_to != null ? batch.range_to - (from ?? 1) + 1 : null;",
  "let remaining = span ?? batch.max_leads ?? null;",
  "let offset = from != null && from > 1 ? Number(from) - 1 : 0;",
  "const page = remaining != null ? Math.min(GATHER_CHUNK, remaining) : GATHER_CHUNK;",
  "if (page <= 0) break;",
  "let sql = `select l.id, l.email from leads l where ${where}`;",
  "if (lastId != null) { params.push(lastId); sql += ` and l.id > $${params.length}`; }",
  "sql += ` order by l.id limit $${params.length}`;",
  "if (offset > 0) { params.push(offset); sql += ` offset $${params.length}`; }",
  "offset = 0;",
  "if (pageRows.length === 0) break;",
  "if (remaining != null) remaining -= pageRows.length;",
  "if (pageRows.length < page) break;",
]);

/**
 * The lines of src/app/api/bison/push-batch/route.ts that turn the popup's body
 * into the batch's fields, which selection.ts (src/lib/questions) copies.
 */
export const PUSH_ROUTE_PINS = Object.freeze([
  "...buildRpcFilters(normalizeFilterState(body.filters)),",
  "...(emailSide ? { emailSide } : {}),",
  "...(clientTag ? { applyClientTargeting: clientTag } : {}),",
  "const p_filters = !hasSelectedIds && body.filters",
  "let storedSelectedIds: string[] | null = hasSelectedIds ? selectedIds! : null;",
  "storedSelectedIds = await idsOfSide(getPool(), selectedIds!, emailSide);",
  "includeAlreadyPushed: body.pushOptions.includeAlreadyPushed === true,",
  "onlyNewSinceLast: body.pushOptions.onlyNewSinceLast === true,",
  "retryFailed: body.pushOptions.retryFailed === true,",
  "range_from: rangeFrom ?? null,",
  "range_to: rangeTo ?? null,",
  "max_leads: body.maxLeads ?? null,",
]);

/**
 * One company's key, in SQL over a leads row "l": its domain, lower case, else
 * company|city|state (company and city lower case), at most 300 characters;
 * NULL with neither. The question writer reads it with each lead and the
 * readiness counts read it the same way, so a key is only ever made here.
 */
export const COMPANY_KEY_SQL =
  `(CASE WHEN nullif(btrim(l.domain), '') IS NOT NULL THEN left(lower(btrim(l.domain)), 300)` +
  ` WHEN nullif(btrim(l.company), '') IS NOT NULL` +
  ` THEN left(lower(btrim(l.company)) || '|' || lower(coalesce(btrim(l.city), '')) || '|' || coalesce(btrim(l.state), ''), 300)` +
  ` ELSE NULL END)`;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {{ connect: () => Promise<Db & { release: () => void }> }} Pool
 * @typedef {{
 *   filters: Record<string, unknown> | null, selected_ids: string[] | null,
 *   range_from: number | null, range_to: number | null, max_leads: number | null,
 *   client_tag: string | null, email_side: "b2b" | "b2c" | null,
 *   push_options: { includeAlreadyPushed: boolean, onlyNewSinceLast: boolean, retryFailed: boolean } | null,
 * }} Selection
 */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const whole = (v) => (Number.isInteger(v) ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stored selection, made safe to read: the fields push-batch stores on a
 * batch, anything else dropped.
 * @param {unknown} raw  question_jobs.selection
 * @returns {Selection}
 */
export function selectionOf(raw) {
  const s = isObject(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const ids = Array.isArray(s.selected_ids) ? s.selected_ids.filter((x) => typeof x === "string" && UUID.test(x)) : [];
  const po = isObject(s.push_options) ? s.push_options : null;
  return {
    filters: isObject(s.filters) ? s.filters : null,
    selected_ids: ids.length ? ids : null,
    range_from: whole(s.range_from),
    range_to: whole(s.range_to),
    max_leads: whole(s.max_leads),
    client_tag: typeof s.client_tag === "string" && s.client_tag.trim() ? s.client_tag.trim() : null,
    email_side: s.email_side === "b2b" || s.email_side === "b2c" ? s.email_side : null,
    push_options: po
      ? { includeAlreadyPushed: po.includeAlreadyPushed === true, onlyNewSinceLast: po.onlyNewSinceLast === true, retryFailed: po.retryFailed === true }
      : null,
  };
}

/** Pushes a value onto a statement's parameters and gives its placeholder. */
function param(params, value) {
  params.push(value);
  return `$${params.length}`;
}

/** The range as gatherCycle reads it: the first page's offset, and the most leads (null: no limit). */
export function rangeOf(sel) {
  const from = sel.range_from;
  const span = sel.range_to != null ? sel.range_to - (from ?? 1) + 1 : null;
  const remaining = span ?? sel.max_leads ?? null;
  const offset = from != null && from > 1 ? Number(from) - 1 : 0;
  return { remaining, offset };
}

/**
 * The filters path's WHERE (over leads l), as gatherCycle builds it, with its
 * parameters pushed onto `params`.
 * @param {Db} db
 * @param {Selection} sel
 * @param {unknown[]} params
 */
export async function filtersWhere(db, sel, params) {
  const { rows: [c] } = await db.query(`select fn_lead_filter_conditions($1::jsonb) as conds`, [JSON.stringify(sel.filters ?? {})]);
  const accounting = [];
  const opts = sel.push_options ?? {};
  if (sel.client_tag) {
    // The tag becomes a parameter only when a clause reads it: Postgres refuses a parameter no clause types.
    let tagParam = null;
    const tag = () => (tagParam ??= param(params, sel.client_tag));
    if (opts.includeAlreadyPushed !== true) {
      accounting.push(`not exists (
        select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
        where pb.client_tag = ${tag()} and pi.lead_id = l.id and pi.status = 'sent')`);
    }
    if (opts.onlyNewSinceLast === true) {
      const { rows: [last] } = await db.query(
        `select max(created_at) as at from push_batches where client_tag = $1 and status in ('processing','complete')`,
        [sel.client_tag]
      );
      // As the push: the time read back into JavaScript (milliseconds), then compared.
      if (last?.at) accounting.push(`l.created_at > ${param(params, new Date(last.at).toISOString())}::timestamptz`);
    }
    if (opts.retryFailed === true) {
      accounting.push(`exists (
        select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
        where pb.client_tag = ${tag()} and pi.lead_id = l.id and pi.status = 'failed')`);
    }
  }
  return [...(c?.conds ?? []), ELIGIBLE, ...accounting].join(" and ");
}

/**
 * The push set as one statement selecting `columns` over leads l: the ids
 * path, or the filters path in l.id order with the range's offset and limit.
 * Same rows as gatherCycle's keyset pages. Only for counting: a job snapshots
 * in pages (gatherJob).
 * @param {Db} db
 * @param {Selection} sel
 * @param {string} columns
 * @param {unknown[]} params
 */
export async function pushSetSql(db, sel, columns, params) {
  if (sel.selected_ids) {
    return `select ${columns} from leads l where l.id = any(${param(params, sel.selected_ids)}::uuid[]) and ${ELIGIBLE}`;
  }
  if (!sel.filters) throw new Error("The selection names no leads: it needs selected ids or filters.");
  const where = await filtersWhere(db, sel, params);
  const { remaining, offset } = rangeOf(sel);
  let sql = `select ${columns} from leads l where ${where}`;
  if (remaining != null || offset > 0) {
    sql += ` order by l.id`;
    if (remaining != null) sql += ` limit ${param(params, remaining)}`;
    if (offset > 0) sql += ` offset ${param(params, offset)}`;
  }
  return sql;
}

/**
 * Every id of the push set, read the way gatherCycle reads it (keyset pages of
 * 5,000, the offset on the first page only). For checks and small sets.
 * @param {Db} db
 * @param {Selection} sel
 * @returns {Promise<string[]>}
 */
export async function pushSetIds(db, sel) {
  if (sel.selected_ids) {
    const { rows } = await db.query(`select l.id from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}`, [sel.selected_ids]);
    return rows.map((r) => r.id);
  }
  if (!sel.filters) throw new Error("The selection names no leads: it needs selected ids or filters.");
  const base = [];
  const where = await filtersWhere(db, sel, base);
  let { remaining, offset } = rangeOf(sel);
  let lastId = null;
  const out = [];
  for (;;) {
    const page = remaining != null ? Math.min(GATHER_CHUNK, remaining) : GATHER_CHUNK;
    if (page <= 0) break;
    const params = [...base];
    let sql = `select l.id from leads l where ${where}`;
    if (lastId != null) sql += ` and l.id > ${param(params, lastId)}`;
    sql += ` order by l.id limit ${param(params, page)}`;
    if (offset > 0) sql += ` offset ${param(params, offset)}`;
    const { rows } = await db.query(sql, params);
    offset = 0;
    if (rows.length === 0) break;
    out.push(...rows.map((r) => r.id));
    lastId = rows[rows.length - 1].id;
    if (remaining != null) remaining -= rows.length;
    if (rows.length < page) break;
  }
  return out;
}

/** One transaction on a pooled client, with its own statement timeout (SET LOCAL only). */
export async function inTx(pool, fn, { timeoutMs = GATHER_STATEMENT_MS } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1_000, Math.floor(timeoutMs))}`);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The most items a job takes: its max_leads (1 to 250,000), else 250,000. */
export function jobCap(job) {
  const n = Number(job?.max_leads);
  return Number.isInteger(n) && n > 0 ? Math.min(n, JOB_CAP) : JOB_CAP;
}

/**
 * Snapshots a job's leads into question_job_items, a page (or 5,000 ids) per
 * statement: the push set, minus leads already among the job's items, minus
 * leads holding a current value unless the job rewrites, at most jobCap(job)
 * items in all. Inserts are idempotent, so a gather cut short (a crash, a
 * stop) is simply run again from the start. Returns what it did; `stopped`
 * when shouldStop() said so between two statements (nothing is lost).
 *
 * @param {Pool} pool
 * @param {{ id: string, selection: unknown, rewrite?: boolean, max_leads?: number | null }} job
 * @param {{ id: string, prompt_version: number }} variable
 * @param {{ shouldStop?: () => boolean }} [opts]
 * @returns {Promise<{ seen: number, inserted: number, items: number, stopped: boolean }>}
 */
export async function gatherJob(pool, job, variable, { shouldStop = () => false } = {}) {
  const sel = selectionOf(job.selection);
  if (!sel.selected_ids && !sel.filters) throw new Error("The job's selection names no leads.");
  const cap = jobCap(job);
  const rewrite = job.rewrite === true;
  const have = Number(
    (await inTx(pool, (c) => c.query(`select count(*)::int as n from question_job_items where job_id = $1`, [job.id]))).rows[0]?.n ?? 0
  );
  let items = have;
  let seen = 0;
  let inserted = 0;

  /** Inserts the page's new candidates, at most `room`; answers the page's size, last id and how many went in. */
  const take = (pageSql, pageParams) => {
    const params = [...pageParams];
    const jobId = param(params, job.id);
    const sql = `with page as (${pageSql}),
      cand as (
        select p.id from page p
         where not exists (select 1 from question_job_items i where i.job_id = ${jobId}::uuid and i.lead_id = p.id)
           and (${param(params, rewrite)}::boolean or not exists (
                 select 1 from lead_question_values v
                  where v.variable_id = ${param(params, variable.id)}::uuid and v.lead_id = p.id
                    and v.status = 'done' and v.prompt_version = ${param(params, variable.prompt_version)}::int))
         order by p.id
         limit ${param(params, Math.max(0, cap - items))}::int),
      ins as (
        insert into question_job_items (job_id, lead_id)
        select ${jobId}::uuid, cand.id from cand
        on conflict (job_id, lead_id) do nothing
        returning 1)
      select (select count(*)::int from page) as n,
             (select p.id from page p order by p.id desc limit 1) as last_id,
             (select count(*)::int from ins) as inserted`;
    return inTx(pool, async (c) => (await c.query(sql, params)).rows[0]);
  };

  if (sel.selected_ids) {
    for (let i = 0; i < sel.selected_ids.length && items < cap; i += GATHER_CHUNK) {
      if (shouldStop()) return { seen, inserted, items, stopped: true };
      const chunk = sel.selected_ids.slice(i, i + GATHER_CHUNK);
      const r = await take(`select l.id from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}`, [chunk]);
      seen += r.n;
      inserted += r.inserted;
      items += r.inserted;
    }
    return { seen, inserted, items, stopped: false };
  }

  const base = [];
  const where = await inTx(pool, (c) => filtersWhere(c, sel, base));
  let { remaining, offset } = rangeOf(sel);
  let lastId = null;
  while (items < cap) {
    if (shouldStop()) return { seen, inserted, items, stopped: true };
    const page = remaining != null ? Math.min(GATHER_CHUNK, remaining) : GATHER_CHUNK;
    if (page <= 0) break;
    const params = [...base];
    let sql = `select l.id from leads l where ${where}`;
    if (lastId != null) sql += ` and l.id > ${param(params, lastId)}`;
    sql += ` order by l.id limit ${param(params, page)}`;
    if (offset > 0) sql += ` offset ${param(params, offset)}`;
    const r = await take(sql, params);
    offset = 0;
    if (r.n === 0) break;
    seen += r.n;
    inserted += r.inserted;
    items += r.inserted;
    lastId = r.last_id;
    if (remaining != null) remaining -= r.n;
    if (r.n < page) break;
  }
  return { seen, inserted, items, stopped: false };
}

/**
 * The export popup's counts for a selection and a variable, in one bounded
 * statement over the push set: how many leads it holds, how many have a
 * current value, an older one (stale), an error or a skip, or none (missing),
 * and how many companies of the leads still to write have no current research.
 * The estimate is what a job would call: one question call a lead to write (a
 * second is made only when the first answer breaks the rules) and one research
 * call a company, at most JOB_CAP leads.
 *
 * @param {Db} db  inside the caller's transaction (READ ONLY is fine)
 * @param {Selection} sel
 * @param {{ id: string, prompt_version: number }} variable
 */
export async function readinessCounts(db, sel, variable) {
  const params = [];
  const set = await pushSetSql(db, sel, `l.id, ${COMPANY_KEY_SQL} as ck`, params);
  const vid = param(params, variable.id);
  const pv = param(params, variable.prompt_version);
  const { rows: [r] } = await db.query(
    `with sel as (${set}),
     j as (
       select sel.ck, v.lead_id is not null as has, v.status,
              coalesce(v.status = 'done' and v.prompt_version = ${pv}::int, false) as fresh
         from sel
         left join lead_question_values v on v.variable_id = ${vid}::uuid and v.lead_id = sel.id),
     need as (select distinct j.ck from j where j.ck is not null and not j.fresh)
     select (select count(*)::int from j) as selected,
            (select count(*)::int from j where j.fresh) as with_value,
            (select count(*)::int from j where j.status = 'done' and not j.fresh) as stale,
            (select count(*)::int from j where j.status in ('error', 'skipped')) as errors,
            (select count(*)::int from j where not j.has) as missing,
            (select count(*)::int from need n
              where not exists (select 1 from question_research r
                                 where r.variable_id = ${vid}::uuid and r.company_key = n.ck
                                   and r.status = 'done' and r.prompt_version = ${pv}::int)) as companies_missing`,
    params
  );
  const toWrite = r.stale + r.errors + r.missing;
  const questionCalls = Math.min(toWrite, JOB_CAP);
  return {
    selected: r.selected,
    withValue: r.with_value,
    stale: r.stale,
    missing: r.missing,
    errors: r.errors,
    companiesMissing: r.companies_missing,
    estimate: { researchCalls: Math.min(r.companies_missing, questionCalls), questionCalls },
  };
}

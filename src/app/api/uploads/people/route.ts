import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { hasPermission } from "@/types/auth";
import { factsOf, peopleReady, peopleStateOf, peopleWhy, type PeopleState } from "@/lib/uploads/found";
import { startUploadFound } from "@/lib/uploads/found-run";
import { ADD_COLUMN, UPLOAD_CAPABILITY, approvedCell, liveFoundBatch } from "../../../../../scripts/lib/enrich/upload-people.mjs";
import { normTag } from "../../../../../scripts/lib/enrich/settings.mjs";

// An upload's no-email rows in its client's People (pipeline) table (migration 130).
//
// GET  ?batch=<id> or ?batches=<id>,<id> (at most 20): where each upload's
//      no-email rows stand (sent to which client's People table, or why not),
//      their People rows by status, how many have an approved email (found),
//      how many of those were added, were already in the database, are being
//      added or were not added, and the upload's 5 newest rounds of found
//      emails; plus the worker: online, whether it moves upload rows
//      (upload_people), and whether it asks for found emails to be added by
//      itself. Manager and up; a manager sees only the uploads they made (as
//      the no-email download). Read only. Counts go through the upload's own
//      rows (enrich_rows by source and status), the approved-email cells and
//      the add_to_database cells of its People table, never a whole table.
// POST { action: "add_found", batch }  manager and up (a manager only their
//      own upload): adds the upload's found emails now, and takes again the
//      people a round could not store (src/lib/uploads/found-run.ts).
// POST { action: "send", batch, tag }  admin and up: sends an upload's
//      no-email rows to that client's People table by hand. Only an upload
//      made before uploads recorded their tags, or one the worker did not
//      send (no client tag, or two); never one already sent, and never one
//      whose tags the worker has still to read. The worker then copies the
//      rows like any other upload's, held: nothing is worked or spent until
//      the client is on People runs. One audit line naming the upload and the tag.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BATCHES = 20;

/** One of an upload's rounds of found emails (upload_batches with source_batch_id = the upload). */
export interface FoundRound {
  id: string;
  status: string;
  created_at: string;
  inserted: number;
  merged: number;
  replaced: number;
  skipped: number;
  errors: number;
}

/** Where one upload's no-email rows stand. */
export interface UploadPeopleView {
  state: PeopleState;
  /** upload_people.reason: why not sent (no_tag, not_client, several), or what the copy waits for. */
  reason: string | null;
  /** The same in plain words, or null. */
  why: string | null;
  client_tag: string | null;
  /** The client's People (pipeline) table, while it exists. */
  table_id: string | null;
  /** The client is on People runs (the people_pipeline switch): its held rows are released. */
  switched_on: boolean;
  /** The client has targeting rules: without them its rows stop at the area check, and no finder runs. */
  targeting: boolean;
  /** Rows the upload kept back for having no usable email. */
  kept_back: number;
  /** Of those, copied into the People table. */
  moved: number;
  /** The upload's People rows by status. */
  rows: { held: number; queued: number; running: number; waiting: number; done: number; error: number };
  /** People with an approved email (Outcome "Approved email"), or with an add result. */
  found: number;
  /** Rows worked to the end with no approved email. */
  not_found: number;
  added: number;
  /** A lead with the address was there already; the upload's rule applied to it. */
  already: number;
  /** In a round now. */
  adding: number;
  /** Not added: the import could not store them, or the address or the row could not be used. */
  failed: number;
  /** The 5 newest rounds, newest first. */
  rounds: FoundRound[];
}

export interface UploadPeopleList {
  batches: Record<string, UploadPeopleView>;
  /** The worker's last heartbeat: online, it copies upload rows (upload_people), it adds found emails by itself. Null when none has run. */
  worker: { online: boolean; moves: boolean; found_auto: boolean } | null;
}

const ROW_STATUSES = ["held", "queued", "running", "waiting", "done", "error"] as const;
const int = (v: unknown) => Number(v ?? 0) || 0;

const BATCH_SQL = `
  SELECT b.id, b.uploaded_by, b.status, b.add_tags, b.no_email_rows,
         (b.batch_type = 'leads' AND b.source_label IS NULL AND b.field_mapping IS NOT NULL) AS is_upload,
         EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = b.id) AS has_kept,
         CASE WHEN b.no_email_rows > 0 THEN b.no_email_rows
              ELSE (SELECT count(*)::int FROM upload_holdbacks h WHERE h.batch_id = b.id) END AS kept_back,
         p.state, p.reason, p.client_tag, p.table_id, p.source_id, p.next_seq, p.moved_rows,
         coalesce(public.fn_enrich_people_switch_on(p.client_tag), false) AS switched_on,
         EXISTS (SELECT 1 FROM client_targeting g WHERE g.client_tag = p.client_tag) AS targeting
    FROM upload_batches b
    LEFT JOIN upload_people p ON p.batch_id = b.id
   WHERE b.id = ANY($1::uuid[])`;

// Approved People rows and rows with an add result, per source (an upload's
// rows in its People table). An added person may since have been worked
// again to another Outcome; they still count as found.
const FOUND_SQL = `
  WITH approved AS (
    SELECT r.source_id, r.id, r.run_status
      FROM enrich_cells o
      JOIN enrich_rows r ON r.id = o.row_id AND r.source_id = ANY($2::uuid[])
     WHERE o.table_id = ANY($1::uuid[]) AND ${approvedCell("o")}
  ), adds AS (
    SELECT r.source_id, r.id, r.run_status, a.status, a.value,
           coalesce(a.status = 'running' AND ${liveFoundBatch("b")}, false) AS live
      FROM enrich_cells a
      JOIN enrich_rows r ON r.id = a.row_id AND r.source_id = ANY($2::uuid[])
      LEFT JOIN upload_batches b ON a.status = 'running' AND b.id::text = a.value->>'batch_id'
     WHERE a.table_id = ANY($1::uuid[]) AND a.column_key = '${ADD_COLUMN}'
  ), found AS (
    SELECT coalesce(p.source_id, d.source_id) AS source_id, coalesce(p.run_status, d.run_status) AS run_status,
           d.status, d.value, coalesce(d.live, false) AS live
      FROM approved p FULL JOIN adds d ON d.id = p.id
  )
  SELECT source_id,
         count(*)::int AS found,
         count(*) FILTER (WHERE run_status = 'done')::int AS found_done,
         count(*) FILTER (WHERE status = 'done' AND value->'added' = 'true'::jsonb)::int AS added,
         count(*) FILTER (WHERE status = 'done' AND value->>'reason' = 'lead')::int AS already,
         count(*) FILTER (WHERE status = 'running' AND live)::int AS adding,
         count(*) FILTER (WHERE status = 'error' OR (status = 'done' AND value->>'reason' IN ('address', 'row')))::int AS failed
    FROM found
   GROUP BY source_id`;

const ROUNDS_SQL = `
  SELECT u.id AS upload_id, x.id, x.status, x.created_at, x.inserted_rows, x.merged_rows, x.replaced_rows, x.skipped_rows, x.error_rows
    FROM unnest($1::uuid[]) AS u(id)
    CROSS JOIN LATERAL (
      SELECT f.id, f.status, f.created_at, f.inserted_rows, f.merged_rows, f.replaced_rows, f.skipped_rows, f.error_rows
        FROM upload_batches f
       WHERE f.source_batch_id = u.id
       ORDER BY f.created_at DESC
       LIMIT 5) x`;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const single = sp.get("batch");
  const asked = single !== null ? [single] : (sp.get("batches") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [...new Set(asked.map((s) => s.toLowerCase()))];
  if (!ids.length || ids.length > MAX_BATCHES || !ids.every(isUuid)) {
    return NextResponse.json({ error: `batch or batches must be upload ids (at most ${MAX_BATCHES})` }, { status: 400 });
  }
  try {
    const out = await withTx<UploadPeopleList | { status: number; error: string }>(
      async (c) => {
        const { rows: all } = await c.query(BATCH_SQL, [ids]);
        // Managers see their own uploads only, as the no-email download allows.
        const mine = auth.role === "manager" ? all.filter((b) => b.uploaded_by === auth.user.id) : all;
        if (single !== null) {
          if (!all.length) return { status: 404, error: "No such upload" };
          if (!mine.length) return { status: 403, error: "Forbidden" };
        }
        const sources = mine.map((b) => b.source_id).filter((s): s is string => typeof s === "string");
        const tables = [...new Set(mine.map((b) => b.table_id).filter((t): t is string => typeof t === "string"))];
        // One statement at a time on the transaction's client.
        const statuses = sources.length
          ? await c.query(`SELECT source_id, run_status, count(*)::int AS n FROM enrich_rows WHERE source_id = ANY($1::uuid[]) GROUP BY 1, 2`, [sources])
          : null;
        const found = sources.length && tables.length ? await c.query(FOUND_SQL, [tables, sources]) : null;
        const rounds = mine.length ? await c.query(ROUNDS_SQL, [mine.map((b) => b.id)]) : null;
        const worker = await workerState(c);
        const bySource = new Map<string, Record<string, number>>();
        for (const r of statuses?.rows ?? []) (bySource.get(r.source_id) ?? bySource.set(r.source_id, {}).get(r.source_id)!)[r.run_status] = int(r.n);
        const foundBy = new Map((found?.rows ?? []).map((r) => [String(r.source_id), r]));
        const roundsBy = new Map<string, FoundRound[]>();
        for (const r of rounds?.rows ?? []) {
          (roundsBy.get(r.upload_id) ?? roundsBy.set(r.upload_id, []).get(r.upload_id)!).push({
            id: r.id,
            status: r.status,
            created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            inserted: int(r.inserted_rows),
            merged: int(r.merged_rows),
            replaced: int(r.replaced_rows),
            skipped: int(r.skipped_rows),
            errors: int(r.error_rows),
          });
        }
        const batches: Record<string, UploadPeopleView> = {};
        for (const b of mine) {
          const facts = factsOf(b);
          const ready = peopleReady(facts);
          const st = ready ? bySource.get(b.source_id) ?? {} : {};
          const f = ready ? foundBy.get(b.source_id) : undefined;
          const rows = Object.fromEntries(ROW_STATUSES.map((k) => [k, int(st[k])])) as UploadPeopleView["rows"];
          batches[b.id] = {
            state: peopleStateOf(facts),
            reason: facts.reason,
            why: peopleWhy(facts),
            client_tag: facts.clientTag,
            table_id: facts.tableId,
            switched_on: b.switched_on === true,
            targeting: b.targeting === true,
            kept_back: int(b.kept_back),
            moved: facts.movedRows,
            rows,
            found: int(f?.found),
            not_found: Math.max(0, rows.done - int(f?.found_done)),
            added: int(f?.added),
            already: int(f?.already),
            adding: int(f?.adding),
            failed: int(f?.failed),
            rounds: roundsBy.get(b.id) ?? [],
          };
        }
        const caps = worker?.info?.capabilities;
        return {
          batches,
          worker: worker
            ? {
                online: worker.online,
                moves: Array.isArray(caps) && caps.includes(UPLOAD_CAPABILITY),
                found_auto: worker.info?.upload_people?.found_auto === true,
              }
            : null,
        };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`uploads/people GET: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ error: "Could not read where the uploads' no-email rows stand" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { action?: unknown; batch?: unknown; tag?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const action = body && typeof body === "object" ? body.action : undefined;
  const batch = body && typeof body === "object" && isUuid(body.batch) ? body.batch.toLowerCase() : null;

  if (action === "add_found") {
    if (!batch) return NextResponse.json({ error: "batch must be an upload's id" }, { status: 400 });
    if (auth.role === "manager") {
      const owner = await withTx(
        async (c) => (await c.query(`SELECT uploaded_by FROM upload_batches WHERE id = $1`, [batch])).rows[0] ?? null,
        { readOnly: true, timeoutMs: 8_000 }
      ).catch(() => undefined);
      if (owner === undefined) return NextResponse.json({ error: "Could not read the upload" }, { status: 500 });
      if (!owner) return NextResponse.json({ error: "No such upload" }, { status: 404 });
      if (owner.uploaded_by !== auth.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const out = await startUploadFound(batch, auth.user.id, { auto: false });
    return NextResponse.json(out.body, { status: out.status });
  }

  if (action === "send") {
    if (!hasPermission(auth.role, "admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!batch) return NextResponse.json({ error: "batch must be an upload's id" }, { status: 400 });
    const tag = typeof body?.tag === "string" ? normTag(body.tag) : "";
    if (!tag || tag.length > 64) return NextResponse.json({ error: "tag must be a client tag" }, { status: 400 });
    let out: { status: number; error?: string; body?: Record<string, unknown> };
    try {
      out = await withTx(
        async (c) => {
          const { rows: [client] } = await c.query(`SELECT tag FROM client_tags WHERE upper(btrim(tag)) = $1 LIMIT 1`, [tag]);
          if (!client) return { status: 400, error: `${tag} is not a client tag` };
          const { rows: [u] } = await c.query(
            `SELECT b.id, b.status, b.add_tags, b.no_email_rows,
                    (b.batch_type = 'leads' AND b.source_label IS NULL AND b.field_mapping IS NOT NULL) AS is_upload,
                    EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = b.id) AS has_kept,
                    p.state, p.reason, p.client_tag, p.table_id, p.source_id, p.next_seq, p.moved_rows
               FROM upload_batches b LEFT JOIN upload_people p ON p.batch_id = b.id
              WHERE b.id = $1`,
            [batch]
          );
          if (!u) return { status: 404, error: "No such upload" };
          const facts = factsOf(u);
          const state = peopleStateOf(facts);
          if (!facts.isUpload) return { status: 409, error: "Only an upload's no-email rows can be sent to a People table, and this batch is not an upload." };
          if (state === "processing") return { status: 409, error: "This upload is still being imported. Send it once it has finished." };
          if (state === "none") return { status: 409, error: "This upload had no rows without an email, so there is nothing to send." };
          if (state === "moving" || state === "moved") {
            return { status: 409, error: `This upload's no-email rows were sent to ${facts.clientTag}'s People table already.` };
          }
          if (state === "undecided") {
            return {
              status: 409,
              error:
                "This upload recorded its tags, so the worker decides where its no-email rows go, within a minute of the upload finishing. Only an upload made before that, or one that was not sent, can be sent by hand.",
            };
          }
          const { rows: sent } = await c.query(
            `INSERT INTO upload_people (batch_id, state, reason, client_tag, sent_by, next_try_at)
             VALUES ($1, 'moving', NULL, $2, $3, now())
             ON CONFLICT (batch_id) DO UPDATE
                SET state = 'moving', reason = NULL, client_tag = EXCLUDED.client_tag, sent_by = EXCLUDED.sent_by,
                    next_try_at = now(), updated_at = now()
              WHERE upload_people.state = 'not_sent'
             RETURNING batch_id`,
            [batch, tag, auth.user.id]
          );
          if (!sent.length) return { status: 409, error: "This upload's no-email rows were sent meanwhile. Reload the page." };
          return {
            status: 200,
            body: { batch, state: "moving", client_tag: tag },
            audit: `${tag}: upload ${batch}, its no-email rows sent to the People table by hand (${state === "before" ? "made before uploads recorded their tags" : `not sent: ${facts.reason ?? "no client"}`})`,
          };
        },
        { timeoutMs: 15_000 }
      ).then(async (r) => {
        if ("audit" in r && r.audit) await logAudit({ action: "upload_people_send", performedBy: auth.user.id, details: r.audit });
        return r;
      });
    } catch (err) {
      console.error(`uploads/people send: ${err instanceof Error ? err.message : err}`);
      return NextResponse.json({ error: "Could not send the upload's no-email rows" }, { status: 500 });
    }
    if (out.error) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.body, { status: out.status });
  }

  return NextResponse.json({ error: 'action must be "add_found" or "send"' }, { status: 400 });
}

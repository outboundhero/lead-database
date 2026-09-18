import { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { HOLDBACK_PART_SIZE } from "@/lib/uploads/constants";
import { stringify } from "csv-stringify/sync";

// GET /api/uploads/holdbacks?batch=<uuid>&part=<n>
//
// Streams the rows an upload could NOT import (no usable email) as CSV,
// exactly as they were in the file — the server-parsed header row and cells,
// in file order — in parts of HOLDBACK_PART_SIZE rows so each file stays under
// Clay's 50k limit. Parts are non-overlapping by construction: part p is
// holdback seq [p*SIZE, (p+1)*SIZE). Pages are pulled one at a time as the
// client consumes them (backpressure), each in its own short transaction.
//
// The pool client is shared with the import engine and the export stream, so a
// cancelled download (tab closed mid-stream — Next aborts the body pipe on the
// response 'close' event) must never hand a client back with a transaction
// open: cancel() only flags, and the in-flight page finishes its commit /
// rollback before the client is released.

export const maxDuration = 300;
const PART_SIZE = HOLDBACK_PART_SIZE;
const PAGE = 5_000;

export async function GET(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return new Response("Forbidden", { status: 403 });
  }

  const batchId = request.nextUrl.searchParams.get("batch") ?? "";
  const part = Math.max(0, parseInt(request.nextUrl.searchParams.get("part") ?? "0", 10) || 0);
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return new Response("batch required", { status: 400 });

  const { data: batch } = await admin
    .from("upload_batches").select("filename, no_email_rows, source_headers, uploaded_by").eq("id", batchId).maybeSingle();
  if (!batch) return new Response("batch not found", { status: 404 });
  // Same rule as the upload_batches RLS policy: managers see their own uploads.
  if (profile.role === "manager" && batch.uploaded_by !== user.id) return new Response("Forbidden", { status: 403 });
  const headers = (batch.source_headers as string[] | null) ?? [];
  const pool = getPool();
  let total = Number(batch.no_email_rows ?? 0);
  if (total === 0) {
    // Counters are written at the end of an import; if it died first the rows
    // are still there and still downloadable.
    const { rows } = await pool.query(`select count(*)::int as n from upload_holdbacks where batch_id = $1`, [batchId]);
    total = rows[0]?.n ?? 0;
  }
  const parts = Math.max(1, Math.ceil(total / PART_SIZE));
  if (part >= parts) return new Response(`part ${part} does not exist (${parts} part${parts === 1 ? "" : "s"})`, { status: 404 });

  // Take the connection before answering so a saturated pool is a 503, not a
  // download that dies half-way.
  let client: PoolClient | null;
  try { client = await pool.connect(); }
  catch (e) { return new Response(`Database busy: ${e instanceof Error ? e.message : String(e)}`, { status: 503 }); }

  const lo = part * PART_SIZE, hi = lo + PART_SIZE;
  const encoder = new TextEncoder();
  let last = lo - 1;
  let inFlight: Promise<void> | null = null;
  let cancelled = false;
  let broken = false;      // a query/rollback failed: destroy the connection instead of pooling it
  const release = () => { const c = client; client = null; c?.release(broken ? new Error("holdback stream aborted") : undefined); };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(stringify([headers])));
    },
    async pull(controller) {
      const c = client;
      if (!c || cancelled) { release(); try { controller.close(); } catch { /* already closed */ } return; }
      inFlight = (async () => {
        try {
          await c.query("begin");
          await c.query("set local statement_timeout = '60s'");
          const { rows } = await c.query(
            `select seq, raw from upload_holdbacks where batch_id = $1 and seq > $2 and seq < $3 order by seq limit $4`,
            [batchId, last, hi, PAGE]
          );
          await c.query("commit");
          if (cancelled) return;                     // the consumer is gone; nothing to enqueue
          if (rows.length) {
            const cells = rows.map((r) => {
              const arr = (r.raw as unknown[]).map((v) => (v == null ? "" : String(v)));
              // Pad/trim to the header width so every line has the same column count.
              return headers.length ? Array.from({ length: headers.length }, (_, i) => arr[i] ?? "") : arr;
            });
            controller.enqueue(encoder.encode(stringify(cells)));
            last = rows[rows.length - 1].seq as number;
          }
          if (rows.length < PAGE) { controller.close(); release(); }
        } catch (e) {
          broken = true;
          await c.query("rollback").catch(() => {});
          release();
          if (!cancelled) controller.error(e);
        }
      })();
      try { await inFlight; } finally { inFlight = null; }
      if (cancelled) release();
    },
    cancel() {
      cancelled = true;
      if (!inFlight) release();                      // otherwise pull() releases once its transaction is closed
    },
  });

  const base = (batch.filename ?? "upload").replace(/\.csv$/i, "").replace(/[^\w.-]+/g, "_");
  const name = parts > 1 ? `${base}_no-email_part${part + 1}-of-${parts}.csv` : `${base}_no-email.csv`;
  return new Response(stream.pipeThrough(new CompressionStream("gzip")), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-cache",
    },
  });
}

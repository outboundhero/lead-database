import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// GET /api/bison/push-batches/errors?batchId=<uuid>
//
// Per-contact detail for one push, split into the two things that look alike in
// the UI but must be treated completely differently:
//
//   failed  — a genuine error (network blip, Bison 5xx, bad payload). Retrying
//             CAN succeed, so these are what the Retry buttons requeue.
//   skipped — Bison itself refused the lead: already in another sequence,
//             previously bounced there, or unsubscribed. Retrying NEVER
//             succeeds; it just burns API calls. Production currently holds
//             37,469 of these vs 326 real failures, so showing them as
//             "errors" would be badly misleading.
//
// Messages are GROUPED by reason with a count and a few example addresses —
// hundreds of identical rows are noise, the reason and its size are the signal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GROUPS = 12;
const SAMPLES_PER_GROUP = 5;

interface Row {
  reason: string;
  n: string;
  samples: string[];
}

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const batchId = (request.nextUrl.searchParams.get("batchId") ?? "").trim();
  if (!UUID_RE.test(batchId)) {
    return NextResponse.json({ error: "batchId (uuid) required" }, { status: 400 });
  }

  const pool = getPool();
  try {
    // Group per status. push_items is indexed by (batch_id, lead_id) so this is
    // bounded to one batch and stays cheap.
    // Worker errors embed the contact's address and the full request URL, so
    // raw messages are unique per row and would never group. Strip the URL
    // FIRST (it contains the url-encoded address, so doing emails first would
    // shred it mid-string), then the address, then collapse whitespace. On a
    // real batch this turns 115 unique strings into 2 readable reasons.
    const { rows } = await pool.query<Row & { status: string }>(
      `select status,
              regexp_replace(
                regexp_replace(
                  regexp_replace(coalesce(nullif(btrim(error), ''), 'No reason recorded'),
                    'https?://[^ ]*', 'the Bison API', 'g'),
                  '[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.%-]+\\.[A-Za-z]{2,}', 'a contact', 'g'),
                '\\s+', ' ', 'g') as reason,
              count(*)::text as n,
              (array_agg(email order by email))[1:$2] as samples
         from push_items
        where batch_id = $1 and status in ('failed', 'skipped')
        group by status, reason
        order by count(*) desc
        limit $3`,
      [batchId, SAMPLES_PER_GROUP, MAX_GROUPS * 2]
    );

    const shape = (s: string) =>
      rows
        .filter((r) => r.status === s)
        .slice(0, MAX_GROUPS)
        .map((r) => ({ reason: r.reason, count: Number(r.n), samples: r.samples ?? [] }));

    const failed = shape("failed");
    const skipped = shape("skipped");
    return NextResponse.json({
      batchId,
      failed,
      skipped,
      retryableCount: failed.reduce((n, g) => n + g.count, 0),
      notAcceptedCount: skipped.reduce((n, g) => n + g.count, 0),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load push errors" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { insertRows } from "@/lib/enrich/insert-rows";
import { rowsFromPostback } from "@/lib/enrich/gmaps";

// POST /api/enrich/intake — Google Maps places from the GMaps Scraper, for the
// clients switched to "database" or "both" there.
//   Authorization: Bearer <ENRICH_INTAKE_KEY>
//   X-Client-Tag:      the lead database client tag (upper-case)
//   X-Gmaps-Buffer-Id: the scraper's chunk id — makes a re-delivery a no-op (falls back to the body's taskId)
//   body:              the chunk exactly as Clay's webhook received it (src/lib/enrich/gmaps.ts)
//
// Excluded from the session middleware: the key is the only auth. Rows are
// stored and queued only — no provider is called during the request, so the
// scraper gets its answer fast. 2xx comes only after the commit, so the
// scraper may forget a chunk once it has a 2xx. 404 = no Clay-tab table for the
// client, 422 = a chunk Clay would also have dropped; the scraper parks those.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.ENRICH_INTAKE_KEY);
  if (key === "not_configured") {
    console.error("Enrich intake: ENRICH_INTAKE_KEY is not set (or shorter than 32 characters)");
    return json({ error: "intake is not configured" }, 500);
  }
  if (key === "unauthorized") return json({ error: "Unauthorized" }, 401);

  const tag = (req.headers.get("x-client-tag") ?? "").trim().toUpperCase();
  if (!tag) return json({ error: "X-Client-Tag header is required" }, 400);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const parsed = rowsFromPostback(body, tag);
  if (parsed.missing.length) return json({ error: `chunk is missing ${parsed.missing.join(", ")}` }, 422);
  const externalId = req.headers.get("x-gmaps-buffer-id")?.trim() || parsed.taskId;
  const label = req.headers.get("x-source-label")?.trim().slice(0, 200) ||
    [parsed.meta.keyword, parsed.meta.city, parsed.meta.state].filter(Boolean).join(" · ") || "Google Maps";

  try {
    const result = await withTx(
      async (c) => {
        const { rows: [t] } = await c.query<{ id: string }>(
          `SELECT id FROM enrich_tables WHERE client_tag = $1 AND kind = 'companies' ORDER BY created_at LIMIT 1`,
          [tag]
        );
        if (!t) return null;
        const { rows: cols } = await c.query<{ key: string }>(
          `SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`,
          [t.id]
        );
        const out = await insertRows(c, {
          tableId: t.id,
          inputKeys: cols.map((r) => r.key),
          source: { kind: "maps", externalId, label, meta: parsed.meta },
          rows: parsed.rows,
        });
        return { table: t.id, ...out };
      },
      { timeoutMs: 20_000 }
    );
    if (!result) return json({ error: `no Clay-tab Companies table for client ${tag}` }, 404);
    return json({ ok: true, ...result }, 200);
  } catch (err) {
    console.error("Enrich intake failed:", err);
    return json({ error: "intake failed" }, 500);
  }
}

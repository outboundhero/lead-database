import { after } from "next/server";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { importRows, type ImportCounters } from "@/lib/uploads/import-rows";
import {
  beginPromote,
  finishPromote,
  PROMOTE_COLUMNS,
  PROMOTE_EXTRA_FIELDS,
  PROMOTE_STALE_HOURS,
  promotionAllowed,
} from "../../../scripts/lib/enrich/promote.mjs";
import { readFitSettings } from "@/lib/companies/fit";
import type { PromoteKind } from "./fit-types";

// Pipeline emails into leads (2B.5; switch promotion.promote_to_leads, shipped
// OFF and covering no client). As the AI Ark add does (src/lib/aiark/add-run.ts):
// one round per client at a time (an advisory lock on the client), the
// contacts that may be promoted taken in one query (scripts/lib/enrich/promote.mjs),
// those the database already holds settled at once, the rest imported through
// the Uploads page's engine as one upload batch per kind (duplicates skipped,
// never merged, the client's tag added, the pipeline's source label), then
// each contact settled, with 3 tries. A round is two batches, inboxes then
// people, at most promotion.batch_max (1,000) contacts each. The answer comes
// as soon as the batches exist; the imports run after it (Next `after()`).
//
// Refused while promotion is off or the client is not on its list, while the
// fit gate does not cover the client (so a promoted lead can never be pushed
// past a later bad score), while the rule or the model is not set, and while a
// batch of the client is still being imported.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KINDS: PromoteKind[] = ["general", "person"];
const KIND_WORD: Record<PromoteKind, string> = { general: "general inboxes", person: "people" };

interface Started {
  kind: PromoteKind;
  batchId: string;
  batchAt: string;
  filename: string;
  rows: string[][];
  contacts: Array<{ row_id: number; table_id: string; email: string }>;
}

export async function startPromote({
  tag,
  kind = null,
  userId,
  automatic = false,
}: {
  tag: string;
  kind?: PromoteKind | null;
  userId: string | null;
  automatic?: boolean;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const kinds = kind ? [kind] : KINDS;
  let out:
    | { error: string; status: number }
    | { started: Started[]; settled: number; refused: number; held: Record<string, number>; busy: PromoteKind[]; label: string };
  try {
    out = await withTx(
      async (c) => {
        // One round per client at a time: a second press waits here, then finds the first under way.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('company-promote:' || $1))`, [tag]);
        const settings = await readFitSettings(c);
        const allowed = promotionAllowed(settings, tag);
        if (!allowed.ok) return { status: 409, error: `${allowed.why}. Nothing was promoted.` };
        const { rows: [g] } = await c.query(`SELECT public.fn_fit_gate_applies($1) AS on`, [tag]);
        if (g?.on !== true) {
          return {
            status: 409,
            error: `The fit gate does not cover ${tag} yet, so nothing was promoted: a promoted lead must never be pushed past a later bad score. Put the client on the gate first.`,
          };
        }
        // Batches that never got a final status (a restart) are dead, as the Uploads page treats them.
        await c.query(
          `UPDATE upload_batches SET status = 'error', error_log = $1::jsonb, completed_at = now()
            WHERE status = 'processing' AND created_at < now() - make_interval(hours => $2)
              AND id IN (SELECT batch_id FROM enrich_contacts WHERE client_tag = $3 AND promote_state = 'running')`,
          [
            JSON.stringify([`Stalled: no final status after ${PROMOTE_STALE_HOURS} hours (server restarted?). Rows imported before that point are kept.`]),
            PROMOTE_STALE_HOURS,
            tag,
          ]
        );
        const started: Started[] = [];
        const busy: PromoteKind[] = [];
        const held: Record<string, number> = {};
        let settled = 0;
        let refused = 0;
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        for (const k of kinds) {
          const filename = `Companies pipeline · ${tag} · ${KIND_WORD[k]} · ${stamp} UTC`;
          const begun = await beginPromote(c, {
            tag,
            kind: k,
            userId,
            settings,
            button: !automatic,
            filename,
          });
          if (begun.busy) {
            busy.push(k);
            continue;
          }
          settled += begun.settled ?? 0;
          refused += begun.refused ?? 0;
          for (const [why, n] of Object.entries((begun.held ?? {}) as Record<string, number>)) held[why] = (held[why] ?? 0) + n;
          if (begun.batchId && begun.batchAt) {
            started.push({
              kind: k,
              batchId: begun.batchId,
              batchAt: begun.batchAt,
              filename,
              rows: begun.rows as string[][],
              contacts: begun.contacts as Started["contacts"],
            });
          }
        }
        if (busy.length === kinds.length) {
          return { status: 409, error: `${tag}'s contacts are being promoted already. Wait for that round to finish.` };
        }
        return { started, settled, refused, held, busy, label: settings.promotion.source_label };
      },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    console.error("companies/promote:", err);
    return { status: 500, body: { error: "Could not start promoting the client's contacts" } };
  }
  if ("error" in out) return { status: out.status, body: { error: out.error } };

  const { started, settled, refused, held, busy, label } = out;
  if (started.length) {
    after(async () => {
      // Inboxes first, then people: one batch at a time, as the design's round.
      for (const b of started) await importAndSettle(tag, b, label);
    });
  }
  const adding = started.reduce((n, b) => n + b.contacts.length, 0);
  const heldCount = Object.values(held).reduce((a, b) => a + b, 0);
  // A worker's round that found nothing to do leaves no audit row.
  if (!automatic || adding + settled + refused + heldCount > 0) await logAudit({
    action: "company_promote",
    performedBy: userId,
    details:
      `${tag}: ${automatic ? "automatic " : ""}promotion round, ${adding} to add, ${settled} already in the database, ` +
      `${refused} refused, ${heldCount} held back` +
      (started.length ? `, upload ${started.map((b) => b.batchId).join(", ")}` : ""),
  });
  return {
    status: 202,
    body: {
      batches: started.map((b) => ({ kind: b.kind, batchId: b.batchId, adding: b.contacts.length })),
      adding,
      settled,
      refused,
      held,
      busy,
    },
  };
}

/** One batch: the import, its counters, then each contact settled (3 tries). */
async function importAndSettle(tag: string, b: Started, label: string) {
  try {
    const counters = await importRows(getPool(), b.rows, {
      batchId: b.batchId,
      filename: b.filename,
      headers: PROMOTE_COLUMNS.map(([h]) => h),
      fieldMapping: Object.fromEntries(PROMOTE_COLUMNS.map(([, k], i) => [i, k])),
      duplicateStrategy: "skip",
      overrideFields: [],
      addTags: [tag],
      extraFields: [...PROMOTE_EXTRA_FIELDS],
      onProgress: (c) => writeProgress(b.batchId, c),
    });
    const nothingLanded = counters.inserted + counters.skipped === 0;
    await writeProgress(b.batchId, counters, counters.errors > 0 && nothingLanded ? "error" : "complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[companies/promote] import ${b.batchId} failed: ${msg}`);
    await enrichPool()
      .query(`UPDATE upload_batches SET status = 'error', error_log = $2::jsonb, completed_at = now() WHERE id = $1`, [b.batchId, JSON.stringify([msg])])
      .catch(() => {});
  }
  // Whatever the import did, each contact's cell says so and stops reading as being added.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await finishPromote(enrichPool(), { batchId: b.batchId, batchAt: b.batchAt, contacts: b.contacts, label });
      return;
    } catch (err) {
      console.error(`[companies/promote] settling ${b.batchId} failed: ${err instanceof Error ? err.message : err}`);
      await sleep(2_000 * attempt);
    }
  }
}

/** The batch's counters, as the Uploads page shows them. The last write (with a status) stops its polling, so it is retried. */
async function writeProgress(batchId: string, c: ImportCounters, status?: "complete" | "error") {
  for (let attempt = 1; ; attempt++) {
    try {
      await enrichPool().query(
        `UPDATE upload_batches
            SET processed_rows = $2, inserted_rows = $3, merged_rows = $4, replaced_rows = $5, skipped_rows = $6,
                no_email_rows = $7, in_file_duplicates = $8, locations_added = $9, esp_detected = $10, error_rows = $11,
                error_log = $12::jsonb, status = coalesce($13::text, status),
                completed_at = CASE WHEN $13::text IS NULL THEN completed_at ELSE now() END
          WHERE id = $1`,
        [
          batchId, c.processed, c.inserted, c.merged, c.replaced, c.skipped, c.no_email, c.in_file_duplicates,
          c.locations_added, c.esp_detected, c.errors, c.error_log.length ? JSON.stringify(c.error_log) : null, status ?? null,
        ]
      );
      return;
    } catch (err) {
      if (!status || attempt >= 3) {
        console.error(`[companies/promote] progress write failed for ${batchId}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await sleep(2_000 * attempt);
    }
  }
}

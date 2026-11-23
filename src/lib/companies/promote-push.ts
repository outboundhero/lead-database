import type { Pool, PoolClient } from "pg";
import { flagOn, normTag, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { scoringStatusFor } from "../../../scripts/lib/enrich/fit-push.mjs";
import { installRole } from "../../../scripts/lib/bison-groups.mjs";
import { loadQuestionSettings, questionSwitchOn } from "../../../scripts/lib/questions/settings.mjs";
import { copyTag } from "../../../scripts/lib/questions/names.mjs";
import { PUSH_NOTE } from "../../../scripts/lib/enrich/promote.mjs";
import {
  notePushCells,
  PROMOTE_PUSH_SOURCE,
  pushColumnsReady,
  pushWaiting,
  readyRows,
  waitingWhy,
} from "../../../scripts/lib/enrich/promote-push.mjs";
import { autoPickCampaigns, type PickableCampaign } from "@/lib/bison/campaign-autopick";
import { isArchivedCampaign } from "@/lib/bison/campaign-meta";
import { searchClientCampaigns, type BisonCampaignRow } from "@/lib/bison/client-campaigns";
import { bisonInstances } from "@/lib/bison/keys";
import {
  checkPushCampaigns,
  groupToSave,
  selectedIdsError,
  sideAcrossInstalls,
  TARGET_MARKET_COLUMNS,
  type PushBatchCampaign,
} from "@/lib/bison/push-batch-core";
import { sidesOfLeads, stampCampaigns, type PushSide } from "@/lib/bison/push-stamp";
import { sharingTx } from "@/lib/sharing/db";

// The automatic push of promoted leads (migration 140; switch
// promotion.auto_push for the clients on promotion.tags): one client's queued
// leads that are ready (scripts/lib/enrich/promote-push.mjs says when) into
// its Email Bison campaigns, as one push batch, the way an operator's push
// from Leads, Export makes it. Clay's General table pushed each approved inbox
// straight into the client's campaigns; promotion stopped at the leads table.
// Called by POST /api/companies/promote/auto/push, which the enrich-worker
// asks.
//
//   - Off for the client, migration 140 missing, no Bison keys, or a campaign
//     search that reported any error ("partial" included): 409, and nothing
//     changes, so the leads stay queued and the next ask tries again.
//   - The campaigns are picked exactly as the export popup pre-selects them
//     (autoPickCampaigns over the client's live campaigns, all of them or
//     none) and sent through the push route's own checks
//     (src/lib/bison/push-batch-core.ts), stamping and side rule. Nothing
//     picked, or a check refusing: every lead held with the reason, left for
//     a push from Leads, Export, and never taken again.
//   - A lead goes only to campaigns on its own side, as Clay put an inbox in
//     the client's B2B or B2C install: when the picked campaigns cover one
//     side only, the other side's leads are held ("no B2C campaign"). Mimecast
//     addresses are held too, as the Leads page and shares leave them out by
//     default. A lead that is gone, or already in one of the client's pushes,
//     is dropped.
//   - The rest go into ONE push_batches row: the picked campaigns, exactly
//     these lead ids, the client's tag, no email side, forced (the route's
//     24-hour guard never applies to it), push_options source "promote" with
//     skipAlreadySent, and the status the fit gate gives. The same
//     transaction marks exactly those contacts pushed, so a lead is pushed at
//     most once. An empty id list is never inserted (the worker would gather
//     the whole table).
//
// Every read and write of the contacts happens in one transaction under
// pg_advisory_xact_lock(hashtext('promote-push:' || tag)). The campaign
// search runs before it (a Bison read can take a minute, and a transaction
// must not sit open across it), as the share push does.

export type CampaignReader = (tag: string) => Promise<{ data: BisonCampaignRow[]; errors: string[] }>;

export interface PromotePushAnswer {
  tag: string;
  /** Leads queued into the push batch. */
  pushed: number;
  batch: string | null;
  campaigns: number;
  held: number;
  /** Why leads were held (each reason once), or null. */
  held_why: string | null;
  dropped: number;
  /** Queued leads not ready yet (their round importing, or waiting for places). */
  waiting: number;
  note: string | null;
}

export type PromotePushResult =
  | { status: 200; body: PromotePushAnswer }
  | { status: 409; body: { error: string; kept: number } };

/** The push options every automatic push carries; force is a record only (the 24-hour guard lives in the route). */
export const PROMOTE_PUSH_OPTIONS = Object.freeze({
  includeAlreadyPushed: false,
  onlyNewSinceLast: false,
  retryFailed: false,
  source: PROMOTE_PUSH_SOURCE,
  skipAlreadySent: true,
  force: true,
});

type Row = { row_id: number; table_id: string; lead_id: string | null };
type Outcome = { state: "held" | "dropped"; why: string; rows: Row[] };

const sideName = (s: PushSide) => (s === "b2c" ? "B2C" : "B2B");
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

async function readSettings(c: PoolClient) {
  const { rows } = await c.query(`SELECT key, value FROM enrich_settings WHERE key = 'promotion'`);
  return settingsFrom(rows);
}

/** The question variable the client's pushes send (139), when its switch is on and a live one is chosen; else null. */
async function questionVariableOf(c: PoolClient, tag: string): Promise<string | null> {
  if (!questionSwitchOn(await loadQuestionSettings(c), tag)) return null;
  const { rows: [ready] } = await c.query(
    `SELECT to_regclass('public.client_question_settings') IS NOT NULL AND to_regclass('public.question_variables') IS NOT NULL AS ok`
  );
  if (!ready?.ok) return null;
  const { rows: [v] } = await c.query(
    `SELECT v.name FROM client_question_settings s JOIN question_variables v ON v.id = s.variable_id
      WHERE s.client_tag = $1 AND v.archived_at IS NULL`,
    [tag]
  );
  return v?.name ? String(v.name) : null;
}

/** The leads of these ids already in one of the client's pushes: queued and not gathered yet, or an item not failed or skipped. */
async function alreadyPushed(c: PoolClient, tag: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { rows } = await c.query(
    `SELECT DISTINCT ON (x.lead_id) x.lead_id::text AS lead_id, x.batch_id::text AS batch_id FROM (
       SELECT i.lead_id, i.batch_id FROM push_items i JOIN push_batches b ON b.id = i.batch_id
        WHERE i.lead_id = ANY($1::uuid[]) AND b.client_tag = $2 AND i.status IN ('pending', 'pushing', 'sent')
       UNION ALL
       SELECT u.lead_id, b.id FROM push_batches b CROSS JOIN LATERAL unnest(b.selected_ids) AS u(lead_id)
        WHERE b.client_tag = $2 AND b.status IN ('pending', 'scoring', 'gathering') AND b.selected_ids && $1::uuid[]
          AND u.lead_id = ANY($1::uuid[])
     ) x`,
    [ids, tag]
  );
  for (const r of rows) out.set(r.lead_id as string, r.batch_id as string);
  return out;
}

async function auditRow(c: PoolClient, action: string, details: string) {
  await c.query(`INSERT INTO audit_logs (action, performed_by, details) VALUES ($1, NULL, $2)`, [action, details]);
}

/** Marks contacts held or dropped with the reason, says so in their cells, and logs each reason once. */
async function settle(c: PoolClient, tag: string, outcomes: Outcome[]) {
  for (const o of outcomes) {
    if (!o.rows.length) continue;
    await c.query(
      `UPDATE enrich_contacts SET auto_push_state = $2, auto_push_note = $3, auto_push_at = now()
        WHERE row_id = ANY($1::bigint[]) AND auto_push_state = 'queued'`,
      [o.rows.map((r) => r.row_id), o.state, o.why]
    );
    await notePushCells(
      c,
      o.rows.map((r) => ({
        row_id: r.row_id,
        state: o.state,
        sentence: `${PUSH_NOTE.held}: ${o.why}.${o.state === "held" ? " Push it from Leads, Export." : ""}`,
      }))
    );
    await auditRow(
      c,
      o.state === "held" ? "promotion_push_held" : "promotion_push_dropped",
      `${tag}: ${plural(o.rows.length, "promoted lead")} not pushed into its campaigns: ${o.why}`
    );
  }
}

/**
 * Pushes one client's ready promoted leads (see the note at the top).
 *
 * @param pool the web app's pg pool
 * @param opts.tag the client's tag
 * @param opts.readCampaigns the live campaign read; tests pass a stand-in
 */
export async function pushPromoted(
  pool: Pool,
  { tag: rawTag, readCampaigns = searchClientCampaigns }: { tag: string; readCampaigns?: CampaignReader }
): Promise<PromotePushResult> {
  const tag = normTag(rawTag);
  const answer = (o: Partial<PromotePushAnswer>): PromotePushResult => ({
    status: 200,
    body: { tag, pushed: 0, batch: null, campaigns: 0, held: 0, held_why: null, dropped: 0, waiting: 0, note: null, ...o },
  });
  const off = (kept: number) => ({
    status: 409 as const,
    body: {
      error:
        `The automatic push is off for ${tag} (promotion's switch, its client list, or "Push into campaigns" on the ` +
        "Companies tab's settings), so nothing was pushed. Its queued leads stay queued.",
      kept,
    },
  });

  // Before the campaign search: may it run, and is anything ready?
  const first = await sharingTx(
    pool,
    async (c) => {
      const settings = await readSettings(c);
      if (!(await pushColumnsReady(c))) return { settings, ready: false, waiting: null };
      return { settings, ready: true, waiting: await pushWaiting(c, tag) };
    },
    { readOnly: true, timeoutMs: 15_000 }
  );
  if (!first.ready || !first.waiting) {
    return { status: 409, body: { error: "Migration 140 is not applied here, so nothing is queued or pushed automatically.", kept: 0 } };
  }
  if (!flagOn(first.settings, "promotion_push", tag)) return off(first.waiting.queued);
  if (first.waiting.ready === 0) {
    return answer({ waiting: first.waiting.queued, note: waitingWhy(first.waiting) ?? "nothing to push" });
  }

  const instances = bisonInstances();
  if (instances.length === 0) {
    return { status: 409, body: { error: "No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY), so nothing was pushed. The leads stay queued.", kept: first.waiting.ready } };
  }
  let read: { data: BisonCampaignRow[]; errors: string[] };
  try {
    read = await readCampaigns(tag);
  } catch (e) {
    read = { data: [], errors: [e instanceof Error ? e.message : String(e)] };
  }
  if (read.errors.length) {
    return {
      status: 409,
      body: {
        error: `The campaign search for ${tag} reported an error, so nothing was pushed this time (the leads stay queued): ${read.errors.join("; ")}`,
        kept: first.waiting.ready,
      },
    };
  }

  return sharingTx(
    pool,
    async (c): Promise<PromotePushResult> => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('promote-push:' || $1))`, [tag]);
      const settings = await readSettings(c);
      const rows = (await readyRows(c, { tag, lock: true })) as Row[];
      if (!flagOn(settings, "promotion_push", tag)) return off(rows.length);
      if (!rows.length) {
        const w = await pushWaiting(c, tag);
        return answer({ waiting: w.queued, note: waitingWhy(w) ?? "nothing to push" });
      }
      const leftWaiting = async () => (await pushWaiting(c, tag)).queued;
      const holdAll = async (why: string) => {
        await settle(c, tag, [{ state: "held", why, rows }]);
        return answer({ held: rows.length, held_why: why, waiting: await leftWaiting() });
      };

      // The client, its saved installs, and the question variable its pushes send.
      const { rows: [ct] } = await c.query(`SELECT tag, group_no, b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`, [tag]);
      if (!ct) return holdAll(`${tag} is not in the client list (client_tags)`);
      const variable = await questionVariableOf(c, tag);
      if (variable) {
        return holdAll(
          `${tag}'s pushes send the question variable ${copyTag(variable)}, and these new leads have none written yet: ` +
            "write it for them and push them from Leads, Export"
        );
      }

      // The campaigns, exactly as the export popup pre-selects them from the same search, and sends them.
      const pick = autoPickCampaigns(read.data as unknown as Array<PickableCampaign & { workspace_name?: unknown }>, tag, ct);
      if (!pick.picked.length) return holdAll(`no campaign could be picked as the export popup picks them: ${pick.blocked ?? "none picked"}`);
      const sent = pick.picked
        .filter((x) => !isArchivedCampaign(x))
        .map((x) => ({ id: x.id, name: x.name, instance_url: x.instance_url, workspace_name: x.workspace_name, status: x.status }));
      const checked = checkPushCampaigns(sent, instances);
      if ("error" in checked) return holdAll(checked.error);
      const campaigns: PushBatchCampaign[] = checked.campaigns;
      const saved = stampCampaigns(campaigns, ct);
      const sided = sideAcrossInstalls(campaigns, tag);
      if ("error" in sided) return holdAll(sided.error);

      // Each lead to its own side: a side with no picked campaign holds its leads. A campaign of a one-install push
      // with no saved side takes its install's own; one on an install in no group is open to either side, as the
      // worker leaves it.
      const covered = new Set<PushSide>();
      for (const cp of campaigns) {
        const side = cp.side ?? (installRole(cp.instance_url) as { side: PushSide } | null)?.side ?? null;
        if (side) covered.add(side);
        else covered.add("b2b").add("b2c");
      }
      const ids = [...new Set(rows.map((r) => r.lead_id).filter((id): id is string => Boolean(id)))];
      const sides = await sidesOfLeads(c, ids);
      const { rows: mime } = await c.query(`SELECT id::text AS id FROM leads WHERE id = ANY($1::uuid[]) AND esp = 'Mimecast'`, [ids]);
      const mimecast = new Set(mime.map((m) => m.id as string));
      const taken = await alreadyPushed(c, tag, ids);
      const outcomes: Record<string, Outcome> = {};
      const out = (state: Outcome["state"], why: string, r: Row) => (outcomes[`${state}|${why}`] ??= { state, why, rows: [] }).rows.push(r);
      const toPush: Row[] = [];
      for (const r of rows) {
        const side = r.lead_id ? sides.get(r.lead_id) : undefined;
        if (!r.lead_id || !side) out("dropped", "the lead is gone or has no email", r);
        else if (taken.has(r.lead_id)) out("dropped", `it is in ${tag}'s push batch ${taken.get(r.lead_id)} already`, r);
        else if (mimecast.has(r.lead_id)) out("held", "a Mimecast address, which the Leads page and shares leave out unless an operator adds them", r);
        else if (!covered.has(side)) out("held", `no ${sideName(side)} campaign of ${tag} was picked, so its ${sideName(side)} leads stay out`, r);
        else toPush.push(r);
      }

      let batch: string | null = null;
      const pushIds = [...new Set(toPush.map((r) => r.lead_id as string))];
      if (pushIds.length) {
        const idsError = selectedIdsError(pushIds);
        if (idsError) return holdAll(idsError);
        const status = await scoringStatusFor(c, tag);
        const { rows: [tm] } = await c.query(`SELECT ${TARGET_MARKET_COLUMNS} FROM client_targeting WHERE client_tag = $1`, [tag]);
        // Never an empty id list: with no filters the worker would gather the whole leads table.
        const { rows: [b] } = await c.query(
          `INSERT INTO push_batches (created_by, campaigns, filters, target_market, selected_ids, range_from, range_to, max_leads,
                                     client_tag, email_side, push_options, status)
           SELECT NULL, $1::jsonb, NULL, $2::jsonb, $3::uuid[], NULL, NULL, NULL, $4, NULL, $5::jsonb, $6
            WHERE cardinality($3::uuid[]) > 0
           RETURNING id::text AS id`,
          [JSON.stringify(campaigns), tm ? JSON.stringify(tm) : null, pushIds, tag, JSON.stringify(PROMOTE_PUSH_OPTIONS), status]
        );
        batch = (b?.id as string | undefined) ?? null;
        if (!batch) throw new Error("the push batch was not inserted");
        const { rowCount } = await c.query(
          `UPDATE enrich_contacts SET auto_push_state = 'pushed', auto_push_batch_id = $2, auto_push_at = now(), auto_push_note = NULL
            WHERE row_id = ANY($1::bigint[]) AND auto_push_state = 'queued'`,
          [toPush.map((r) => r.row_id), batch]
        );
        if (rowCount !== toPush.length) throw new Error(`marking the pushed contacts changed ${rowCount} of ${toPush.length} rows`);
        await notePushCells(
          c,
          toPush.map((r) => ({
            row_id: r.row_id,
            state: "pushed",
            batch_id: batch,
            sentence: `${PUSH_NOTE.pushed}: push batch ${batch}, ${plural(campaigns.length, "campaign")}, forced.`,
          }))
        );
        await auditRow(
          c,
          "bison_push_batch_queued",
          `Queued Bison push batch ${batch} to ${campaigns.length} campaign(s): ${campaigns.map((x) => x.name || x.id).join(", ")} ` +
            `(the automatic push of ${plural(pushIds.length, "lead")} ${tag}'s promotion added, forced${status === "scoring" ? ", waiting for fit scoring" : ""})`
        );
        // The group these installs resolved, saved on the client as the push route saves it.
        const toSave = groupToSave({ group: (ct.group_no as number | null) ?? null, b2b: saved.b2b, b2c: saved.b2c }, sided.group);
        if (toSave) {
          await c.query(
            `UPDATE client_tags SET group_no = $2, b2b_instance = $3, b2c_instance = $4, source = 'push' WHERE tag = $1`,
            [tag, toSave.group, toSave.b2b, toSave.b2c]
          );
          await auditRow(
            c,
            "Client Group Set From Push",
            `${tag}: group ${toSave.group} (was ${toSave.previous ?? "none"}), from the installs of automatic push batch ${batch}`
          );
        }
      }
      const list = Object.values(outcomes);
      await settle(c, tag, list);
      const held = list.filter((o) => o.state === "held");
      return answer({
        pushed: pushIds.length,
        batch,
        campaigns: batch ? campaigns.length : 0,
        held: held.reduce((n, o) => n + o.rows.length, 0),
        held_why: held.length ? held.map((o) => o.why).join("; ") : null,
        dropped: list.filter((o) => o.state === "dropped").reduce((n, o) => n + o.rows.length, 0),
        waiting: await leftWaiting(),
        note: null,
      });
    },
    { timeoutMs: 120_000 }
  );
}

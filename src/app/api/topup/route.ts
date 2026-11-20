import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { modes } from "@/lib/aiark/server";
import { settingsFrom } from "../../../../scripts/lib/enrich/settings.mjs";
import { placeLabel } from "../../../../scripts/lib/aiark/start-run.mjs";
import { pullsStartedToday, topupBudget } from "../../../../scripts/lib/topup/budget.mjs";
import { readFreeFirst } from "../../../../scripts/lib/topup/free-first.mjs";
import { handRunsBlocked } from "../../../../scripts/lib/topup/hand-runs.mjs";
import type { TopupClient, TopupHandRun, TopupPull, TopupView } from "./types";

// GET /api/topup: the Sharing page's Low places tab. The weekly top-up's
// settings, the newest pass with its flags per client (low places, available
// against the minimum, what was done, the run, the client's tag count, and
// its "free first" numbers as the pass stored them), the pass's count of
// every unresolved lead, the pulls waiting to start with the versions
// POST /api/aiark/runs checks, the budget used and held in the last 7 days,
// which AI Ark modes can run, and the AI Ark runs someone started by hand
// that are going for clients that cannot receive now (a live read).
// Manager and up. Read only. Before migration 135 it answers ready: false.

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  try {
    const view = await withTx(
      async (c): Promise<TopupView> => {
        const { rows: [ready] } = await c.query(`SELECT to_regclass('public.topup_passes') IS NOT NULL AS ok`);
        if (!ready.ok) {
          return {
            ready: false, settings: null, pass: null, lastDone: null, clients: [], pulls: [], budget: null, clientBudget: {}, modes: null,
            freeFirst: null, handRuns: [],
          };
        }
        const { rows: srows } = await c.query(`SELECT key, value FROM enrich_settings`);
        const wt = settingsFrom(srows).weekly_topup;
        const { rows: [pass] } = await c.query(
          `SELECT p.*, coalesce(cardinality(p.clients_done), 0) AS done_n, up.full_name AS requested_by_name
             FROM topup_passes p LEFT JOIN user_profiles up ON up.id = p.requested_by
            ORDER BY p.requested_at DESC LIMIT 1`
        );
        const { rows: [lastDone] } = await c.query(
          `SELECT id, finished_at FROM topup_passes WHERE state = 'done' ORDER BY finished_at DESC NULLS LAST LIMIT 1`
        );
        const { rows: flags } = pass
          ? await c.query(
              `SELECT f.*, ct.name, ct.client_type, ct.status, cs.leads AS tag_leads, cs.contactable AS tag_contactable
                 FROM topup_flags f
                 LEFT JOIN client_tags ct ON ct.tag = f.client_tag
                 LEFT JOIN client_stats cs ON cs.tag = f.client_tag
                WHERE f.pass_id = $1
                ORDER BY f.client_tag, f.available NULLS LAST, f.id`,
              [pass.id]
            )
          : { rows: [] };
        // Free first, as the pass stored it (checked; a pass from before it has none).
        const free = readFreeFirst(pass?.counts);
        const byTag = new Map<string, TopupClient>();
        for (const f of flags) {
          let cl = byTag.get(f.client_tag);
          if (!cl) {
            cl = {
              tag: f.client_tag, name: f.name ?? null, clientType: f.client_type ?? null, status: f.status ?? null,
              receiveBlock: f.receive_block ?? null, minimum: f.minimum ?? null, kind: null, places: [], action: "none", reason: null,
              pullId: null, runId: null,
              tagLeads: f.tag_leads == null ? null : Number(f.tag_leads),
              tagContactable: f.tag_contactable == null ? null : Number(f.tag_contactable),
              freeFirst: free.clientOf(f.client_tag),
            };
            byTag.set(f.client_tag, cl);
          }
          if (f.kind === "low" || f.kind === "unresolved") {
            cl.places.push({ kind: f.kind, label: f.label, placeKey: f.place_key, place: f.place ?? null, available: f.available, minimum: f.minimum });
            if (f.kind === "low") {
              cl.action = f.action;
              cl.reason = f.reason ?? cl.reason;
              cl.pullId = f.pull_id ?? cl.pullId;
              cl.runId = f.run_id ?? cl.runId;
            } else if (!cl.reason) {
              cl.reason = f.reason ?? null;
            }
          } else {
            cl.kind = f.kind;
            cl.reason = f.reason ?? null;
          }
          if (cl.minimum == null && f.minimum != null) cl.minimum = f.minimum;
        }
        const { rows: pullRows } = await c.query(
          `SELECT p.*, jsonb_array_length(p.requests) AS searches, t.updated_at::text AS rules_version, pf.updated_at::text AS people_version
             FROM topup_pulls p
             LEFT JOIN client_targeting t ON t.client_tag = p.client_tag
             LEFT JOIN client_people_filters pf ON pf.client_tag = p.client_tag
            WHERE p.state = 'prepared'
            ORDER BY p.created_at, p.id`
        );
        const pulls: TopupPull[] = pullRows.map((p) => ({
          id: p.id, passId: p.pass_id, tag: p.client_tag, mode: p.mode, places: p.places, labels: (p.places ?? []).map(placeLabel),
          size: p.size, searches: Number(p.searches), brake: Number(p.brake), countCredits: Number(p.count_credits),
          matchCount: p.match_count == null ? null : Number(p.match_count), countedAt: p.counted_at, note: p.note, createdAt: p.created_at,
          rulesVersion: p.rules_version ?? null, peopleVersion: p.people_version ?? null,
        }));
        const b = await topupBudget(c);
        const clientBudget: TopupView["clientBudget"] = {};
        for (const tag of new Set(pulls.map((p) => p.tag))) {
          const cb = await topupBudget(c, { tag });
          clientBudget[tag] = { used: cb.clientUsed, reserved: cb.clientReserved };
        }
        const handRuns: TopupHandRun[] = (await handRunsBlocked(c)).map((r) => ({
          id: r.id, tag: r.client_tag, status: r.status, mode: r.mode, strategy: r.strategy,
          size: Number(r.size_requested), creditsUsed: Number(r.credits_used), pulled: Number(r.pulled),
          createdAt: iso(r.created_at) ?? "", startedAt: iso(r.started_at), startedBy: r.started_by ?? null, reason: r.block,
        }));
        return {
          ready: true,
          settings: {
            enabled: wt.enabled, clientTypes: wt.client_types, defaultMinimum: wt.default_minimum, pullMode: wt.pull_mode,
            pullTags: wt.pull_tags, weeklyCredits: wt.weekly_credits, clientWeeklyCredits: wt.client_weekly_credits,
            maxPullSize: wt.max_pull_size, pullsPerDay: wt.pulls_per_day,
          },
          pass: pass
            ? {
                id: pass.id, state: pass.state, trigger: pass.trigger, requestedAt: pass.requested_at, startedAt: pass.started_at,
                finishedAt: pass.finished_at, clientsDone: Number(pass.done_n), counts: pass.counts ?? {}, lastError: pass.last_error,
                requestedByName: pass.requested_by_name ?? null,
              }
            : null,
          lastDone: lastDone ? { id: lastDone.id, finishedAt: lastDone.finished_at } : null,
          clients: [...byTag.values()],
          pulls,
          budget: {
            used: b.used, reserved: b.reserved, weekly: wt.weekly_credits, clientWeekly: wt.client_weekly_credits,
            pullsToday: await pullsStartedToday(c), pullsPerDay: wt.pulls_per_day,
          },
          clientBudget,
          modes: modes(),
          freeFirst: free.top,
          handRuns,
        };
      },
      { readOnly: true, timeoutMs: 15_000 }
    );
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("topup GET:", err);
    return NextResponse.json({ error: "Could not load the low places" }, { status: 500 });
  }
}

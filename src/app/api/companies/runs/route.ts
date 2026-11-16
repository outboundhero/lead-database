import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import {
  cleanTag,
  clientInfo,
  COMPANY_RUN_FIELDS,
  companyFiltersFor,
  companyModes,
  companyPlan,
  companyRunsFor,
  countsFor,
  createCompanyRun,
  geo,
  pipelineView,
  PULL_SIZE_LIMIT,
  readPipelineSettings,
  savedPeople,
  TAG_RE,
  targetingOf,
  workerView,
} from "@/lib/companies/server";
import type { RunMode } from "@/lib/aiark/types";
import type { PullSource } from "@/lib/linkedin/types";
import { changedText, createLinkedinCompanyRun, linkedinPlanOf, linkedinPullFilters, switchRefusal } from "@/lib/linkedin/server";
import { linkedinSettingsFor } from "../../../../../scripts/lib/aiark/linkedin-settings.mjs";
import { settingsFrom } from "../../../../../scripts/lib/enrich/settings.mjs";
import { hasRetiredV1, variantFor } from "../../../../../scripts/lib/enrich/templates.mjs";
import { originalsSummary } from "../../../../../scripts/lib/enrich/compile-original.mjs";

// GET  /api/companies/runs?tag=ABC: a client's 10 newest company pulls, the
//      worker, the counts on its list and the settings' switch. The tab polls this.
// POST /api/companies/runs {tag, mode, size, matchCount, rulesVersion,
//      filtersVersion}: queues a pull. It uses the client's current rules and
//      saved company filters, never filters from the request; the page sends the
//      versions it showed, and a 409 with `changed` answers any change since. In
//      one transaction it makes the client's Companies table on the Clay tab (or
//      brings its columns up to date), the pull's source and its
//      aiark_company_runs row; the enrichment worker does the buying.
//      Refused with a 409 while company pulls are switched off or the client is
//      not on their client list (company_pipeline.tags), while the worker is
//      offline or doesn't run the pipeline's Clay originals (pipeline_v2), while
//      the client has a pull going, while the Clay originals are not loaded, for
//      a client that still has a phase 1 (companies_v1) table (D24), without a
//      count, or when the rules or filters changed. The size is at most the
//      settings' largest pull. Manager and up: a live pull spends AI Ark credits.
//      source "linkedin" {..., source, linkedinVersion} (migration 128; "ai_ark"
//      when left out) queues the client's LinkedIn company pull instead: the
//      same refusals, and also while the LinkedIn searches are off or the client
//      is not on their list, with a worker that doesn't do LinkedIn searches
//      (linkedin_sources), and with `changed` when its LinkedIn search changed
//      since the page loaded it. One pull per client, of either source. The
//      pull keeps what it was asked in filters.linkedin.

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("en-US");

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => ({
        runs: await companyRunsFor(c, tag),
        worker: workerView(await workerState(c)),
        counts: await countsFor(c, tag),
        pipeline: pipelineView((await readPipelineSettings(c)).value, tag),
      }),
      { readOnly: true, timeoutMs: 8_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/runs GET:", err);
    return NextResponse.json({ error: "Could not load the pulls" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: {
    tag?: unknown; mode?: unknown; size?: unknown; matchCount?: unknown; rulesVersion?: unknown; filtersVersion?: unknown; source?: unknown; linkedinVersion?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const mode = body.mode === "live" || body.mode === "demo" ? (body.mode as RunMode) : null;
  if (!mode) return NextResponse.json({ error: "mode must be live or demo" }, { status: 400 });
  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 1 || size > PULL_SIZE_LIMIT) {
    return NextResponse.json({ error: `size must be a whole number from 1 to ${fmt(PULL_SIZE_LIMIT)}` }, { status: 400 });
  }
  const source: PullSource | null = body.source === undefined || body.source === null ? "ai_ark" : body.source === "ai_ark" || body.source === "linkedin" ? body.source : null;
  if (!source) return NextResponse.json({ error: "source must be ai_ark or linkedin" }, { status: 400 });
  const linkedinVersion = typeof body.linkedinVersion === "string" ? body.linkedinVersion : null;
  const ready = companyModes()[mode];
  if (!ready.ready) return NextResponse.json({ error: ready.why, needsKey: mode === "live" }, { status: 409 });
  const matchCount = typeof body.matchCount === "number" && Number.isSafeInteger(body.matchCount) && body.matchCount >= 0 ? body.matchCount : null;
  if (matchCount === null) {
    return NextResponse.json({ error: "Count the matches first: a pull starts only after a count for these rules and filters." }, { status: 409 });
  }
  const rulesVersion = typeof body.rulesVersion === "string" ? body.rulesVersion : null;
  const filtersVersion = typeof body.filtersVersion === "string" ? body.filtersVersion : null;

  try {
    const out = await withTx(
      async (c) => {
        // Two clicks at once must not start two pulls for the client.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-company-run:' || $1))`, [tag]);
        const settings = (await readPipelineSettings(c)).value.company_pipeline;
        if (!settings.enabled) {
          return { status: 409, error: "Company pulls are off, so nothing was started. An admin can switch them on in the settings." };
        }
        const { rows: settingRows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`);
        const all = settingsFrom(settingRows);
        if (!all.flagOn("company_pipeline", tag)) {
          return {
            status: 409,
            error: `${tag} is not on the company pipeline's client list, so nothing was started. An admin adds it in the settings.`,
          };
        }
        if (source === "linkedin") {
          const why = switchRefusal(all, tag, "companies", "started");
          if (why) return { status: 409, error: why };
        }
        if (size > settings.max_pull_size) {
          return { status: 400, error: `A pull takes at most ${fmt(settings.max_pull_size)} companies for now (the largest pull in the settings).` };
        }
        const { rows: active } = await c.query(
          `SELECT id FROM aiark_company_runs WHERE client_tag = $1 AND status IN ('queued', 'running') LIMIT 1`,
          [tag]
        );
        if (active.length) return { status: 409, error: `${tag} already has a company pull going. Cancel it or let it finish first.` };
        // A pull queued now would start spending the moment a worker that knows company pulls appears.
        const worker = workerView(await workerState(c));
        if (!worker?.online) {
          return { status: 409, error: "Pulls can't start yet: the service that runs them is off, so nothing was started." };
        }
        if (!worker.companyRuns) {
          return { status: 409, error: "The worker that is running doesn't do company pulls yet, so nothing was started. Deploy the latest worker first." };
        }
        const capabilities = (await workerState(c))?.info?.capabilities;
        if (!Array.isArray(capabilities) || !capabilities.includes("pipeline_v2")) {
          return {
            status: 409,
            error: "The worker that is running doesn't run the pipeline's Clay originals yet, so nothing was started. Deploy the latest worker first.",
          };
        }
        if (source === "linkedin" && !worker.linkedin) {
          return { status: 409, error: "The worker that is running doesn't do LinkedIn searches yet, so nothing was started. Deploy the latest worker first." };
        }
        if (await hasRetiredV1(c, tag)) {
          return {
            status: 409,
            error: `${tag} still has a phase 1 (companies_v1) table, so nothing was started: its pulls wait until the owner decides what happens to it.`,
          };
        }
        const variant = await variantFor(c, tag);
        const loaded = await originalsSummary(c, variant === "default" ? null : variant);
        if (!(variant === "default" ? loaded.default.complete : loaded.client?.complete)) {
          return {
            status: 409,
            error: "The Clay originals are not loaded, so nothing was started. They are loaded with scripts/enrich-seed-originals.mjs.",
          };
        }
        const client = await clientInfo(c, tag);
        if (!client) return { status: 404, error: `${tag} is not a client` };
        if (source === "linkedin") {
          const effective = await linkedinSettingsFor(c, { tag, kind: "companies" });
          if (effective.version !== linkedinVersion) return { status: 409, error: changedText(tag, "companies", "started"), changed: true };
          const built = linkedinPlanOf(effective, await geo(c));
          const blocked = [...built.blockers, ...built.pullBlockers];
          if (blocked.length) return { status: 400, error: blocked.join(" ") };
          // As createCompanyRun below, plus the source: the copy matches the LinkedIn places, the bought rows are kind linkedin.
          const run = await createLinkedinCompanyRun(c, {
            tag,
            mode,
            size,
            filters: linkedinPullFilters(effective, built),
            requests: built.requests,
            matchCount,
            createdBy: auth.user.id,
            targeting: built.targeting,
          });
          const { rows } = await c.query(
            `SELECT ${COMPANY_RUN_FIELDS} FROM aiark_company_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`,
            [run.id]
          );
          return { run: rows[0] };
        }
        const targeting = await targetingOf(c, tag);
        const saved = await savedPeople(c, tag);
        const filtersChanged = (saved?.version ?? null) !== filtersVersion;
        if (filtersChanged || (targeting?.version ?? null) !== rulesVersion) {
          const what = filtersChanged ? "company filters (size and industries, on the AI Ark tab)" : "rules (locations and exclusions)";
          return { status: 409, error: `${tag}'s ${what} changed since this page loaded them, so nothing was started.`, changed: true };
        }
        const filters = companyFiltersFor(saved, client.client_type ?? null);
        const p = companyPlan(targeting, filters.value, await geo(c), client.client_type ?? null);
        const blocked = [...p.blockers, ...p.pullBlockers];
        if (blocked.length) return { status: 400, error: blocked.join(" ") };
        // createCompanyRun makes the client's three pipeline tables (Companies companies_v2, General
        // inboxes, People), compiled from the Clay originals, on its first pull and brings their columns
        // up to date on every pull, then adds the pull's sources and row. The checks above make its own
        // refusals (a v1 table, originals missing) unreachable, short of a race.
        const run = await createCompanyRun(c, {
          tag,
          mode,
          size,
          filters: {
            company: filters.value,
            defaults_from: filters.defaultsFrom,
            rules_version: rulesVersion,
            filters_version: filtersVersion,
            targeting_updated_at: targeting?.updated_at ?? null,
            filters_updated_at: saved?.updated_at ?? null,
            report: p.report,
            notes: p.notes,
          },
          requests: p.requests,
          matchCount,
          createdBy: auth.user.id,
        });
        const { rows } = await c.query(
          `SELECT ${COMPANY_RUN_FIELDS} FROM aiark_company_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`,
          [run.id]
        );
        return { run: rows[0] };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) {
      return NextResponse.json({ error: out.error, changed: "changed" in out }, { status: out.status });
    }
    await logAudit({
      action: "companies_run",
      performedBy: auth.user.id,
      details: `${tag}: ${mode} ${source === "linkedin" ? "LinkedIn " : ""}pull of ${size} companies queued (run ${out.run.id})`,
    });
    return NextResponse.json({ run: out.run }, { status: 201 });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "LinkedinPullRefused") return NextResponse.json({ error: (err as Error).message }, { status: 409 });
    if (name === "RetiredV1Table" || name === "OriginalsMissing") {
      return NextResponse.json(
        { error: name === "OriginalsMissing" ? "The Clay originals are not loaded, so nothing was started." : (err as Error).message },
        { status: 409 }
      );
    }
    console.error("companies/runs POST:", err);
    return NextResponse.json({ error: "Could not start the pull" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { AiArkError, aiArkFor } from "@/lib/aiark/server";
import {
  cleanTag,
  clientInfo,
  companyFiltersFor,
  companyModes,
  companyPlan,
  companySample,
  geo,
  readPipelineSettings,
  savedPeople,
  TAG_RE,
  targetingOf,
} from "@/lib/companies/server";
import type { CompanyCountResult } from "@/lib/companies/types";
import type { RunMode } from "@/lib/aiark/types";
import { settingsFrom } from "../../../../../scripts/lib/enrich/settings.mjs";

// POST /api/companies/count {tag, mode, rulesVersion, filtersVersion}: how
// many companies AI Ark has for a client's rules and company filters. One
// Company Search page per search: 5 companies on the first (shown as examples),
// 1 on each other (its totalElements is the count). AI Ark charges 0.1 credit
// a company returned, so a count costs 0.5 credit plus 0.1 for each further
// search (demo: made-up companies, nothing spent). Nothing is stored, so a
// pull may buy the sampled companies again.
//
// rulesVersion and filtersVersion are the versions the tab loaded: when either
// changed since, the answer is 409 with `changed` and nothing is spent. The
// answer carries the versions it counted with, and a pull needs a count made
// for the versions on screen. Refused while company pulls are switched off,
// and for a client not on their client list (company_pipeline.tags): a live
// count spends credits. Manager and up.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SAMPLE = 5;
const PER_COMPANY = 0.1; // credits per company returned, when AI Ark's X-Credit header is missing
const round = (n: number) => Math.round(n * 100) / 100;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; mode?: unknown; rulesVersion?: unknown; filtersVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const mode = body.mode === "live" || body.mode === "demo" ? (body.mode as RunMode) : null;
  if (!mode) return NextResponse.json({ error: "mode must be live or demo" }, { status: 400 });
  const ready = companyModes()[mode];
  if (!ready.ready) return NextResponse.json({ error: ready.why, needsKey: mode === "live" }, { status: 409 });

  let requests: object[];
  let rulesVersion: string | null;
  let filtersVersion: string | null;
  try {
    const p = await withTx(
      async (c) => {
        const settings = await readPipelineSettings(c);
        const { rows: settingRows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`);
        const client = await clientInfo(c, tag);
        const targeting = await targetingOf(c, tag);
        const saved = await savedPeople(c, tag);
        const filters = companyFiltersFor(saved, client?.client_type ?? null);
        return {
          enabled: settings.value.company_pipeline.enabled,
          listed: settingsFrom(settingRows).flagOn("company_pipeline", tag),
          ...companyPlan(targeting, filters.value, await geo(c), client?.client_type ?? null),
          rulesVersion: (targeting?.version as string | undefined) ?? null,
          filtersVersion: (saved?.version as string | undefined) ?? null,
        };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if (!p.enabled) {
      return NextResponse.json({ error: "Company pulls are off, so nothing was counted. An admin can switch them on in the settings." }, { status: 409 });
    }
    if (!p.listed) {
      return NextResponse.json(
        { error: `${tag} is not on the company pipeline's client list, so nothing was counted. An admin adds it in the settings.` },
        { status: 409 }
      );
    }
    const rulesChanged = body.rulesVersion !== undefined && p.rulesVersion !== body.rulesVersion;
    const filtersChanged = body.filtersVersion !== undefined && p.filtersVersion !== body.filtersVersion;
    if (rulesChanged || filtersChanged) {
      const what = rulesChanged ? "rules (locations and exclusions)" : "company filters (size and industries, on the AI Ark tab)";
      return NextResponse.json(
        { error: `${tag}'s ${what} changed since this page loaded them, so nothing was counted. Reload to see them.`, changed: true },
        { status: 409 }
      );
    }
    if (p.blockers.length) return NextResponse.json({ error: p.blockers.join(" ") }, { status: 400 });
    requests = p.requests;
    rulesVersion = p.rulesVersion;
    filtersVersion = p.filtersVersion;
  } catch (err) {
    console.error("companies/count plan:", err);
    return NextResponse.json({ error: "Could not work out the search" }, { status: 500 });
  }

  const got = await aiArkFor(mode, { env: process.env, db: enrichPool() });
  if (!got.client) return NextResponse.json({ error: got.why, needsKey: mode === "live" }, { status: 409 });
  const perSearch: number[] = [];
  let sample: CompanyCountResult["sample"] = [];
  let credits = 0;
  try {
    for (let i = 0; i < requests.length; i++) {
      const page = await got.client.companySearch(requests[i], { page: 0, size: i === 0 ? SAMPLE : 1 });
      const content: unknown[] = Array.isArray(page.content) ? page.content : [];
      credits += typeof page.credits === "number" && Number.isFinite(page.credits) ? page.credits : PER_COMPANY * content.length;
      perSearch.push(Number(page.totalElements) || 0);
      if (i === 0) sample = content.slice(0, SAMPLE).map(companySample);
    }
  } catch (e) {
    const err = e instanceof AiArkError ? e : null;
    const status = err?.kind === "credits" ? 402 : err?.kind === "rate" ? 429 : 502;
    if (mode === "live" && credits) {
      await logAudit({
        action: "companies_count",
        performedBy: auth.user.id,
        details: `${tag}: stopped after ${round(credits)} credits: ${err?.message ?? "error"}`,
      });
    }
    return NextResponse.json({ error: err?.message ?? "AI Ark did not answer", credits: round(credits) }, { status });
  }
  const total = perSearch.reduce((s, n) => s + n, 0);
  if (mode === "live") {
    await logAudit({
      action: "companies_count",
      performedBy: auth.user.id,
      details: `${tag}: ${total} companies in ${perSearch.length} searches, ${round(credits)} credits`,
    });
  }
  const out: CompanyCountResult = { mode, total, perSearch, credits: round(credits), sample, rulesVersion, filtersVersion };
  return NextResponse.json(out);
}

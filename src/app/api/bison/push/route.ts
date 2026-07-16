import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { normalizeFilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { pushLeadsToCampaign, leadToPushLead, type BisonPushResult } from "@/lib/bison/push-leads";
import { bisonAuthFor, bisonInstances, normalizeDomain } from "@/lib/bison/keys";
import { findCursorForRangeStart } from "@/lib/exports/skip-cursor";

// Push leads into an Email Bison campaign (two-step: create in Bison, then
// attach to campaign — see src/lib/bison/push-leads.ts). Runs synchronously
// and returns the result; capped so it stays within the request window. For a
// client "pull" (a targeted set of leads) this is the intended size.

export const maxDuration = 300;

const HARD_CAP = 5000;

const supabaseAdmin = () =>
  createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

interface PushPayload {
  campaignId: number | string;
  campaignInstanceUrl?: string;
  selectedIds?: string[];
  filters?: unknown;
  limit?: number;
  rangeFrom?: number;
  rangeTo?: number;
}

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = supabaseAdmin();

  // Role check — pushing into a live campaign is an export-level action
  // (viewer = filter and view only, same pattern as /api/admin/bulk-delete).
  const { data: profile } = await admin
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only owners, admins, and managers can push leads to Bison" },
      { status: 403 }
    );
  }

  const auth = bisonAuthFor(undefined);
  // resolved again below once we know the campaign's instance
  if (!auth) {
    return NextResponse.json(
      { error: "No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY)." },
      { status: 503 }
    );
  }

  let body: PushPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.campaignId === undefined || body.campaignId === null || body.campaignId === "") {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > HARD_CAP)) {
    return NextResponse.json(
      { error: `limit must be a positive integer between 1 and ${HARD_CAP}` },
      { status: 400 }
    );
  }
  // Never send a Bison token to a host that isn't one of ours.
  if (body.campaignInstanceUrl !== undefined) {
    const domain = typeof body.campaignInstanceUrl === "string" ? normalizeDomain(body.campaignInstanceUrl) : "";
    if (!domain || !bisonInstances().some((i) => i.domain === domain)) {
      return NextResponse.json(
        { error: `Unknown Bison instance "${body.campaignInstanceUrl}" — not one of the configured instances` },
        { status: 400 }
      );
    }
  }
  const { rangeFrom, rangeTo } = body;
  if (rangeFrom !== undefined || rangeTo !== undefined) {
    if (
      !Number.isInteger(rangeFrom) || !Number.isInteger(rangeTo) ||
      (rangeFrom as number) < 1 || (rangeTo as number) < (rangeFrom as number)
    ) {
      return NextResponse.json(
        { error: "rangeFrom/rangeTo must be positive integers with rangeTo >= rangeFrom" },
        { status: 400 }
      );
    }
    if ((rangeTo as number) - (rangeFrom as number) + 1 > HARD_CAP) {
      return NextResponse.json(
        { error: `Range too large (${(rangeTo as number) - (rangeFrom as number) + 1}). Max ${HARD_CAP} per push.` },
        { status: 400 }
      );
    }
    if (body.selectedIds && body.selectedIds.length > 0) {
      return NextResponse.json(
        { error: "rangeFrom/rangeTo cannot be combined with selectedIds" },
        { status: 400 }
      );
    }
    if (!body.filters) {
      return NextResponse.json(
        { error: "rangeFrom/rangeTo requires filters" },
        { status: 400 }
      );
    }
  }

  // Gather the leads. Selected IDs = explicit picks; otherwise the current
  // filter set (validated + non-bounced, same gate as export) capped at HARD_CAP.
  let leads: Partial<Lead>[] = [];
  let skippedIneligible = 0;
  const cols = "id, email, first_name, last_name, title, company, notes, bison_lead_id, category, subcategory, city, state";

  if (body.selectedIds && body.selectedIds.length > 0) {
    if (body.selectedIds.length > HARD_CAP) {
      return NextResponse.json({ error: `Too many leads (${body.selectedIds.length}). Max ${HARD_CAP} per push.` }, { status: 400 });
    }
    for (let i = 0; i < body.selectedIds.length; i += 1000) {
      const chunk = body.selectedIds.slice(i, i + 1000);
      // Same deliverability gate as fn_export_leads — explicit picks must not
      // bypass it when the destination is a live sending campaign.
      const { data, error } = await admin
        .from("leads")
        .select(cols)
        .in("id", chunk)
        .eq("is_bounced", false)
        .or("validation_status.in.(valid,catch_all),validation_status.is.null");
      if (error) {
        return NextResponse.json(
          { error: `Failed to load selected leads: ${error.message}` },
          { status: 500 }
        );
      }
      if (data) leads.push(...(data as Partial<Lead>[]));
    }
    skippedIneligible = body.selectedIds.length - leads.length;
  } else if (body.filters) {
    const p_filters = buildRpcFilters(normalizeFilterState(body.filters));
    let take = Math.min(body.limit ?? HARD_CAP, HARD_CAP);
    let cursor: string | null = null;
    if (rangeFrom && rangeTo) {
      take = Math.min(rangeTo - rangeFrom + 1, HARD_CAP);
      if (rangeFrom > 1) {
        // Same anchor mechanism as /api/exports/stream: composite
        // (created_at, id) cursor so the range starts at a stable row.
        try {
          const { cursor: anchor, found } = await findCursorForRangeStart(admin, p_filters, rangeFrom);
          if (!found) {
            return NextResponse.json(
              { error: `Range start ${rangeFrom} is beyond available data` },
              { status: 400 }
            );
          }
          cursor = anchor;
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Skip-to-cursor failed" },
            { status: 500 }
          );
        }
      }
    }
    const { data, error } = await admin.rpc("fn_export_leads", {
      p_filters: JSON.stringify(p_filters),
      p_cursor: cursor,
      p_limit: take,
      p_skip: 0,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = (data as { data?: Lead[] } | null)?.data ?? [];
    leads = rows.map((r) => r as Partial<Lead>);
  } else {
    return NextResponse.json({ error: "Provide selectedIds or filters" }, { status: 400 });
  }

  leads = leads.filter((l) => l.email);
  if (leads.length === 0) {
    return NextResponse.json({ error: "No eligible leads to push (all filtered out by the deliverability gate?)", skippedIneligible }, { status: 400 });
  }
  if (leads.length > HARD_CAP) {
    return NextResponse.json({ error: `Too many leads (${leads.length}). Narrow the filter; max ${HARD_CAP} per push.` }, { status: 400 });
  }

  let campaignAuth: { base: string; key: string } | null;
  try {
    campaignAuth = bisonAuthFor(body.campaignInstanceUrl);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `No Bison key configured for instance ${body.campaignInstanceUrl}` },
      { status: 400 }
    );
  }
  if (!campaignAuth) {
    return NextResponse.json(
      { error: `No Bison key configured for instance ${body.campaignInstanceUrl}` },
      { status: 503 }
    );
  }

  let result: BisonPushResult;
  try {
    result = await pushLeadsToCampaign(leads.map(leadToPushLead), {
      apiKey: campaignAuth.key,
      campaignId: body.campaignId,
      instanceUrl: campaignAuth.base,
    });
  } catch (err) {
    // Fatal abort (Bison 401/403 mid-push) — report partial progress and
    // leave an audit trail rather than escaping as a bare 500.
    const e = err as Error & { fatal?: boolean; partial?: BisonPushResult };
    const partial: BisonPushResult = e.partial ?? { total: leads.length, created: 0, attached: 0, failed: 0, attachFailed: 0, errors: [] };
    await admin.from("audit_logs").insert({
      action: "bison_push",
      performed_by: user.id,
      details: `Push to Bison campaign ${body.campaignId} aborted after creating ${partial.created}/${partial.total} leads: ${e.message}`,
      metadata: { campaignId: body.campaignId, error: e.message, ...partial } as Record<string, unknown>,
    }).then(() => {}, () => {});
    return NextResponse.json(
      { error: e.message, ...partial },
      { status: e.fatal ? 502 : 500 }
    );
  }

  // Audit trail (best-effort).
  await admin.from("audit_logs").insert({
    action: "bison_push",
    performed_by: user.id,
    details: `Pushed ${result.attached}/${result.total} leads to Bison campaign ${body.campaignId}`,
    metadata: { campaignId: body.campaignId, skippedIneligible, ...result } as Record<string, unknown>,
  }).then(() => {}, () => {});

  return NextResponse.json({ ...result, skippedIneligible });
}

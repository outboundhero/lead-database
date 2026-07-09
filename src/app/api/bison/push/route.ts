import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { pushLeadsToCampaign, leadToPushLead } from "@/lib/bison/push-leads";

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
  filters?: FilterState;
  limit?: number;
}

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.EMAILBISON_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "EMAILBISON_API_KEY is not configured — add it to enable pushing to Bison." },
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

  const admin = supabaseAdmin();

  // Gather the leads. Selected IDs = explicit picks; otherwise the current
  // filter set (validated + non-bounced, same gate as export) capped at HARD_CAP.
  let leads: Partial<Lead>[] = [];
  const cols = "id, email, first_name, last_name, title, company, notes, bison_lead_id, category, subcategory, city, state";

  if (body.selectedIds && body.selectedIds.length > 0) {
    if (body.selectedIds.length > HARD_CAP) {
      return NextResponse.json({ error: `Too many leads (${body.selectedIds.length}). Max ${HARD_CAP} per push.` }, { status: 400 });
    }
    for (let i = 0; i < body.selectedIds.length; i += 1000) {
      const chunk = body.selectedIds.slice(i, i + 1000);
      const { data } = await admin.from("leads").select(cols).in("id", chunk);
      if (data) leads.push(...(data as Partial<Lead>[]));
    }
  } else if (body.filters) {
    const p_filters = buildRpcFilters(body.filters);
    const take = Math.min(body.limit ?? HARD_CAP, HARD_CAP);
    const { data, error } = await admin.rpc("fn_export_leads", {
      p_filters: JSON.stringify(p_filters),
      p_cursor: null,
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
    return NextResponse.json({ error: "No eligible leads to push (all filtered out by the deliverability gate?)" }, { status: 400 });
  }
  if (leads.length > HARD_CAP) {
    return NextResponse.json({ error: `Too many leads (${leads.length}). Narrow the filter; max ${HARD_CAP} per push.` }, { status: 400 });
  }

  const result = await pushLeadsToCampaign(leads.map(leadToPushLead), {
    apiKey,
    campaignId: body.campaignId,
    instanceUrl: body.campaignInstanceUrl,
  });

  // Audit trail (best-effort).
  await admin.from("audit_logs").insert({
    action: "bison_push",
    performed_by: user.id,
    details: `Pushed ${result.attached}/${result.total} leads to Bison campaign ${body.campaignId}`,
    metadata: { campaignId: body.campaignId, ...result } as Record<string, unknown>,
  }).then(() => {}, () => {});

  return NextResponse.json(result);
}

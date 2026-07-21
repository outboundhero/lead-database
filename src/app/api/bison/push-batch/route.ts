import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeFilterState } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { bisonInstances, normalizeDomain } from "@/lib/bison/keys";

// Queue an async Bison push batch. Unlike the synchronous /api/bison/push
// (kept for targeted client "pulls"), this only validates + inserts a
// push_batches row and returns immediately — scripts/push-worker.mjs gathers
// the leads into push_items and does the create/attach work. Every selected
// campaign gets EVERY lead; campaigns may span multiple Bison instances.

const MAX_CAMPAIGNS = 10;
const MAX_SELECTED_IDS = 100000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PushBatchCampaign {
  id: number | string;
  name?: string;
  instance_url: string;
  workspace_name?: string;
}

interface PushBatchPayload {
  campaigns?: PushBatchCampaign[];
  filters?: unknown;
  selectedIds?: string[];
  rangeFrom?: number;
  rangeTo?: number;
  maxLeads?: number;
}

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Role check — pushing into a live campaign is an export-level action
  // (same gate as the synchronous /api/bison/push).
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

  const instances = bisonInstances();
  if (instances.length === 0) {
    return NextResponse.json(
      { error: "No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY)." },
      { status: 503 }
    );
  }

  let body: PushBatchPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Campaigns — every one gets every lead, so keep the fan-out bounded.
  if (!Array.isArray(body.campaigns) || body.campaigns.length === 0) {
    return NextResponse.json({ error: "campaigns is required (at least one campaign)" }, { status: 400 });
  }
  if (body.campaigns.length > MAX_CAMPAIGNS) {
    return NextResponse.json(
      { error: `Too many campaigns (${body.campaigns.length}). Max ${MAX_CAMPAIGNS} per batch.` },
      { status: 400 }
    );
  }
  const campaigns: PushBatchCampaign[] = [];
  for (const c of body.campaigns) {
    if (!c || typeof c !== "object" || c.id === undefined || c.id === null || c.id === "" || !/^\d+$/.test(String(c.id))) {
      return NextResponse.json({ error: "Every campaign needs an id" }, { status: 400 });
    }
    // Never send a Bison token to a host that isn't one of ours.
    const domain = typeof c.instance_url === "string" ? normalizeDomain(c.instance_url) : "";
    if (!domain || !instances.some((i) => i.domain === domain)) {
      return NextResponse.json(
        { error: `Unknown Bison instance "${c.instance_url}" — not one of the configured instances` },
        { status: 400 }
      );
    }
    campaigns.push({
      id: c.id,
      name: typeof c.name === "string" ? c.name : undefined,
      instance_url: domain,
      workspace_name: typeof c.workspace_name === "string" ? c.workspace_name : undefined,
    });
  }

  // Selected IDs — explicit picks; must be uuids, capped, exclusive with ranges.
  const selectedIds = body.selectedIds;
  const hasSelectedIds = Array.isArray(selectedIds) && selectedIds.length > 0;
  if (selectedIds !== undefined && !Array.isArray(selectedIds)) {
    return NextResponse.json({ error: "selectedIds must be an array of lead ids" }, { status: 400 });
  }
  if (hasSelectedIds) {
    if (selectedIds.length > MAX_SELECTED_IDS) {
      return NextResponse.json(
        { error: `Too many leads (${selectedIds.length}). Max ${MAX_SELECTED_IDS} per batch.` },
        { status: 400 }
      );
    }
    if (!selectedIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return NextResponse.json({ error: "selectedIds must be uuid strings" }, { status: 400 });
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
    if (hasSelectedIds) {
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
  if (body.maxLeads !== undefined && (!Number.isInteger(body.maxLeads) || body.maxLeads < 1)) {
    return NextResponse.json({ error: "maxLeads must be a positive integer" }, { status: 400 });
  }

  if (!hasSelectedIds && !body.filters) {
    return NextResponse.json({ error: "Provide selectedIds or filters" }, { status: 400 });
  }

  // Store the RPC-shaped filters (same p_filters the export stream feeds to
  // fn_export_leads / fn_lead_filter_conditions) so the worker consumes them
  // as-is; normalize first so old client payloads never miss newer keys.
  const p_filters = !hasSelectedIds && body.filters
    ? buildRpcFilters(normalizeFilterState(body.filters))
    : null;

  const { data: batch, error: insertError } = await admin
    .from("push_batches")
    .insert({
      created_by: user.id,
      campaigns,
      filters: p_filters,
      selected_ids: hasSelectedIds ? selectedIds : null,
      range_from: rangeFrom ?? null,
      range_to: rangeTo ?? null,
      max_leads: body.maxLeads ?? null,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertError || !batch) {
    return NextResponse.json(
      { error: `Failed to queue push batch: ${insertError?.message ?? "insert returned no row"}` },
      { status: 500 }
    );
  }

  // Audit trail (best-effort).
  await admin.from("audit_logs").insert({
    action: "bison_push_batch_queued",
    performed_by: user.id,
    details: `Queued Bison push batch ${batch.id} to ${campaigns.length} campaign(s): ${campaigns.map((c) => c.name || c.id).join(", ")}`,
    metadata: {
      batchId: batch.id,
      campaigns,
      selectedCount: hasSelectedIds ? selectedIds.length : 0,
      hasFilters: p_filters !== null,
      rangeFrom: rangeFrom ?? null,
      rangeTo: rangeTo ?? null,
      maxLeads: body.maxLeads ?? null,
    } as Record<string, unknown>,
  }).then(() => {}, () => {});

  return NextResponse.json({ batchId: batch.id, queued: true });
}

import { NextRequest, NextResponse } from "next/server";
import { isNurtureCampaign } from "@/lib/bison/campaigns";
import { idsOfSide, stampCampaigns } from "@/lib/bison/push-stamp";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeFilterState } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { bisonInstances, normalizeDomain } from "@/lib/bison/keys";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { gateEnabled, scoringStatusFor } from "../../../../../scripts/lib/enrich/fit-push.mjs";
import { BISON_GROUPS, sideCampaignsByInstall } from "../../../../../scripts/lib/bison-groups.mjs";
import { isSharePush } from "../../../../../scripts/lib/overlap-topup.mjs";
import { loadQuestionSettings, questionSwitchOn } from "../../../../../scripts/lib/questions/settings.mjs";
import { copyTag } from "../../../../../scripts/lib/questions/names.mjs";

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
  // ESP routing (client req #9): when any campaign in the batch carries a
  // bucket, each lead is attached ONLY to the campaign matching its email
  // provider — outlook (Microsoft/Outlook), seg (security gateways), default
  // (Google/custom/everything else). Bucket-less batches attach to all.
  bucket?: "outlook" | "seg" | "default";
  // WORKSPACE ROUTING: which of the client's two Bison installs this campaign
  // belongs to. Business emails are sent from the B2B install and personal
  // ones from the B2C install, so a lead must only attach to campaigns on its
  // own side. Absent = campaign is on neither of this client's instances, and
  // is left open to any lead.
  side?: "b2b" | "b2c";
  // Bison's status as the picker read it; only used to refuse "archived" at
  // queue time. Not stored on the batch.
  status?: string;
}

/** A recent batch of the client, as the double-push guard reads it. */
interface RecentBatch {
  id: string;
  status: string;
  email_side: string | null;
  total: number | null;
  sent: number | null;
  created_at: string | Date;
  source: string | null;
}

interface PushBatchPayload {
  campaigns?: PushBatchCampaign[];
  filters?: unknown;
  selectedIds?: string[];
  rangeFrom?: number;
  rangeTo?: number;
  maxLeads?: number;
  // Send-to-Bison wizard: which client this batch belongs to, and which side of
  // the B2B/B2C split it carries. When set, emailSide narrows the batch to the
  // matching leads so the wizard's two pushes never overlap.
  clientTag?: string;
  emailSide?: "b2b" | "b2c";
  // Export accounting (client req #8), applied by the gather stage per client
  // tag. Already-pushed leads are EXCLUDED by default.
  pushOptions?: {
    includeAlreadyPushed?: boolean;
    onlyNewSinceLast?: boolean;
    retryFailed?: boolean;
  };
  // Double-push guard override: a recent batch for the same client tag makes
  // this endpoint 409 unless force is set.
  force?: boolean;
  // Question variables (migration 139, ships off): the variable this push sends
  // besides the usual ones, picked in the export popup. Only with clientTag, as
  // pushOptions. The worker skips leads without a written value.
  questionVariableId?: string | null;
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
    // Only MAIN campaigns may be pushed to. The pickers already hide Nurture
    // campaigns, but a picker is not a boundary — this route is, and it is what
    // the API consumers hit directly.
    if (isNurtureCampaign(c.name)) {
      return NextResponse.json(
        { error: `"${String(c.name)}" is a Nurture campaign — leads are only ever pushed to main campaigns.` },
        { status: 400 }
      );
    }
    // An archived campaign cannot send. The pickers hide them, but a preset
    // saved before the campaign was archived still names it; the status rides
    // along from the picker's own Bison read so this can be refused here.
    if (typeof c.status === "string" && c.status.trim().toLowerCase() === "archived") {
      return NextResponse.json(
        { error: `"${String(c.name ?? c.id)}" is archived in Bison and cannot send — pick a live campaign.` },
        { status: 400 }
      );
    }
    campaigns.push({
      id: c.id,
      name: typeof c.name === "string" ? c.name : undefined,
      instance_url: domain,
      workspace_name: typeof c.workspace_name === "string" ? c.workspace_name : undefined,
      ...(c.bucket === "outlook" || c.bucket === "seg" || c.bucket === "default" ? { bucket: c.bucket } : {}),
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

  // ── Send-to-Bison wizard extras: client tag + B2B/B2C side ──
  const emailSide = body.emailSide;
  if (emailSide !== undefined && emailSide !== "b2b" && emailSide !== "b2c") {
    return NextResponse.json({ error: "emailSide must be 'b2b' or 'b2c'" }, { status: 400 });
  }
  let clientTag: string | null = null;
  // The client's saved group as read below, and the group this push's installs
  // resolved when the saved one did not cover them (saved after queueing).
  let savedMapping: { group: number | null; b2b: string; b2c: string } | null = null;
  let resolvedGroup: number | null = null;
  if (body.clientTag !== undefined) {
    if (typeof body.clientTag !== "string" || !body.clientTag.trim()) {
      return NextResponse.json({ error: "clientTag must be a non-empty string" }, { status: 400 });
    }
    clientTag = body.clientTag.trim();
    const { data: tagRow, error: tagErr } = await admin
      .from("client_tags")
      .select("tag, group_no, b2b_instance, b2c_instance")
      .eq("tag", clientTag)
      .maybeSingle();
    if (tagErr) {
      return NextResponse.json({ error: `Failed to validate client tag: ${tagErr.message}` }, { status: 500 });
    }
    if (!tagRow) {
      return NextResponse.json({ error: `Unknown client tag "${clientTag}"` }, { status: 400 });
    }

    // ROUTING IS DECIDED HERE, ONCE, AND STORED ON THE BATCH.
    //
    // Until 2026-08-26 only the send-to-Bison wizard did this; the export popup
    // sent campaigns with no labels at all, and the worker's fallback for
    // unlabelled campaigns is "attach the lead to every one of them". Measured
    // consequence: 100% of sent leads on those batches landed in BOTH the B2B
    // and the B2C workspace, and in 2.33-5.98 campaigns each, instead of one.
    //
    //   side   — which workspace, from the campaign's install vs this client's
    //            b2b/b2c instances. Business emails go to the B2B install,
    //            personal ones to the B2C install.
    //   bucket — which campaign within that workspace, from the campaign NAME
    //            ("JPCA: SEGs" -> seg). A caller-supplied bucket still wins, so
    //            the wizard's explicit choice is never overridden.
    // The stamping itself is src/lib/bison/push-stamp.ts, shared with the
    // share push. No side when the campaign is on neither of this client's
    // instances: the worker then leaves that campaign open to any lead rather
    // than silently dropping it.
    const { b2b, b2c } = stampCampaigns(campaigns, tagRow);
    savedMapping = { group: (tagRow.group_no as number | null) ?? null, b2b, b2c };
  }

  // QUESTION VARIABLE (migration 139; ships off). The export popup sends the
  // variable it picked only with the client, as it sends pushOptions. Refused
  // unless the question_variables switch is on for this client and the variable
  // exists and is not archived; stored on the batch (id and name) for the worker
  // (scripts/lib/push-question-var.mjs). Absent: the batch is as it always was.
  let questionVariable: { id: string; name: string } | null = null;
  if (body.questionVariableId !== undefined && body.questionVariableId !== null) {
    if (!clientTag) {
      return NextResponse.json(
        { error: "A question variable is only sent with a client: select the client (top bar) and push again." },
        { status: 400 }
      );
    }
    if (typeof body.questionVariableId !== "string" || !UUID_RE.test(body.questionVariableId)) {
      return NextResponse.json({ error: "questionVariableId must be a question variable's id" }, { status: 400 });
    }
    try {
      const settings = await loadQuestionSettings(getPool());
      if (!questionSwitchOn(settings, clientTag)) {
        return NextResponse.json(
          { error: `Question variables are off for ${clientTag} (Companies tab, Settings): push with the default {QUESTION}, or turn them on first.` },
          { status: 400 }
        );
      }
      const { rows } = await getPool().query(
        `select id, name, archived_at from question_variables where id = $1`,
        [body.questionVariableId]
      );
      const row = rows[0] as { id: string; name: string; archived_at: string | Date | null } | undefined;
      if (!row) {
        return NextResponse.json({ error: "That question variable no longer exists: pick another one." }, { status: 400 });
      }
      if (row.archived_at) {
        return NextResponse.json(
          { error: `${copyTag(row.name)} is archived: pick another variable, or restore it on the Clay tab.` },
          { status: 400 }
        );
      }
      questionVariable = { id: row.id, name: row.name };
    } catch (e) {
      if ((e as { code?: string })?.code === "42P01") {
        return NextResponse.json({ error: "Question variables are not set up in this database yet." }, { status: 400 });
      }
      return NextResponse.json(
        { error: `Failed to read the question variable: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      );
    }
  }

  // FIT GATE (fit scoring, migration 127; shipped OFF). While the gate is on,
  // a push must name its client: a tagless batch skips the client's
  // conditions at push time, the fit condition with them. And while the gate
  // covers this client (with require_scored), the batch waits in 'scoring'
  // until its companies are scored (scripts/lib/enrich/fit-push.mjs); the
  // worker gathers 'pending' batches only. With the gate off this changes
  // nothing: no batch is refused and every batch starts 'pending'.
  let startStatus: "pending" | "scoring" = "pending";
  try {
    if (!clientTag && (await gateEnabled(getPool()))) {
      return NextResponse.json(
        { error: "The fit gate is on, so a push must name its client: select the client (top bar) and push again." },
        { status: 409 }
      );
    }
    if (clientTag) startStatus = await scoringStatusFor(getPool(), clientTag);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to read the fit gate: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  // A BATCH ACROSS TWO INSTALLS MUST KNOW WHICH SIDE EACH CAMPAIGN IS.
  //
  // The worker refuses to guess (push-side.mjs): a lead in a two-install batch
  // whose campaigns carry no side would otherwise land in both workspaces, the
  // 2026-09-24 incident. On 2026-10-05 four exports (CVJCIN, SCAS, RICS, TTT —
  // 148,550 leads) were queued for clients whose B2B/B2C install mapping had not
  // been synced yet, gathered in full, and then every lead was skipped — so this
  // is settled HERE, before anything is queued.
  //
  // Campaigns on the client's saved installs were sided above. The rest take
  // their install's own side (an install never changes side: OutboundHero and
  // FacilityReach are B2B, CleaningOutbound and OutboundClean are B2C), but only
  // when every install in the batch belongs to ONE group, so a business lead can
  // never reach B2B campaigns in both groups. The group is then saved on the
  // client. Until 2026-11-18 this refused with "has no B2B/B2C mapping" and asked
  // for a sheet fix + "Sync groups"; the Nov-15 clients (ATOH, JMBCS, CCGSOR, SG,
  // LBJ, JATL) were in no group sheet and could not push at all.
  const installs = new Set(campaigns.map((c) => c.instance_url));
  if (installs.size > 1) {
    if (!clientTag) {
      return NextResponse.json(
        {
          error:
            "These campaigns are on two Bison installs, so the leads must be split into B2B and B2C — " +
            "select the client (top bar) before exporting, or pick campaigns from one install only.",
        },
        { status: 400 }
      );
    }
    if (campaigns.some((c) => !c.side)) {
      const { group } = sideCampaignsByInstall(campaigns);
      if (group === null) {
        return NextResponse.json(
          {
            error:
              `These campaigns are on ${[...installs].join(", ")}, which are not the two installs of one Bison group, ` +
              `so the leads could not be split into B2B and B2C. Pick ${clientTag}'s campaigns from one group: ` +
              "OutboundHero + CleaningOutbound, or FacilityReach + OutboundClean.",
          },
          { status: 400 }
        );
      }
      resolvedGroup = group;
    }
  }

  // DOUBLE-PUSH GUARD (client req #8/#10): a batch for the same client tag that
  // is still running, or completed within the last 24h, blocks a new queue
  // unless the caller explicitly forces — the exact accident that pushed
  // CWSJ-OS twice. Guarded per (client_tag, email_side) since the wizard
  // legitimately queues one batch per side back-to-back.
  //
  // Share and top-up pushes (push_options.source "share" or "topup", queued by
  // the Sharing page's push, migration 134) never clash: they carry no
  // email_side, like an export popup push, so without this the next popup push
  // for the client would answer 409 and operators would learn to force it.
  // They are named in the answer instead (sharePushes, only when there are some).
  let sharePushes: Array<{ id: string; status: string; created_at: string; total: number | null; source: string }> = [];
  if (clientTag && body.force !== true) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recentOf = async (shares: boolean, limit: number) =>
      (
        await getPool().query(
          `select id, status, email_side, total, sent, created_at, push_options->>'source' as source
             from push_batches
            where client_tag = $1
              and status in ('pending', 'gathering', 'processing', 'complete', 'scoring')
              and created_at >= $2::timestamptz
              and coalesce(push_options->>'source', '') ${shares ? "in" : "not in"} ('share', 'topup')
            order by created_at desc
            limit $3`,
          [clientTag, since, limit]
        )
      ).rows as RecentBatch[];
    // A failed read finds no clash, as the guard always did (its read's error was never checked).
    let recent: RecentBatch[] = [];
    try {
      recent = await recentOf(false, 5);
      sharePushes = (await recentOf(true, 10))
        .filter((b) => isSharePush({ source: b.source }))
        .map((b) => ({ id: b.id, status: b.status, created_at: new Date(b.created_at).toISOString(), total: b.total, source: b.source as string }));
    } catch (e) {
      console.error(`[push-batch] could not read ${clientTag}'s recent pushes: ${e instanceof Error ? e.message : String(e)}`);
    }
    const clash = recent.find((b) => (b.email_side ?? null) === (emailSide ?? null));
    if (clash) {
      const when = new Date(clash.created_at).toLocaleString();
      return NextResponse.json(
        {
          error:
            clash.status === "complete"
              ? `A ${clientTag} push already completed ${when} (${clash.sent ?? 0}/${clash.total ?? 0} sent). Queue again anyway?`
              : `A ${clientTag} push is already ${clash.status === "scoring" ? "waiting for fit scoring" : clash.status} (queued ${when}). Queue another anyway?`,
          duplicateOf: { id: clash.id, status: clash.status, created_at: new Date(clash.created_at).toISOString(), total: clash.total, sent: clash.sent },
          ...(sharePushes.length ? { sharePushes } : {}),
        },
        { status: 409 }
      );
    }
  }

  // Store the RPC-shaped filters (same p_filters the export stream feeds to
  // fn_export_leads / fn_lead_filter_conditions) so the worker consumes them
  // as-is; normalize first so old client payloads never miss newer keys. When
  // an emailSide is set, inject it into the stored filters jsonb so the worker's
  // gather (fn_lead_filter_conditions) applies the freemail split.
  // clientTag also rides along as applyClientTargeting so the worker's gather
  // (fn_lead_filter_conditions) enforces the client's targeting rules.
  const p_filters = !hasSelectedIds && body.filters
    ? {
        ...buildRpcFilters(normalizeFilterState(body.filters)),
        ...(emailSide ? { emailSide } : {}),
        ...(clientTag ? { applyClientTargeting: clientTag } : {}),
      }
    : null;

  // Provenance snapshot: which targeting rules were active when this batch was
  // queued (kept on the batch even if the client's config changes later).
  let targetMarket: Record<string, unknown> | null = null;
  if (clientTag) {
    const { data: targeting } = await admin
      .from("client_targeting")
      .select("countries, include_locations, exclude_locations, exclude_industries, exclude_keywords, require_location, allow_inferred_location, commercial_cleaning")
      .eq("client_tag", clientTag)
      .maybeSingle();
    targetMarket = targeting ?? null;
  }

  // On the selectedIds path the worker gathers by id + eligibility only (it
  // never re-reads filters), so the split can't ride along in the jsonb.
  // Narrow the id list to this side's leads up front instead — this keeps the
  // wizard's two pushes disjoint without touching the worker.
  let storedSelectedIds: string[] | null = hasSelectedIds ? selectedIds! : null;
  if (hasSelectedIds && emailSide) {
    try {
      storedSelectedIds = await idsOfSide(getPool(), selectedIds!, emailSide);
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to split selection by email side: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 }
      );
    }
    // An empty subset must never fall through to the worker's filters path
    // (empty selected_ids + null filters would gather the ENTIRE table).
    if (storedSelectedIds.length === 0) {
      return NextResponse.json(
        { error: `No ${emailSide} leads in the selection` },
        { status: 400 }
      );
    }
  }

  const { data: batch, error: insertError } = await admin
    .from("push_batches")
    .insert({
      created_by: user.id,
      campaigns,
      filters: p_filters,
      target_market: targetMarket,
      selected_ids: storedSelectedIds,
      range_from: rangeFrom ?? null,
      range_to: rangeTo ?? null,
      max_leads: body.maxLeads ?? null,
      client_tag: clientTag,
      email_side: emailSide ?? null,
      push_options: body.pushOptions && typeof body.pushOptions === "object"
        ? {
            includeAlreadyPushed: body.pushOptions.includeAlreadyPushed === true,
            onlyNewSinceLast: body.pushOptions.onlyNewSinceLast === true,
            retryFailed: body.pushOptions.retryFailed === true,
          }
        : null,
      status: startStatus,
      ...(questionVariable
        ? { question_variable_id: questionVariable.id, question_variable_name: questionVariable.name }
        : {}),
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
      selectedCount: storedSelectedIds ? storedSelectedIds.length : 0,
      hasFilters: p_filters !== null,
      rangeFrom: rangeFrom ?? null,
      rangeTo: rangeTo ?? null,
      maxLeads: body.maxLeads ?? null,
      clientTag,
      emailSide: emailSide ?? null,
      // The variable's name only (never a value).
      ...(questionVariable ? { questionVariable: questionVariable.name } : {}),
    } as Record<string, unknown>,
  }).then(() => {}, () => {});

  // Save the group this batch's installs resolved, so the client is mapped from
  // now on (Clients page, previews, single-install pushes). Only after the batch
  // is queued — a refused push changes nothing — and best-effort: the batch
  // already carries its sides, so a failed save cannot misroute it.
  let clientGroupSet: { tag: string; group: number; previous: number | null } | null = null;
  if (clientTag && resolvedGroup !== null) {
    const pair = (BISON_GROUPS as Record<number, { b2b: string; b2c: string }>)[resolvedGroup];
    const changed = !savedMapping || savedMapping.group !== resolvedGroup ||
      savedMapping.b2b !== pair.b2b || savedMapping.b2c !== pair.b2c;
    if (changed) {
      const { error: groupErr } = await admin
        .from("client_tags")
        .update({ group_no: resolvedGroup, b2b_instance: pair.b2b, b2c_instance: pair.b2c, source: "push" })
        .eq("tag", clientTag);
      if (groupErr) {
        console.error(`[push-batch] could not save group ${resolvedGroup} for ${clientTag}: ${groupErr.message}`);
      } else {
        const previous = savedMapping?.group ?? null;
        clientGroupSet = { tag: clientTag, group: resolvedGroup, previous };
        await logAudit({
          action: "Client Group Set From Push",
          performedBy: user.email ?? user.id,
          details: `${clientTag}: group ${resolvedGroup} (was ${previous ?? "none"}), from the installs of push batch ${batch.id}`,
        });
      }
    }
  }

  // A batch waiting for fit scoring says so; otherwise the answer is as it always was.
  return NextResponse.json({
    batchId: batch.id,
    queued: true,
    ...(startStatus === "scoring" ? { waitsForScoring: true } : {}),
    ...(clientGroupSet ? { clientGroupSet } : {}),
    ...(sharePushes.length ? { sharePushes } : {}),
    ...(questionVariable ? { questionVariable } : {}),
  });
}

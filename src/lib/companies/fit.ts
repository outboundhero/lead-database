import type { PoolClient } from "pg";
import { cleanModelSetting, REASONING_EFFORTS, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { capFor, spentToday } from "../../../scripts/lib/enrich/spend.mjs";
import { COPY_TO_COMPANIES_SQL } from "../../../scripts/lib/enrich/fit-keys.mjs";
import { promoteCounts, promotionAllowed } from "../../../scripts/lib/enrich/promote.mjs";
import type { WorkerState } from "@/lib/enrich/types";
import type {
  FitGateView,
  FitKeyKind,
  FitModel,
  FitRun,
  FitSettingsView,
  FitState,
  ReviewDecision,
  ReviewItem,
  ReviewPage,
} from "./fit-types";

// Server side of fit scoring (phase 3): the settings an admin edits, the gate
// an owner or admin edits, the fit panel's state, manual scores and the review
// list's queries. The worker does the scoring, the scoring and review runs
// (scripts/lib/enrich/fit-*.mjs); promotion runs here (promote-run.ts).
//
// Nothing here writes a rule on its own: fit_rule.prompt changes only when an
// admin saves one in the fit settings (PUT /api/fit/settings). Until then the
// scorer is idle, "Waiting for the fit rule" (D16).

type Db = Pick<PoolClient, "query">;
export type FitSettings = ReturnType<typeof settingsFrom>;

export const RULE_MAX = 20_000;
export const VERSION_MAX = 40;
export const REASON_MAX = 300;
export const WAITING_FOR_RULE = "Waiting for the fit rule";
/** company_fit is counted exactly only below this many rows; above it the planner's estimate is shown. */
const EXACT_COUNT_BELOW = 200_000;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/** Every setting, fresh, as the worker reads them (settingsFrom checks each value). */
export async function readFitSettings(c: Db): Promise<FitSettings> {
  const { rows } = await c.query(`SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

async function writeSetting(c: Db, key: string, value: unknown) {
  await c.query(
    `INSERT INTO enrich_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// ── Scoring settings (admin) ────────────────────────────────────────────────

export function fitSettingsView(s: FitSettings): FitSettingsView {
  return {
    rule: { prompt: s.fit_rule.prompt, version: s.fit_rule.version },
    scoring: { ...s.fit_scoring },
    model: (s.models.fit_score as FitModel | null) ?? null,
    efforts: [...REASONING_EFFORTS],
  };
}

/**
 * The body of PUT /api/fit/settings, checked against what is stored: the
 * rule (text up to 20,000 characters, and its version, up to 40, which must
 * change whenever the text does, so every score keeps the version it was made
 * under), the scoring switch, batch size and calls in flight, and the model.
 * Only the parts the body holds are written.
 */
export function cleanFitSettings(body: unknown, s: FitSettings) {
  const b = obj(body);
  const errors: string[] = [];
  const changes: string[] = [];
  const out: {
    fit_rule?: { prompt: string | null; version: string | null };
    fit_scoring?: { enabled: boolean; batch_size: number; calls_in_flight: number };
    fit_score?: FitModel;
  } = {};

  if (has(b, "rule")) {
    const r = obj(b.rule);
    const prompt = r.prompt == null ? null : typeof r.prompt === "string" ? r.prompt.trim() || null : undefined;
    const version = r.version == null ? null : typeof r.version === "string" ? r.version.trim() || null : undefined;
    if (prompt === undefined) errors.push("The rule must be text, or empty to clear it");
    else if (prompt && prompt.length > RULE_MAX) errors.push(`The rule is ${prompt.length.toLocaleString("en-US")} characters; at most ${RULE_MAX.toLocaleString("en-US")}`);
    if (version === undefined) errors.push("The rule's version must be text");
    else if (version && version.length > VERSION_MAX) errors.push(`The rule's version is at most ${VERSION_MAX} characters`);
    if (prompt !== undefined && version !== undefined && !errors.length) {
      const textChanged = prompt !== s.fit_rule.prompt;
      if (prompt && !version) errors.push("Give the rule a version (for example the date): each score keeps the version it was made under");
      else if (!prompt && version) errors.push("A version needs a rule");
      else if (prompt && textChanged && version === s.fit_rule.version) {
        errors.push("The rule's text changed, so its version must change too: scores made under the old text keep the old version");
      }
      if (!errors.length && (textChanged || version !== s.fit_rule.version)) {
        out.fit_rule = { prompt, version };
        if (!prompt) changes.push("rule cleared");
        else if (textChanged) changes.push(`rule set, version ${version} (${prompt.length.toLocaleString("en-US")} characters)`);
        else changes.push(`rule version ${s.fit_rule.version ?? "(none)"} to ${version}`);
      }
    }
  }

  if (has(b, "scoring")) {
    const sc = obj(b.scoring);
    const cur = s.fit_scoring;
    const enabled = has(sc, "enabled") ? sc.enabled : cur.enabled;
    const size = has(sc, "batch_size") ? sc.batch_size : cur.batch_size;
    const flight = has(sc, "calls_in_flight") ? sc.calls_in_flight : cur.calls_in_flight;
    if (typeof enabled !== "boolean") errors.push("Scoring on or off must be true or false");
    if (!(typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= 50)) errors.push("Companies a call: a whole number from 1 to 50");
    if (!(typeof flight === "number" && Number.isInteger(flight) && flight >= 1 && flight <= 8)) errors.push("Calls at once: a whole number from 1 to 8");
    if (!errors.length) {
      const next = { enabled: enabled as boolean, batch_size: size as number, calls_in_flight: flight as number };
      const before = changes.length;
      if (next.enabled !== cur.enabled) changes.push(`scoring ${next.enabled ? "on" : "off"}`);
      if (next.batch_size !== cur.batch_size) changes.push(`companies a call ${cur.batch_size} to ${next.batch_size}`);
      if (next.calls_in_flight !== cur.calls_in_flight) changes.push(`calls at once ${cur.calls_in_flight} to ${next.calls_in_flight}`);
      if (changes.length > before) out.fit_scoring = next;
    }
  }

  if (has(b, "model")) {
    const m = obj(b.model);
    const cleaned = cleanModelSetting({ model: m.model, ...(m.reasoning_effort ? { reasoning_effort: m.reasoning_effort } : {}) }) as FitModel | null;
    if (!cleaned) errors.push("The model must be a model id (for example gpt-6-luna)");
    else if (m.reasoning_effort && cleaned.reasoning_effort !== m.reasoning_effort) {
      errors.push(`Reasoning effort "${String(m.reasoning_effort)}" is not accepted for ${cleaned.model}`);
    } else {
      const cur = (s.models.fit_score as FitModel | null) ?? null;
      if (cur?.model !== cleaned.model || (cur?.reasoning_effort ?? null) !== (cleaned.reasoning_effort ?? null)) {
        out.fit_score = cleaned;
        changes.push(
          `fit model ${cur ? `${cur.model}${cur.reasoning_effort ? ` (${cur.reasoning_effort})` : ""}` : "(none)"} to ` +
            `${cleaned.model}${cleaned.reasoning_effort ? ` (${cleaned.reasoning_effort})` : ""}`
        );
      }
    }
  }
  return { value: out, errors, changes };
}

/** Writes what cleanFitSettings kept. */
export async function saveFitSettings(c: Db, value: ReturnType<typeof cleanFitSettings>["value"]) {
  if (value.fit_rule) await writeSetting(c, "fit_rule", value.fit_rule);
  if (value.fit_scoring) await writeSetting(c, "fit_scoring", value.fit_scoring);
  if (value.fit_score) {
    const { rowCount } = await c.query(
      `UPDATE enrich_settings SET value = jsonb_set(value, '{fit_score}', $1::jsonb), updated_at = now() WHERE key = 'models'`,
      [JSON.stringify(value.fit_score)]
    );
    if (!rowCount) await writeSetting(c, "models", { fit_score: value.fit_score });
  }
}

// ── The gate (owner and admin) ──────────────────────────────────────────────

export async function fitGateView(c: Db, s: FitSettings): Promise<FitGateView> {
  const { rows } = await c.query(
    `SELECT DISTINCT client_type FROM client_tags WHERE client_type IS NOT NULL AND btrim(client_type) <> '' ORDER BY 1`
  );
  return {
    ...s.fit_gate,
    tags: [...s.fit_gate.tags],
    client_types: [...s.fit_gate.client_types],
    refresh: { ...s.fit_gate_refresh },
    known_types: rows.map((r) => String(r.client_type)),
  };
}

/**
 * The body of PUT /api/fit/gate, checked: the switch, the client list (client
 * tags, or "*" for every client of the listed types), the threshold 1 to 5,
 * the client types, require_scored. Unknown tags are refused.
 */
export async function cleanGate(c: Db, body: unknown, s: FitSettings) {
  const b = obj(body);
  const cur = s.fit_gate;
  const errors: string[] = [];
  const changes: string[] = [];
  const enabled = has(b, "enabled") ? b.enabled : cur.enabled;
  const threshold = has(b, "threshold") ? b.threshold : cur.threshold;
  const requireScored = has(b, "require_scored") ? b.require_scored : cur.require_scored;
  if (typeof enabled !== "boolean") errors.push("The gate on or off must be true or false");
  if (!(typeof threshold === "number" && Number.isInteger(threshold) && threshold >= 1 && threshold <= 5)) {
    errors.push("The threshold is a whole number from 1 to 5");
  }
  if (typeof requireScored !== "boolean") errors.push("require_scored must be true or false");

  let tags = [...cur.tags];
  if (has(b, "tags")) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== "string")) errors.push("The client list is a list of client tags");
    else {
      tags = [...new Set(b.tags.map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
      if (tags.length > 2000) errors.push("At most 2,000 clients on the list");
      const named = tags.filter((t) => t !== "*");
      if (named.length) {
        const { rows } = await c.query(`SELECT tag FROM client_tags WHERE tag = ANY($1::text[])`, [named]);
        const known = new Set(rows.map((r) => r.tag));
        const unknown = named.filter((t) => !known.has(t));
        if (unknown.length) errors.push(`Not client tags: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ", ..." : ""}`);
      }
    }
  }
  let types = [...cur.client_types];
  if (has(b, "client_types")) {
    if (!Array.isArray(b.client_types) || b.client_types.some((t) => typeof t !== "string" || !t.trim())) {
      errors.push("The client types are a list of client types");
    } else {
      types = [...new Set(b.client_types.map((t) => String(t).trim()))];
      if (types.length > 20) errors.push("At most 20 client types");
    }
  }
  const value = {
    enabled: enabled as boolean,
    tags,
    threshold: threshold as number,
    client_types: types,
    require_scored: requireScored as boolean,
  };
  if (!errors.length) {
    if (value.enabled !== cur.enabled) changes.push(`gate ${value.enabled ? "on" : "off"}`);
    const added = value.tags.filter((t) => !cur.tags.includes(t));
    const removed = cur.tags.filter((t) => !value.tags.includes(t));
    if (added.length) changes.push(`clients added: ${added.join(", ")}`);
    if (removed.length) changes.push(`clients removed: ${removed.join(", ")}`);
    if (value.threshold !== cur.threshold) changes.push(`threshold ${cur.threshold} to ${value.threshold}`);
    if (value.require_scored !== cur.require_scored) changes.push(`unscored companies ${value.require_scored ? "blocked" : "let through"}`);
    if (types.join("|") !== cur.client_types.join("|")) changes.push(`client types: ${types.join(", ") || "(none)"}`);
  }
  return { value, errors, changes };
}

/**
 * Writes the gate and marks the blocked refresh pending: the fit loop brings
 * company_fit.blocked up to date in batches (fn_fit_refresh_blocked) and the
 * panel says "Refresh pending" meanwhile.
 */
export async function saveGate(c: Db, value: Awaited<ReturnType<typeof cleanGate>>["value"]) {
  await writeSetting(c, "fit_gate", value);
  await writeSetting(c, "fit_gate_refresh", { pending: true, since: new Date().toISOString() });
}

// ── The fit panel ───────────────────────────────────────────────────────────

/** Why the scorer does nothing, as far as the settings tell (the worker adds its own reasons). */
export function idleReason(s: FitSettings): string | null {
  if (!s.fit_scoring.enabled) return "Scoring is off";
  if (!s.fit_rule.prompt) return WAITING_FOR_RULE;
  if (!s.models.fit_score?.model) return "No model is set for fit scoring";
  return null;
}

/** The worker's fit loop, as its heartbeat tells it. Never a key, only whether things are set. */
function fitWorker(w: WorkerState | null): FitState["worker"] {
  if (!w) return null;
  const info = obj(w.info);
  const fit = obj(info.fit);
  const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    online: w.online,
    fit_scoring: caps.includes("fit_scoring"),
    state: str(fit.state),
    why: str(fit.why),
    last_error: str(fit.last_error),
    last_error_at: str(fit.last_error_at),
  };
}

export async function fitState(c: Db, s: FitSettings, tag: string | null, worker: WorkerState | null): Promise<FitState> {
  const { rows: queue } = await c.query(
    `SELECT priority::int AS priority, count(*) FILTER (WHERE claim_token IS NULL)::int AS waiting,
            count(*) FILTER (WHERE claim_token IS NOT NULL)::int AS claimed
       FROM company_fit_queue GROUP BY priority ORDER BY priority`
  );
  const { rows: [est] } = await c.query(`SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'public.company_fit'::regclass`);
  let scores: FitState["scores"];
  if (Number(est?.n ?? 0) < EXACT_COUNT_BELOW) {
    const { rows: [n] } = await c.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE blocked)::int AS blocked,
              count(*) FILTER (WHERE status = 'manual')::int AS manual, count(*) FILTER (WHERE status = 'unscorable')::int AS unscorable
         FROM company_fit`
    );
    scores = { total: n.total, approx: false, blocked: n.blocked, manual: n.manual, unscorable: n.unscorable };
  } else {
    // Large: the planner's estimate of the total, and the blocked set from its partial index.
    const { rows: [b] } = await c.query(`SELECT count(*)::int AS n FROM company_fit_keys WHERE blocked AND fit_kind = key_kind AND fit_key = key`);
    scores = { total: Number(est.n), approx: true, blocked: b.n, manual: null, unscorable: null };
  }
  const spent = await spentToday(c);
  let coversClient: boolean | null = null;
  if (tag) {
    const { rows: [g] } = await c.query(`SELECT public.fn_fit_gate_applies($1) AS on`, [tag]);
    coversClient = g?.on === true;
  }
  const p = s.promotion;
  let blockedWhy: string | null = null;
  let counts: FitState["promotion"]["counts"] = null;
  if (tag) {
    // Only the switch and its client list: promotion needs no fit score, rule, model or gate (kept for v2).
    const allowed = promotionAllowed(s, tag);
    if (!allowed.ok) blockedWhy = allowed.why;
    counts = (await promoteCounts(c, { tag, settings: s })) as FitState["promotion"]["counts"];
  }
  return {
    rule: { set: Boolean(s.fit_rule.prompt), version: s.fit_rule.version },
    model: (s.models.fit_score as FitModel | null) ?? null,
    scoring: { ...s.fit_scoring },
    idle_reason: idleReason(s),
    queue: queue.map((q) => ({ priority: q.priority, waiting: q.waiting, claimed: q.claimed })),
    refresh_pending: s.fit_gate_refresh.pending,
    spend: { used: spent.openai_usd_fit, cap: capFor("openai_usd_fit", s) },
    worker: fitWorker(worker),
    gate: {
      enabled: s.fit_gate.enabled,
      tags: [...s.fit_gate.tags],
      threshold: s.fit_gate.threshold,
      client_types: [...s.fit_gate.client_types],
      require_scored: s.fit_gate.require_scored,
      covers_client: coversClient,
    },
    scores,
    promotion: {
      enabled: p.promote_to_leads,
      tags: [...p.tags],
      on_for_client: tag ? s.flagOn("promotion", tag) : null,
      require_question: p.require_question,
      source_label: p.source_label,
      blocked_why: blockedWhy,
      counts,
    },
  };
}

// ── Manual scores (admin) ───────────────────────────────────────────────────

/**
 * A key as a person types it, made canonical by the SQL rule the gate reads
 * with: a domain (any URL or address works; free-mail, platform and
 * directory domains are refused) or "company|city|ST". Null when it can't be one.
 */
export async function canonicalKey(c: Db, kind: FitKeyKind, key: string): Promise<string | null> {
  if (kind === "domain") {
    const { rows: [r] } = await c.query(`SELECT public.fn_fit_domain_ok($1) AS k`, [key]);
    return r?.k ?? null;
  }
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  const { rows: [r] } = await c.query(`SELECT public.fn_fit_name_key($1, $2, $3) AS k`, parts);
  return typeof r?.k === "string" && /\|[A-Z]{2,3}$/.test(r.k) ? r.k : null;
}

/**
 * A person's score for one company: stored as 'manual', which no re-score
 * replaces. The key becomes this score's own (an alias held by another score
 * moves to it); blocked follows from the gate's threshold; pipeline rows under
 * the key show it; a queued scoring of the key is dropped.
 */
export async function setManualScore(
  c: Db,
  { kind, key, score, homeOffice, reason, userId }: { kind: FitKeyKind; key: string; score: number; homeOffice: boolean | null; reason: string | null; userId: string }
) {
  const { rows: [r] } = await c.query(
    `INSERT INTO company_fit AS f (key_kind, key, score, home_office, reason, status, model, rule_version, inputs_hash, source, scored_by, scored_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', NULL, NULL, NULL, 'manual', $6, now())
     ON CONFLICT (key_kind, key) DO UPDATE
       SET score = EXCLUDED.score, home_office = EXCLUDED.home_office, reason = EXCLUDED.reason, status = 'manual',
           model = NULL, rule_version = NULL, inputs_hash = NULL, source = 'manual', scored_by = EXCLUDED.scored_by, scored_at = now()
     RETURNING f.key_kind, f.key, f.score, f.blocked`,
    [kind, key, score, homeOffice, reason, userId]
  );
  await c.query(COPY_TO_COMPANIES_SQL, [JSON.stringify([{ key_kind: kind, key }])]);
  await c.query(`DELETE FROM company_fit_queue WHERE key_kind = $1 AND key = $2`, [kind, key]);
  return { key_kind: r.key_kind as FitKeyKind, key: r.key as string, score: Number(r.score), blocked: r.blocked === true };
}

// ── Runs and the review list ────────────────────────────────────────────────

const RUN_FIELDS = `r.id, r.kind, r.client_tag, r.status, r.leads_seen, r.companies, r.queued, r.items, r.last_error,
  r.created_at, r.finished_at, r.progress, r.estimate, up.full_name AS created_by_name`;

function runOut(r: Record<string, unknown>): FitRun {
  return {
    id: String(r.id),
    kind: r.kind as FitRun["kind"],
    client_tag: (r.client_tag as string | null) ?? null,
    status: String(r.status),
    leads_seen: Number(r.leads_seen ?? 0),
    companies: Number(r.companies ?? 0),
    queued: Number(r.queued ?? 0),
    items: Number(r.items ?? 0),
    last_error: (r.last_error as string | null) ?? null,
    created_at: iso(r.created_at) ?? "",
    finished_at: iso(r.finished_at),
    created_by_name: (r.created_by_name as string | null) ?? null,
    progress: obj(r.progress),
    estimate: (r.estimate as FitRun["estimate"]) ?? null,
  };
}

export async function fitRuns(c: Db, { kind, tag = null, limit = 10 }: { kind: "score" | "review"; tag?: string | null; limit?: number }) {
  const { rows } = await c.query(
    `SELECT ${RUN_FIELDS} FROM fit_backfill_runs r LEFT JOIN user_profiles up ON up.id = r.created_by
      WHERE r.kind = $1 AND ($2::text IS NULL OR r.client_tag = $2)
      ORDER BY r.created_at DESC LIMIT $3`,
    [kind, tag, limit]
  );
  return rows.map(runOut);
}

export const REVIEW_PAGE = 100;

/**
 * One client's review list, a page at a time by item id (keyset, no OFFSET),
 * optionally one campaign's; with the list's totals, its campaigns, the last
 * build, whether the gate covers the client, the fit removals queued for it
 * and its last dry runs.
 */
export async function reviewPage(
  c: Db,
  { tag, campaign = null, after = 0, limit = REVIEW_PAGE }: { tag: string; campaign?: { instance_url: string; campaign_id: string } | null; after?: number; limit?: number }
): Promise<ReviewPage> {
  const { rows } = await c.query(
    `SELECT i.*, up.full_name AS decided_by_name,
            EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.key_kind = i.key_kind AND k.key = i.key AND k.blocked) AS still_blocked
       FROM fit_review_items i LEFT JOIN user_profiles up ON up.id = i.decided_by
      WHERE i.client_tag = $1 AND i.leads > 0 AND i.id > $2
        AND ($3::text IS NULL OR (i.instance_url = $3 AND i.campaign_id = $4))
      ORDER BY i.id LIMIT $5`,
    [tag, after, campaign?.instance_url ?? null, campaign?.campaign_id ?? null, limit + 1]
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: ReviewItem[] = page.map((r) => ({
    id: Number(r.id),
    instance_url: r.instance_url,
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    campaign_status: r.campaign_status,
    campaign_from: r.campaign_from,
    key_kind: r.key_kind,
    key: r.key,
    company: r.company,
    domain: r.domain,
    city: r.city,
    state: r.state,
    score: r.score == null ? null : Number(r.score),
    home_office: r.home_office,
    reason: r.reason,
    model: r.model,
    leads: r.leads,
    emails_sent: r.emails_sent,
    replied: r.replied,
    interested: r.interested,
    removable: r.removable,
    oldest_sync: iso(r.oldest_sync),
    decision: r.decision as ReviewDecision,
    decided_by_name: r.decided_by_name,
    decided_at: iso(r.decided_at),
    still_blocked: r.still_blocked === true,
  }));
  const { rows: [sum] } = await c.query(
    `SELECT count(*)::int AS items, count(*) FILTER (WHERE decision = 'pending')::int AS pending,
            count(*) FILTER (WHERE decision = 'approved')::int AS approved, count(*) FILTER (WHERE decision = 'rejected')::int AS rejected,
            coalesce(sum(leads), 0)::int AS leads, coalesce(sum(removable), 0)::int AS removable, min(oldest_sync) AS oldest_sync
       FROM fit_review_items WHERE client_tag = $1 AND leads > 0`,
    [tag]
  );
  const { rows: camps } = await c.query(
    `SELECT instance_url, campaign_id, max(campaign_name) AS name, count(*)::int AS items
       FROM fit_review_items WHERE client_tag = $1 AND leads > 0
      GROUP BY instance_url, campaign_id ORDER BY max(campaign_name), campaign_id`,
    [tag]
  );
  const [build] = await fitRuns(c, { kind: "review", tag, limit: 1 });
  const { rows: [g] } = await c.query(`SELECT public.fn_fit_gate_applies($1) AS on`, [tag]);
  const { rows: [rm] } = await c.query(
    `SELECT count(*) FILTER (WHERE status = 'fit_held')::int AS held, count(*) FILTER (WHERE status = 'done')::int AS done,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM bison_campaign_removals WHERE reason = 'fit' AND client_tag = $1`,
    [tag]
  );
  const { rows: dry } = await c.query(
    `SELECT id, created_at, used_at, would_remove, would_skip, cannot_confirm, cardinality(row_ids)::int AS rows
       FROM fit_removal_dry_runs WHERE client_tag = $1 ORDER BY created_at DESC LIMIT 5`,
    [tag]
  );
  return {
    items,
    next: more ? items[items.length - 1].id : null,
    summary: { ...sum, oldest_sync: iso(sum.oldest_sync) },
    campaigns: camps.map((x) => ({ instance_url: x.instance_url, campaign_id: x.campaign_id, name: x.name, items: x.items })),
    build: build ?? null,
    gate_covers: g?.on === true,
    removals: rm,
    dry_runs: dry.map((d) => ({ ...d, id: String(d.id), created_at: iso(d.created_at) ?? "", used_at: iso(d.used_at) })),
  };
}

/**
 * Records a decision, by name: per item, or in bulk for every pending item of
 * the client scored under 2 with no reply and no interest. Returns how many
 * items it changed.
 */
export async function decideItems(
  c: Db,
  { tag, ids, bulk, decision, userId }: { tag: string; ids: number[]; bulk: "under_2_no_replies" | null; decision: ReviewDecision; userId: string }
) {
  if (bulk === "under_2_no_replies") {
    const { rowCount } = await c.query(
      `UPDATE fit_review_items SET decision = $2, decided_by = $3, decided_at = now()
        WHERE client_tag = $1 AND decision = 'pending' AND leads > 0 AND score < 2 AND replied = 0 AND interested = 0`,
      [tag, decision, userId]
    );
    return rowCount ?? 0;
  }
  const { rowCount } = await c.query(
    `UPDATE fit_review_items SET decision = $3, decided_by = $4, decided_at = now()
      WHERE client_tag = $1 AND id = ANY($2::bigint[]) AND decision IS DISTINCT FROM $3`,
    [tag, ids, decision, userId]
  );
  return rowCount ?? 0;
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { normalizeFilterState, countActiveFilters, type FilterState } from "@/types/filters";

// POST   /api/leads/suppress   { emails | ids | filters, reason?, notes?, delete?, preview? }
// DELETE /api/leads/suppress   { emails } | { reason }          — lift a suppression
// GET    /api/leads/suppress?group=reason | ?reason=&q=&limit=&offset=
//
// Permanent do-not-contact, keyed on the ADDRESS rather than the lead row.
// That distinction is the point: the Bison sync adds addresses Bison holds that
// we do not, so a merely-deleted lead reappears on the next run and goes back
// into a client campaign. Suppression survives deletion and is checked by the
// import, by browse, and by the push eligibility gate.
//
// `delete: true` also removes the lead row. The suppression entry remains, so
// the address still cannot come back.
//
// Bulk (2026-09-23): this used to loop fn_suppress_email once per address —
// one Railway→Sydney round trip each, so its own 5,000 cap was unreachable in
// practice and the UI could only ever suppress the rows checked on one page.
// It now resolves a whole SELECTION (the same filters the Leads page ran,
// including rows unchecked out of a select-all) and writes it through
// fn_suppress_emails in chunks — 200 addresses measured at ~3 s.

export const maxDuration = 300;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EMAILS = 5000;          // explicit emails/ids in one request
const MAX_FILTERED = 100_000;     // a filtered selection
const CHUNK = 5_000;              // addresses per statement
const NO_REASON = "(no reason given)";

async function requireRole(roles: string[], forbidMessage: string) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("role, full_name, email").eq("id", user.id).single();
  if (!profile || !roles.includes(profile.role)) {
    return { error: NextResponse.json({ error: forbidMessage }, { status: 403 }) };
  }
  return { user, profile };
}
const requireManager = () => requireRole(["owner", "admin", "manager"], "Your role can't suppress leads — ask an admin");
// Lifting a do-not-contact is the sensitive direction: it puts an address back
// into client campaigns. Restricted to the roles that can reach the Admin page.
const requireAdmin = () => requireRole(["owner", "admin"], "Only an admin or owner can restore suppressed addresses");

function readEmails(body: { emails?: unknown; email?: unknown }): string[] | null {
  const raw = Array.isArray(body.emails) ? body.emails : body.email ? [body.email] : [];
  const out = [...new Set(raw.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
  if (out.length === 0 || out.length > MAX_EMAILS) return null;
  return out.filter((e) => EMAIL_RE.test(e));
}

/** The SQL gates for a saved/filter selection, mirroring what the table showed. */
function gatesFor(filters: FilterState, conds: string[]): string {
  const gates = [...conds];
  if (!filters.includeBounced) gates.push("l.is_bounced = false");
  return gates.join(" and ");
}

export async function POST(request: NextRequest) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  let body: {
    emails?: unknown; email?: unknown; ids?: unknown; filters?: unknown;
    reason?: string; notes?: string; delete?: boolean; preview?: boolean;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const pool = getPool();
  const who = auth.profile.full_name || auth.profile.email || "Unknown user";
  const reason = body.reason?.trim() || null;
  const notes = body.notes?.trim() || null;

  // ── Which addresses? ──────────────────────────────────────────────────────
  // A filtered selection is resolved here, in chunks, so the browser never has
  // to hold 40,000 ids and the server suppresses exactly what the filters
  // matched (including `excludeIds` — rows unchecked out of a select-all).
  let emails: string[] = [];
  if (body.filters && typeof body.filters === "object") {
    const normalized = normalizeFilterState(body.filters as Partial<FilterState>);
    if (countActiveFilters(normalized) === 0) {
      return NextResponse.json(
        { error: "Refusing to suppress with no active filters. Narrow the search first." }, { status: 400 });
    }
    const { rows: [c] } = await pool.query(
      `select fn_lead_filter_conditions($1::jsonb) as conds`, [JSON.stringify(buildRpcFilters(normalized))]);
    const conds = (c?.conds ?? []) as string[];
    if (conds.length === 0) {
      return NextResponse.json({ error: "Refusing to suppress with no filter conditions." }, { status: 400 });
    }
    const where = gatesFor(normalized, conds);
    const { rows: [n] } = await pool.query(
      `select count(*)::int as n from leads l where ${where} and l.email is not null`);
    const matched = Number(n?.n ?? 0);
    if (body.preview === true) return NextResponse.json({ preview: true, matched });
    if (matched > MAX_FILTERED) {
      return NextResponse.json(
        { error: `That selection is ${matched.toLocaleString()} leads — more than the ${MAX_FILTERED.toLocaleString()} allowed in one go. Narrow the filters.` },
        { status: 400 });
    }
    const { rows } = await pool.query(
      `select distinct lower(l.email) as email from leads l where ${where} and l.email is not null`);
    emails = rows.map((r) => String(r.email));
  } else if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = [...new Set(body.ids.map((i) => String(i)).filter((i) => UUID_RE.test(i)))].slice(0, MAX_EMAILS);
    if (ids.length === 0) return NextResponse.json({ error: "No valid lead ids" }, { status: 400 });
    const { rows } = await pool.query(
      `select distinct lower(email) as email from leads where id = any($1::uuid[]) and email is not null`, [ids]);
    emails = rows.map((r) => String(r.email));
  } else {
    const parsed = readEmails(body);
    if (!parsed) return NextResponse.json({ error: `Provide 1-${MAX_EMAILS} leads` }, { status: 400 });
    emails = parsed;
  }
  if (emails.length === 0) return NextResponse.json({ error: "No valid email addresses" }, { status: 400 });

  // ── Write, in chunks ──────────────────────────────────────────────────────
  let suppressed = 0, flagged = 0;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const { rows } = await pool.query(
      `select * from fn_suppress_emails($1::text[], $2, $3, $4::uuid, $5)`,
      [chunk, reason, notes, auth.user.id, who]);
    suppressed += Number(rows[0]?.suppressed ?? 0);
    flagged += Number(rows[0]?.leads_flagged ?? 0);
  }

  // Optional hard delete of the lead rows. The suppression entries stay behind,
  // which is what stops the Bison sync recreating them.
  let deleted = 0;
  if (body.delete === true) {
    for (let i = 0; i < emails.length; i += CHUNK) {
      const { rowCount } = await pool.query(
        `delete from leads where email = any($1::text[])`, [emails.slice(i, i + CHUNK)]);
      deleted += rowCount ?? 0;
    }
  }

  return NextResponse.json({
    suppressed, leadsFlagged: flagged, leadsDeleted: deleted,
    message:
      `${suppressed.toLocaleString()} address${suppressed === 1 ? "" : "es"} will never be contacted again` +
      (deleted ? `, and ${deleted.toLocaleString()} lead row${deleted === 1 ? "" : "s"} deleted` : "") +
      ". They stay blocked even if Bison still holds them.",
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  let body: { emails?: unknown; email?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const pool = getPool();
  let emails: string[];

  // Restore a whole reason group in one action — reasons are free text and
  // inconsistently cased ("Out of USA" / "out of USA"), so the group is keyed
  // case-insensitively, exactly as the listing groups them.
  if (typeof body.reason === "string") {
    const key = body.reason.trim().toLowerCase();
    const { rows } = await pool.query(
      key === NO_REASON
        ? `select email from suppressed_emails where reason is null or btrim(reason) = ''`
        : `select email from suppressed_emails where lower(btrim(coalesce(reason, ''))) = $1`,
      key === NO_REASON ? [] : [key]);
    emails = rows.map((r) => String(r.email));
  } else {
    const parsed = readEmails(body);
    if (!parsed || parsed.length === 0) {
      return NextResponse.json({ error: "No valid email addresses" }, { status: 400 });
    }
    emails = parsed;
  }
  if (emails.length === 0) return NextResponse.json({ error: "Nothing to restore" }, { status: 400 });

  let unsuppressed = 0, restored = 0;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const { rows } = await pool.query(
      `select * from fn_unsuppress_emails($1::text[])`, [emails.slice(i, i + CHUNK)]);
    unsuppressed += Number(rows[0]?.unsuppressed ?? 0);
    restored += Number(rows[0]?.leads_restored ?? 0);
  }
  return NextResponse.json({
    unsuppressed, leadsRestored: restored,
    message:
      `${unsuppressed.toLocaleString()} address${unsuppressed === 1 ? "" : "es"} restored` +
      (restored ? `, ${restored.toLocaleString()} lead${restored === 1 ? "" : "s"} active again` : "") +
      (restored < unsuppressed ? ` (${(unsuppressed - restored).toLocaleString()} had no lead row left)` : ""),
  });
}

export async function GET(request: NextRequest) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const pool = getPool();
  const sp = request.nextUrl.searchParams;

  // Grouped view: one row per reason, most-suppressed first. Reasons are free
  // text, so they are folded case-insensitively and the most common spelling
  // is shown ("Out of USA" and "out of USA" are one group).
  if (sp.get("group") === "reason") {
    const { rows } = await pool.query(
      `select coalesce(nullif(lower(btrim(reason)), ''), $1) as key,
              (array_agg(reason order by cnt desc nulls last))[1] as label,
              sum(cnt)::int as total,
              min(first_at) as first_at,
              max(last_at) as last_at,
              sum(with_lead)::int as with_lead
         from (
           select reason, count(*) as cnt, min(created_at) as first_at, max(created_at) as last_at,
                  count(*) filter (where exists (select 1 from leads l where l.email = s.email)) as with_lead
             from suppressed_emails s group by reason
         ) g
        group by 1 order by total desc, key`, [NO_REASON]);
    const { rows: [t] } = await pool.query(`select count(*)::int n from suppressed_emails`);
    return NextResponse.json({
      groups: rows.map((r) => ({
        key: String(r.key),
        label: r.label ? String(r.label) : NO_REASON,
        total: Number(r.total),
        withLead: Number(r.with_lead),
        firstAt: r.first_at,
        lastAt: r.last_at,
      })),
      total: t?.n ?? 0,
    });
  }

  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 1000);
  const offset = Math.max(Number(sp.get("offset")) || 0, 0);
  const reason = sp.get("reason");
  const q = sp.get("q")?.trim().toLowerCase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (reason !== null) {
    if (reason.toLowerCase() === NO_REASON) where.push(`(s.reason is null or btrim(s.reason) = '')`);
    else { params.push(reason.toLowerCase()); where.push(`lower(btrim(coalesce(s.reason, ''))) = $${params.length}`); }
  }
  if (q) { params.push(`%${q}%`); where.push(`s.email like $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const { rows } = await pool.query(
    `select s.email, s.reason, s.notes, s.suppressed_by_name, s.created_at,
            exists (select 1 from leads l where l.email = s.email) as lead_exists
       from suppressed_emails s ${whereSql}
      order by s.created_at desc limit ${limit} offset ${offset}`, params);
  const { rows: [t] } = await pool.query(
    `select count(*)::int n from suppressed_emails s ${whereSql}`, params);
  return NextResponse.json({ suppressed: rows, total: t?.n ?? 0, limit, offset });
}

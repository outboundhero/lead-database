import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// POST   /api/leads/suppress   { emails: [...], reason?, notes?, delete?: boolean }
// DELETE /api/leads/suppress   { emails: [...] }        — lift a suppression
// GET    /api/leads/suppress?limit=100                  — what is suppressed
//
// Permanent do-not-contact, keyed on the ADDRESS rather than the lead row.
// That distinction is the point: the Bison sync adds addresses Bison holds that
// we do not, so a merely-deleted lead reappears on the next run and goes back
// into a client campaign. Suppression survives deletion and is checked by the
// import, by browse, and by the push eligibility gate.
//
// `delete: true` also removes the lead row. The suppression entry remains, so
// the address still cannot come back.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAILS = 5000;

async function requireManager(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("role, full_name, email").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return { error: NextResponse.json({ error: "Your role can't suppress leads — ask an admin" }, { status: 403 }) };
  }
  void request;
  return { user, profile };
}

function readEmails(body: { emails?: unknown; email?: unknown }): string[] | null {
  const raw = Array.isArray(body.emails) ? body.emails : body.email ? [body.email] : [];
  const out = [...new Set(raw.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
  if (out.length === 0 || out.length > MAX_EMAILS) return null;
  return out.filter((e) => EMAIL_RE.test(e));
}

export async function POST(request: NextRequest) {
  const auth = await requireManager(request);
  if ("error" in auth) return auth.error;

  let body: { emails?: unknown; email?: unknown; reason?: string; notes?: string; delete?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const emails = readEmails(body);
  if (!emails) return NextResponse.json({ error: `Provide 1-${MAX_EMAILS} email addresses` }, { status: 400 });
  if (emails.length === 0) return NextResponse.json({ error: "No valid email addresses" }, { status: 400 });

  const pool = getPool();
  const who = auth.profile.full_name || auth.profile.email || "Unknown user";
  let flagged = 0;
  for (const email of emails) {
    const { rows } = await pool.query(
      `select fn_suppress_email($1, $2, $3, $4::uuid, $5) as n`,
      [email, body.reason ?? null, body.notes ?? null, auth.user.id, who]
    );
    flagged += Number(rows[0]?.n ?? 0);
  }

  // Optional hard delete of the lead row. The suppression entry stays behind,
  // which is what stops the Bison sync recreating it.
  let deleted = 0;
  if (body.delete === true) {
    const { rowCount } = await pool.query(`delete from leads where email = any($1::text[])`, [emails]);
    deleted = rowCount ?? 0;
  }

  return NextResponse.json({
    suppressed: emails.length,
    leadsFlagged: flagged,
    leadsDeleted: deleted,
    message:
      `${emails.length} address${emails.length === 1 ? "" : "es"} will never be contacted again` +
      (deleted ? `, and ${deleted} lead row${deleted === 1 ? "" : "s"} deleted` : "") +
      ". They stay blocked even if Bison still holds them.",
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireManager(request);
  if ("error" in auth) return auth.error;
  let body: { emails?: unknown; email?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const emails = readEmails(body);
  if (!emails || emails.length === 0) return NextResponse.json({ error: "No valid email addresses" }, { status: 400 });

  const pool = getPool();
  let restored = 0;
  for (const email of emails) {
    const { rows } = await pool.query(`select fn_unsuppress_email($1) as n`, [email]);
    restored += Number(rows[0]?.n ?? 0);
  }
  return NextResponse.json({ unsuppressed: emails.length, leadsRestored: restored });
}

export async function GET(request: NextRequest) {
  const auth = await requireManager(request);
  if ("error" in auth) return auth.error;
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit")) || 100, 1), 1000);
  const pool = getPool();
  const { rows } = await pool.query(
    `select s.email, s.reason, s.notes, s.suppressed_by_name, s.created_at,
            exists (select 1 from leads l where l.email = s.email) as lead_exists
       from suppressed_emails s order by s.created_at desc limit $1`, [limit]);
  const { rows: total } = await pool.query(`select count(*)::int n from suppressed_emails`);
  return NextResponse.json({ suppressed: rows, total: total[0]?.n ?? 0 });
}

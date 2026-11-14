import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/companies/server";
import { contactsPage } from "@/lib/companies/people";

// GET /api/companies/contacts?tag=&row=&after=: one company's general inboxes
// and people (enrich_contacts), general emails first, in keyset pages of 50
// (`after` is the page before's `next`; no OFFSET). `row` is the company's
// row in the client's pipeline Companies table. The first page also counts
// each kind. Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const tag = cleanTag(sp.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const row = Number(sp.get("row"));
  if (!Number.isSafeInteger(row) || row < 1) return NextResponse.json({ error: "row must be a company row id" }, { status: 400 });
  const after = sp.get("after");
  try {
    const page = await withTx((c) => contactsPage(c, { tag, row, after }), { readOnly: true, timeoutMs: 8_000 });
    if (!page) return NextResponse.json({ error: "after is not a page cursor" }, { status: 400 });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/contacts:", err);
    return NextResponse.json({ error: "Could not load the company's contacts" }, { status: 500 });
  }
}

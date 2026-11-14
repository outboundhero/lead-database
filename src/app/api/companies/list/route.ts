import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { cleanTag, decodeCursor, listCompanies, TAG_RE } from "@/lib/companies/server";
import { FOUND_BY, PAGE_SIZES, type CompaniesPage, type FoundBy, type ListHas, type ListSort } from "@/lib/companies/types";

// GET /api/companies/list?tag=&sort=newest|name&size=50|100|200&after=&q=&state=&status=valid|catch_all&found=&hideHeld=1&has=people|general
// One page of a client's listed companies (enrich_companies.listed): those
// passing the client's rules with a usable general email or a usable person
// email, held ones included. `has` keeps only those with people emails, or
// only those with a general email. Each row carries its first general emails
// and people (enrich_contacts).
// Keyset paging, no OFFSET: `after` is the `next` cursor of the page before,
// a base64url [found_at, row_id] (newest first) or [lower(company), row_id]
// (A to Z), so a page costs the same however many companies the client has.
// The first page also lists the states the client's companies are in.
// Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const tag = cleanTag(sp.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const sort: ListSort = sp.get("sort") === "name" ? "name" : "newest";
  const sizeIn = Number(sp.get("size"));
  const size = (PAGE_SIZES as readonly number[]).includes(sizeIn) ? sizeIn : PAGE_SIZES[0];
  const rawAfter = sp.get("after");
  const after = rawAfter ? decodeCursor(rawAfter, sort) : null;
  if (rawAfter && !after) return NextResponse.json({ error: "after is not a page cursor for this order" }, { status: 400 });
  const q = (sp.get("q") ?? "").trim().toLowerCase().slice(0, 200);
  const state = (sp.get("state") ?? "").trim().slice(0, 100) || null;
  const statusIn = sp.get("status");
  const status = statusIn === "valid" || statusIn === "catch_all" ? statusIn : null;
  const foundIn = sp.get("found");
  const foundBy = FOUND_BY.includes(foundIn as FoundBy) ? (foundIn as FoundBy) : null;
  const hideHeld = sp.get("hideHeld") === "1" || sp.get("hideHeld") === "true";
  const hasIn = sp.get("has");
  const has: ListHas | null = hasIn === "people" || hasIn === "general" ? hasIn : null;

  try {
    const page = await withTx<CompaniesPage>(
      (c) => listCompanies(c, { tag, sort, size, after, q, state, status, foundBy, hideHeld, has }),
      { readOnly: true, timeoutMs: 10_000 }
    );
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/list:", err);
    const timedOut = (err as { code?: string } | null)?.code === "57014";
    return NextResponse.json({ error: timedOut ? "The search took too long" : "Could not load the companies" }, { status: 500 });
  }
}

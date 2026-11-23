import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import type { ContextView } from "@/lib/questions/types";

// GET /api/questions/context?tag=TAG (manager and up): the client's onboarding
//     sheet answer about who it targets (client_targeting.sheet_raw ->>
//     'target', as the 6-hourly sheet sync stores it), for the Question
//     variable tab's "Fill from onboarding". null when the client has none.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const target = await withTx(
      async (c) => {
        const { rows } = await c.query<{ target: string | null }>(
          `SELECT sheet_raw ->> 'target' AS target FROM client_targeting WHERE client_tag = $1`,
          [tag]
        );
        const t = rows[0]?.target?.trim();
        return t ? t : null;
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    const body: ContextView = { target };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/context GET:", err);
    return NextResponse.json({ error: "Could not read the onboarding answers" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { normalizeDomain } from "@/lib/bison/keys";
import { authOf, createVariableNamed, listVariableNames } from "@/lib/questions/bison";
import { clientOf, copyTag, variableRow, type ClientRow } from "@/lib/questions/server";
import type { BisonCreateResult, BisonInstallView, BisonView } from "@/lib/questions/types";

// GET  /api/questions/bison?tag=TAG&variableId=ID (manager and up, a live
//      read): whether the variable exists on each of the client's Bison
//      installs (client_tags.b2b_instance and b2c_instance). exists null with
//      an error: that install could not be read. A client with no installs
//      saved answers an empty list.
// POST /api/questions/bison {tag, variableId} (admin and up): makes the
//      variable, under its stored lower-case name, on each install where it is
//      missing, and says which were made, which had it, and which failed.
// Bison is asked outside any database transaction, 20 s at most a request,
// and only on installs with a key in EMAILBISON_KEYS. No answer holds a token.

export const dynamic = "force-dynamic";

/** The client's installs, B2B first. */
function installsOf(client: ClientRow): Array<{ install: string; side: "b2b" | "b2c" }> {
  const out: Array<{ install: string; side: "b2b" | "b2c" }> = [];
  for (const [raw, side] of [[client.b2b_instance, "b2b"], [client.b2c_instance, "b2c"]] as const) {
    const install = raw ? normalizeDomain(raw) : "";
    if (install && !out.some((x) => x.install === install)) out.push({ install, side });
  }
  return out;
}

async function load(tag: string, variableId: string) {
  return withTx(
    async (c) => {
      const client = await clientOf(c, tag);
      if (!client) return { status: 404, error: `${tag} is not a client` };
      const v = await variableRow(c, variableId);
      if (!v) return { status: 404, error: "No such variable" };
      return { client, variable: v };
    },
    { readOnly: true, timeoutMs: 8_000 }
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const tag = cleanTag(sp.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const variableId = sp.get("variableId");
  if (!isUuid(variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  try {
    const got = await load(tag, variableId);
    if ("error" in got) return NextResponse.json({ error: got.error }, { status: got.status });
    const name = got.variable.name;
    const installs: BisonInstallView[] = await Promise.all(
      installsOf(got.client).map(async ({ install, side }) => {
        const a = authOf(install);
        if (!a.auth) return { install, side, exists: null, error: a.error };
        try {
          const names = await listVariableNames(a.auth);
          return { install, side, exists: names.includes(name), error: null };
        } catch (e) {
          return { install, side, exists: null, error: e instanceof Error ? e.message : "Bison could not be read" };
        }
      })
    );
    const body: BisonView = { name, copyTag: copyTag(name), installs };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/bison GET:", err);
    return NextResponse.json({ error: "Could not read Bison" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; variableId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (!isUuid(body.variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  const variableId = body.variableId;
  try {
    const got = await load(tag, variableId);
    if ("error" in got) return NextResponse.json({ error: got.error }, { status: got.status });
    const name = got.variable.name;
    if (got.variable.archived_at != null) {
      return NextResponse.json({ error: `${copyTag(name)} is archived: restore it before making it in Bison` }, { status: 400 });
    }
    const installs = installsOf(got.client);
    if (!installs.length) {
      return NextResponse.json(
        { error: `${tag} has no Bison installs saved yet (its group is set by the client sheet or its first push), so nothing was made.` },
        { status: 409 }
      );
    }
    const out: BisonCreateResult = { created: [], existed: [], failed: [] };
    for (const { install } of installs) {
      const a = authOf(install);
      if (!a.auth) {
        out.failed.push({ install, error: a.error });
        continue;
      }
      try {
        const names = await listVariableNames(a.auth);
        if (names.includes(name)) {
          out.existed.push(install);
          continue;
        }
        await createVariableNamed(a.auth, name);
        out.created.push(install);
      } catch (e) {
        out.failed.push({ install, error: e instanceof Error ? e.message : "Bison refused" });
      }
    }
    if (out.created.length || out.failed.length) {
      await logAudit({
        action: "question_variable_bison",
        performedBy: auth.user.id,
        details: `${copyTag(name)} for ${tag}: made on ${out.created.length} install(s), already on ${out.existed.length}, failed on ${out.failed.length}`,
      });
    }
    return NextResponse.json(out);
  } catch (err) {
    console.error("questions/bison POST:", err);
    return NextResponse.json({ error: "Could not make the variable in Bison" }, { status: 500 });
  }
}

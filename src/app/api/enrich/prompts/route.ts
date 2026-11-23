import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, clientInfo, TAG_RE } from "@/lib/aiark/server";
import { settingsFrom } from "../../../../../scripts/lib/enrich/settings.mjs";
import { lockPipelineTables } from "../../../../../scripts/lib/enrich/templates.mjs";
import { isPromptPosition, PROMPT_ROLES } from "../../../../../scripts/lib/enrich/prompt-overrides.mjs";
import {
  promptBase,
  promptsView,
  recompileIfTables,
  resetPromptOverride,
  savePromptOverride,
} from "../../../../../scripts/lib/enrich/prompt-editor.mjs";

// The Clay tab's prompt editor (migration 139): a client's own text for its
// four personalisation AI steps, People P#60 (research) and P#61 (question
// AI), General G#48 and G#49, applied when its pipeline tables compile. The
// Clay originals are never changed; Reset deletes the edit.
//
// GET    /api/enrich/prompts?tag=TAG (manager and up): PromptsView. For each
//        step: whose text runs (edited, the client's own Clay text, or the
//        default's), the text (null when the original can't be shown as text
//        and there is no edit), the Clay original as text, the placeholders
//        the step can read, the edit's version and who saved it last, and
//        `problem` when an edit no longer compiles (the original runs then).
//        Works for a client with no tables yet.
// PUT    {tag, kind, position, text, version} (admin and up): saves the text
//        (written as the pipeline's expression by the server, never taken as
//        one), compiles the client's templates in memory with it, writes the
//        edit (version + 1) and its log row, and compiles the client's tables
//        again when it has any, all in one transaction under the client's
//        pipeline lock. 400 { error, errors } for a placeholder the step
//        can't read (each named) or a text that does not compile; 409
//        { error, changed } when the edit is not at `version` any more (null:
//        not edited); 409 when the Clay originals are not loaded; 404 for a
//        tag that is no client. Answers PromptsSaved: the GET shape, and
//        whether anything was saved and the tables compiled again.
// DELETE {tag, kind, position, version} (admin and up): Reset to the Clay
//        original: deletes the edit, logs it, compiles the tables again.
//        Same answers.
// The audit log gets lengths only: never a prompt's text.

export const dynamic = "force-dynamic";

export type PromptKind = "people" | "inboxes";

export interface PromptColumnView {
  kind: PromptKind;
  position: number;
  key: string;
  name: string;
  role: "research" | "question";
  source: "edited" | "client" | "default";
  /** The text that runs now (an edit that does not compile: the edit, with `problem`); null when it can't be shown as text. */
  text: string | null;
  /** The Clay original as text: the client's own Clay text, else the default's. */
  originalText: string | null;
  /** True when the original can't be shown as text (originalReason says why). */
  originalAdvanced: boolean;
  originalReason: string | null;
  placeholders: Array<{ name: string; fields?: string[] }>;
  /** The edit's version, null when not edited. */
  version: number | null;
  updatedAt: string | null;
  /** The email of who saved the edit last, or null. */
  updatedBy: string | null;
  /** Why the edit does not run now (it no longer compiles), or null. */
  problem: string | null;
}

export interface PromptsView {
  tag: string;
  personalisation: { enabled: boolean; listed: boolean; sharedTextOk: boolean };
  columns: PromptColumnView[];
}

export interface PromptsSaved extends PromptsView {
  /** Something was written (false: the same text again, or nothing to reset). */
  saved: boolean;
  /** The client's pipeline tables were compiled again with it. */
  recompiled: boolean;
  /** Why they were not (no tables yet, or they can't be compiled now), or null. */
  note: string | null;
}

const KINDS: PromptKind[] = ["people", "inboxes"];
const kindOf = (v: unknown): PromptKind | null => (KINDS.includes(v as PromptKind) ? (v as PromptKind) : null);
const LETTER: Record<PromptKind, string> = { people: "P", inboxes: "G" };
const isMissing = (e: unknown) => (e as { name?: unknown } | null)?.name === "OriginalsMissing";

type Body = { tag?: unknown; kind?: unknown; position?: unknown; text?: unknown; version?: unknown };

/** The body's step and version, or the 400 it gets. */
async function readBody(req: NextRequest, needsText: boolean) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return { error: "Body is not JSON" } as const;
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return { error: "tag is not a client tag" } as const;
  const kind = kindOf(body.kind);
  if (!kind) return { error: "kind must be people or inboxes" } as const;
  const position = Number(body.position);
  if (!isPromptPosition(kind, position)) return { error: "position must be 60 or 61 for people, 48 or 49 for inboxes" } as const;
  if (needsText && typeof body.text !== "string") return { error: "text is required" } as const;
  if (!("version" in body) || (body.version !== null && !Number.isInteger(body.version))) {
    return { error: "version is required: the step's version as the page loaded it (null when it was not edited)" } as const;
  }
  return { tag, kind, position, text: typeof body.text === "string" ? body.text : "", version: body.version as number | null };
}

async function readSettings(c: PoolClient) {
  const { rows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientInfo(c, tag))) return { status: 404, error: `${tag} is not a client` } as const;
        const settings = await readSettings(c);
        return { view: (await promptsView(c, tag, { settings })) as PromptsView };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isMissing(err)) return NextResponse.json({ error: "The Clay originals are not loaded" }, { status: 409 });
    console.error("enrich/prompts GET:", err);
    return NextResponse.json({ error: "Could not load the prompts" }, { status: 500 });
  }
}

/** PUT saves a step's text, DELETE resets it: one transaction under the client's pipeline lock, the tables compiled again. */
async function change(req: NextRequest, action: "save" | "reset") {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  const b = await readBody(req, action === "save");
  if ("error" in b) return NextResponse.json({ error: b.error }, { status: 400 });
  const { tag, kind, position, version } = b;
  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientInfo(c, tag))) return { status: 404, error: `${tag} is not a client` } as const;
        await lockPipelineTables(c, tag);
        const settings = await readSettings(c);
        const base = await promptBase(c, tag, { settings });
        const r =
          action === "save"
            ? await savePromptOverride(c, { tag, kind, position, text: b.text, version, userId: auth.user.id, settings, base })
            : await resetPromptOverride(c, { tag, kind, position, version, userId: auth.user.id });
        if ("error" in r) return r;
        const saved = "saved" in r ? r.saved : r.reset;
        const tables = saved ? await recompileIfTables(c, tag, { settings }) : { recompiled: false, note: null };
        const view = (await promptsView(c, tag, { settings, base })) as PromptsView;
        const answer: PromptsSaved = { ...view, saved, recompiled: tables.recompiled, note: tables.note };
        return { answer, lengths: "after" in r ? { before: r.before, after: r.after } : { before: r.before, after: null } };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      if ("changed" in out && out.changed) answer.changed = true;
      return NextResponse.json(answer, { status: out.status });
    }
    if (out.answer.saved) {
      const step = `${LETTER[kind]}#${position} (${(PROMPT_ROLES[kind] as Record<number, string>)[position]})`;
      const was = out.lengths.before == null ? "the Clay original" : `${out.lengths.before} characters`;
      await logAudit({
        action: "enrich_prompt",
        performedBy: auth.user.id,
        details:
          action === "save"
            ? `${tag} ${step}: prompt saved, ${out.lengths.after} characters (was ${was})${out.answer.recompiled ? ", tables compiled again" : ""}`
            : `${tag} ${step}: reset to the Clay original (was ${was})${out.answer.recompiled ? ", tables compiled again" : ""}`,
      });
    }
    return NextResponse.json(out.answer);
  } catch (err) {
    if (isMissing(err)) return NextResponse.json({ error: "The Clay originals are not loaded" }, { status: 409 });
    console.error(`enrich/prompts ${action === "save" ? "PUT" : "DELETE"}:`, err);
    return NextResponse.json({ error: action === "save" ? "Could not save the prompt" : "Could not reset the prompt" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  return change(req, "save");
}

export async function DELETE(req: NextRequest) {
  return change(req, "reset");
}

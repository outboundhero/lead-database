import type { PoolClient } from "pg";
import { workerState } from "@/lib/enrich/queries";
import { copyTag, isOsClient } from "../../../scripts/lib/questions/names.mjs";
import { questionSettingsFrom, questionSwitchOn } from "../../../scripts/lib/questions/settings.mjs";
import { placeholderErrors, QUESTION_PLACEHOLDERS, RESEARCH_PLACEHOLDERS } from "../../../scripts/lib/questions/render.mjs";
import { QUESTION_JOBS_CAPABILITY } from "../../../scripts/lib/questions/capability.mjs";
import { settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import type { JobStatus, JobView, VariableDetail, VariableListItem, VariablesView, VariableView } from "./types";

// Server side of the question variable routes (src/app/api/questions/*,
// migration 139): reading a variable and a client's list, checking a
// variable's fields before a save, and the views the routes answer.

export { copyTag };

/** A client as the routes read it (client_tags). */
export interface ClientRow {
  tag: string;
  name: string | null;
  client_type: string | null;
  status: string | null;
  b2b_instance: string | null;
  b2c_instance: string | null;
}

export async function clientOf(c: PoolClient, tag: string): Promise<ClientRow | null> {
  const { rows } = await c.query<ClientRow>(
    `SELECT tag, name, client_type, status, b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`,
    [tag]
  );
  return rows[0] ?? null;
}

/** A question_variables row as the routes read it, with the email of whoever saved it last. */
export interface VariableRow {
  id: string;
  name: string;
  created_for_tag: string | null;
  services: string;
  client_context: string;
  research_prompt: string;
  people_prompt: string;
  general_prompt: string;
  max_words: number;
  version: number;
  prompt_version: number;
  archived_at: Date | string | null;
  updated_at: Date | string | null;
  updated_by_email: string | null;
}

const VARIABLE_COLUMNS = `v.id, v.name, v.created_for_tag, v.services, v.client_context, v.research_prompt, v.people_prompt,
  v.general_prompt, v.max_words, v.version, v.prompt_version, v.archived_at, v.updated_at, up.email AS updated_by_email`;

export async function variableRow(c: PoolClient, id: string, { lock = false } = {}): Promise<VariableRow | null> {
  const { rows } = await c.query<VariableRow>(
    `SELECT ${VARIABLE_COLUMNS}
       FROM question_variables v LEFT JOIN user_profiles up ON up.id = v.updated_by
      WHERE v.id = $1${lock ? " FOR UPDATE OF v" : ""}`,
    [id]
  );
  return rows[0] ?? null;
}

const iso = (v: Date | string | null | undefined) => (v == null ? null : new Date(v).toISOString());

export function variableDetailOf(r: VariableRow): VariableDetail {
  return {
    id: r.id,
    name: r.name,
    copyTag: copyTag(r.name),
    createdForTag: r.created_for_tag,
    services: r.services,
    clientContext: r.client_context,
    researchPrompt: r.research_prompt,
    peoplePrompt: r.people_prompt,
    generalPrompt: r.general_prompt,
    maxWords: Number(r.max_words),
    version: Number(r.version),
    promptVersion: Number(r.prompt_version),
    archived: r.archived_at != null,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by_email ?? null,
  };
}

/** GET /api/questions/variables/<id>'s answer. */
export function variableView(r: VariableRow): VariableView {
  return {
    variable: variableDetailOf(r),
    placeholders: { research: [...RESEARCH_PLACEHOLDERS], question: [...QUESTION_PLACEHOLDERS] },
  };
}

/** The fields a person edits, as stored. */
export interface VariableFields {
  services: string;
  client_context: string;
  research_prompt: string;
  people_prompt: string;
  general_prompt: string;
  max_words: number;
}

export const EMPTY_FIELDS: VariableFields = Object.freeze({
  services: "",
  client_context: "",
  research_prompt: "",
  people_prompt: "",
  general_prompt: "",
  max_words: 16,
}) as VariableFields;

/** Each field: its name in a request, its stored column, its label in an error, and its most characters. */
const TEXT_FIELDS = [
  { input: "services", column: "services", label: "Services", max: 2000 },
  { input: "clientContext", column: "client_context", label: "Client context", max: 6000 },
  { input: "researchPrompt", column: "research_prompt", label: "Research prompt", max: 20000, allowed: RESEARCH_PLACEHOLDERS },
  { input: "peoplePrompt", column: "people_prompt", label: "People question prompt", max: 20000, allowed: QUESTION_PLACEHOLDERS },
  { input: "generalPrompt", column: "general_prompt", label: "General question prompt", max: 20000, allowed: QUESTION_PLACEHOLDERS },
] as const;

/**
 * A save's fields checked and laid over `base` (a field left out keeps the
 * base's value). Text is trimmed at its ends and NUL characters are dropped;
 * anything too long, a placeholder the prompt may not use, or max words
 * outside 4 to 40 is refused with its reason, never cut or replaced.
 */
export function cleanVariableFields(body: Record<string, unknown>, base: VariableFields): { value: VariableFields; errors: string[] } {
  const errors: string[] = [];
  const value: VariableFields = { ...base };
  for (const f of TEXT_FIELDS) {
    const raw = body[f.input];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== "string") {
      errors.push(`${f.label} must be text.`);
      continue;
    }
    const text = String(raw ?? "").replace(/\u0000/g, "").trim();
    if (text.length > f.max) errors.push(`${f.label} is ${text.length.toLocaleString("en-US")} characters: at most ${f.max.toLocaleString("en-US")}.`);
    (value as unknown as Record<string, unknown>)[f.column] = text;
  }
  for (const f of TEXT_FIELDS) {
    if (!("allowed" in f)) continue;
    for (const e of placeholderErrors((value as unknown as Record<string, string>)[f.column], f.allowed)) errors.push(`${f.label}: ${e}`);
  }
  if (body.maxWords !== undefined) {
    const n = body.maxWords;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 4 || n > 40) errors.push("Max words must be a whole number from 4 to 40.");
    else value.max_words = n;
  }
  return { value, errors };
}

/** The stored fields of a row. */
export function fieldsOf(r: VariableRow | Record<string, unknown>): VariableFields {
  const x = r as Record<string, unknown>;
  return {
    services: String(x.services ?? ""),
    client_context: String(x.client_context ?? ""),
    research_prompt: String(x.research_prompt ?? ""),
    people_prompt: String(x.people_prompt ?? ""),
    general_prompt: String(x.general_prompt ?? ""),
    max_words: Number(x.max_words ?? 16),
  };
}

/** Which fields differ (their stored names). */
export function changedFields(a: VariableFields, b: VariableFields): string[] {
  return (Object.keys(a) as (keyof VariableFields)[]).filter((k) => a[k] !== b[k]);
}

/** Counts and lengths only, for the audit log (readable by every signed-in user): never a prompt's text. */
export function lengthsText(v: VariableFields): string {
  return (
    `services ${v.services.length} chars, client context ${v.client_context.length}, research prompt ${v.research_prompt.length}, ` +
    `People prompt ${v.people_prompt.length}, General prompt ${v.general_prompt.length}, max ${v.max_words} words`
  );
}

/** The question_variables switch, and the sharing setting's isolated tag endings, read fresh. */
export async function questionSettingsNow(c: PoolClient) {
  const { rows } = await c.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM enrich_settings WHERE key IN ('question_variables', 'overlap_sharing')`
  );
  const qs = questionSettingsFrom(rows.find((r) => r.key === "question_variables")?.value);
  const suffixes = settingsFrom(rows.filter((r) => r.key === "overlap_sharing")).overlap_sharing.isolated_tag_suffixes as string[];
  return { qs, suffixes };
}

/** Whether the worker running now writes question jobs: online, with question_jobs in its heartbeat. */
export async function questionWorker(c: PoolClient): Promise<{ online: boolean; ready: boolean } | null> {
  const w = await workerState(c);
  if (!w) return null;
  const caps = w.info?.capabilities;
  return { online: w.online, ready: Array.isArray(caps) && caps.includes(QUESTION_JOBS_CAPABILITY) };
}

/** GET /api/questions/variables?tag=TAG's answer: the client's choice and every variable, its own first. */
export async function variablesView(c: PoolClient, client: ClientRow): Promise<VariablesView> {
  const tag = client.tag;
  const { qs, suffixes } = await questionSettingsNow(c);
  const worker = await questionWorker(c);
  const { rows: [current] } = await c.query<{ variable_id: string | null }>(
    `SELECT variable_id FROM client_question_settings WHERE client_tag = $1`,
    [tag]
  );
  const { rows } = await c.query<VariableRow & { used_by: string[] | null }>(
    `SELECT ${VARIABLE_COLUMNS},
            (SELECT array_agg(s.client_tag ORDER BY s.client_tag) FROM client_question_settings s WHERE s.variable_id = v.id) AS used_by
       FROM question_variables v LEFT JOIN user_profiles up ON up.id = v.updated_by
      ORDER BY (v.created_for_tag IS DISTINCT FROM $1), (v.archived_at IS NOT NULL), v.name`,
    [tag]
  );
  const variables: VariableListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    copyTag: copyTag(r.name),
    createdForTag: r.created_for_tag,
    services: r.services,
    maxWords: Number(r.max_words),
    promptVersion: Number(r.prompt_version),
    archived: r.archived_at != null,
    usedBy: r.used_by ?? [],
  }));
  return {
    tag,
    isOs: isOsClient({ tag, clientType: client.client_type }, suffixes),
    switchOn: questionSwitchOn(qs, tag),
    workerReady: Boolean(worker?.online && worker.ready),
    current: { variableId: current?.variable_id ?? null },
    variables,
  };
}

/** A question_jobs row joined with its variable's name. */
export const JOB_COLUMNS = `j.id, j.variable_id, v.name AS variable_name, j.status, j.total, j.done, j.failed, j.skipped,
  j.companies, j.researched, j.spend_usd::float8 AS spend_usd, j.note, j.error, j.created_at, j.completed_at`;

export function jobViewOf(r: Record<string, unknown>): JobView {
  return {
    id: String(r.id),
    variableId: String(r.variable_id),
    variableName: String(r.variable_name ?? ""),
    status: r.status as JobStatus,
    total: Number(r.total ?? 0),
    done: Number(r.done ?? 0),
    failed: Number(r.failed ?? 0),
    skipped: Number(r.skipped ?? 0),
    companies: Number(r.companies ?? 0),
    researched: Number(r.researched ?? 0),
    spendUsd: Number(r.spend_usd ?? 0),
    note: (r.note as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at as Date | string) ?? "",
    completedAt: iso(r.completed_at as Date | string | null),
  };
}

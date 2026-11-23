import type { PoolClient } from "pg";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { idsOfSide } from "@/lib/bison/push-stamp";
import { normalizeFilterState } from "@/types/filters";

// The export popup's selection, checked and turned into the fields a push
// batch stores, exactly as POST /api/bison/push-batch does it (its lines are
// pinned in scripts/lib/questions/gather.mjs PUSH_ROUTE_PINS): the filters as
// filters as the database reads them (normalizeFilterState, buildRpcFilters, the email side, and the
// client as applyClientTargeting), selected ids (narrowed to the email side
// when one is given), the range or max_leads, the client and the accounting
// options. The question routes read the push set from these fields
// (gather.mjs), and a job stores them as its selection.
//
// The selection is the body the popup would send to push-batch, minus
// campaigns, force and the question fields: filters or selectedIds (the
// select-all's unchecked rows ride inside filters as excludeIds), rangeFrom,
// rangeTo, maxLeads, clientTag, pushOptions {includeAlreadyPushed,
// onlyNewSinceLast, retryFailed} (includeAlreadyPushed is also taken at the
// top level) and emailSide. Its client is always the route's tag: a question
// variable is sent only with a client, so the push it matches carries one.

const MAX_SELECTED_IDS = 100000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A push batch's fields, as push-batch stores them (scripts/lib/questions/gather.mjs selectionOf reads them). */
export interface StoredSelection {
  filters: Record<string, unknown> | null;
  selected_ids: string[] | null;
  range_from: number | null;
  range_to: number | null;
  max_leads: number | null;
  client_tag: string;
  email_side: "b2b" | "b2c" | null;
  push_options: { includeAlreadyPushed: boolean; onlyNewSinceLast: boolean; retryFailed: boolean } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Checks a selection the way push-batch checks its body, and resolves it.
 * Answers { selection } or { errors } (plain words, as the route's 400s).
 */
export async function resolveSelection(
  c: Pick<PoolClient, "query">,
  raw: unknown,
  tag: string
): Promise<{ selection: StoredSelection; errors?: undefined } | { errors: string[]; selection?: undefined }> {
  if (!isObject(raw)) return { errors: ["selection must be the export popup's selection: filters or selectedIds, and the range."] };
  const body = raw;
  const selectedIds = body.selectedIds;
  if (selectedIds !== undefined && !Array.isArray(selectedIds)) return { errors: ["selectedIds must be an array of lead ids"] };
  const hasSelectedIds = Array.isArray(selectedIds) && selectedIds.length > 0;
  if (hasSelectedIds) {
    if (selectedIds.length > MAX_SELECTED_IDS) {
      return { errors: [`Too many leads (${selectedIds.length}). Max ${MAX_SELECTED_IDS} per batch.`] };
    }
    if (!selectedIds.every((id) => typeof id === "string" && UUID_RE.test(id))) return { errors: ["selectedIds must be uuid strings"] };
  }
  const { rangeFrom, rangeTo } = body;
  if (rangeFrom !== undefined || rangeTo !== undefined) {
    if (!Number.isInteger(rangeFrom) || !Number.isInteger(rangeTo) || (rangeFrom as number) < 1 || (rangeTo as number) < (rangeFrom as number)) {
      return { errors: ["rangeFrom/rangeTo must be positive integers with rangeTo >= rangeFrom"] };
    }
    if (hasSelectedIds) return { errors: ["rangeFrom/rangeTo cannot be combined with selectedIds"] };
    if (!body.filters) return { errors: ["rangeFrom/rangeTo requires filters"] };
  }
  if (body.maxLeads !== undefined && (!Number.isInteger(body.maxLeads) || (body.maxLeads as number) < 1)) {
    return { errors: ["maxLeads must be a positive integer"] };
  }
  if (!hasSelectedIds && !body.filters) return { errors: ["Provide selectedIds or filters"] };
  if (!hasSelectedIds && !isObject(body.filters)) return { errors: ["filters must be the Leads page's filters"] };
  const emailSide = body.emailSide;
  if (emailSide !== undefined && emailSide !== "b2b" && emailSide !== "b2c") return { errors: ["emailSide must be 'b2b' or 'b2c'"] };
  if (body.clientTag !== undefined) {
    if (typeof body.clientTag !== "string" || !body.clientTag.trim()) return { errors: ["clientTag must be a non-empty string"] };
    if (body.clientTag.trim().toUpperCase() !== tag) return { errors: [`The selection is for ${body.clientTag.trim()}, not ${tag}`] };
  }
  if (body.pushOptions !== undefined && !isObject(body.pushOptions)) return { errors: ["pushOptions must be an object"] };
  if (body.includeAlreadyPushed !== undefined && typeof body.includeAlreadyPushed !== "boolean") {
    return { errors: ["includeAlreadyPushed must be true or false"] };
  }

  const po = isObject(body.pushOptions) ? body.pushOptions : null;
  const push_options =
    po || body.includeAlreadyPushed !== undefined
      ? {
          includeAlreadyPushed: po ? po.includeAlreadyPushed === true : body.includeAlreadyPushed === true,
          onlyNewSinceLast: po?.onlyNewSinceLast === true,
          retryFailed: po?.retryFailed === true,
        }
      : null;

  const filters = !hasSelectedIds
    ? {
        ...buildRpcFilters(normalizeFilterState(body.filters)),
        ...(emailSide ? { emailSide } : {}),
        applyClientTargeting: tag,
      }
    : null;

  let ids: string[] | null = hasSelectedIds ? (selectedIds as string[]) : null;
  if (ids && emailSide) {
    ids = await idsOfSide(c, ids, emailSide);
    // As push-batch: an empty side must never fall through to the filters path.
    if (ids.length === 0) return { errors: [`No ${emailSide} leads in the selection`] };
  }

  return {
    selection: {
      filters,
      selected_ids: ids,
      range_from: (rangeFrom as number | undefined) ?? null,
      range_to: (rangeTo as number | undefined) ?? null,
      max_leads: (body.maxLeads as number | undefined) ?? null,
      client_tag: tag,
      email_side: (emailSide as "b2b" | "b2c" | undefined) ?? null,
      push_options,
    },
  };
}

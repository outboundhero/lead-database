import type { PoolClient } from "pg";
import { SERVICE_AREA, SERVICE_AREA_MAX, cleanServiceArea, serviceAreaFor } from "../../../scripts/lib/enrich/service-area.mjs";
import {
  cleanCountries,
  countryErrors,
  DEFAULT_PLACES,
  entriesOf,
  samePlaces,
  validateEntries,
  type LocationEntry,
  type Places,
} from "./targeting-validate";

// The server half of a client's places and service area (migration 139): the
// lock that keeps a hand edit of places from the onboarding-sheet sync, its
// log (client_targeting_log), the service area (client_variables, logged in
// client_variables_log), and what GET /api/clients/location shows. PUT
// /api/clients/targeting (the Rules dialog) and PUT /api/clients/location
// (the Clay tab) both save through here, under one per-client lock.

/** Where a service area comes from (serviceAreaFor in scripts/lib/enrich/service-area.mjs). */
export type ServiceAreaFrom = "variable" | "sheet" | "places" | "none";
/** Who wrote a client variable (client_variables.source). */
export type VariableSource = "manual" | "sheet" | "scraper";

/** What GET /api/clients/location answers, and PUT with what it saved. */
export interface LocationView {
  tag: string;
  /** False while the client has no client_targeting row (its places are then the defaults). */
  hasRules: boolean;
  countries: string[];
  includeLocations: LocationEntry[];
  excludeLocations: LocationEntry[];
  /** True after places were edited by hand: the onboarding-sheet sync leaves them alone. */
  locked: boolean;
  lockedAt: string | null;
  /** The email of who locked them, when known. */
  lockedBy: string | null;
  /** The onboarding sheet's places text as the sync last read it (read only), and when it synced. */
  sheet: { locations: string | null; syncedAt: string | null };
  serviceArea: {
    /** The client's own value (client_variables "service_area"), or null. */
    value: string | null;
    source: VariableSource | null;
    /** What the pipeline uses (serviceAreaFor): the own value, else the sheet's text, else a label of the places. */
    effective: string;
    /** Where `effective` comes from. */
    from: ServiceAreaFrom;
    /** What the pipeline would use with no own value: what "Use the sheet's text" leaves. */
    fallback: { value: string; from: ServiceAreaFrom };
    updatedAt: string | null;
  };
  /** client_targeting.updated_at and client_variables.updated_at: a save sends it back, a changed one is a 409. */
  version: string;
}

type TargetingRow = {
  client_tag: string;
  countries: string[] | null;
  include_locations: LocationEntry[] | null;
  exclude_locations: LocationEntry[] | null;
  sheet_raw: Record<string, unknown> | null;
  sheet_synced_at: Date | string | null;
  locations_locked: boolean;
  locations_locked_by: string | null;
  locations_locked_at: Date | string | null;
  version: string;
};
type VariableRow = { value: string; source: VariableSource; updated_at: Date | string; version: string };

const iso = (v: Date | string | null | undefined) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Is migration 139 in the database (the lock columns, client_targeting_log and client_variables)? */
export async function hasLocationTables(c: PoolClient): Promise<boolean> {
  const { rows } = await c.query<{ ok: boolean }>(
    `SELECT to_regclass('public.client_targeting_log') IS NOT NULL AND to_regclass('public.client_variables') IS NOT NULL AS ok`
  );
  return rows[0]?.ok === true;
}

/** The per-client lock both save routes take, to the end of the caller's transaction. */
export async function lockClientPlaces(c: PoolClient, tag: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('client-places:' || $1))`, [tag]);
}

/** The client's client_targeting row as the lock and the view read it, or null. Needs 139. */
export async function targetingRow(c: PoolClient, tag: string, { forUpdate = false } = {}): Promise<TargetingRow | null> {
  const { rows } = await c.query<TargetingRow>(
    `SELECT client_tag, countries, include_locations, exclude_locations, sheet_raw, sheet_synced_at,
            locations_locked, locations_locked_by, locations_locked_at, updated_at::text AS version
       FROM client_targeting WHERE client_tag = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [tag]
  );
  return rows[0] ?? null;
}

async function serviceAreaRow(c: PoolClient, tag: string, { forUpdate = false } = {}): Promise<VariableRow | null> {
  const { rows } = await c.query<VariableRow>(
    `SELECT value, source, updated_at, updated_at::text AS version
       FROM client_variables WHERE client_tag = $1 AND name = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tag, SERVICE_AREA]
  );
  return rows[0] ?? null;
}

/** A row's places, or the defaults for none. */
export const placesOf = (t: Pick<TargetingRow, "countries" | "include_locations" | "exclude_locations"> | null): Places =>
  t
    ? { countries: t.countries ?? [], include_locations: t.include_locations ?? [], exclude_locations: t.exclude_locations ?? [] }
    : { ...DEFAULT_PLACES, countries: [...DEFAULT_PLACES.countries] };

/** One row of client_targeting_log: places and countries only. */
export async function logPlaces(
  c: PoolClient,
  e: { tag: string; action: "save" | "lock" | "unlock"; before: Places | null; after: Places | null; userId: string | null }
): Promise<void> {
  await c.query(
    `INSERT INTO client_targeting_log (client_tag, action, before, after, by_user) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [e.tag, e.action, e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.userId]
  );
}

const versionOf = (t: TargetingRow | null, v: VariableRow | null) => `${t?.version ?? "-"}|${v?.version ?? "-"}`;

/** GET /api/clients/location's answer for one client. Needs 139. */
export async function locationView(c: PoolClient, tag: string): Promise<LocationView> {
  const t = await targetingRow(c, tag);
  const v = await serviceAreaRow(c, tag);
  let lockedBy: string | null = null;
  if (t?.locations_locked && t.locations_locked_by) {
    const { rows } = await c.query<{ email: string | null }>(`SELECT email FROM user_profiles WHERE id = $1`, [t.locations_locked_by]);
    lockedBy = rows[0]?.email ?? null;
  }
  const places = placesOf(t);
  const chosen = serviceAreaFor(t, v);
  const fallback = serviceAreaFor(t, null);
  const sheetLocations = t?.sheet_raw && typeof t.sheet_raw === "object" && typeof t.sheet_raw.locations === "string" ? t.sheet_raw.locations : null;
  return {
    tag,
    hasRules: Boolean(t),
    countries: places.countries,
    includeLocations: places.include_locations,
    excludeLocations: places.exclude_locations,
    locked: t?.locations_locked === true,
    lockedAt: t?.locations_locked ? iso(t.locations_locked_at) : null,
    lockedBy,
    sheet: { locations: sheetLocations, syncedAt: iso(t?.sheet_synced_at) },
    serviceArea: {
      value: v?.value ?? null,
      source: v?.source ?? null,
      effective: chosen.value,
      from: chosen.from as ServiceAreaFrom,
      fallback: { value: fallback.value, from: fallback.from as ServiceAreaFrom },
      updatedAt: iso(v?.updated_at),
    },
    version: versionOf(t, v),
  };
}

/** What a location save did, for the answer and the audit line. */
export interface LocationSaved {
  places: boolean;
  unlocked: boolean;
  serviceArea: "saved" | "removed" | null;
  /** Counts for the audit line: never a place or the text. */
  counts: { include: number; exclude: number; countries: number; serviceAreaLength: number };
}

export type LocationSaveResult =
  | { status: number; error: string; errors?: string[]; changed?: boolean }
  | { saved: LocationSaved; view: LocationView };

/**
 * PUT /api/clients/location: inside the route's transaction, under the
 * per-client lock. Places sent go through the Rules dialog's checks; changed
 * places lock (locations_locked, by, at) and are logged ('save'); unlock hands
 * them back to the sheet (logged 'unlock', and the stored sheet text of the
 * places is forgotten, so the next sync reads the sheet's places again); the
 * service area is saved or removed (client_variables, logged). A version that
 * differs from the stored one is a 409 with `changed`.
 */
export async function saveLocation(
  c: PoolClient,
  { tag, body, userId }: { tag: string; body: Record<string, unknown>; userId: string }
): Promise<LocationSaveResult> {
  await lockClientPlaces(c, tag);
  const { rows: [client] } = await c.query<{ tag: string }>(`SELECT tag FROM client_tags WHERE tag = $1`, [tag]);
  if (!client) return { status: 404, error: `${tag} is not a client` };
  const t = await targetingRow(c, tag, { forUpdate: true });
  const v = await serviceAreaRow(c, tag, { forUpdate: true });
  if (body.version !== versionOf(t, v)) {
    return { status: 409, error: "The places or the service area changed since this page loaded them: they were loaded again", changed: true };
  }

  const errors: string[] = [];
  const before = placesOf(t);
  const after: Places = { ...before };
  if ("countries" in body) {
    const list = cleanCountries(body.countries);
    if (!list) errors.push("countries must be a list");
    else {
      errors.push(...(await countryErrors(c, list)));
      after.countries = list;
    }
  }
  for (const [key, field, label] of [
    ["includeLocations", "include_locations", "include location"],
    ["excludeLocations", "exclude_locations", "exclude location"],
  ] as const) {
    if (!(key in body)) continue;
    const list = entriesOf(body[key]);
    if (!list) {
      errors.push(`${key} must be a list`);
      continue;
    }
    const checked = await validateEntries(c, list);
    errors.push(...checked.errors.map((e) => `${label}: ${e}`));
    after[field] = checked.entries;
  }
  let area: string | null | undefined;
  if ("serviceArea" in body) {
    const raw = body.serviceArea;
    if (raw === null) area = null;
    else if (typeof raw !== "string") errors.push("serviceArea must be text, or null to remove it");
    else {
      area = cleanServiceArea(raw) || null;
      if (area && area.length > SERVICE_AREA_MAX) errors.push(`The service area is ${area.length.toLocaleString("en-US")} characters: ${SERVICE_AREA_MAX.toLocaleString("en-US")} at most`);
    }
  }
  if ("unlock" in body && body.unlock !== true) errors.push("unlock can only be true");
  if (errors.length) return { status: 400, error: errors[0], errors };

  const placesChanged = !samePlaces(before, after);
  const unlock = body.unlock === true;
  if (unlock && placesChanged) {
    return { status: 400, error: "Save the changed places, or follow the sheet again: not both at once", errors: ["Save the changed places, or follow the sheet again: not both at once"] };
  }

  const saved: LocationSaved = {
    places: false,
    unlocked: false,
    serviceArea: null,
    counts: { include: after.include_locations.length, exclude: after.exclude_locations.length, countries: after.countries.length, serviceAreaLength: area ? area.length : 0 },
  };
  if (placesChanged) {
    if (t) {
      await c.query(
        `UPDATE client_targeting
            SET countries = $2::text[], include_locations = $3::jsonb, exclude_locations = $4::jsonb,
                locations_locked = true, locations_locked_by = $5, locations_locked_at = now(), updated_at = now()
          WHERE client_tag = $1`,
        [tag, after.countries, JSON.stringify(after.include_locations), JSON.stringify(after.exclude_locations), userId]
      );
    } else {
      // A first row, as the sheet sync makes one: cleaning clients exclude the commercial-cleaning titles by default.
      await c.query(
        `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, commercial_cleaning,
                                       locations_locked, locations_locked_by, locations_locked_at, updated_at)
         VALUES ($1, $2::text[], $3::jsonb, $4::jsonb,
                 coalesce((SELECT ct.client_type = 'Cleaning' FROM client_tags ct WHERE ct.tag = $1), false),
                 true, $5, now(), now())`,
        [tag, after.countries, JSON.stringify(after.include_locations), JSON.stringify(after.exclude_locations), userId]
      );
    }
    await logPlaces(c, { tag, action: "save", before: t ? before : null, after, userId });
    saved.places = true;
  } else if (unlock && t?.locations_locked) {
    // The sheet's places text is forgotten (sheet_raw minus locations), so the next sync sees it as changed and
    // reads the sheet's places again, even when the sheet has not changed since the lock.
    await c.query(
      `UPDATE client_targeting
          SET locations_locked = false, locations_locked_by = NULL, locations_locked_at = NULL,
              sheet_raw = CASE WHEN jsonb_typeof(sheet_raw) = 'object' THEN sheet_raw - 'locations' ELSE sheet_raw END, updated_at = now()
        WHERE client_tag = $1`,
      [tag]
    );
    await logPlaces(c, { tag, action: "unlock", before, after: before, userId });
    saved.unlocked = true;
  }

  if (area !== undefined) {
    if (area === null) {
      if (v) {
        await c.query(`DELETE FROM client_variables WHERE client_tag = $1 AND name = $2`, [tag, SERVICE_AREA]);
        await c.query(
          `INSERT INTO client_variables_log (client_tag, name, action, before_value, after_value, source, by_user)
           VALUES ($1, $2, 'delete', $3, NULL, $4, $5)`,
          [tag, SERVICE_AREA, v.value, v.source, userId]
        );
        saved.serviceArea = "removed";
      }
    } else if (!v || v.value !== area || v.source !== "manual") {
      await c.query(
        `INSERT INTO client_variables (client_tag, name, value, source, updated_by) VALUES ($1, $2, $3, 'manual', $4)
         ON CONFLICT (client_tag, name) DO UPDATE SET value = EXCLUDED.value, source = 'manual', updated_by = EXCLUDED.updated_by`,
        [tag, SERVICE_AREA, area, userId]
      );
      await c.query(
        `INSERT INTO client_variables_log (client_tag, name, action, before_value, after_value, source, by_user)
         VALUES ($1, $2, 'save', $3, $4, 'manual', $5)`,
        [tag, SERVICE_AREA, v?.value ?? null, area, userId]
      );
      saved.serviceArea = "saved";
    }
  }
  return { saved, view: await locationView(c, tag) };
}

/** The audit line of a location save: counts and lengths only, never a place or the text. */
export function locationAuditDetails(tag: string, s: LocationSaved): string | null {
  const parts: string[] = [];
  if (s.places) parts.push(`places saved and kept from the sheet sync (${s.counts.include} in, ${s.counts.exclude} out, ${s.counts.countries} countries)`);
  if (s.unlocked) parts.push("places follow the onboarding sheet again");
  if (s.serviceArea === "saved") parts.push(`service area saved (${s.counts.serviceAreaLength} characters)`);
  if (s.serviceArea === "removed") parts.push("service area removed (the sheet's text or the places apply)");
  return parts.length ? `${tag}: ${parts.join("; ")}` : null;
}

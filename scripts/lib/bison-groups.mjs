// Bison groups — one place for the group -> install-pair mapping, each install's
// fixed B2B/B2C side, and the parser for the tracker's "Groups" tab.
//
// Used by:
//   src/app/api/bison/push-batch/route.ts  — sides a push's campaigns from their installs
//   src/app/api/clients/sync-groups/route.ts, src/app/api/clients/sync-sheet/route.ts,
//   scripts/sync-clients-from-sheet.mjs    — read the Groups tab the same way
// Pure functions, tested by scripts/test-bison-groups.mts, and recordGroupsTab(),
// the one database step the three readers share (scripts/test-churn-dates.mjs).
//
// Churn dates (2026-11-20, migration 132): the parser also returns each listed
// client's Churn Date cell, and every good read records, for every client,
// whether the tab lists it and what its churn cell says. A client the tab does
// not list, or whose churn date is within 15 days, cannot receive shared leads
// or top-up pulls (fn_client_receive_block, 132).
//
// Why (2026-11-18): the Nov-15 clients (ATOH, JMBCS, CCGSOR, SG, LBJ, JATL) were
// never added to any group sheet, so every push for them was refused with "has no
// B2B/B2C mapping" although their campaigns were already on the group-1 installs.
// An install never changes side, so the installs a push names are enough to route it.

import { churnCellOf, groupsTabRecord, mergeChurnCells } from "./overlap-topup.mjs";

// Group -> instance pair. Bare domains (match bisonAuthFor / EMAILBISON_KEYS keys).
export const BISON_GROUPS = {
  1: { b2b: "app.outboundhero.co", b2c: "personal.cleaningoutbound.com" },
  2: { b2b: "app.facilityreach.com", b2c: "personal.outboundclean.com" },
};

/** The group and fixed side of one install (bare domain); null for an install in no group. */
export function installRole(domain) {
  for (const [group, pair] of Object.entries(BISON_GROUPS)) {
    if (pair.b2b === domain) return { group: Number(group), side: "b2b" };
    if (pair.b2c === domain) return { group: Number(group), side: "b2c" };
  }
  return null;
}

/** The one group all these installs belong to; null when any install is unknown or they span both groups. */
export function groupOfInstalls(domains) {
  let group = null;
  for (const d of domains) {
    const role = installRole(d);
    if (!role) return null;
    if (group !== null && group !== role.group) return null;
    group = role.group;
  }
  return group;
}

/**
 * A push across two installs must know every campaign's side (the worker refuses
 * to guess — a lead would otherwise attach in both workspaces). For campaigns the
 * client's saved installs did not side, take the install's own side, but only
 * when every install in the push belongs to ONE group: a business lead must never
 * be able to attach to B2B campaigns in both groups. Mutates `campaigns`.
 *   -> { group }            the group the push's installs belong to (save it on the client)
 *   -> { group: null }      the installs span both groups, or one is unknown: refuse
 */
export function sideCampaignsByInstall(campaigns) {
  const installs = [...new Set(campaigns.map((c) => c.instance_url))];
  const group = groupOfInstalls(installs);
  if (group === null) return { group: null, installs };
  for (const c of campaigns) {
    if (c.side !== "b2b" && c.side !== "b2c") c.side = installRole(c.instance_url).side;
  }
  return { group, installs };
}

// ── The tracker's "Groups" tab ──────────────────────────────────────────────
// A = group 1 tags | B = Status | C = Churn Date | D = Plan
// E = group 2 tags | F = Status | G = Churn Date | H = Plan
// Columns are found by header, never by position: reading A:B would turn the
// Status values ("Active", "Churned") into clients.
export const GROUPS_TAB_GID = 239723744;
export const ONBOARDING_SHEET_DEFAULT = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";

/** The range the readers read: both groups' tag, Status, Churn Date and Plan columns, with room to spare. */
export const groupsTabA1 = (title) => `'${String(title).replace(/'/g, "''")}'!A1:L400`;

/**
 * How the readers read this tab (only this one; every other tab keeps the
 * formatted read): raw values, so a date cell comes as a day number whatever
 * the sheet shows, and a text cell as its text. Cells may then be numbers or
 * booleans, so the parser turns them into text itself.
 *
 * @type {Readonly<{ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }>}
 */
export const GROUPS_TAB_RENDER = Object.freeze({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" });

export const cleanTag = (v) => String(v ?? "").trim().toUpperCase();
const NOT_A_TAG =
  /^(true|false|missing in group|owner|status|notes|active|churned|paused|plan|churn date|not found|healthy|confirmed churn|tier .*)$/i;
// Longer than 64 characters is a note, not a tag: no client tag is that long,
// and the churn record (132) refuses one.
export const isGroupsTabTag = (v) => !!v && v.length <= 64 && !NOT_A_TAG.test(v) && !/^b2[bc]\b/i.test(v);

/** A "Churn Date" header: any case, and a line break or run of spaces counts as one space. */
const isChurnHeader = (h) => h.replace(/\s+/g, " ").toLowerCase().includes("churn date");

/**
 * @typedef {import("./overlap-topup.mjs").ChurnCell} ChurnCell
 * @typedef {{ error: string, groups?: undefined, churn?: undefined, churnError?: undefined, duplicates?: undefined }
 *   | { error?: undefined, groups: Map<string, number>, churn: Map<string, ChurnCell> | null, churnError: string | null, duplicates: string[] }} GroupsTab
 */

/**
 * Rows of the Groups tab (header row first) -> what it lists, or { error }.
 *   groups      Map<tag, 1|2>. First occurrence wins; a tag in both columns of one row keeps group 1.
 *   churn       Map<tag, ChurnCell>, one entry for every tag in groups (churnCellOf,
 *               scripts/lib/overlap-topup.mjs). A group's cell is in the first column
 *               whose header says "Churn Date", right of the group's tag column and
 *               left of the next tag column (the last group: to the end). A tag listed
 *               twice gets mergeChurnCells() of its cells: an unreadable cell wins, then
 *               the earliest date. Null when a group has no such column; churnError then
 *               says why, and the readers record nothing that run (the last good read stands).
 *   duplicates  tags listed more than once, in the order they repeat.
 *
 * @param {unknown[][]} rows
 * @returns {GroupsTab}
 */
export function parseGroupsTab(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return { error: "The Groups tab returned no data rows." };
  const header = rows[0].map((h) => String(h ?? ""));
  const g1 = header.findIndex((h) => /b2b\s*#?\s*1/i.test(h));
  const g2 = header.findIndex((h) => /b2b\s*#?\s*2/i.test(h));
  if (g1 < 0 || g2 < 0) {
    return {
      error:
        "Could not find the group columns in the Groups tab. Expected headers containing " +
        `"B2B #1" and "B2B #2"; got: ${header.filter(Boolean).join(" | ")}`,
    };
  }
  const tagCols = [[g1, 1], [g2, 2]];
  const churnCols = tagCols.map(([col]) => {
    const end = Math.min(header.length, ...tagCols.map(([c]) => c).filter((c) => c > col));
    for (let i = col + 1; i < end; i++) if (isChurnHeader(header[i])) return i;
    return -1;
  });
  const noChurn = tagCols.filter((_, i) => churnCols[i] < 0).map(([, group]) => group);
  const churnError = noChurn.length
    ? `The Groups tab has no "Churn Date" column for group ${noChurn.join(" and ")} ` +
      "(it must sit between that group's tag column and the next one), so no churn date was read."
    : null;

  const groups = new Map();
  const churn = new Map();
  const seen = new Set();
  const duplicates = [];
  for (const row of rows.slice(1)) {
    tagCols.forEach(([col, group], i) => {
      const tag = cleanTag(row[col]);
      if (!isGroupsTabTag(tag)) return;
      if (!seen.has(tag)) seen.add(tag);
      else if (!duplicates.includes(tag)) duplicates.push(tag);
      if (!groups.has(tag)) groups.set(tag, group);
      if (!churnError) churn.set(tag, mergeChurnCells(churn.get(tag), churnCellOf(row[churnCols[i]])));
    });
  }
  if (groups.size === 0) return { error: "0 client tags parsed from the Groups tab." };
  return { groups, churn: churnError ? null : churn, churnError, duplicates };
}

/**
 * What a read's churn cells say, for the dry run, the sync answers and the
 * logs: the dates, the non-answers and the unreadable cells (tag and cell), the
 * number of blank cells, and the tags listed twice. `read` is false when the
 * tab was not read or has no churn column (`error` then says why, if it can).
 *
 * @param {GroupsTab | null | undefined} parsed
 */
export function churnReport(parsed) {
  /** @type {Array<{ tag: string, date: string, cell: string | null }>} */
  const dates = [];
  /** @type {Array<{ tag: string, cell: string | null }>} */
  const nonAnswers = [];
  /** @type {Array<{ tag: string, cell: string | null }>} */
  const unreadable = [];
  let blank = 0;
  for (const [tag, c] of parsed?.churn ?? []) {
    if (c.state === "date") dates.push({ tag, date: /** @type {string} */ (c.date), cell: c.cell });
    else if (c.state === "non_answer") nonAnswers.push({ tag, cell: c.cell });
    else if (c.state === "unreadable") unreadable.push({ tag, cell: c.cell });
    else blank++;
  }
  return {
    read: Boolean(parsed?.churn),
    error: parsed?.error ?? parsed?.churnError ?? null,
    dates,
    nonAnswers,
    unreadable,
    blank,
    duplicates: parsed?.duplicates ?? [],
  };
}

/** Active or Healthy, trimmed, any case: the statuses that may receive (fn_client_receive_block_of, 132). */
export const isActiveStatus = (status) => ["active", "healthy"].includes(String(status ?? "").replace(/^ +| +$/g, "").toLowerCase());

/**
 * Takes the lock the three readers share, so their write transactions never
 * cross (each rewrites every client_tags row once the tab is recorded). Call it
 * first in the transaction; it is held until the transaction ends.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<unknown> }} db  a client inside a transaction
 */
export async function lockClientTagsSync(db) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('client-tags-sync'))`);
}

/**
 * Records one good read of the Groups tab (fn_client_groups_tab_record,
 * migration 132): on_groups_tab for every client, and the churn cell of every
 * client the tab lists (cleared for one it does not). Call it inside the
 * transaction that writes the groups, after them, and only for a tab that was
 * read. It runs in a savepoint: in a database without 132, or when the
 * function refuses the read, the group writes stay as they are, nothing about
 * churn is written, and the warning says why. The last good read then stands.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db  a client inside a transaction
 * @param {GroupsTab | null | undefined} parsed  parseGroupsTab()'s answer
 * @returns {Promise<{ recorded: { listed: number, unlisted: number, not_in_roster: string[] } | null, warning: string | null }>}
 */
export async function recordGroupsTab(db, parsed) {
  if (!parsed?.groups) return { recorded: null, warning: "The Groups tab was not read, so no churn date was recorded; the last good read stands." };
  if (!parsed.churn) return { recorded: null, warning: `${parsed.churnError} The last good read stands.` };
  const { rows: [fn] } = await db.query(`SELECT to_regprocedure('public.fn_client_groups_tab_record(jsonb)') IS NOT NULL AS ok`);
  if (!fn?.ok) return { recorded: null, warning: "Churn dates were not recorded: migration 132 is not in this database." };
  await db.query("SAVEPOINT groups_tab_record");
  try {
    const { rows: [r] } = await db.query(`SELECT fn_client_groups_tab_record($1::jsonb) AS recorded`, [groupsTabRecord(parsed.churn)]);
    await db.query("RELEASE SAVEPOINT groups_tab_record");
    return { recorded: r.recorded, warning: null };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT groups_tab_record");
    await db.query("RELEASE SAVEPOINT groups_tab_record");
    const msg = e instanceof Error ? e.message : String(e);
    return { recorded: null, warning: `Churn dates were not recorded (${msg}); the last good read stands.` };
  }
}

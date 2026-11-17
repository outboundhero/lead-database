// Bison groups — one place for the group -> install-pair mapping, each install's
// fixed B2B/B2C side, and the parser for the tracker's "Groups" tab.
//
// Used by:
//   src/app/api/bison/push-batch/route.ts  — sides a push's campaigns from their installs
//   src/app/api/clients/sync-groups/route.ts, src/app/api/clients/sync-sheet/route.ts,
//   scripts/sync-clients-from-sheet.mjs    — read the Groups tab the same way
// Pure functions, tested by scripts/test-bison-groups.mts.
//
// Why (2026-11-18): the Nov-15 clients (ATOH, JMBCS, CCGSOR, SG, LBJ, JATL) were
// never added to any group sheet, so every push for them was refused with "has no
// B2B/B2C mapping" although their campaigns were already on the group-1 installs.
// An install never changes side, so the installs a push names are enough to route it.

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

export const cleanTag = (v) => String(v ?? "").trim().toUpperCase();
const NOT_A_TAG =
  /^(true|false|missing in group|owner|status|notes|active|churned|paused|plan|churn date|not found|healthy|confirmed churn|tier .*)$/i;
export const isGroupsTabTag = (v) => !!v && !NOT_A_TAG.test(v) && !/^b2[bc]\b/i.test(v);

/**
 * Rows of the Groups tab (header row first) -> { groups: Map<tag, 1|2> } or { error }.
 * First occurrence wins; a tag in both columns of one row keeps group 1.
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
  const groups = new Map();
  for (const row of rows.slice(1)) {
    for (const [col, group] of [[g1, 1], [g2, 2]]) {
      const tag = cleanTag(row[col]);
      if (isGroupsTabTag(tag) && !groups.has(tag)) groups.set(tag, group);
    }
  }
  if (groups.size === 0) return { error: "0 client tags parsed from the Groups tab." };
  return { groups };
}

/**
 * Job title aliases — when the user filters by a canonical title (e.g. "CEO"),
 * the filter also matches all variants listed below (case-insensitively).
 *
 * The data has thousands of distinct title strings. This catches the most common
 * variants users actually filter for. Add to this list as you find more.
 *
 * Lookup key is lowercased, normalized canonical title.
 * Values are lowercased variant strings as they appear in lead_job_titles.title.
 */
export const TITLE_ALIASES: Record<string, string[]> = {
  ceo: [
    "ceo",
    "c.e.o.",
    "c.e.o",
    "chief executive officer",
    "chief executive",
    "founder & ceo",
    "founder and ceo",
    "ceo & founder",
    "ceo and founder",
    "co-founder & ceo",
    "co-founder and ceo",
    "cofounder & ceo",
    "ceo / founder",
    "founder/ceo",
  ],
  owner: [
    "owner",
    "business owner",
    "owner/operator",
    "owner / operator",
    "sole proprietor",
    "proprietor",
    "owner & founder",
    "owner and founder",
    "owner-operator",
    "owner / president",
  ],
  president: [
    "president",
    "co-president",
    "vice president",
    "founder & president",
    "president & ceo",
    "president and ceo",
    "president/ceo",
  ],
  founder: [
    "founder",
    "co-founder",
    "cofounder",
    "co founder",
    "founding partner",
    "founder & president",
    "founder/owner",
  ],
  coo: [
    "coo",
    "c.o.o.",
    "c.o.o",
    "chief operating officer",
    "chief operations officer",
  ],
  cfo: [
    "cfo",
    "c.f.o.",
    "c.f.o",
    "chief financial officer",
    "vp finance",
    "vp of finance",
  ],
  cto: [
    "cto",
    "c.t.o.",
    "c.t.o",
    "chief technology officer",
    "chief technical officer",
  ],
  cmo: [
    "cmo",
    "c.m.o.",
    "chief marketing officer",
    "vp marketing",
    "vp of marketing",
  ],
  cio: [
    "cio",
    "c.i.o.",
    "chief information officer",
  ],
  vp: [
    "vp",
    "v.p.",
    "vice president",
    "vice-president",
  ],
  director: [
    "director",
    "dir",
    "managing director",
    "executive director",
  ],
  manager: [
    "manager",
    "mgr",
    "general manager",
    "operations manager",
  ],
};

/**
 * Given the user's selected title strings, return the expanded list including
 * all aliases. Inputs that don't match a canonical key are passed through
 * unchanged (so custom titles still work).
 *
 * Example: ["CEO", "Engineering Manager"] →
 *   ["ceo", "c.e.o.", "chief executive officer", ..., "engineering manager"]
 */
export function expandTitleAliases(titles: string[]): string[] {
  const out = new Set<string>();
  for (const raw of titles) {
    const key = raw.trim().toLowerCase();
    const aliases = TITLE_ALIASES[key];
    if (aliases) {
      for (const a of aliases) out.add(a);
    } else {
      out.add(key);
    }
  }
  return Array.from(out);
}

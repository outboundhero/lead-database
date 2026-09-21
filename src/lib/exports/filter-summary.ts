// One-line description of the filters an export ran with, for the Export
// history table. Lives outside the page component so it can be checked against
// real stored payloads — scripts/test-export-summary.mts.
//
// The shapes here are FilterState's, as stored in export_jobs.filters_used:
// location.city/state/country are {include, exclude, …} objects, not strings.
// Reading city as a string printed a literal "City: [object Object]" on every
// row from the day the column shipped until 2026-09-21.

export function formatFilterSummary(filtersUsed: Record<string, unknown> | null): string {
  if (!filtersUsed) return "—";
  const parts: string[] = [];
  if (filtersUsed.fullName) parts.push(`Name: "${filtersUsed.fullName}"`);
  if (filtersUsed.companyName) parts.push(`Company: "${filtersUsed.companyName}"`);
  const keyword = filtersUsed.keyword as { include?: string[]; exclude?: string[] } | string | undefined;
  if (typeof keyword === "string" && keyword) {
    parts.push(`Keyword: "${keyword}"`);
  } else if (keyword && typeof keyword === "object") {
    if (keyword.include?.length) parts.push(`Keyword: ${keyword.include.join(", ")}`);
    if (keyword.exclude?.length) parts.push(`Excl: ${keyword.exclude.join(", ")}`);
  }
  const source = filtersUsed.source as { include?: string[] } | undefined;
  if (source?.include?.length) parts.push(`Source: ${source.include.join(", ")}`);
  const seniority = filtersUsed.seniority as { include?: string[] } | undefined;
  if (seniority?.include?.length) parts.push(`Seniority: ${seniority.include.join(", ")}`);
  const industry = filtersUsed.generalIndustry as { include?: string[] } | undefined;
  if (industry?.include?.length) parts.push(`Industry: ${industry.include.join(", ")}`);
  // location.city/state/country are {include,exclude,…} objects, NOT strings —
  // reading them as strings rendered a literal "City: [object Object]" on every
  // row, hiding what the export actually ran with (2026-09-21).
  const inc = (v: unknown): string[] => {
    const list = (v as { include?: unknown[] } | undefined)?.include;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && !!x) : [];
  };
  const short = (list: string[]) =>
    list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3} more` : list.join(", ");
  const location = filtersUsed.location as { city?: unknown; state?: unknown; country?: unknown } | undefined;
  for (const [label, v] of [["City", location?.city], ["State", location?.state], ["Country", location?.country]] as const) {
    const values = inc(v);
    if (values.length) parts.push(`${label}: ${short(values)}`);
  }
  // A client-tagged export whose targeting never got applied scans the whole
  // database and exports out-of-territory leads — say so here rather than
  // leaving it to be reconstructed from the stored payload.
  const clientTag = filtersUsed.clientTag;
  if (typeof clientTag === "string" && clientTag) {
    const targeted = (filtersUsed.locationTargets as { include?: unknown[] } | undefined)?.include;
    const n = Array.isArray(targeted) ? targeted.length : 0;
    parts.push(`Client: ${clientTag} ${n ? `(${n} targeted locations)` : "(no location targeting)"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "All leads";
}

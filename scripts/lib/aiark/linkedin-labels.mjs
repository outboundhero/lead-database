// What the LinkedIn sources are called wherever they are written or shown
// (migration 128). A module of its own so the row checks, the templates and
// the projections can name them without loading the request builders;
// linkedin-requests.mjs exports the same object.

export const LINKEDIN_LABELS = Object.freeze({
  source: "LinkedIn",
  companyPull: "LinkedIn company pull (AI Ark)", // enrich_sources.label of the rows a LinkedIn pull bought
  peopleRun: "LinkedIn people run (AI Ark)", // enrich_sources.label of the People rows a LinkedIn run bought
  companyRows: "LinkedIn companies (AI Ark)", // the company row's source input, a LinkedIn pull's rows (design 2C.1)
  companyRowsCopied: "LinkedIn companies (AI Ark): copied from an earlier pull (no charge)", // a LinkedIn pull's rows copied from the registry
  personCompanies: "LinkedIn people (AI Ark)", // the source of a LinkedIn person's company brought in (design 2C.2)
  projection: "LinkedIn (AI Ark)", // enrich_companies.source of a LinkedIn row
});

/** Does a row's source input name a LinkedIn source? */
export const isLinkedinSource = (source) => typeof source === "string" && source.startsWith(LINKEDIN_LABELS.source);

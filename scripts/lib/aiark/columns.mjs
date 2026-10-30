// The columns of an AI Ark run's Clay-tab table. Every run gets the same set:
// what AI Ark returned for the person (inputs), then the steps that work out
// the person's outcome — the checks the lead database applies to anyone it
// sends to, run here before anyone is added.
//
// Shared by the run route (which creates the table) and the worker (which
// fills it). Plain JavaScript so both Node and Next.js can import it.

const USABLE = `({{email_verdict}} === "Valid" || {{email_verdict}} === "Catch-all")`;

/** @type {Array<Record<string, unknown>>} */
const COLUMNS = [
  // ── What AI Ark returned ──────────────────────────────────────────────────
  { key: "full_name", name: "Name", kind: "input", description: "The person's name on their AI Ark profile." },
  { key: "title", name: "Job title", kind: "input", description: "Current job title." },
  { key: "seniority", name: "Seniority", kind: "input" },
  { key: "department", name: "Department", kind: "input" },
  { key: "company", name: "Company", kind: "input" },
  { key: "domain", name: "Company domain", kind: "input", data_type: "url" },
  { key: "company_industry", name: "Industry", kind: "input", description: "AI Ark's industry for the company." },
  { key: "company_size", name: "Employees", kind: "input", description: "AI Ark's headcount figure or band for the company." },
  { key: "city", name: "City", kind: "input", description: "Where the person is, as AI Ark has it." },
  { key: "state", name: "State", kind: "input" },
  { key: "country", name: "Country", kind: "input" },
  { key: "email", name: "Email (AI Ark)", kind: "input", description: "The address AI Ark found when the person was exported. Empty when it found none." },
  {
    key: "email_status", name: "Email check", kind: "input",
    description: "AI Ark's own check of the address at export time: VALID or INVALID (with the reason when it gave one).",
  },
  {
    key: "email_domain_type", name: "Mailbox type", kind: "input",
    description: "SMTP: a normal mailbox. CATCH_ALL: the domain accepts every address, so this one cannot be proved. UNKNOWN: AI Ark could not tell.",
  },
  { key: "email_provider", name: "Mail provider", kind: "input", description: "The provider behind the domain's MX record, as AI Ark reports it." },
  { key: "linkedin", name: "LinkedIn", kind: "input", data_type: "url" },
  { key: "company_linkedin", name: "Company LinkedIn", kind: "input", data_type: "url", hidden: true },
  { key: "company_description", name: "Company description", kind: "input", hidden: true },
  { key: "aiark_id", name: "AI Ark id", kind: "input", description: "AI Ark's id for the person. A person is bought once: later runs exclude every id already bought." },
  {
    key: "pulled_before", name: "Bought before", kind: "input",
    description: "Filled when an earlier run had already bought this person (it can happen past AI Ark's list limits). The person is not bought or added twice.",
  },

  // ── Steps ─────────────────────────────────────────────────────────────────
  {
    key: "email_verdict", name: "Email verdict", kind: "formula",
    formula: `!{{email}} ? "Not found" : {{email_status}} !== "VALID" ? "Invalid" : {{email_domain_type}} === "CATCH_ALL" ? "Catch-all" : "Valid"`,
    description: "Only addresses AI Ark marked VALID are used. A catch-all domain's address is kept as catch-all, the way the lead database already treats them.",
  },
  {
    key: "in_database", name: "Lead database", kind: "action", action: "lead_lookup", data_type: "json",
    inputs: { email: "{{email}}" }, run_if: USABLE, provider: "Lead database",
    description: "Looks the address up in the lead database and on the never-contact list (which survives a lead being deleted). Bounced means a real, hard bounce.",
  },
  {
    key: "in_area", name: "Inside the client's area", kind: "action", action: "client_area", data_type: "boolean",
    inputs: { city: "{{city}}", state: "{{state}}", country: "{{country}}" }, provider: "Client rules",
    description: "Re-checks the person's city and state against the client's locations. AI Ark matches place names loosely (a bare city name matches in any state), so this catches people from a same-named city elsewhere.",
  },
  {
    key: "rule_match", name: "Client exclusions", kind: "action", action: "client_exclusions",
    inputs: { company: "{{company}}", industry: "{{company_industry}}", description: "{{company_description}}", title: "{{title}}" },
    provider: "Client rules",
    description: "Re-checks the company against the client's exclusion terms the way the lead database does (the term anywhere in the text), which is stricter than AI Ark's whole-word match. For cleaning clients the job title is also checked against the cleaning title exclusions.",
  },
  {
    key: "outcome", name: "Outcome", kind: "formula",
    formula:
      `!${USABLE} ? "No email"` +
      ` : {{pulled_before}} ? "Bought in an earlier run"` +
      ` : {{in_database}}?.never_contact ? "On the never-contact list"` +
      ` : {{in_database}}?.bounced ? "Bounced"` +
      ` : {{in_database}}?.lead_id ? "Already in the database"` +
      ` : {{in_area}} === false ? "Outside the client's area"` +
      ` : {{rule_match}} ? "Excluded by the client's rules"` +
      ` : "Ready to add"`,
    description: "Ready to add: a valid email, not already in the database or on the never-contact list, inside the client's area and clear of its exclusions. Those people join the lead database in Phase 4.",
  },

  // ── Later phases: shown so the whole flow can be seen, not run yet ───────
  {
    key: "find_email", name: "Find email", kind: "action", action: "later", phase: 3, provider: "Email finders",
    run_if: `!${USABLE}`,
    description: "People AI Ark returns without a valid email go through the email-finding steps (Findymail, Prospeo, Anymail Finder) and the checks after them. Built in Phase 3.",
  },
  {
    key: "add_to_database", name: "Add to the database", kind: "action", action: "later", phase: 4, provider: "Lead database",
    run_if: `{{outcome}} === "Ready to add"`,
    description: "People marked Ready to add join the lead database with source AI Ark, and then go out from the Leads tab like any other lead. Built in Phase 4.",
  },
];

/** enrich_columns rows for a new run table, positions in order. */
export const RUN_COLUMNS = COLUMNS.map((c, i) => ({
  key: c.key,
  name: c.name,
  position: i + 1,
  kind: c.kind,
  action: c.action ?? null,
  formula: c.formula ?? null,
  waterfall: null,
  inputs: c.inputs ?? {},
  config: {},
  run_if: c.run_if ?? null,
  data_type: c.data_type ?? "text",
  description: c.description ?? null,
  provider: c.provider ?? (c.kind === "input" ? "AI Ark" : c.kind === "formula" ? "Formula" : null),
  needs_env: [],
  phase: c.phase ?? 1,
  hidden: c.hidden ?? false,
}));

/** The input keys a run writes for each person. */
export const RUN_INPUT_KEYS = RUN_COLUMNS.filter((c) => c.kind === "input").map((c) => c.key);

/** Text a person row is found by in the Clay tab's search box. */
export const PERSON_SEARCH_KEYS = ["full_name", "title", "company", "domain", "email", "city", "state"];

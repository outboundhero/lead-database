// The keys a company's fit score lives under (2B.2, migration 126).
//
// One score per company, shared by every client, under its canonical key:
//   domain  the company's bare domain, when it stands for one company: valid,
//           never a free-mail domain (freemail_domains) and never a platform,
//           directory or placeholder domain (fit_domain_exclusions);
//   name    lower(company)|lower(city)|UPPER(state code), when there is a
//           company and a state code.
// The domain key wins: the email's own domain when it stands for a company,
// else the website's. Every other key a company's leads may show is an alias
// (company_fit_keys), so the gate finds the score by the lead's email domain,
// its website's domain or its name key.
//
// The SQL functions of migration 126 (fn_bare_domain, fn_fit_domain_ok,
// fn_fit_domain_key, fn_fit_name_key) are what the gate, the scorer and the
// push check run; the functions here give the same answers in JavaScript, for
// the tests and for code that holds a company's fields already.
//
// fit_lookup is the Clay section's view of a score (the companies_v2 hooks
// fit_score and home_office): free, never cached, it shows the shared score
// on the row. Registered in ACTIONS at integration (actions.mjs).

import { bareDomain } from "./domain.mjs";

export const FIT_KEY_KINDS = Object.freeze(["domain", "name"]);

/** Postgres btrim(): spaces only. */
const btrim = (v) => String(v ?? "").replace(/^ +| +$/g, "");

/**
 * fn_fit_name_key: "company|city|ST", lower case but the state code, or null
 * without a company or a state code.
 *
 * @param {unknown} company
 * @param {unknown} city
 * @param {unknown} stateCode
 * @returns {string | null}
 */
export function fitNameKey(company, city, stateCode) {
  const c = btrim(company);
  const s = btrim(stateCode);
  if (!c || !s) return null;
  return `${c.toLowerCase()}|${btrim(city).toLowerCase()}|${s.toUpperCase()}`;
}

/**
 * @typedef {{ freemail: Set<string>, excluded: Set<string> }} FitExclusions
 *   the domains that are never a company key: freemail_domains and fit_domain_exclusions
 */

/**
 * fn_fit_domain_ok: the bare domain when it may stand for one company, else null.
 *
 * @param {unknown} domain  a domain, website or URL
 * @param {FitExclusions} exclusions
 * @returns {string | null}
 */
export function fitDomainOk(domain, exclusions) {
  const d = bareDomain(domain);
  if (!d) return null;
  if (exclusions?.freemail?.has(d) || exclusions?.excluded?.has(d)) return null;
  return d;
}

/** The part of an address after its first "@", as split_part(email, '@', 2) gives it. */
function emailDomainPart(email) {
  const s = String(email ?? "");
  const at = s.indexOf("@");
  if (at < 0) return "";
  const rest = s.slice(at + 1);
  const next = rest.indexOf("@");
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * fn_fit_domain_key: the email's domain when it stands for a company, else the website's, else null.
 *
 * @param {unknown} email
 * @param {unknown} website
 * @param {FitExclusions} exclusions
 * @returns {string | null}
 */
export function fitDomainKey(email, website, exclusions) {
  return fitDomainOk(emailDomainPart(email), exclusions) ?? fitDomainOk(website, exclusions);
}

/**
 * @typedef {{ key_kind: "domain" | "name", key: string }} FitKey
 */

/**
 * A company's canonical key and its aliases, from what a lead or a pipeline
 * company shows: the domain key when there is one (the email's domain, else
 * the website's), else the name key. Every other key it shows (the other
 * domain, the name key) is an alias. Null when it shows no key at all.
 *
 * @param {{ email?: unknown, website?: unknown, company?: unknown, city?: unknown, stateCode?: unknown }} fields
 * @param {FitExclusions} exclusions
 * @returns {(FitKey & { aliases: FitKey[] }) | null}
 */
export function companyFitKey({ email, website, company, city, stateCode }, exclusions) {
  const keys = [
    { key_kind: "domain", key: fitDomainOk(emailDomainPart(email), exclusions) },
    { key_kind: "domain", key: fitDomainOk(website, exclusions) },
    { key_kind: "name", key: fitNameKey(company, city, stateCode) },
  ].filter((k) => k.key);
  if (!keys.length) return null;
  const [first, ...rest] = keys;
  const seen = new Set([`${first.key_kind}:${first.key}`]);
  const aliases = [];
  for (const k of rest) {
    const id = `${k.key_kind}:${k.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    aliases.push(/** @type {FitKey} */ ({ key_kind: k.key_kind, key: k.key }));
  }
  return { key_kind: /** @type {"domain" | "name"} */ (first.key_kind), key: /** @type {string} */ (first.key), aliases };
}

/**
 * The two lists a domain key may never come from, read once.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @returns {Promise<FitExclusions>}
 */
export async function loadFitExclusions(db) {
  const { rows: fm } = await db.query(`SELECT lower(domain) AS d FROM freemail_domains`);
  const { rows: ex } = await db.query(`SELECT domain AS d FROM fit_domain_exclusions`);
  return { freemail: new Set(fm.map((r) => r.d)), excluded: new Set(ex.map((r) => r.d)) };
}

/**
 * The SQL that gives a lead's keys, on a leads alias (default l): the domain
 * of its email and of its website when each may be a key, and its name key.
 * The scoring run, the push check and the scoring of a waiting push read
 * these; the canonical key is coalesce(email_key, website_key, name_key),
 * domain kind unless only the name key is there.
 *
 * @param {string} [alias]
 * @returns {{ email_key: string, website_key: string, name_key: string }}
 */
export function leadFitKeySql(alias = "l") {
  const a = /^[a-z_][a-z0-9_]*$/.test(alias) ? alias : "l";
  return {
    email_key: `public.fn_fit_domain_ok(nullif(split_part(coalesce(${a}.email, ''), '@', 2), ''))`,
    website_key: `public.fn_fit_domain_ok(${a}.domain)`,
    name_key: `public.fn_fit_name_key(${a}.company, ${a}.city, ${a}.state_code)`,
  };
}

/**
 * Keys as the queries above return them (email_key, website_key, name_key)
 * turned into the canonical key and its aliases, as companyFitKey does.
 *
 * @param {{ email_key?: string | null, website_key?: string | null, name_key?: string | null }} r
 * @returns {(FitKey & { aliases: FitKey[] }) | null}
 */
export function keysFromRow(r) {
  const keys = [
    { key_kind: "domain", key: r?.email_key ?? null },
    { key_kind: "domain", key: r?.website_key ?? null },
    { key_kind: "name", key: r?.name_key ?? null },
  ].filter((k) => typeof k.key === "string" && k.key);
  if (!keys.length) return null;
  const [first, ...rest] = keys;
  const seen = new Set([`${first.key_kind}:${first.key}`]);
  const aliases = [];
  for (const k of rest) {
    const id = `${k.key_kind}:${k.key}`;
    if (!seen.has(id)) {
      seen.add(id);
      aliases.push(/** @type {FitKey} */ ({ key_kind: k.key_kind, key: k.key }));
    }
  }
  return { key_kind: /** @type {"domain" | "name"} */ (first.key_kind), key: /** @type {string} */ (first.key), aliases };
}

/**
 * Points keys at a scored company, as aliases (2B.2). $1 is a JSON list of
 * { key_kind, key, fit_kind, fit_key }. Rules:
 *   - the target must be scored (a company_fit row);
 *   - a key that is some company's own canonical key is never moved: its own
 *     key always points at itself (trg_company_fit_keys_sync);
 *   - a key already held by a manual score is kept, unless the new target is a
 *     manual score too; otherwise the newest score takes it;
 *   - blocked is copied from the target, so the gate follows it at once.
 * Returns how many keys were added or moved.
 */
export const ALIAS_UPSERT_SQL = `
  WITH x AS (
    SELECT DISTINCT ON (a.key_kind, a.key) a.key_kind, a.key, a.fit_kind, a.fit_key
      FROM jsonb_to_recordset($1::jsonb) AS a(key_kind text, key text, fit_kind text, fit_key text)
     WHERE a.key_kind IN ('domain', 'name') AND coalesce(a.key, '') <> ''
       AND NOT (a.key_kind = a.fit_kind AND a.key = a.fit_key)
  ),
  t AS (
    SELECT x.key_kind, x.key, f.key_kind AS fit_kind, f.key AS fit_key, f.blocked, f.status = 'manual' AS manual
      FROM x JOIN company_fit f ON f.key_kind = x.fit_kind AND f.key = x.fit_key
     WHERE NOT EXISTS (SELECT 1 FROM company_fit own WHERE own.key_kind = x.key_kind AND own.key = x.key)
  ),
  up AS (
    INSERT INTO company_fit_keys AS k (key_kind, key, fit_kind, fit_key, blocked)
    SELECT t.key_kind, t.key, t.fit_kind, t.fit_key, t.blocked FROM t
    ON CONFLICT (key_kind, key) DO UPDATE
      SET fit_kind = EXCLUDED.fit_kind, fit_key = EXCLUDED.fit_key, blocked = EXCLUDED.blocked, added_at = now()
      WHERE (k.fit_kind, k.fit_key) IS DISTINCT FROM (EXCLUDED.fit_kind, EXCLUDED.fit_key)
        AND NOT EXISTS (SELECT 1 FROM company_fit own WHERE own.key_kind = k.key_kind AND own.key = k.key)
        AND (NOT EXISTS (SELECT 1 FROM company_fit held WHERE held.key_kind = k.fit_kind AND held.key = k.fit_key
                                                     AND held.status = 'manual')
             OR EXISTS (SELECT 1 FROM company_fit mine WHERE mine.key_kind = EXCLUDED.fit_kind AND mine.key = EXCLUDED.fit_key
                                                     AND mine.status = 'manual'))
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM up`;

/**
 * Points the given keys at a scored company (ALIAS_UPSERT_SQL).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {Array<FitKey & { fit_kind: string, fit_key: string }>} aliases
 * @returns {Promise<number>}
 */
export async function addAliases(db, aliases) {
  const list = (aliases ?? []).filter((a) => a && a.key && a.fit_key);
  if (!list.length) return 0;
  const { rows } = await db.query(ALIAS_UPSERT_SQL, [JSON.stringify(list)]);
  return rows[0]?.n ?? 0;
}

/**
 * Copies scores onto the pipeline's company rows (enrich_companies) whose fit
 * key leads to one of the given canonical scores, so the Companies tab shows
 * the score, the home-office flag and the reason. $1: JSON [{ key_kind, key }].
 */
export const COPY_TO_COMPANIES_SQL = `
  UPDATE enrich_companies e
     SET fit_score = f.score, home_office = f.home_office, fit_reason = f.reason, fit_scored_at = f.scored_at,
         updated_at = now()
    FROM company_fit_keys k
    JOIN company_fit f ON f.key_kind = k.fit_kind AND f.key = k.fit_key
   WHERE e.fit_key_kind = k.key_kind AND e.fit_key = k.key
     AND (k.fit_kind, k.fit_key) IN (SELECT x.key_kind, x.key FROM jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text))
     AND (e.fit_score, e.home_office, e.fit_reason, e.fit_scored_at)
         IS DISTINCT FROM (f.score, f.home_office, f.reason, f.scored_at)`;

// ── fit_lookup: the shared score, shown on a Companies row ──────────────────

/**
 * @typedef {{ score: number | null, home_office: boolean | null, reason: string | null, status: string,
 *             blocked: boolean, model: string | null, rule_version: string | null, scored_at: string,
 *             key_kind: string, key: string }} FitLookupValue
 *   the value of a fit_lookup cell; empty (no value) while the company is not scored
 */

const text = (v) => (v == null ? "" : String(v).trim());

/**
 * fit_lookup: the company's shared score, by its domain key, else its name key.
 * Inputs (compiled at integration): domain ({{use_domain}}), company, city
 * ({{use_city}}), state ({{use_state}}, a code). config.show: "score" (the
 * fit_score column) or "home_office". Free, never cached: a score given later
 * shows the next time the row is worked.
 */
async function fitLookup({ inputs, config, db }) {
  const { rows } = await db.query(
    `WITH q AS (SELECT public.fn_fit_domain_ok($1) AS d, public.fn_fit_name_key($2, $3, $4) AS n)
     SELECT f.score, f.home_office, f.reason, f.status, k.blocked, f.model, f.rule_version, f.scored_at,
            f.key_kind, f.key
       FROM q
       JOIN company_fit_keys k ON (k.key_kind = 'domain' AND k.key = q.d) OR (k.key_kind = 'name' AND k.key = q.n)
       JOIN company_fit f ON f.key_kind = k.fit_kind AND f.key = k.fit_key
      ORDER BY (k.key_kind = 'domain') DESC
      LIMIT 1`,
    [text(inputs?.domain) || null, text(inputs?.company) || null, text(inputs?.city) || null, text(inputs?.state) || null]
  );
  const f = rows[0];
  if (!f) return { status: "empty", note: "Not scored yet: the score appears once the fit scorer has scored this company" };
  /** @type {FitLookupValue} */
  const value = {
    score: f.score == null ? null : Number(f.score),
    home_office: f.home_office ?? null,
    reason: f.reason ?? null,
    status: f.status,
    blocked: f.blocked === true,
    model: f.model ?? null,
    rule_version: f.rule_version ?? null,
    scored_at: f.scored_at instanceof Date ? f.scored_at.toISOString() : String(f.scored_at),
    key_kind: f.key_kind,
    key: f.key,
  };
  const showHome = config?.show === "home_office";
  const display = showHome
    ? value.home_office === true ? "Likely a home office" : value.home_office === false ? "No" : "Unknown"
    : value.status === "unscorable" ? "Could not be scored" : `${value.score} of 5`;
  const by = value.status === "manual" ? "set by hand" : `${value.model ?? "no model"}, rule ${value.rule_version ?? "unversioned"}`;
  return { status: "done", value, display, note: `${value.reason ?? "No reason given"} (${by}${value.blocked ? "; blocked by the gate" : ""})` };
}

/** The fit actions, registered beside the others in ACTIONS (actions.mjs) at integration. */
export const FIT_ACTIONS = Object.freeze({
  fit_lookup: Object.freeze({ run: fitLookup, cache: false }),
});

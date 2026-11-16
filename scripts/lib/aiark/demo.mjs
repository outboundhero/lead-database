// A stand-in for AI Ark that never leaves the machine, offered only when
// AIARK_DEMO=1. It answers the same endpoints, with the same shapes and the
// same errors, as the documented API (./client.mjs). A demo run shows the
// ordinary paths: Preview pages that cost a credit, exclusion lists, single
// exports that charge only when an email is found, async export jobs, 402 when
// the credits run out. It runs with latency only, so refunds, expired jobs,
// PROCESSING emails, 429s and 5xx answers come up only when a caller asks for
// them through the options below, which scripts/test-aiark.mjs does.
//
// The people are made up (./demo-people.mjs): every web address is under the
// reserved ".example" domain. The same filters always give the same people,
// so a demo run can be repeated, resumed and tested.
//
// Company Search (POST /v1/companies, the Companies tab's pulls) answers with
// made-up companies (./demo-companies.mjs): each place has its own, so two
// clients that share a place share companies. 0.1 credit per company returned,
// with X-Credit, company_id exclusion lists and the 10,000-record cap.
//
// People Preview by company id (contact.company.latest.any.include, the
// Companies tab's people runs) answers with made-up people at those companies
// (makeCompanyPerson in ./demo-people.mjs): the same company id always has the
// same people, with titles made from the request's title phrases, and Export
// Single then answers for them, with an email or without one. A company the
// stand-in has served from Company Search (or was given in `companies`) keeps
// its name, domain and office; any other id gets a made-up company of its own.
//
// Every Preview person's company object carries its offices (location:
// headquarter and locations), as AI Ark's does: the company's own for people
// by company id, the person's place otherwise. With `areaCompanies` an area
// search (LinkedIn people runs) puts its people at that many made-up companies
// of each place, the ones Company Search returns for the place, so a run meets
// several people at one company.
//
// State (lists, export jobs, the credit balance) lives in this process only.

import { createHash, randomUUID } from "node:crypto";
import { demoId, hash32, makeCompanyPerson, makePerson, peopleCountAt } from "./demo-people.mjs";
import { excludedByAccount, makeCompany } from "./demo-companies.mjs";

export const DEMO_TOKEN = "demo-key";
const PEOPLE_CACHE = 8;
const COMPANY_CACHE = 64;

/** JSON with sorted keys, so the same filters always hash the same. */
function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

const mask = (s) => (s.length <= 2 ? `${s[0] ?? ""}***` : `${s.slice(0, 2)}***${s.slice(-1)}`);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contentOf = (x) => (Array.isArray(x) ? x : Array.isArray(x?.content) ? x.content : []);

/** What a request body asks for, in the terms makePerson understands. */
function askOf(f) {
  const loc = contentOf(f.contact?.location?.any?.include).map(String);
  const places = loc.map((s) => {
    const i = s.lastIndexOf(",");
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ["Centerville", s.trim()];
  });
  const title = f.contact?.experience?.latest?.title ?? f.contact?.experience?.current?.title;
  return {
    placesRaw: loc,
    places,
    titles: contentOf(title?.any?.include).map(String),
    seniority: contentOf(f.contact?.seniority?.any?.include).map(String),
    departments: contentOf(f.contact?.departmentAndFunction?.any?.include).map(String),
    industries: contentOf(f.account?.industries?.any?.include).map(String),
    excludeIndustries: contentOf(f.account?.industries?.any?.exclude).map(String),
    excludeTerms: contentOf(f.account?.keyword?.any?.exclude).map(String),
  };
}

function staffOf(band) {
  const [a, b] = band.split("-").map(Number);
  return { total: Math.round((a + b) / 2), range: { start: a, end: b } };
}

/** A company's offices as AI Ark's people records carry them: its own, or (made-up companies) at the person's place. */
function officesFor(p) {
  if (p.companyLocation) return p.companyLocation;
  const hq = { continent: "North America", country: p.country, ...(p.state ? { state: p.state } : {}), city: p.city };
  return { headquarter: hq, locations: [hq] };
}

function previewItem(p, { description = true, company = true } = {}) {
  const short = p.state ? `${p.city}, ${p.state}` : p.city;
  return {
    id: p.id,
    profile: { first_name: p.first, last_name: mask(p.last), title: p.title, headline: `${p.title} at ${p.company}` },
    company: company ? {
      id: p.companyId ?? demoId(`co:${p.domain}`, 0),
      summary: { name: p.company, industry: p.industry, ...(description ? { description: p.description } : {}), staff: staffOf(p.staff) },
      location: officesFor(p),
    } : null,
    location: {
      country: p.country,
      ...(p.state ? { state: p.state } : {}),
      city: p.city,
      default: `${short}, ${p.country}, North America`,
      short,
    },
    department: { departments: [p.department], sub_departments: [], functions: [p.department], seniority: p.seniority },
  };
}

function fullPerson(p, { processing = false, company = true } = {}) {
  const base = previewItem(p, { company });
  const handle = `${slug(`${p.first} ${p.last}`)}-${p.id.slice(0, 4)}`;
  const email = processing
    ? { state: "PROCESSING", output: [] }
    : { state: "DONE", output: [{ ...p.email, date: "2026-10-30T12:00:00.000000" }] };
  return {
    ...base,
    identifier: handle,
    profile: { ...base.profile, last_name: p.last, full_name: `${p.first} ${p.last}` },
    link: { linkedin: `https://linkedin.example/in/${handle}`, twitter: null, github: null, facebook: null },
    company: base.company ? {
      ...base.company,
      link: {
        website: `https://${p.domain}`,
        domain: p.domain,
        linkedin: `https://linkedin.example/company/${slug(p.company)}`,
      },
    } : null,
    email,
    last_updated: "2026-10-01",
  };
}

/** The company ids a People search is scoped to (contact.company.latest/current, include). */
function companyIdsOf(f) {
  const co = f?.contact?.company ?? {};
  return [...new Set([...contentOf(co.latest?.any?.include), ...contentOf(co.current?.any?.include)].map(String))];
}

/** A company as a people search's people carry it, from a Company Search record. */
function companyFacts(record) {
  const s = record?.summary ?? {};
  const hq = record?.location?.headquarter ?? {};
  const link = record?.link ?? {};
  // The company's own domain only: a website on a platform (a Facebook page) is not one.
  const domain = String(link.domain ?? "")
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const staff = s.staff?.range ? `${s.staff.range.start}-${s.staff.range.end}` : "11-50";
  return {
    id: String(record.id),
    name: String(s.name ?? "Made-up Company"),
    domain: domain || `${slug(String(s.name ?? "company"))}.example`,
    industry: String(s.industry ?? "business services"),
    description: String(s.description ?? "A made-up business generated for an AI Ark demo."),
    staff,
    city: String(hq.city ?? "Springfield").replace(/,.*$/, ""),
    state: hq.state ? String(hq.state) : "Illinois",
    country: hq.country ? String(hq.country) : "United States",
    location: record?.location && typeof record.location === "object" ? record.location : null,
  };
}

/** A company the stand-in has never seen: made up from its id alone. */
function madeUpCompany(id) {
  const r = hash32(`coid|${id}`);
  const names = ["Northgate", "Bluestone", "Summit", "Harborview", "Cedar Ridge", "Ironwood", "Lakeshore", "Silver Oak"];
  const kinds = [["Dental Group", "dental"], ["Property Management", "property management"], ["Law Offices", "law practice"], ["Logistics", "truck transportation"]];
  const [kind, industry] = kinds[(r >>> 5) % kinds.length];
  const name = `${names[r % names.length]} ${kind}`;
  return {
    id,
    name,
    domain: `${slug(name)}-${String(id).slice(0, 6)}.example`,
    industry,
    description: `${name} is a made-up business generated for an AI Ark demo run.`,
    staff: "11-50",
    city: "Springfield",
    state: "Illinois",
    country: "United States",
  };
}

/** A person AI Ark would leave out under the request's exclusions (whole-word, as WORD mode does). */
function excludedByFilters(p, ask) {
  const word = (t, s) => new RegExp(`(^|[^a-z0-9])${escapeRx(t.toLowerCase())}($|[^a-z0-9])`, "i").test(s);
  if (ask.excludeTerms.some((t) => word(t, p.company) || word(t, p.industry) || word(t, p.description))) return true;
  if (ask.excludeIndustries.some((t) => t.toLowerCase() === p.industry)) return true;
  return false;
}

/**
 * The demo transport. Options:
 *   balance     credits on the demo account (the caller passes what is left)
 *   latencyMs   delay per answer, so a demo run moves at a believable pace
 *   jobMs       how long an export job takes to finish
 *   processingMs  after a job finishes, ~5% of its people still show their
 *                 email as PROCESSING for this long (tests the re-read path)
 *   faults      for tests:
 *                 rateEvery, serverEvery   every Nth call answers 429 / 500
 *                 refundJobOnce            the first look at a job finds it refunded
 *                 refundAtReadOnce         the first results read finds it refunded (after DONE)
 *                 expireJobOnce            the first results read answers 404, not refunded
 *                 expireRefundedOnce       the same 404, for a job AI Ark did refund
 *                 ignoreLists              exclusion lists leave nobody (and no company) out
 *               Company Search only:
 *                 companyAnswers           what the next Company Search calls answer, in order, before
 *                                          any normal answer: a status (402, 401, 400, 429, 500 …),
 *                                          0 for no answer at all (the transport throws), or
 *                                          { status, charge: true } to charge the page first and then
 *                                          lose its answer (a 5xx or 0)
 *                 searchCap                the most records one search pages through (10,000)
 *                 noCreditHeader           no X-Credit header on a charged page
 *                 badCreditHeader          an X-Credit header that is not a number
 *                 noContent                a 200 answer with no list of companies
 *               People Preview only:
 *                 previewAnswers           what the next Preview calls answer, in order, before any
 *                                          normal answer: a status (400 is AI Ark's "request size"
 *                                          refusal, 402, 401, 403, 404, 429, 500 …), 0 for no answer
 *                                          at all, { status, charge: true } to charge the page first,
 *                                          or { status: 400, message } for another refusal
 *                 previewWithoutDescription  Preview company objects carry no description (Export
 *                                          Single's still does)
 *                 noCompanyEvery           every Nth person (by id) has no company at all
 *   companiesPerPlace  a fixed number of companies per place (default 30 to 119, by place)
 *   companies   Company Search records the stand-in knows by id before any search (people runs'
 *               tests): their people carry the company's name, domain and office
 *   areaCompanies  an area search's people work at this many made-up companies of each place
 *               (makeCompany's, the ones Company Search returns for the place), with their offices;
 *               unset, each person's company is made up from their name and sits at their place
 */
export function createDemoTransport({ balance = 25_000, latencyMs = 0, jobMs = 4_000, processingMs = 0, faults = {}, companiesPerPlace = null, companies = [], areaCompanies = null } = {}) {
  const lists = new Map(); // list id -> Set of person or company ids
  const jobs = new Map(); // trackId -> job
  const people = new Map(); // person id -> person, for single exports
  const cache = new Map(); // filter seed -> people[]
  const companyCache = new Map(); // place -> companies[]
  const companyIndex = new Map(); // company id -> the facts its people carry (served or given)
  for (const c of companies ?? []) if (c?.id) companyIndex.set(String(c.id), companyFacts(c));
  const state = { balance, calls: 0, charged: 0, listsMade: 0, companyCalls: 0, previewCalls: 0, refundedOnce: false, expiredOnce: false };
  /** A person AI Ark gives no company (faults.noCompanyEvery). */
  const noCompany = (p) => Boolean(faults.noCompanyEvery) && hash32(`noco|${p.id}`) % faults.noCompanyEvery === 0;
  const REFUNDED = "this request was automatically refunded because the results were not delivered within the time limit. you can submit it again.";

  const answer = (status, json, headers = {}) => ({
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: json === undefined ? "" : JSON.stringify(json),
  });
  const appError = (status, error, path = "") => answer(status, { timestamp: new Date().toISOString(), status, error, path });
  const charge = (n) => {
    if (state.balance < n) return false;
    state.balance = Math.round((state.balance - n) * 100) / 100;
    state.charged = Math.round((state.charged + n) * 100) / 100;
    return true;
  };
  const refund = (job) => {
    const back = job.people.length * 0.5 + job.found * 0.5;
    job.refunded = true;
    job.done = true;
    state.balance += back;
    state.charged = Math.round((state.charged - back) * 100) / 100;
  };

  /**
   * With areaCompanies, an area search's person works at one of that many
   * made-up companies of the place they were found for (makeCompany's, as
   * Company Search returns them there): its id, name, domain, industry,
   * description and offices.
   */
  function atAreaCompany(p, seed, i, ask) {
    if (!areaCompanies || !ask.placesRaw.length) return p;
    const r = hash32(`${seed}#${i}`);
    const place = ask.placesRaw[(r >>> 3) % ask.placesRaw.length];
    const c = makeCompany(place, hash32(`area|${seed}|${i}`) % areaCompanies);
    if (!companyIndex.has(c.id)) companyIndex.set(c.id, companyFacts(c));
    const domain = String(c.link?.domain ?? "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || `${slug(c.summary.name)}.example`;
    return {
      ...p, companyId: c.id, company: c.summary.name, domain, industry: c.summary.industry, description: c.summary.description,
      staff: `${c.summary.staff.range.start}-${c.summary.staff.range.end}`, companyLocation: c.location,
    };
  }

  /** The people at the companies a search names, in the companies' order: those its titles and keywords let through. */
  function companyPopulation(f, ids) {
    const ask = askOf(f);
    const title = f.contact?.experience?.latest?.title ?? f.contact?.experience?.current?.title;
    const exclude = contentOf(title?.any?.exclude).map(String);
    const keywords = contentOf(f.contact?.keyword?.any?.exclude).map(String);
    const word = (t, s) => new RegExp(`(^|[^a-z0-9])${escapeRx(t.toLowerCase())}($|[^a-z0-9])`, "i").test(s);
    const all = [];
    for (const id of ids) {
      const company = companyIndex.get(id) ?? madeUpCompany(id);
      for (let i = 0; i < peopleCountAt(id); i++) {
        const p = makeCompanyPerson(company, i, ask);
        if (exclude.some((t) => word(t, p.title))) continue;
        if (keywords.some((t) => word(t, `${p.title} at ${p.company}`))) continue;
        all.push(p);
        people.set(p.id, p);
      }
    }
    return all;
  }

  function populationOf(filters) {
    const f = { contact: filters.contact ?? {}, account: filters.account ?? {} };
    const seed = createHash("sha1").update(stable(f)).digest("hex").slice(0, 16);
    let all = cache.get(seed);
    if (!all && companyIdsOf(f).length) {
      all = companyPopulation(f, companyIdsOf(f));
      cache.set(seed, all);
      if (cache.size > PEOPLE_CACHE) cache.delete(cache.keys().next().value);
    }
    if (!all) {
      const ask = askOf(f);
      let total = 0;
      for (const place of ask.placesRaw) total += 40 + (hash32(`${seed}|${place}`) % 120);
      if (!ask.titles.length && !ask.seniority.length && !ask.departments.length) total *= 4;
      all = [];
      for (let i = 0; i < total; i++) {
        const p = atAreaCompany(makePerson(seed, i, ask), seed, i, ask);
        if (excludedByFilters(p, ask)) continue;
        all.push(p);
        people.set(p.id, p);
      }
      cache.set(seed, all);
      if (cache.size > PEOPLE_CACHE) cache.delete(cache.keys().next().value);
    }
    return all;
  }

  function matching(body) {
    const excluded = new Set();
    if (!faults.ignoreLists) for (const id of contentOf(body.lists?.people_id?.exclude)) for (const p of lists.get(id) ?? []) excluded.add(p);
    return populationOf(body).filter((p) => !excluded.has(p.id));
  }

  /** The companies a Company Search body matches, in a stable order, before its exclusion lists. */
  function companiesFor(body) {
    const account = body.account ?? {};
    const seen = new Set();
    const out = [];
    for (const place of contentOf(account.location?.any?.include).map(String)) {
      let all = companyCache.get(place);
      if (!all) {
        const n = companiesPerPlace ?? 30 + (hash32(`place|${place}`) % 90);
        all = Array.from({ length: n }, (_, i) => makeCompany(place, i));
        companyCache.set(place, all);
        if (companyCache.size > COMPANY_CACHE) companyCache.delete(companyCache.keys().next().value);
      }
      for (const c of all) {
        if (seen.has(c.id) || excludedByAccount(c, account)) continue;
        seen.add(c.id);
        out.push(c);
        if (!companyIndex.has(c.id)) companyIndex.set(c.id, companyFacts(c));
      }
    }
    return out;
  }

  function companySearch(req, path) {
    const companyFault = faults.companyAnswers?.length ? faults.companyAnswers.shift() : null;
    const page = Number(req.page);
    const size = Number(req.size);
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(size) || size < 1 || size > 100) return appError(400, "invalid page or size", path);
    const account = req.account ?? {};
    const includes = [
      contentOf(account.location?.any?.include), contentOf(account.industries?.any?.include), contentOf(account.domain?.any?.include),
      contentOf(account.name?.any?.include),
    ];
    if (!includes.some((x) => x.length)) return appError(400, "a search cannot consist of exclude filters only", path);
    if ((page + 1) * size > (faults.searchCap ?? 10_000)) return appError(400, "pagination limit exceeded", path);
    const excluded = new Set();
    if (!faults.ignoreLists) for (const id of contentOf(req.lists?.company_id?.exclude)) for (const c of lists.get(id) ?? []) excluded.add(c);
    const all = companiesFor(req).filter((c) => !excluded.has(c.id));
    const content = all.slice(page * size, page * size + size);
    const price = Math.round(content.length * 10) / 100;
    if (companyFault !== null) {
      const fault = typeof companyFault === "object" ? companyFault : { status: companyFault };
      if (fault.charge && content.length) charge(price);
      if (!fault.status) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (fault.status === 429) return answer(429, { message: "API rate limit exceeded" }, { "Retry-After": "1" });
      if (fault.status === 402) return answer(402, { status: 402, error: "not enough balance" });
      if (fault.status === 401) return answer(401, { message: "No API key found in request" });
      if (fault.status === 403) return answer(403, { status: 403, error: "account restricted" });
      if (fault.status === 400) return appError(400, "request size must less or equal to {0,number} bytes", path);
      return answer(fault.status, { status: fault.status, error: "unexpected error" });
    }
    if (!all.length) return appError(404, "data not found", path);
    if (content.length && !charge(price)) return answer(402, { status: 402, error: "not enough balance" });
    if (faults.noContent) return answer(200, { totalElements: all.length });
    const credit = !content.length || faults.noCreditHeader ? {} : { "X-Credit": faults.badCreditHeader ? "abc" : `-${price.toFixed(1)}` };
    return answer(
      200,
      {
        content,
        pageable: { pageNumber: page, pageSize: size, offset: page * size, paged: true, unpaged: false },
        totalElements: all.length,
        totalPages: Math.ceil(all.length / size),
        last: (page + 1) * size >= all.length,
        size,
        number: page,
        numberOfElements: content.length,
        first: page === 0,
        empty: content.length === 0,
      },
      credit
    );
  }

  async function handle({ method, url, headers, body }) {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    state.calls++;
    if (faults.rateEvery && state.calls % faults.rateEvery === 0) return answer(429, { message: "API rate limit exceeded" });
    if (faults.serverEvery && state.calls % faults.serverEvery === 0) return answer(500, { status: 500, error: "unexpected error" });
    if (headers?.["X-TOKEN"] !== DEMO_TOKEN) return answer(401, { message: "No API key found in request" });

    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/developer-portal/, "");
    let req = {};
    try {
      req = body ? JSON.parse(body) : {};
    } catch {
      return appError(400, "malformed json", path);
    }

    if (method === "GET" && path === "/v1/payments/credits") return answer(200, { total: Math.floor(state.balance) });

    if (method === "POST" && path === "/v1/people/preview") {
      state.previewCalls++;
      const previewFault = faults.previewAnswers?.length ? faults.previewAnswers.shift() : null;
      const page = Number(req.page);
      const size = Number(req.size);
      if (!Number.isInteger(page) || page < 0 || !Number.isInteger(size) || size < 0 || size > 100) return appError(400, "invalid page or size", path);
      if (!contentOf(req.contact?.location?.any?.include).length && !req.account && !companyIdsOf(req).length) {
        return appError(400, "at least one include filter is required", path);
      }
      if (companyIdsOf(req).length > 300) return appError(400, "company ids exceed the limit of 300", path);
      if (page * Math.max(size, 1) >= 10_000) return appError(400, "pagination limit exceeded", path);
      if (previewFault !== null) {
        const fault = typeof previewFault === "object" ? previewFault : { status: previewFault };
        if (fault.charge) charge(1);
        if (!fault.status) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        if (fault.status === 400) return appError(400, fault.message ?? "request size must less or equal to {0,number} bytes", path);
        if (fault.status === 402) return answer(402, { status: 402, error: "not enough balance" });
        if (fault.status === 401) return answer(401, { message: "No API key found in request" });
        if (fault.status === 403) return answer(403, { status: 403, error: "account restricted" });
        if (fault.status === 404) return appError(404, "data not found", path);
        if (fault.status === 429) return answer(429, { message: "API rate limit exceeded" }, { "Retry-After": "1" });
        return answer(fault.status, { status: fault.status, error: "unexpected error" });
      }
      if (!charge(1)) return answer(402, { status: 402, error: "not enough balance" });
      const all = matching(req);
      if (!all.length) return appError(404, "data not found");
      const content = all
        .slice(page * size, page * size + size)
        .map((p) => previewItem(p, { description: !faults.previewWithoutDescription, company: !noCompany(p) }));
      return answer(200, {
        content,
        size,
        totalElements: all.length,
        totalPages: size ? Math.ceil(all.length / size) : 0,
        numberOfElements: content.length,
        trackId: null,
      });
    }

    if (method === "POST" && path === "/v1/lists") {
      const values = Array.isArray(req.values) ? req.values.map(String) : null;
      if (!values) return appError(400, "values is required");
      if (values.length > 10_000) return appError(400, "terms_lookup_list_values_limit_exceeded 10000");
      if (req.type !== "people_id" && req.type !== "company_id") return appError(400, "type is required");
      if (state.listsMade >= 50) return appError(400, "daily list quota exceeded");
      state.listsMade++;
      const id = randomUUID();
      lists.set(id, new Set(values));
      return answer(200, { id, workspace: "demo", type: req.type, values, created: Date.now() });
    }

    if (method === "POST" && path === "/v1/companies") {
      state.companyCalls++;
      return companySearch(req, path);
    }

    if (method === "POST" && path === "/v2/people/export/single") {
      if (!req.id && !req.url) return answer(400, { status: 400, error: "id and url cannot be both empty" });
      const p = people.get(String(req.id ?? ""));
      const notFound = (error) =>
        answer(200, { status: 404, error: { timestamp: new Date().toISOString(), status: 404, error, path: "/v2/people/export/single" }, data: null });
      if (!p) return notFound("person not found");
      if (!(p.email.found && p.email.status === "VALID")) return notFound("no email found");
      if (!charge(1)) return answer(402, { status: 402, error: "not enough balance" });
      return answer(200, { status: 200, error: null, data: fullPerson(p, { company: !noCompany(p) }) }, { "X-Credit": "-1.0" });
    }

    if (method === "POST" && path === "/v1/people/export") {
      const size = Number(req.size);
      if (!Number.isInteger(size) || size < 1 || size > 10_000) return appError(400, "pagination limit exceeded", path);
      const hook = String(req.webhook ?? "");
      if (!/^https:\/\//i.test(hook) || /^https:\/\/(localhost|127\.|\[::1\])/i.test(hook)) {
        return appError(400, "webhook must be a public https url", path);
      }
      if ([...jobs.values()].filter((j) => !j.done).length >= 500) return appError(400, "too many pending requests", path);
      const picked = matching(req).slice(0, size);
      const found = picked.filter((p) => p.email.found && p.email.status === "VALID").length;
      if (!charge(picked.length * 0.5 + found * 0.5)) return answer(402, { status: 402, error: "not enough balance" });
      const trackId = randomUUID();
      const now = Date.now();
      jobs.set(trackId, { trackId, people: picked, found, size, created: now, doneAt: now + jobMs, done: false });
      return answer(200, { trackId, statistics: { total: picked.length, found: 0 }, webhook: { state: "PENDING", retry: null }, state: "PENDING", description: null });
    }

    if (method === "GET" && path === "/v1/people/export/submissions") {
      const refundedOnly = u.searchParams.get("fullyRefunded");
      const all = [...jobs.values()]
        .filter((j) => refundedOnly === null || Boolean(j.refunded) === (refundedOnly === "true"))
        .sort((a, b) => b.created - a.created);
      const page = Math.max(0, Number(u.searchParams.get("page") ?? 0) || 0);
      const size = Math.min(100, Math.max(1, Number(u.searchParams.get("size") ?? 25) || 25));
      const content = all.slice(page * size, page * size + size).map((j) => ({
        trackId: j.trackId,
        service: "PEOPLE_EXPORT",
        requestSize: j.size,
        state: Date.now() >= j.doneAt ? "SETTLED" : "PENDING",
        fullyRefunded: Boolean(j.refunded),
        refundReason: j.refunded ? "STUCK_HARD_REFUND" : null,
        created: new Date(j.created).toISOString(),
      }));
      return answer(200, { content, totalElements: all.length });
    }

    const m = /^\/v1\/people\/export\/([^/]+)\/(statistics|inquiries)$/.exec(path);
    if (m && method === "GET") {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job || job.expired) return appError(404, "track id expired or not found");
      if (job.refunded) return answer(403, { timestamp: new Date().toISOString(), status: 4031013, error: REFUNDED, path: "" });
      if ((faults.refundJobOnce || (faults.refundAtReadOnce && m[2] === "inquiries")) && !state.refundedOnce) {
        state.refundedOnce = true;
        refund(job);
        return answer(403, { timestamp: new Date().toISOString(), status: 4031013, error: REFUNDED, path: "" });
      }
      if ((faults.expireJobOnce || faults.expireRefundedOnce) && !state.expiredOnce && m[2] === "inquiries") {
        state.expiredOnce = true;
        if (faults.expireRefundedOnce) refund(job);
        job.expired = true;
        return appError(404, "track id expired or not found");
      }
      const done = Date.now() >= job.doneAt;
      if (done) job.done = true;
      if (m[2] === "statistics") {
        return answer(200, {
          trackId: job.trackId,
          statistics: { total: job.people.length, found: done ? job.found : Math.floor(job.found / 2) },
          webhook: { state: done ? "DONE" : null, retry: null },
          state: done ? "DONE" : "PENDING",
          description: null,
        });
      }
      if (!done) return appError(409, "track id in progress");
      const page = Math.max(0, Number(u.searchParams.get("page") ?? 0) || 0);
      const size = Math.min(100, Math.max(1, Number(u.searchParams.get("size") ?? 10) || 10));
      const stillChecking = processingMs > 0 && Date.now() < job.doneAt + processingMs;
      const content = job.people
        .slice(page * size, page * size + size)
        .map((p) => fullPerson(p, { processing: stillChecking && hash32(p.id) % 20 === 0 }));
      const totalPages = Math.ceil(job.people.length / size);
      return answer(200, {
        content,
        size,
        totalElements: job.people.length,
        totalPages,
        numberOfElements: content.length,
        number: page,
        first: page === 0,
        last: page + 1 >= totalPages,
        empty: content.length === 0,
        trackId: job.trackId,
      });
    }

    return appError(404, "data not found", path);
  }

  handle.state = state;
  /** For tests: the facts a company id's people carry (the company as the stand-in knows it). */
  handle.companyFacts = (id) => companyIndex.get(String(id)) ?? madeUpCompany(String(id));
  return handle;
}

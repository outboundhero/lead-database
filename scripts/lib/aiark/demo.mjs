// A stand-in for AI Ark that never leaves the machine, offered only when
// AIARK_DEMO=1. It answers the same endpoints, with the same shapes and the
// same errors, as the documented API (./client.mjs), so a demo run exercises
// every path a live run takes: Preview pages that cost a credit, exclusion
// lists, single exports that charge only when an email is found, async export
// jobs, 402 when the credits run out.
//
// The people are made up (./demo-people.mjs): every web address is under the
// reserved ".example" domain. The same filters always give the same people,
// so a demo run can be repeated, resumed and tested.
//
// State (lists, export jobs, the credit balance) lives in this process only.

import { createHash, randomUUID } from "node:crypto";
import { demoId, hash32, makePerson } from "./demo-people.mjs";

export const DEMO_TOKEN = "demo-key";
const PEOPLE_CACHE = 8;

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

function previewItem(p) {
  const short = p.state ? `${p.city}, ${p.state}` : p.city;
  return {
    id: p.id,
    profile: { first_name: p.first, last_name: mask(p.last), title: p.title, headline: `${p.title} at ${p.company}` },
    company: {
      id: demoId(`co:${p.domain}`, 0),
      summary: { name: p.company, industry: p.industry, description: p.description, staff: staffOf(p.staff) },
    },
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

function fullPerson(p, { processing = false } = {}) {
  const base = previewItem(p);
  const handle = `${slug(`${p.first} ${p.last}`)}-${p.id.slice(0, 4)}`;
  const email = processing
    ? { state: "PROCESSING", output: [] }
    : { state: "DONE", output: [{ ...p.email, date: "2026-10-30T12:00:00.000000" }] };
  return {
    ...base,
    identifier: handle,
    profile: { ...base.profile, last_name: p.last, full_name: `${p.first} ${p.last}` },
    link: { linkedin: `https://linkedin.example/in/${handle}`, twitter: null, github: null, facebook: null },
    company: {
      ...base.company,
      link: {
        website: `https://${p.domain}`,
        domain: p.domain,
        linkedin: `https://linkedin.example/company/${slug(p.company)}`,
      },
    },
    email,
    last_updated: "2026-10-01",
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
 *   faults      { rateEvery, serverEvery, refundJobOnce, expireJobOnce } for tests
 */
export function createDemoTransport({ balance = 25_000, latencyMs = 0, jobMs = 4_000, processingMs = 0, faults = {} } = {}) {
  const lists = new Map(); // list id -> Set of person ids
  const jobs = new Map(); // trackId -> job
  const people = new Map(); // person id -> person, for single exports
  const cache = new Map(); // filter seed -> people[]
  const state = { balance, calls: 0, charged: 0, listsMade: 0, refundedOnce: false, expiredOnce: false };

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

  function populationOf(filters) {
    const f = { contact: filters.contact ?? {}, account: filters.account ?? {} };
    const seed = createHash("sha1").update(stable(f)).digest("hex").slice(0, 16);
    let all = cache.get(seed);
    if (!all) {
      const ask = askOf(f);
      let total = 0;
      for (const place of ask.placesRaw) total += 40 + (hash32(`${seed}|${place}`) % 120);
      if (!ask.titles.length && !ask.seniority.length && !ask.departments.length) total *= 4;
      all = [];
      for (let i = 0; i < total; i++) {
        const p = makePerson(seed, i, ask);
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
    for (const id of contentOf(body.lists?.people_id?.exclude)) for (const p of lists.get(id) ?? []) excluded.add(p);
    return populationOf(body).filter((p) => !excluded.has(p.id));
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
      const page = Number(req.page);
      const size = Number(req.size);
      if (!Number.isInteger(page) || page < 0 || !Number.isInteger(size) || size < 0 || size > 100) return appError(400, "invalid page or size", path);
      if (!contentOf(req.contact?.location?.any?.include).length && !req.account) return appError(400, "at least one include filter is required", path);
      if (page * Math.max(size, 1) >= 10_000) return appError(400, "pagination limit exceeded", path);
      if (!charge(1)) return answer(402, { status: 402, error: "not enough balance" });
      const all = matching(req);
      if (!all.length) return appError(404, "data not found");
      const content = all.slice(page * size, page * size + size).map(previewItem);
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
      if (req.type !== "people_id") return appError(400, "type is required");
      if (state.listsMade >= 50) return appError(400, "daily list quota exceeded");
      state.listsMade++;
      const id = randomUUID();
      lists.set(id, new Set(values));
      return answer(200, { id, workspace: "demo", type: "people_id", values, created: Date.now() });
    }

    if (method === "POST" && path === "/v2/people/export/single") {
      if (!req.id && !req.url) return answer(400, { status: 400, error: "id and url cannot be both empty" });
      const p = people.get(String(req.id ?? ""));
      const notFound = (error) =>
        answer(200, { status: 404, error: { timestamp: new Date().toISOString(), status: 404, error, path: "/v2/people/export/single" }, data: null });
      if (!p) return notFound("person not found");
      if (!(p.email.found && p.email.status === "VALID")) return notFound("no email found");
      if (!charge(1)) return answer(402, { status: 402, error: "not enough balance" });
      return answer(200, { status: 200, error: null, data: fullPerson(p) }, { "X-Credit": "-1.0" });
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
      const content = [...jobs.values()]
        .sort((a, b) => b.created - a.created)
        .map((j) => ({
          trackId: j.trackId,
          service: "PEOPLE_EXPORT",
          requestSize: j.size,
          state: Date.now() >= j.doneAt ? "SETTLED" : "PENDING",
          fullyRefunded: false,
          refundReason: null,
          created: new Date(j.created).toISOString(),
        }));
      return answer(200, { content, totalElements: content.length });
    }

    const m = /^\/v1\/people\/export\/([^/]+)\/(statistics|inquiries)$/.exec(path);
    if (m && method === "GET") {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) return appError(404, "track id expired or not found");
      if (faults.refundJobOnce && !state.refundedOnce) {
        state.refundedOnce = true;
        jobs.delete(job.trackId);
        const refund = job.people.length * 0.5 + job.found * 0.5;
        state.balance += refund;
        state.charged = Math.round((state.charged - refund) * 100) / 100;
        return appError(403, "this request was automatically refunded because the results were not delivered within the time limit. you can submit it again.");
      }
      if (faults.expireJobOnce && !state.expiredOnce && m[2] === "inquiries") {
        state.expiredOnce = true;
        jobs.delete(job.trackId);
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
  return handle;
}

// AI Ark's developer API: the calls the AI Ark tab makes, written from the
// public docs (docs.ai-ark.com and ai-ark.com/llms.txt, read and checked
// 2026-10-30). Not yet run against a live key — confirm each response shape on
// the first real call.
//
// Every call goes through one transport, so the demo (./demo.mjs) stands in
// for the network on exactly the same error paths. Failures are AiArkError
// with a `kind` the run engine acts on; no message ever carries the key.
//
// Plain JavaScript so the worker and the Next.js routes share it.

import { bareDomain } from "../enrich/actions.mjs";

export const AIARK_BASE_URL = "https://api.ai-ark.com/api/developer-portal";
export const PAGE_MAX = 100; // results per page: Preview and export results
export const SEARCH_CAP = 10_000; // matches one search can page through
export const ARRAY_MAX = 300; // values per include/exclude array
export const LIST_MAX = 10_000; // ids per exclusion list
export const LISTS_PER_REQUEST = 10;
export const LISTS_PER_DAY = 50;
export const EXPORT_MAX = 10_000; // people per Export People with Email job

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v) => (v == null ? "" : String(v).trim());

export class AiArkError extends Error {
  /**
   * kind: key | credits | rate | bad_request | pending_cap | list_limit |
   *       not_ready | refunded | expired | unsupported | server | network
   */
  constructor(kind, message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "AiArkError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  /** Worth trying again later without changing anything. */
  get retryable() {
    return this.kind === "rate" || this.kind === "server" || this.kind === "network" || this.kind === "not_ready";
  }
}

/** The real network. A transport answers { status, headers, text } and throws only when no answer came back. */
export async function fetchTransport({ method, url, headers, body, timeoutMs }) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function errorText(json, raw) {
  const m = json?.message ?? (typeof json?.error === "string" ? json.error : json?.error?.error);
  return text(m) || text(raw).slice(0, 200) || "no details";
}

/**
 * An AI Ark client. `token` is the X-TOKEN key (never logged). Calls are
 * spaced to `rps` per second — AI Ark allows 5 per key, and a burst above
 * that is what its terms call robotic velocity — and a 429 is waited out.
 */
export function createAiArk({ token, transport = fetchTransport, rps = 4, timeoutMs = 45_000, wait = sleep } = {}) {
  if (!token) throw new Error("AI Ark key is missing");
  const gap = 1000 / Math.max(0.5, Math.min(5, rps));
  let nextSlot = 0;
  const stats = { calls: 0, rateLimited: 0 };

  async function throttle() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await wait(at - now);
  }

  /**
   * One call. `retry`: "safe" retries 429s, 5xx and network errors (reads and
   * calls whose repeat costs at most one credit); "rate-only" retries just
   * 429s — the request was refused before AI Ark processed it — so a call
   * that could buy thousands of people is never sent twice by accident.
   */
  async function call(method, path, { body, query, retry = "safe", trackId = false } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const req = {
      method,
      url: `${AIARK_BASE_URL}${path}${qs}`,
      headers: { "X-TOKEN": token, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    };
    let rateTries = 0;
    let otherTries = 0;
    for (;;) {
      await throttle();
      stats.calls++;
      let res;
      try {
        res = await transport(req);
      } catch (e) {
        const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        const why = timeout ? `no answer within ${timeoutMs / 1000}s` : text(e?.cause?.code || e?.message) || "request failed";
        if (retry === "safe" && ++otherTries < 3) {
          await wait(2_000 * otherTries);
          continue;
        }
        throw new AiArkError("network", `AI Ark did not answer (${why})`);
      }
      let json = null;
      try {
        json = res.text ? JSON.parse(res.text) : null;
      } catch {
        /* not JSON */
      }
      const s = res.status;
      if (s >= 200 && s < 300) return { json, headers: res.headers, status: s };

      if (s === 429) {
        stats.rateLimited++;
        if (++rateTries <= 6) {
          const after = Number(res.headers?.get?.("retry-after"));
          await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1_000 * 2 ** (rateTries - 1));
          continue;
        }
        throw new AiArkError("rate", "AI Ark kept refusing calls as too fast (429)", { status: s });
      }
      if (s >= 500 && s !== 501 && retry === "safe" && ++otherTries < 3) {
        await wait(2_000 * otherTries);
        continue;
      }

      const why = errorText(json, res.text);
      const code = typeof json?.status === "number" ? json.status : null;
      if (s === 401) throw new AiArkError("key", "AI Ark refused the key (401)", { status: s });
      if (s === 402) throw new AiArkError("credits", "The AI Ark account is out of credits (402)", { status: s });
      if (s === 403) {
        // An export job auto-refunded by AI Ark (body status 4031013 / 4031014);
        // anywhere else a 403 is a key problem.
        if (trackId) throw new AiArkError("refunded", `AI Ark refunded the export: ${why}`, { status: s, code });
        throw new AiArkError("key", `AI Ark refused the key (403): ${why}`, { status: s });
      }
      if (s === 404 && trackId) throw new AiArkError("expired", `AI Ark no longer has this export: ${why}`, { status: s });
      if (s === 404) return { json: null, headers: res.headers, status: s, empty: true };
      if (s === 409) throw new AiArkError("not_ready", "The export is still running (409)", { status: s });
      if (s === 400 && /too many pending/i.test(why)) {
        throw new AiArkError("pending_cap", "AI Ark already holds 500 unfinished exports for this key", { status: s });
      }
      if (s === 400 && path === "/v1/lists") throw new AiArkError("list_limit", `AI Ark refused the exclusion list: ${why}`, { status: s });
      if (s === 400) throw new AiArkError("bad_request", `AI Ark refused the request: ${why}`, { status: s });
      if (s === 501) throw new AiArkError("unsupported", `AI Ark does not support this filter: ${why}`, { status: s });
      if (s >= 500) throw new AiArkError("server", `AI Ark had an error (${s}): ${why}`, { status: s });
      throw new AiArkError("bad_request", `AI Ark answered ${s}: ${why}`, { status: s });
    }
  }

  return {
    stats,

    /** Credits left on the account. Free. */
    async credits() {
      const { json } = await call("GET", "/v1/payments/credits");
      const n = Number(json?.total);
      if (!Number.isFinite(n)) throw new AiArkError("server", "AI Ark's credit balance had no total");
      return n;
    },

    /**
     * People Preview: one page of matches without emails, last names masked.
     * 1 credit per page, whatever its size. No matches comes back as 404 or as
     * an empty page — both read as an empty page here.
     */
    async preview(filters, { page = 0, size = PAGE_MAX, lists = null } = {}) {
      const body = { ...filters, ...(lists?.length ? { lists: { people_id: { exclude: lists } } } : {}), page, size };
      const r = await call("POST", "/v1/people/preview", { body });
      const json = r.empty ? {} : r.json ?? {};
      return {
        content: Array.isArray(json.content) ? json.content : [],
        totalElements: Number(json.totalElements ?? 0) || 0,
        totalPages: Number(json.totalPages ?? 0) || 0,
      };
    },

    /** Saves ids as an exclusion list (free; 50 a day, 24 h life). Returns its id. */
    async createList(ids) {
      const { json } = await call("POST", "/v1/lists", { body: { type: "people_id", values: ids } });
      const id = text(json?.id);
      if (!id) throw new AiArkError("server", "AI Ark created a list but returned no id");
      return id;
    },

    /**
     * Export Single Person with Email (v2): the full profile and an email for
     * one person. 1 credit only when a valid email is found, nothing otherwise.
     * Answers 200 in every expected case; the envelope's own status says which.
     */
    async exportSingle(id) {
      const { json, headers } = await call("POST", "/v2/people/export/single", { body: { id } });
      if (json?.status === 200 && json.data && typeof json.data === "object") {
        const charged = Math.abs(parseFloat(headers?.get?.("x-credit") ?? ""));
        return { found: true, person: json.data, credits: Number.isFinite(charged) ? charged : 1 };
      }
      if (json?.status === 404) {
        const why = errorText(json.error, "");
        return { found: false, reason: /person not found/i.test(why) ? "not_found" : "no_email", credits: 0 };
      }
      if (json?.status === 402) throw new AiArkError("credits", "The AI Ark account is out of credits (402)", { status: 402 });
      throw new AiArkError("server", `AI Ark's single export answered status ${json?.status ?? "?"}: ${errorText(json?.error, "")}`);
    },

    /**
     * Export People with Email: an async job of up to 10,000 people
     * (0.5 credits a person + 0.5 per email found). AI Ark requires a public
     * HTTPS webhook. Never retried on a lost answer — that could buy the same
     * people twice; the run engine checks the submissions list instead.
     */
    async exportStart(filters, { size, lists = null, webhook }) {
      const body = { ...filters, ...(lists?.length ? { lists: { people_id: { exclude: lists } } } : {}), page: 0, size, webhook };
      const { json } = await call("POST", "/v1/people/export", { body, retry: "rate-only" });
      const trackId = text(json?.trackId);
      if (!trackId) throw new AiArkError("server", "AI Ark accepted the export but returned no trackId");
      return { trackId, state: text(json?.state) || "PENDING" };
    },

    /** An export job's state (PENDING … DONE) and counts. Free. */
    async exportStatus(trackId) {
      const { json } = await call("GET", `/v1/people/export/${encodeURIComponent(trackId)}/statistics`, { trackId: true });
      return {
        state: text(json?.state).toUpperCase() || "PENDING",
        total: Number(json?.statistics?.total ?? 0) || 0,
        found: Number(json?.statistics?.found ?? 0) || 0,
      };
    },

    /** One page of a finished export's people, emails included. Free; 409 until DONE. */
    async exportResults(trackId, { page = 0, size = PAGE_MAX } = {}) {
      const { json } = await call("GET", `/v1/people/export/${encodeURIComponent(trackId)}/inquiries`, {
        query: { page: String(page), size: String(size) },
        trackId: true,
      });
      const content = Array.isArray(json?.content) ? json.content : [];
      const totalPages = Number(json?.totalPages ?? 0) || 0;
      return { content, totalPages, totalElements: Number(json?.totalElements ?? 0) || 0, last: json?.last === true || page + 1 >= totalPages };
    },

    /** The key's recent export submissions, newest first. Free. */
    async exportSubmissions({ size = 25 } = {}) {
      const { json } = await call("GET", "/v1/people/export/submissions", { query: { page: "0", size: String(size), sort: "created,desc" } });
      return Array.isArray(json?.content) ? json.content : [];
    },
  };
}

// ── What AI Ark returned → the run table's input cells ─────────────────────

/** The address to use from an email block: a VALID one first, then any found. */
export function pickEmail(email) {
  const out = Array.isArray(email?.output) ? email.output.filter((o) => o && typeof o === "object") : [];
  const found = out.filter((o) => o.found !== false && text(o.address));
  return { state: text(email?.state).toUpperCase() || null, best: found.find((o) => o.status === "VALID") ?? found[0] ?? null };
}

function sizeText(staff) {
  const total = Number(staff?.total);
  const start = Number(staff?.range?.start);
  const end = Number(staff?.range?.end);
  const band = Number.isFinite(start) && start > 0
    ? Number.isFinite(end) && end > 0 && end < 1_000_000 ? `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")}` : `${start.toLocaleString("en-US")}+`
    : "";
  if (Number.isFinite(total) && total > 0) return band ? `${total.toLocaleString("en-US")} (${band})` : total.toLocaleString("en-US");
  return band;
}

/**
 * The input cells for one person, from a Preview item (masked last name, no
 * email), an Export Single answer or an export result. Every value is text.
 */
export function personInputs(p) {
  const prof = p?.profile ?? p?.summary ?? {};
  const co = p?.company ?? {};
  const cs = co.summary ?? {};
  const loc = p?.location ?? {};
  const dep = p?.department ?? {};
  const { state, best } = pickEmail(p?.email);
  const status = best
    ? best.status === "VALID" ? "VALID" : `INVALID${text(best.subStatus) && best.subStatus !== "EMPTY" ? ` (${best.subStatus})` : ""}`
    : state === "PROCESSING" ? "PENDING" : "";
  const out = {
    full_name: text(prof.full_name) || [text(prof.first_name), text(prof.last_name)].filter(Boolean).join(" "),
    title: text(prof.title),
    seniority: text(dep.seniority),
    department: (Array.isArray(dep.departments) ? dep.departments : []).slice(0, 3).join(", "),
    company: text(cs.name ?? co.name),
    domain: text(co.link?.domain) || bareDomain(co.link?.website) || "",
    company_industry: text(cs.industry),
    company_size: sizeText(cs.staff),
    city: text(loc.city),
    state: text(loc.state),
    country: text(loc.country),
    email: best ? text(best.address).toLowerCase() : "",
    email_status: status,
    email_domain_type: best ? text(best.domainType) : "",
    email_provider: best ? text(best.mx?.provider) : "",
    linkedin: text(p?.link?.linkedin),
    company_linkedin: text(co.link?.linkedin),
    company_description: text(cs.description).slice(0, 5_000),
    aiark_id: text(p?.id),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

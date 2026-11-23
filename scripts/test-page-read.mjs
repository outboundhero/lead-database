#!/usr/bin/env node
// Checks for the email searches' page reading (scripts/lib/enrich/page-read.mjs)
// and what it changes in ai_web and the engine. No database and no network:
// fetch and the host lookup are stand-ins (test-support installNet), and the
// engine runs on a fake database that answers its shared-memory and spend
// queries.
//
//   node scripts/test-page-read.mjs
//
//   P1. addresses: startUrl, baseDomain, isPublicAddress, pageStart, siteInPrompt
//   P2. what a page holds: entities, Cloudflare addresses, emailsIn (mailto,
//       text, [at]/[dot], the page's own data, junk left out), pageLinks,
//       visibleText, excerpt
//   P3. readSite: the start page, its contact page, a redirect, /contact-us
//       tried, refusals (private, local, internal, other ports, a redirect to a
//       private host), not HTML, HTTP errors, the size cap, the time budget
//   P4. ai_web: the pages after the prompt; no web search for the first search
//       when the pages held an address, always for the second; the run record
//   P5. the engine: the page-reading memory kind and input hash, "N/A"
//       remembered for the nothing-found days, a website waterfall skipping "N/A"

import { checker, installNet } from "./fixtures/test-support.mjs";
import {
  baseDomain, cleanEmail, decodeCfEmail, decodeEntities, emailsIn, excerpt, isPublicAddress, PAGE_LIMIT, PAGE_MAX_BYTES,
  PAGE_READ_MEMORY, pageLinks, pageStart, pagesForPrompt, readSite, readsPages, setPageReadDeps, siteInPrompt,
  startUrl, visibleText,
} from "./lib/enrich/page-read.mjs";
import { ACTIONS } from "./lib/enrich/actions.mjs";
import { memoryKey, runRow } from "./lib/enrich/engine.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";

const t0 = Date.now();
const count = checker();
const { check, section } = count;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── P1 ──────────────────────────────────────────────────────────────────────
section("P1. Addresses");
check("startUrl: https added, path kept, fragment dropped; N/A, no dot, spaces and other schemes are none",
  startUrl("cityhospital.example") === "https://cityhospital.example/" && startUrl("http://a.example/x?y=1#z") === "http://a.example/x?y=1" &&
    startUrl(" https://www.x.example/doctors/a ") === "https://www.x.example/doctors/a" && startUrl("N/A") === null && startUrl("n/a.") === null &&
    startUrl("localhost") === null && startUrl("two words.com") === null && startUrl("ftp://x.example") === null && startUrl({ url: "x.com" }) === null && startUrl("") === null);
check("baseDomain: the registrable part, two-part suffixes kept",
  baseDomain("providers.healthnet.example") === "healthnet.example" && baseDomain("www.Springfield.example") === "springfield.example" && baseDomain("a.b.co.uk") === "b.co.uk" && baseDomain("x.org") === "x.org");
check("isPublicAddress: public v4 and v6 yes; loopback, private, link-local (metadata), carrier NAT, reserved, multicast no",
  isPublicAddress("93.184.215.14") && isPublicAddress("8.8.8.8") && isPublicAddress("2606:4700::1111") &&
    ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.7", "203.0.113.9"].every((a) => !isPublicAddress(a)) &&
    ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "64:ff9b::a00:1"].every((a) => !isPublicAddress(a)) &&
    !isPublicAddress("not an ip") && isPublicAddress("172.32.0.1") && isPublicAddress("100.128.0.1"));
check("isPublicAddress: an IPv4 address inside IPv6 is judged as IPv4, dotted or hex",
  !isPublicAddress("::ffff:127.0.0.1") && !isPublicAddress("::ffff:7f00:1") && !isPublicAddress("::ffff:a9fe:a9fe") && !isPublicAddress("::10.0.0.1") &&
    isPublicAddress("::ffff:5db8:d70e"));
check("pageStart: the place's page when it is on the website's site, else the website; either alone",
  pageStart("https://providers.healthnet.example/doctor/a", "healthnet.example") === "https://providers.healthnet.example/doctor/a" &&
    pageStart("https://www.healthgrades.com/physician/x", "drsmith.example") === "https://drsmith.example/" &&
    pageStart("", "cityhospital.example") === "https://cityhospital.example/" && pageStart("https://a.example/p", "") === "https://a.example/p" &&
    pageStart("", "N/A") === null && pageStart(undefined, undefined) === null);
check("siteInPrompt: the site the compiled email prompt names, or empty",
  siteInPrompt("1. Retrieve the company’s official website from site:cityhospital.example, and use it") === "cityhospital.example" &&
    siteInPrompt("Retrieve the company’s official website from site:N/A, and") === "N/A" && siteInPrompt("no site here") === "");
check("readsPages: the two email searches only",
  readsPages({ key: "email_extraction_claygent" }) && readsPages({ key: "email_extraction_claygent_2" }) && !readsPages({ key: "companys_website" }) && !readsPages(null));

// ── P2 ──────────────────────────────────────────────────────────────────────
section("P2. What a page holds");
check("decodeEntities: numeric, hex and the named ones addresses use",
  decodeEntities("info&#64;a.example &#x40; &commat; &amp; &quot;x&quot; &nbsp;") === 'info@a.example @ @ & "x"  ');
const cf = (email, key = 0x2a) => key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
check("decodeCfEmail: Cloudflare's protected address back; bad hex is empty", decodeCfEmail(cf("office@clinic.example")) === "office@clinic.example" && decodeCfEmail("zz") === "" && decodeCfEmail("abc") === "");
check("cleanEmail: lower case, trailing punctuation off; placeholders, file names, no-reply and Wix/Sentry addresses dropped",
  cleanEmail("Info@Clinic.Example.") === "info@clinic.example" && cleanEmail("mailto:front@desk.example") === "front@desk.example" &&
    ["you@example.com", "name@domain.com", "logo@2x.png", "icon@3x.webp", "noreply@a.example", "do-not-reply@a.example", "abc@sentry.io", "x@sentry-next.wixpress.com", "a@wixpress.com", "not an email", ""].every((e) => cleanEmail(e) === ""));
const page = `<html><head><title>Contact &amp; Hours</title><script>var tracker = "abc@sentry.io"; var props = {"email":"data\\u0040clinic.example"};</script>
  <style>.x{background:url(logo@2x.png)}</style></head><body>
  <!-- old: hidden@clinic.example -->
  <a href="mailto:Front.Desk@Clinic.example?subject=Hi">Email us</a>
  <p>Billing: billing&#64;clinic.example</p><p>Write to office [at] clinic [dot] example</p>
  <span class="__cf_email__" data-cfemail="${cf("cf@clinic.example")}">[email&#160;protected]</span>
  <div data-props="{&quot;email&quot;:&quot;props@clinic.example&quot;}"></div>
  <a href="/contact-us">Contact</a> <a href="https://www.clinic.example/locations/springfield">Our Springfield office</a>
  <a href="/about-us/">About us</a> <a href="/blog/2020/01/02/contact-tracing-news">Contact tracing news</a>
  <a href="https://other.example/contact">Partner contact</a> <a href="/files/contact.pdf">Contact (PDF)</a>
  <a href="/login">Contact portal login</a> <a href="tel:+12125550100">Call</a> <a href="#top">Top</a>
  <p>123 Main Street, Suite 4</p><p>(203) 555-0100</p></body></html>`;
const found = emailsIn(page);
check("emailsIn: mailto, plain text, entities, [at]/[dot], Cloudflare, then the page's own data, once each, in that order",
  same(found.slice(0, 4), ["front.desk@clinic.example", "cf@clinic.example", "billing@clinic.example", "office@clinic.example"]) &&
    found.includes("data@clinic.example") && found.includes("props@clinic.example") && found.includes("hidden@clinic.example") &&
    !found.some((e) => /sentry|@2x/.test(e)) && new Set(found).size === found.length,
  JSON.stringify(found));
const links = pageLinks(page, "https://www.clinic.example/");
check("pageLinks: contact pages first, then location, then about; same site only; files, logins, phone and fragments left out",
  links[0]?.url === "https://www.clinic.example/contact-us" && links[0].kind === "contact" &&
    links.some((l) => l.url === "https://www.clinic.example/locations/springfield" && l.kind === "location") &&
    links.some((l) => l.url === "https://www.clinic.example/about-us" && l.kind === "about") &&
    !links.some((l) => /other\.example|\.pdf|login|tel:|#top/.test(l.url)) &&
    links.findIndex((l) => l.url.includes("contact-tracing")) > links.findIndex((l) => l.url.endsWith("/contact-us")),
  JSON.stringify(links));
const vt = visibleText(page);
check("visibleText: no scripts, styles or comments; entities decoded; a line per block",
  vt.includes("Billing: billing@clinic.example") && !vt.includes("tracker") && !vt.includes("background") && !vt.includes("hidden@") && vt.split("\n").length > 3);
const ex = excerpt(page, 2_500);
check("excerpt: the lines with an address, a phone or a street first, at most the size asked", ex.includes("billing@clinic.example") && ex.includes("123 Main Street") && excerpt(page, 30).length <= 30);

// ── P3 ──────────────────────────────────────────────────────────────────────
section("P3. readSite");
/** A fake web: pages by URL (string HTML, or { status, body, headers, location }), the URLs fetched, the hosts looked up. */
function fakeWeb(pages, hosts = {}) {
  const seen = { fetched: [], looked: [] };
  setPageReadDeps({
    lookup: async (h) => {
      seen.looked.push(h);
      if (h in hosts) return hosts[h].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      return [{ address: "93.184.215.14", family: 4 }];
    },
    fetch: async (url, init) => {
      seen.fetched.push(url);
      if (init?.redirect !== "manual") throw new Error("the page reader must not follow redirects itself");
      const p = pages[url] ?? pages[url.replace(/\/$/, "")];
      if (p === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      if (typeof p === "function") return p(init);
      if (typeof p === "string") return new Response(p, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": "text/html", ...(p.location ? { location: p.location } : {}), ...(p.headers ?? {}) } });
    },
  });
  return seen;
}
let web = fakeWeb({
  "http://clinic.example/": { status: 301, location: "https://www.clinic.example/" },
  "https://www.clinic.example/": `<a href="/contact-us">Contact</a><a href="/about">About</a><p>Welcome</p>`,
  "https://www.clinic.example/contact-us": `<a href="mailto:hello@clinic.example">hello@clinic.example</a>`,
  "https://www.clinic.example/about": `<p>About</p>`,
});
let r = await readSite("http://clinic.example/");
check("a redirect is followed; the contact page it links to is read; a contact page with an address ends the reading",
  same(r.emails, ["hello@clinic.example"]) && r.pages.length === 2 && r.pages[0].url === "https://www.clinic.example/" && r.pages[0].kind === "start" &&
    r.pages[1].kind === "contact" && !web.fetched.includes("https://www.clinic.example/about") && r.pages.every((p) => !("html" in p)),
  JSON.stringify({ r, fetched: web.fetched }));

web = fakeWeb({
  "https://plain.example/": `<p>No links here</p>`,
  "https://plain.example/contact-us": `<p>Reach us at desk@plain.example</p>`,
});
r = await readSite("https://plain.example/");
check("no contact link: /contact-us is tried, and its address found", same(r.emails, ["desk@plain.example"]) && r.pages.some((p) => p.kind === "contact (tried)"), JSON.stringify(r));

web = fakeWeb({ "https://many.example/": Array.from({ length: 10 }, (_, i) => `<a href="/contact-${i}">Contact ${i}</a>`).join("") });
r = await readSite("https://many.example/");
check(`at most ${PAGE_LIMIT} pages are read`, r.pages.length === PAGE_LIMIT && web.fetched.length === PAGE_LIMIT, JSON.stringify(r.pages.map((p) => p.url)));

web = fakeWeb({ "https://inside.example/": "<p>x</p>" }, { "inside.example": ["10.0.0.5"] });
r = await readSite("https://inside.example/");
check("a host that resolves to a private address is never fetched", r.pages[0]?.error === "the host resolves to a private address" && web.fetched.length === 0, JSON.stringify(r));
web = fakeWeb({ "https://mixed.example/": "<p>x</p>" }, { "mixed.example": ["93.184.215.14", "127.0.0.1"] });
r = await readSite("https://mixed.example/");
check("one private address among public ones is enough to refuse", r.pages[0]?.error === "the host resolves to a private address" && web.fetched.length === 0);
web = fakeWeb({});
const refusals = [];
for (const u of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://push-worker.railway.internal/", "http://printer.local/", "http://a.example:8080/", "http://user:pw@a.example/", "http://[::1]/"]) {
  refusals.push((await readSite(u)).pages[0]?.error ?? "read");
}
check("local, loopback, metadata, internal and .local hosts, other ports and passwords are refused without a fetch",
  refusals.every((e) => e && e !== "read") && web.fetched.length === 0, JSON.stringify(refusals));
web = fakeWeb({ "https://hop.example/": { status: 302, location: "http://10.0.0.9/admin" } });
r = await readSite("https://hop.example/");
check("a redirect to a private address is refused on that hop", r.pages[0]?.error === "not a public address" && same(web.fetched, ["https://hop.example/"]), JSON.stringify({ r, fetched: web.fetched }));
web = fakeWeb({ "https://loop.example/": { status: 302, location: "https://loop.example/" } });
r = await readSite("https://loop.example/");
check("a redirect loop stops", r.pages[0]?.error === "too many redirects" && web.fetched.length === 5, JSON.stringify(r));
web = fakeWeb({
  "https://types.example/": { status: 200, body: "%PDF-1.4", headers: { "content-type": "application/pdf" } },
});
r = await readSite("https://types.example/");
check("anything but HTML or text is not read", r.pages[0]?.error === "not a web page");
web = fakeWeb({ "https://shut.example/": { status: 403, body: "Forbidden" } });
r = await readSite("https://shut.example/");
check("an HTTP error is noted and nothing more is tried on that site", r.pages.length === 1 && r.pages[0].error === "HTTP 403" && r.pages[0].status === 403 && r.emails.length === 0);
web = fakeWeb({ "https://big.example/": `<p>a@big.example</p>${"x".repeat(PAGE_MAX_BYTES + 50_000)}<p>late@big.example</p>` });
r = await readSite("https://big.example/");
check(`a page is read up to ${PAGE_MAX_BYTES.toLocaleString("en-US")} bytes only`, r.emails.includes("a@big.example") && !r.emails.includes("late@big.example"));
// A site that never answers. The timer keeps the process alive as a real socket would (AbortSignal.timeout's own
// timer does not), so the abort can fire.
web = fakeWeb({
  "https://slow.example/": (init) =>
    new Promise((_, reject) => {
      const alive = setTimeout(() => {}, 5_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(alive);
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    }),
});
const tSlow = Date.now();
r = await readSite("https://slow.example/", { budgetMs: 300 });
check("the time budget bounds a site that never answers", r.pages[0]?.error === "timed out" && Date.now() - tSlow < 2_000, JSON.stringify(r));
setPageReadDeps({ lookup: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); } });
r = await readSite("https://gone.example/");
check("a host that does not resolve is noted", r.pages[0]?.error === "the host does not resolve");

// ── P4 ──────────────────────────────────────────────────────────────────────
section("P4. ai_web with the pages");
const net = installNet(); // fetch and the host lookup as every test has them: .example sites only
const settings = settingsFrom([
  { key: "models", value: { email_extraction_claygent: { model: "gpt-test", max_searches: 2 }, email_extraction_claygent_2: { model: "gpt-test", max_searches: 2 } } },
]);
const env = { OPENAI_API_KEY: "test-key-not-real" };
const cfg = (key) => ({
  model_setting: key, tool: "web_search", user_location: false, keep_na: true, memory: `${key}_v1`, memory_days: "email",
  answer: { company_emails_found: { type: "string", description: "emails" } }, answer_order: ["company_emails_found"], use_case: "claygent",
});
const PROMPT = (site, marker = "p4") => `[fx:${marker}] company=Clinic; Retrieve the company’s official website from site:${site}, and use it as the primary resource.`;
net.pages.set("https://shop.clinic.example/springfield", `<p>Springfield office</p><a href="/contact">Contact</a>`);
net.pages.set("https://shop.clinic.example/contact", `<a href="mailto:springfield@clinic.example">springfield@clinic.example</a>`);
net.openai.set("p4", { company_emails_found: "springfield@clinic.example" });
const run1 = await ACTIONS.ai_web.run({
  inputs: { prompt: PROMPT("clinic.example"), page_url: "https://shop.clinic.example/springfield", site: "clinic.example" },
  config: cfg("email_extraction_claygent"), env, settings, db: null, row: { id: 1 }, column: { key: "email_extraction_claygent" },
});
const body1 = net.bodies.at(-1);
check("the first search reads the place's page and its contact page, sends them after the prompt, and keeps its web search (as Clay's Claygent)",
  run1.status === "done" && run1.display === "springfield@clinic.example" && body1.tools?.[0]?.type === "web_search" && body1.max_tool_calls === 2 &&
    body1.input.startsWith(PROMPT("clinic.example")) && body1.input.includes("#PAGES READ FROM THE COMPANY WEBSITE#") &&
    body1.input.includes("Email addresses found on these pages: springfield@clinic.example"),
  JSON.stringify({ status: run1.status, tools: body1?.tools, input: body1?.input?.slice(-600) }));
check("... its run record names the pages and their addresses",
  run1.run.request.pages?.start === "https://shop.clinic.example/springfield" && same(run1.run.request.pages.emails, ["springfield@clinic.example"]) &&
    run1.run.request.tool === "web_search" && run1.run.request.pages.read.length === 2 && typeof run1.run.request.pages_text === "string",
  JSON.stringify(run1.run.request.pages));
const run2 = await ACTIONS.ai_web.run({
  inputs: { prompt: PROMPT("clinic.example"), page_url: "https://shop.clinic.example/springfield", site: "clinic.example" },
  config: cfg("email_extraction_claygent_2"), env, settings, db: null, row: { id: 1 }, column: { key: "email_extraction_claygent_2" },
});
const body2 = net.bodies.at(-1);
check("the second search too keeps the web search (and its cap) when the pages held an address",
  run2.status === "done" && body2.tools?.[0]?.type === "web_search" && body2.max_tool_calls === 2 && body2.input.includes("Search the web only when none of them fits"),
  JSON.stringify({ tools: body2?.tools, max: body2?.max_tool_calls }));
net.pages.set("https://bare.example/", `<p>Welcome, no address here</p>`);
const run3 = await ACTIONS.ai_web.run({
  inputs: { prompt: PROMPT("bare.example") }, // a table compiled before the page inputs: the site the prompt names
  config: cfg("email_extraction_claygent"), env, settings, db: null, row: { id: 2 }, column: { key: "email_extraction_claygent" },
});
const body3 = net.bodies.at(-1);
check("with no address on the pages the search is told so; an older table's prompt gives the site",
  run3.status === "done" && body3.tools?.[0]?.type === "web_search" && body3.input.includes("No email address was found on these pages") &&
    run3.run.request.pages?.start === "https://bare.example/",
  JSON.stringify({ tools: body3?.tools, start: run3.run.request.pages?.start }));
const before = net.calls.page;
const run4 = await ACTIONS.ai_web.run({
  inputs: { prompt: PROMPT("N/A") }, config: cfg("email_extraction_claygent"), env, settings, db: null, row: { id: 3 }, column: { key: "email_extraction_claygent" },
});
check("no website ('N/A'): no page is opened, the search goes as before, and the record says why",
  net.calls.page === before && run4.run.request.pages?.start === null && !net.bodies.at(-1).input.includes("#PAGES READ") && net.bodies.at(-1).tools?.[0]?.type === "web_search");
const other = await ACTIONS.ai_web.run({
  inputs: { prompt: "[fx:p4] company=Clinic; find the website" }, config: { ...cfg("email_extraction_claygent"), model_setting: "email_extraction_claygent" },
  env, settings, db: null, row: { id: 4 }, column: { key: "companys_website" },
});
check("any other AI column sends exactly what it sent before: no pages, the same input", other.status === "done" && net.bodies.at(-1).input === "[fx:p4] company=Clinic; find the website" && !other.run.request.pages);
check("pagesForPrompt: a site that could not be opened says so, and to search when the search is kept",
  pagesForPrompt({ start: "https://x.example/", pages: [{ url: "https://x.example/", kind: "start", error: "HTTP 403" }], emails: [] }, { tools: true }).includes("could not be opened (HTTP 403). Search the web instead."));

// ── P5 ──────────────────────────────────────────────────────────────────────
section("P5. The engine");
/** A fake database: the shared memory (kind, key) and the spend rows the engine and ai_web read and write. */
function fakeDb() {
  const memory = new Map();
  const db = {
    memory,
    async query(sql, params = []) {
      if (/FROM enrich_memory/.test(sql)) {
        const hit = memory.get(`${params[0]}|${params[1]}`);
        return { rows: hit ? [{ ...hit, created_at: new Date() }] : [] };
      }
      if (/INSERT INTO enrich_memory/.test(sql)) {
        memory.set(`${params[0]}|${params[1]}`, { status: params[2], value: params[3] ? JSON.parse(params[3]) : null, display: params[4], client_tag: params[7], days: params[10] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return db;
}
const engineSettings = settingsFrom([
  { key: "models", value: { email_extraction_claygent: { model: "gpt-test", max_searches: 2 } } },
  { key: "spend_caps", value: { openai_usd_per_day: { pipeline: 5 } } },
]);
const emailCol = {
  key: "email_extraction_claygent", name: "Email Extraction (Claygent)", kind: "action", action: "ai_web", needs_env: ["OPENAI_API_KEY"],
  inputs: { prompt: `"[fx:p5] company=Plain; Retrieve the company’s official website from site:" + {{use_website}} + ", and use it."`, memory_key: `"p5 " + {{use_website}}`, page_url: "{{website}}", site: "{{use_website}}" },
  config: cfg("email_extraction_claygent"),
};
const waterfall = { key: "use_website", name: "Use Website", kind: "waterfall", data_type: "url", waterfall: ["{{website_ai}}", "{{website}}"] };
const inputsCols = [
  { key: "website", kind: "input" },
  { key: "website_ai", kind: "input" },
];
const db = fakeDb();
net.openai.set("p5", { company_emails_found: "N/A" });
net.pages.set("https://plain5.example/", "<p>no address</p>");
const runOnce = async (cells = new Map(), force = []) => {
  const put = new Map(cells);
  const res = await runRow({
    row: { id: 50, created_at: new Date(), run_force: force },
    table: { id: "t5", client_tag: "TEST5" },
    columns: [...inputsCols, waterfall, emailCol],
    cells: put,
    env,
    db,
    settings: engineSettings,
    hooks: {},
  });
  return res;
};
const inputCells = new Map([
  ["website", { status: "done", value: "https://plain5.example/", display: "https://plain5.example/" }],
  ["website_ai", { status: "done", value: "N/A", display: "N/A" }],
]);
const out1 = await runOnce(inputCells);
const kinds = [...db.memory.keys()].map((k) => k.split("|")[0]);
const mem = [...db.memory.values()][0];
check("a website waterfall skips the website AI's 'N/A' and takes the next step",
  out1.values?.use_website === "https://plain5.example/", JSON.stringify(out1.values?.use_website));
check(`the email search remembers under its page-reading kind (…_${PAGE_READ_MEMORY}, a kind the table's check takes), never the old one`,
  same(kinds, [`email_extraction_claygent_v1_${PAGE_READ_MEMORY}`]) && kinds.every((k) => /^[a-z][a-z0-9_]*$/.test(k)), JSON.stringify(kinds));
check("an 'N/A' answer is remembered for the nothing-found days (30), not the email days (90)", mem?.status === "done" && mem.display === "N/A" && mem.days === 30, JSON.stringify(mem));
const old = fakeDb();
old.memory.set(`email_extraction_claygent_v1|${memoryKey("p5 https://plain5.example/", { model: "gpt-test" })}`, { status: "done", value: { company_emails_found: "N/A" }, display: "N/A", client_tag: "OLD" });
const callsBefore = net.calls.openai;
const res2 = await runRow({
  row: { id: 51, created_at: new Date(), run_force: [] }, table: { id: "t5", client_tag: "TEST5" }, columns: [...inputsCols, waterfall, emailCol],
  cells: new Map(inputCells), env, db: old, settings: engineSettings, hooks: {},
});
check("an answer remembered under the old kind (before pages were read) is not reused: the search runs",
  net.calls.openai === callsBefore + 1 && res2.calls === 1, JSON.stringify({ calls: net.calls.openai - callsBefore, summary: res2.calls }));
const okDb = fakeDb();
net.openai.set("p5", { company_emails_found: "front@plain5.example" });
await runRow({
  row: { id: 52, created_at: new Date(), run_force: [] }, table: { id: "t5", client_tag: "TEST5" }, columns: [...inputsCols, waterfall, emailCol],
  cells: new Map(inputCells), env, db: okDb, settings: engineSettings, hooks: {},
});
check("a found address is remembered for the email days (90)", [...okDb.memory.values()][0]?.days === 90, JSON.stringify([...okDb.memory.values()][0]));

console.log(`\n${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(count.failed ? 1 : 0);

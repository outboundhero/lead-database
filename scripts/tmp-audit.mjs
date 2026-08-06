// Full-app Chromium audit (Playwright). Read-only: opens every page, exercises
// filters/dialogs, captures console errors, failed requests, and screenshots.
// Never deletes, never pushes, never saves shared state.
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = "https://lead-database-production.up.railway.app";
const OUT = "/private/tmp/claude-501/-Users-akeesh/49b01301-c8da-487d-a49b-0c92c5d58031/scratchpad/audit";
fs.mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(fs.readFileSync("/private/tmp/claude-501/-Users-akeesh/49b01301-c8da-487d-a49b-0c92c5d58031/scratchpad/audit-creds.json", "utf8"));

const findings = [];
const consoleErrors = [];
const failedReqs = [];
const note = (step, ok, detail = "") => {
  findings.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 300)));
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().includes("_next") && !r.url().includes("favicon")) {
    failedReqs.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`.slice(0, 200));
  }
});
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
const step = async (name, fn) => {
  try { await fn(); note(name, true); }
  catch (e) { note(name, false, String(e).split("\n")[0].slice(0, 220)); await shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {}); }
};

// ── Login ──────────────────────────────────────────────────────────────────
await step("login", async () => {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/leads|dashboard/, { timeout: 30000 });
  await shot("01-after-login");
});

// ── Leads page ─────────────────────────────────────────────────────────────
await step("leads: table renders with data", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  const contacts = await page.textContent("p.mt-0\\.5, p:has-text('contacts')").catch(() => "");
  if (!/contacts/.test(contacts ?? "")) throw new Error("contacts count line missing");
  await shot("02-leads");
});

await step("leads: Category chip + cascade checkboxes", async () => {
  await page.click('button:has-text("Category")', { timeout: 10000 });
  await page.waitForSelector('text=Also apply to Subcategory', { timeout: 10000 });
  await shot("03-category-cascade");
  await page.keyboard.press("Escape");
});

await step("leads: Client dropdown lists roster with counts", async () => {
  await page.click('button:has-text("Client")');
  await page.waitForSelector('input[placeholder*="clients"]', { timeout: 10000 });
  try {
    await page.waitForSelector('button:has-text("CWSJ")', { timeout: 12000 });
  } catch {
    await page.click('text=Not loading? Retry').catch(() => {});
    await page.waitForSelector('button:has-text("CWSJ")', { timeout: 20000 });
  }
  await shot("04-client-dropdown");
});

await step("leads: selecting CWSJ-OS applies targeting", async () => {
  await page.fill('input[placeholder*="clients"]', "CWSJ-OS");
  await page.click('button:has-text("CWSJ-OS")');
  await page.waitForSelector("[data-sonner-toast]", { timeout: 20000 });
  const toast = await page.textContent("[data-sonner-toast]");
  await shot("05-cwsjos-applied");
  if (!/applied|targeting|availability|filtering/i.test(toast ?? "")) throw new Error("no targeting toast: " + (toast ?? "").slice(0, 80));
  await page.keyboard.press("Escape");
});

await step("leads: City filter populated by targeting", async () => {
  const cityChip = await page.textContent('button:has-text("City")');
  if (!/\d/.test(cityChip ?? "")) throw new Error("City chip shows no active count after targeting apply");
});

await step("leads: Lists chip shows editable lists", async () => {
  await page.click('button:has-text("Lists")');
  await page.waitForSelector('text=Commercial cleaning titles', { timeout: 15000 });
  await shot("06-lists-chip");
  await page.keyboard.press("Escape");
});

await step("leads: copy search link", async () => {
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click('button:has-text("Copy search link")');
  await page.waitForSelector('[data-sonner-toast]:has-text("link")', { timeout: 20000 });
  await shot("07-share-link");
});

await step("leads: export popup with client scoping + stats", async () => {
  await page.click('button:has-text("Export")');
  await page.click('text=/Export Filtered|Export All/i', { timeout: 8000 }).catch(async () => {
    await page.click('[role="menuitem"]');
  });
  await page.waitForSelector('text=Bison campaigns', { timeout: 20000 });
  await page.waitForSelector('text=/already pushed|Checking what/i', { timeout: 20000 });
  await shot("08-export-popup");
  await page.keyboard.press("Escape");
});

// ── Clients page ───────────────────────────────────────────────────────────
await step("clients: page + Rules dialog with sheet banner", async () => {
  await page.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("Rules")', { timeout: 30000 });
  await page.locator('button:has-text("Rules")').first().click();
  await page.waitForSelector('text=/Targeting —|Include locations/', { timeout: 15000 });
  await shot("09-rules-dialog");
  await page.keyboard.press("Escape");
});

// ── Locations page ─────────────────────────────────────────────────────────
await step("locations: browse renders with counts", async () => {
  await page.goto(`${BASE}/locations`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=/United States|USA|Unresolved/i", { timeout: 45000 });
  await shot("10-locations");
});

// ── Lists page ─────────────────────────────────────────────────────────────
await step("lists: page + editor dialog", async () => {
  await page.goto(`${BASE}/lists`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('text=Commercial cleaning titles', { timeout: 30000 });
  await page.click('text=Commercial cleaning titles');
  await page.waitForSelector('text=/Edit list/', { timeout: 10000 });
  await shot("11-lists-editor");
  await page.keyboard.press("Escape");
});

// ── Exports page ───────────────────────────────────────────────────────────
await step("exports: push panel + routing totals", async () => {
  await page.goto(`${BASE}/exports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('text=Bison pushes', { timeout: 30000 });
  await page.locator('button:has-text("Routing totals")').first().click();
  await page.waitForSelector("text=/→|Loading totals/", { timeout: 20000 });
  await shot("12-exports-panel");
});

// ── Dashboard / API keys / Admin ───────────────────────────────────────────
await step("dashboard renders", async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1, [class*=card]", { timeout: 45000 });
  await shot("13-dashboard");
});
await step("api-keys: documentation card", async () => {
  await page.goto(`${BASE}/api-keys`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('text=API documentation', { timeout: 30000 });
  await page.waitForSelector('text="POST /api/v1/leads"', { timeout: 5000 });
  await shot("14-api-docs");
});
await step("admin renders", async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1, table, [class*=card]", { timeout: 30000 });
  await shot("15-admin");
});

// ── Shared-link restore round trip ─────────────────────────────────────────
await step("shared link restores the search", async () => {
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  if (!clip.includes("/leads?s=")) throw new Error("no share link in clipboard (headless limitation ok)");
  await page.goto(clip, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-sonner-toast]:has-text("restored")', { timeout: 20000 });
  await shot("16-shared-restore");
});

await browser.close();

const summary = {
  pass: findings.filter((f) => f.ok).length,
  fail: findings.filter((f) => !f.ok).length,
  findings,
  consoleErrors: [...new Set(consoleErrors)].slice(0, 25),
  failedRequests: [...new Set(failedReqs)].slice(0, 25),
};
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`\n=== ${summary.pass} pass / ${summary.fail} fail | console errors: ${summary.consoleErrors.length} | failed requests: ${summary.failedRequests.length}`);

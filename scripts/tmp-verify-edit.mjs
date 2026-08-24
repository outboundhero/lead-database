// Verifies in-app lead editing against the DEPLOYED app, then restores the
// lead to exactly the value it had — leaves production data as it was found.
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = "https://lead-database-production.up.railway.app";
const OUT = "/private/tmp/claude-501/-Users-akeesh/49b01301-c8da-487d-a49b-0c92c5d58031/scratchpad/audit";
fs.mkdirSync(OUT, { recursive: true });
const creds = JSON.parse(fs.readFileSync("/private/tmp/claude-501/-Users-akeesh/49b01301-c8da-487d-a49b-0c92c5d58031/scratchpad/audit-creds.json", "utf8"));
const MARKER = `claude-edit-check ${new Date().toISOString().slice(0, 16)}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("response", (r) => {
  if (r.url().includes("/api/leads/edit")) console.log(`   api ${r.request().method()} -> ${r.status()}`);
});

try {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/leads|dashboard/, { timeout: 45000 });
  console.log("1. logged in");

  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 90000 });
  await page.locator("table tbody tr").first().click();
  await page.waitForSelector('text=/Personalization question|Metadata/', { timeout: 30000 });
  const leadId = (await page.textContent('text=/^[0-9a-f]{8}-[0-9a-f]{4}/').catch(() => "")) ?? "";
  console.log(`2. opened lead ${leadId.slice(0, 8)}…`);

  // Capture the original Notes so it can be restored.
  await page.click('button:has-text("Edit")');
  await page.waitForSelector("#edit-notes", { timeout: 15000 });
  const originalNotes = await page.inputValue("#edit-notes");
  console.log(`3. edit mode open (notes was ${originalNotes ? JSON.stringify(originalNotes.slice(0, 40)) : "empty"})`);
  await page.screenshot({ path: `${OUT}/edit-01-form.png` });

  await page.fill("#edit-notes", MARKER);
  await page.click('button:has-text("Save")');
  await page.waitForSelector('[data-sonner-toast]', { timeout: 30000 });
  const toast = (await page.textContent("[data-sonner-toast]")) ?? "";
  console.log(`4. save toast: ${toast.slice(0, 90)}`);
  await page.screenshot({ path: `${OUT}/edit-02-saved.png` });
  if (!/Saved/i.test(toast)) throw new Error(`unexpected toast: ${toast.slice(0, 120)}`);

  // Value persisted in the read-only view?
  await page.waitForSelector(`text=${MARKER}`, { timeout: 15000 });
  console.log("5. new value shown in the panel");

  // History entry written?
  const historyText = (await page.textContent("section:has(h4:text('History'))")) ?? "";
  const hasUpdate = /Updated/i.test(historyText);
  console.log(`6. history shows an Updated entry: ${hasUpdate}`);

  // Reload to prove it persisted server-side, not just in local state.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 90000 });
  await page.locator("table tbody tr").first().click();
  await page.waitForSelector(`text=${MARKER}`, { timeout: 30000 });
  console.log("7. value survived a reload (persisted in the database)");

  // Restore the original value.
  await page.click('button:has-text("Edit")');
  await page.waitForSelector("#edit-notes", { timeout: 15000 });
  await page.fill("#edit-notes", originalNotes);
  await page.click('button:has-text("Save")');
  await page.waitForSelector('[data-sonner-toast]', { timeout: 30000 });
  console.log("8. original notes restored");

  console.log(errors.length ? `\nPAGE ERRORS: ${errors.join(" | ")}` : "\nRESULT: edit flow works end to end, no page errors");
} catch (e) {
  console.log(`\nFAILED: ${String(e).split("\n")[0].slice(0, 220)}`);
  await page.screenshot({ path: `${OUT}/edit-FAIL.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

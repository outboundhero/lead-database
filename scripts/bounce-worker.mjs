#!/usr/bin/env node
// bounce-worker.mjs — Email Bison bounce classifier.
//
// Runs as a separate Railway cron service in the same project (suggested
// schedule: */15 * * * *). Start command:  node scripts/bounce-worker.mjs
//
// For every lead with bounces > 0 that hasn't been checked yet, fetches its
// bounced replies from Email Bison (GET /api/leads/{email}/replies?folder=bounced
// — the endpoint accepts the lead's email as the id) and classifies the NDR:
//
//   'sender'  -> our sending inbox's fault (auth/quota/reputation/rate-limit).
//                The lead is still contactable: is_bounced is flipped back to
//                false so the lead re-enters default filters and exports.
//   'hard'    -> recipient invalid / blocked / policy rejection. Never contact:
//                is_bounced stays true (default-excluded, never exported).
//   'unknown' -> no bounce reply found or ambiguous NDR. Treated like hard
//                (conservative) but distinguishable for manual review.
//
// Env:
//   DATABASE_URL             required — Supabase pooler URL
//   EMAILBISON_API_KEY       required — Bison workspace API token
//   EMAILBISON_BASE_URL      optional — default: per-lead https://{instance_url}
//   BOUNCE_WORKER_BATCH      optional — leads per run (default 200)
//   BOUNCE_WORKER_DELAY_MS   optional — delay between API calls (default 300)
//
// Modes:
//   node scripts/bounce-worker.mjs                    live run
//   node scripts/bounce-worker.mjs --dry-run          classify but don't write
//   node scripts/bounce-worker.mjs --test-classifier  run built-in NDR corpus

import pg from "pg";

// ─── Classifier ─────────────────────────────────────────────────────────────
// Order matters: specific sender-side patterns are checked first, then
// recipient/policy (hard), then BROAD sender tokens last — so a hard verdict
// wins when an NDR carries both (e.g. quoted auth diagnostics alongside
// "550 5.1.1 user unknown"). NDRs are machine-generated, so pattern matching
// covers the overwhelming majority.

const SENDER_PATTERNS = [
  // Our account / inbox problems
  /your (account|email account|mailbox) (has been|is|was) (suspended|disabled|locked|restricted)/i,
  /sending (limit|quota) (exceeded|reached)/i,
  /daily (sending |user sending |)(limit|quota)/i,
  /exceeded.{0,40}(sending|message|rate) (limit|quota)/i,
  /too many (messages|emails|connections|requests)/i,
  /temporar(y|ily) (deferred|rejected|unavailable|failure)/i,
  // Sender authentication / reputation
  /authentication (failed|required|error)/i,
  /unable to authenticate/i,
  /sender (address |domain |)(rejected|denied|blocked|flagged)/i,
  /sending (ip|domain|server).{0,40}(blocked|blacklist|listed|poor reputation)/i,
  /(ip|host).{0,30}(blacklist|black list|dnsbl|rbl|spamhaus|spamcop|barracuda)/i,
  /poor (sender |ip |domain |)reputation/i,
  /message.{0,30}(identified|detected|flagged) as spam/i,
  /banned sending ip/i,
];

// Broad sender tokens, checked AFTER hard patterns so hard-bounce evidence
// wins when both appear (F08). spf/dkim/dmarc mentions only count with
// failure context — 'spf=pass' in quoted Authentication-Results must not
// classify a dead mailbox as 'sender'.
const SENDER_BROAD_PATTERNS = [
  /\b(spf|dkim|dmarc)\b[^.\n]{0,60}\b(fail(ed|ure|s)?|softfail|permerror|invalid|missing)\b/i,
  /\b(fail(ed|ure|s)?|softfail|permerror|(does )?not pass(ed)?)\b[^.\n]{0,60}\b(spf|dkim|dmarc)\b/i,
  /rate limit/i,
  /try again later/i,
  /\b(421|450|451|452)[ -]/,
];

const HARD_PATTERNS = [
  // Recipient doesn't exist
  /user (unknown|not found|does ?n[o']t exist|invalid)/i,
  /no such (user|recipient|mailbox|address|person)/i,
  /mailbox (unavailable|not found|does ?n[o']t exist|disabled|inactive|invalid)/i,
  /recipient (not found|rejected|unknown|invalid|does ?n[o']t exist)/i,
  /(recipient |)address (not found|rejected|unknown|invalid|no longer (valid|in use))/i,
  /invalid (recipient|mailbox|address)/i,
  /email (account|address) .{0,40}(does ?n[o']t exist|disabled|discontinued)/i,
  /account (disabled|deactivated|discontinued|closed)/i,
  /\b550[ -]5\.1\.[01]\b/,
  /\b(551|553)[ -]/,
  /delivery to the following recipient failed permanently/i,
  /permanent(ly)? (failure|error|rejected|delivery failure)/i,
  // Recipient-side policy blocks
  /blocked (by|due to|for) .{0,40}(policy|administrator|recipient|organization)/i,
  /message rejected due to .{0,40}(policy|content)/i,
  /rejected (by|due to) .{0,40}(policy|recipient)/i,
  /access denied/i,
  /prohibited by administrator/i,
  /recipient.{0,40}(policy|blocked)/i,
  /this message was blocked/i,
];

// Recipient-storage failures — checked BEFORE sender patterns so the generic
// 4xx temp-code pattern doesn't swallow "452 mailbox full". Kept as 'unknown'
// (recipient-side but possibly temporary — not our inbox's fault, not proof
// the address is dead).
const SOFT_STORAGE_PATTERNS = [
  /mailbox (is )?full/i,
  /over quota/i,
  /quota exceeded/i, // recipient-side storage, not our sending quota
];

// Other undecidable signals, checked last
const SOFT_OTHER_PATTERNS = [
  /out of (the )?office/i,
  /auto[- ]?reply/i,
];

// NDRs often append the returned original message (its headers, quoted body,
// Authentication-Results table). Everything after such a boundary describes
// OUR outbound mail, not the bounce verdict — classify only what precedes it.
const QUOTED_BOUNDARY_RE = new RegExp(
  [
    "-{2,}\\s*original message", // -----Original Message----- (survives HTML stripping)
    "begin forwarded message",
    "^[ \\t]*original message[ \\t:]*$",
    "^[ \\t]*from:",
    "^[ \\t]*>",
  ].join("|"),
  "im"
);

function truncateAtQuotedOriginal(text) {
  const m = text.match(QUOTED_BOUNDARY_RE);
  return m ? text.slice(0, m.index) : text;
}

function classifyText(ndr) {
  for (const re of SOFT_STORAGE_PATTERNS) {
    const m = ndr.match(re);
    if (m) return { type: "unknown", matched: m[0] };
  }
  for (const re of SENDER_PATTERNS) {
    const m = ndr.match(re);
    if (m) return { type: "sender", matched: m[0] };
  }
  for (const re of HARD_PATTERNS) {
    const m = ndr.match(re);
    if (m) return { type: "hard", matched: m[0] };
  }
  for (const re of SENDER_BROAD_PATTERNS) {
    const m = ndr.match(re);
    if (m) return { type: "sender", matched: m[0] };
  }
  for (const re of SOFT_OTHER_PATTERNS) {
    const m = ndr.match(re);
    if (m) return { type: "unknown", matched: m[0] };
  }
  return { type: "unknown", matched: null };
}

export function classifyBounce(text) {
  if (!text || !text.trim()) {
    return { type: "unknown", matched: null };
  }
  const ndr = truncateAtQuotedOriginal(text);
  const verdict = classifyText(ndr);
  // The quoted-original boundary can over-fire (any line-start "From:"/">"
  // ahead of the diagnostic). If the truncated text matched nothing but the
  // full text does, the diagnostic sat below the false boundary — use it.
  if (verdict.matched === null && ndr.length < text.length) {
    return classifyText(text);
  }
  return verdict;
}

function stripHtml(html) {
  return (html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Built-in test corpus (--test-classifier) ───────────────────────────────

const TEST_CORPUS = [
  ["550 5.1.1 The email account that you tried to reach does not exist", "hard"],
  ["550 5.1.1 <bob@x.com>: Recipient address rejected: User unknown", "hard"],
  ["Delivery to the following recipient failed permanently: jane@corp.com", "hard"],
  ["554 5.7.1 Message rejected due to local policy", "hard"],
  ["550 5.7.1 This message was blocked by the recipient's organization policy", "hard"],
  ["Your message was blocked. Access denied. Prohibited by administrator.", "hard"],
  ["550 No such user here", "hard"],
  ["Mailbox unavailable. The recipient's mailbox is disabled.", "hard"],
  ["421 4.7.0 Try again later, closing connection", "sender"],
  ["451 4.7.1 Sending rate limit exceeded for your account", "sender"],
  ["550 5.7.26 This message does not pass DKIM authentication checks", "sender"],
  ["SPF validation failed for sending domain outboundclean.com", "sender"],
  ["Your IP 1.2.3.4 is listed on Spamhaus. Delivery blocked.", "sender"],
  ["Daily user sending limit exceeded. Message not sent.", "sender"],
  ["Sender address rejected: poor reputation", "sender"],
  ["452 4.2.2 The recipient's mailbox is full", "unknown"],
  ["The recipient's inbox is over quota", "unknown"],
  ["", "unknown"],
  // F08 mixed-signal NDRs: hard verdict must win over sender tokens in the
  // quoted original message / auth diagnostics appended below it
  [
    "Undeliverable: quick intro\n550 5.1.1 User unknown\n\n-----Original Message-----\nFrom: us@outboundclean.com\nAuthentication-Results: spf=pass; dkim=pass; dmarc=pass",
    "hard",
  ],
  [
    "Mail delivery failed\nRecipient address rejected: mailbox not found\n\nOriginal message\nDKIM authentication failed for outboundclean.com",
    "hard",
  ],
  [
    "550 5.1.1 <bob@x.com> does not exist. Authentication-Results: spf=pass dkim=pass",
    "hard",
  ],
  [
    "Delivery status\n550 user unknown\n> From: us@outboundclean.com\n> Subject: quick intro about SPF failures",
    "hard",
  ],
  // Sender NDRs stay 'sender' even with a quoted original appended
  [
    "Delivery temporarily deferred, try again later\n\n-----Original Message-----\nFrom: us@outboundclean.com",
    "sender",
  ],
];

// ─── Worker ──────────────────────────────────────────────────────────────────

const BATCH = parseInt(process.env.BOUNCE_WORKER_BATCH ?? "200", 10);
const DELAY_MS = parseInt(process.env.BOUNCE_WORKER_DELAY_MS ?? "300", 10);
const REASON_MAX = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Multi-instance keys (mirrors src/lib/bison/keys.ts): the client runs three
// separate Bison installs, each with its own token. EMAILBISON_KEYS is a JSON
// map of instance domain -> token; EMAILBISON_API_KEY is the untagged default.
const normalizeDomain = (v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
const KEY_MAP = (() => {
  const out = {};
  try {
    if (process.env.EMAILBISON_KEYS) {
      for (const [d, k] of Object.entries(JSON.parse(process.env.EMAILBISON_KEYS))) {
        if (typeof k === "string" && k.trim()) out[normalizeDomain(d)] = k.trim();
      }
    }
  } catch { console.error("EMAILBISON_KEYS is not valid JSON — ignoring"); }
  return out;
})();
const DEFAULT_KEY = (process.env.EMAILBISON_API_KEY ?? "").trim() || null;
const DEFAULT_DOMAIN = normalizeDomain(process.env.EMAILBISON_BASE_URL || "app.outboundhero.co");

// Returns { base, key } for a lead's instance, or null when no key covers it.
function authFor(lead) {
  const domain = lead.instance_url ? normalizeDomain(lead.instance_url) : DEFAULT_DOMAIN;
  const key = KEY_MAP[domain] ?? DEFAULT_KEY;
  return key ? { base: `https://${domain}`, key } : null;
}

async function fetchBouncedReplies(lead, auth) {
  const url = `${auth.base}/api/leads/${encodeURIComponent(lead.email)}/replies?folder=bounced`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.key}`, Accept: "application/json" },
  });
  if (res.status === 404) return { notFound: true, replies: [] };
  if (res.status === 401 || res.status === 403) {
    // Wrong/missing key for THIS instance — non-fatal in a multi-instance
    // setup; the consecutive-error guard still aborts a fully-broken run.
    throw new Error(`Bison auth failed for ${auth.base} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`Bison HTTP ${res.status} for ${lead.email}`);
  }
  const json = await res.json();
  const replies = Array.isArray(json?.data) ? json.data : [];
  return { notFound: false, replies };
}

// Failed lookups still get bounce_checked_at so ORDER BY bounce_checked_at
// NULLS FIRST moves them to the BACK of the queue instead of head-of-line
// blocking every run; they re-enter when bounced_at advances past it.
// bounce_type / is_bounced are left untouched (lead stays excluded).
async function markCheckFailed(client, lead, why) {
  // Don't clobber a legitimate NDR snippet from an earlier classification —
  // only fill bounce_reason when there is none yet.
  await client.query(
    `UPDATE leads
     SET bounce_reason = COALESCE(bounce_reason, $1),
         bounce_checked_at = now(),
         updated_at = now()
     WHERE id = $2`,
    [`check_failed: ${why}`.slice(0, REASON_MAX), lead.id]
  );
}

function extractNdrText(replies) {
  if (replies.length === 0) return null;
  // Most recent bounce reply carries the definitive NDR
  const sorted = [...replies].sort(
    (a, b) => new Date(b.date_received ?? 0) - new Date(a.date_received ?? 0)
  );
  const r = sorted[0];
  const body = r.text_body?.trim() ? r.text_body : stripHtml(r.html_body);
  return `${r.subject ?? ""}\n${body ?? ""}`.trim();
}

async function run({ dryRun }) {
  if (!DEFAULT_KEY && Object.keys(KEY_MAP).length === 0) {
    console.error("No Bison keys set (EMAILBISON_KEYS or EMAILBISON_API_KEY) — nothing to do.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Candidates: bounced leads never checked, re-bounced since last check, or
  // re-imports that re-flipped is_bounced on an already-'sender' lead.
  const { rows: leads } = await client.query(
    `SELECT id, email, instance_url, bounces
     FROM leads
     WHERE bounces > 0 AND email IS NOT NULL
       AND (
         bounce_checked_at IS NULL
         OR (bounced_at IS NOT NULL AND bounced_at > bounce_checked_at)
         OR (is_bounced = true AND bounce_type = 'sender')
       )
     ORDER BY bounce_checked_at NULLS FIRST
     LIMIT $1`,
    [BATCH]
  );

  console.log(`bounce-worker: ${leads.length} lead(s) to check${dryRun ? " (dry run)" : ""}`);
  if (leads.length === 0) {
    await client.end();
    return;
  }

  const counts = { sender: 0, hard: 0, unknown: 0, errors: 0 };
  let consecutiveErrors = 0;

  for (const lead of leads) {
    const auth = authFor(lead);
    if (!auth) {
      // No key for this lead's instance yet — defer to the back of the queue.
      const domain = lead.instance_url ? normalizeDomain(lead.instance_url) : DEFAULT_DOMAIN;
      counts.errors++;
      if (!dryRun) await markCheckFailed(client, lead, `no API key for instance ${domain}`);
      console.error(`  ${lead.email} -> ERROR no API key for instance ${domain} (deferred)`);
      continue;
    }
    try {
      const { notFound, replies } = await fetchBouncedReplies(lead, auth);
      let type, reason;

      if (notFound) {
        type = "unknown";
        reason = "Lead not found in Email Bison";
      } else {
        const ndr = extractNdrText(replies);
        if (!ndr) {
          type = "unknown";
          reason = "No bounced reply found in Email Bison";
        } else {
          const c = classifyBounce(ndr);
          type = c.type;
          reason = (c.matched ? `[${c.matched}] ` : "") + ndr.slice(0, REASON_MAX);
        }
      }

      if (!dryRun) {
        await client.query(
          `UPDATE leads
           SET bounce_type = $1,
               bounce_reason = $2,
               bounce_checked_at = now(),
               is_bounced = $3,
               updated_at = now()
           WHERE id = $4`,
          [type, reason.slice(0, REASON_MAX + 60), type !== "sender", lead.id]
        );
      }
      counts[type]++;
      consecutiveErrors = 0;
      console.log(`  ${lead.email} -> ${type}${dryRun ? " (not written)" : ""}`);
    } catch (err) {
      if (err.fatal) {
        console.error(String(err.message));
        await client.end();
        process.exit(1);
      }
      counts.errors++;
      consecutiveErrors++;
      if (!dryRun) await markCheckFailed(client, lead, err.message);
      console.error(`  ${lead.email} -> ERROR ${err.message} (deferred to back of queue)`);
      if (consecutiveErrors >= 10) {
        console.error("10 consecutive errors — aborting run (Bison likely down).");
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(
    `bounce-worker done: sender=${counts.sender} hard=${counts.hard} unknown=${counts.unknown} errors=${counts.errors}`
  );
  await client.end();
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--test-classifier")) {
  let pass = 0;
  for (const [text, expected] of TEST_CORPUS) {
    const { type } = classifyBounce(text);
    const ok = type === expected;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} [${expected} -> ${type}] ${text.slice(0, 70)}`);
  }
  console.log(`\n${pass}/${TEST_CORPUS.length} passed`);
  process.exit(pass === TEST_CORPUS.length ? 0 : 1);
} else {
  run({ dryRun: args.includes("--dry-run") }).catch((err) => {
    console.error("bounce-worker fatal:", err);
    process.exit(1);
  });
}

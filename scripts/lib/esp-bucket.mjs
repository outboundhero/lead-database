// ESP → routing bucket (client req #9). Shared by the push-worker and the
// campaign-remediation tooling so both route identically.
//
//   outlook — Microsoft / Outlook / Office 365 mailboxes
//   seg     — recognized security email gateways (filtering appliances in
//             front of the real mailbox)
//   default — Google, Zoho, custom mail servers, unknown: everything else
//
// The leads.esp column currently holds: Barracuda, Custom, Google,
// Microsoft / Outlook, Mimecast, Proofpoint, Zoho — but match generously so
// future enrichment values route correctly without a code change.

const SEG_PATTERNS = [
  "mimecast", "proofpoint", "barracuda", "ironscales", "abnormal", "avanan",
  "sophos", "trend micro", "trendmicro", "cisco", "ironport", "messagelabs",
  "symantec", "broadcom", "fortinet", "fortimail", "trustwave", "mxlogic",
  "mx layer", "spamtitan", "mailguard", "perception point", "agari", "area 1",
  "greathorn", "zerospam", "libraesva", "hornetsecurity", "retarus", "vipre",
];

export function espBucket(esp) {
  const v = String(esp ?? "").toLowerCase();
  if (/microsoft|outlook|office\s*365|o365|exchange/.test(v)) return "outlook";
  if (SEG_PATTERNS.some((s) => v.includes(s))) return "seg";
  return "default";
}

// Campaign-name → suggested bucket, for pre-filling routing UIs
// ("CWSJ-OS: SEGs (Cleaning Client)" -> seg).
export function suggestBucketFromName(name) {
  const n = String(name ?? "").toLowerCase();
  if (/\bseg s?\b|\bsegs?\b|gateway/.test(n)) return "seg";
  if (/outlook|microsoft|o365/.test(n)) return "outlook";
  if (/google|custom|gsuite|workspace/.test(n)) return "default";
  return null;
}

// ESP → routing bucket (client req #9). TypeScript twin of
// scripts/lib/esp-bucket.mjs (the push-worker's copy) — keep the two in sync.
//
//   outlook — Microsoft / Outlook / Office 365 mailboxes
//   seg     — recognized security email gateways
//   default — Google, Zoho, custom mail servers, unknown: everything else

export type EspBucket = "outlook" | "seg" | "default";

const SEG_PATTERNS = [
  "mimecast", "proofpoint", "barracuda", "ironscales", "abnormal", "avanan",
  "sophos", "trend micro", "trendmicro", "cisco", "ironport", "messagelabs",
  "symantec", "broadcom", "fortinet", "fortimail", "trustwave", "mxlogic",
  "mx layer", "spamtitan", "mailguard", "perception point", "agari", "area 1",
  "greathorn", "zerospam", "libraesva", "hornetsecurity", "retarus", "vipre",
];

export function espBucket(esp: string | null | undefined): EspBucket {
  const v = String(esp ?? "").toLowerCase();
  if (/microsoft|outlook|office\s*365|o365|exchange/.test(v)) return "outlook";
  if (SEG_PATTERNS.some((s) => v.includes(s))) return "seg";
  return "default";
}

// Campaign-name → suggested bucket for pre-filling routing UIs
// ("CWSJ-OS: SEGs (Cleaning Client)" -> seg).
export function suggestBucketFromName(name: string | null | undefined): EspBucket | null {
  const n = String(name ?? "").toLowerCase();
  if (/\bsegs?\b|gateway/.test(n)) return "seg";
  if (/outlook|microsoft|o365/.test(n)) return "outlook";
  if (/google|custom|gsuite|workspace/.test(n)) return "default";
  return null;
}

export const BUCKET_LABELS: Record<EspBucket, string> = {
  outlook: "Outlook",
  seg: "Security gateways",
  default: "Google + Custom",
};

// Translate raw database/API errors into operator language (client req #11).
// Anything unmatched passes through unchanged — never hide a real message.

const RULES: Array<[RegExp, string]> = [
  [/requires a where clause/i,
    "Nothing was selected to delete — select rows or set at least one filter first."],
  [/statement timeout|canceling statement due to/i,
    "The database took too long on that request — narrow the filters and try again."],
  [/jwt expired|invalid jwt|refresh_token/i,
    "Your session expired — refresh the page and sign in again."],
  [/too many connections|connection terminated|ECONNRESET|ETIMEDOUT/i,
    "The database connection dropped — wait a few seconds and try again."],
  [/duplicate key value/i,
    "That name already exists — pick a different one."],
  [/violates foreign key/i,
    "Something still references this item — remove those references first."],
  [/permission denied|violates row-level security/i,
    "Your account doesn't have permission for that — ask an admin."],
];

export function friendlyError(raw: unknown, fallback = "Something went wrong"): string {
  const msg = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (!msg) return fallback;
  for (const [re, friendly] of RULES) if (re.test(msg)) return friendly;
  return msg;
}

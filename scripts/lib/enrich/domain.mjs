// A website or address reduced to its bare domain (Clay's "Normalize a Domain",
// type "bare"). Its own module so the Clay actions (actions.mjs), the company
// actions (company-actions.mjs) and the AI Ark client can share it without
// importing each other. actions.mjs re-exports it.

const text = (v) => (v == null ? "" : String(v).trim());

/** "https://www.Example.com/about?x" -> "example.com"; anything without a domain -> null. */
export function bareDomain(input) {
  let s = text(input).toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^/@]*@/, "");
  s = s.split(/[/?#\s]/)[0];
  s = s.replace(/:\d+$/, "").replace(/\.+$/, "");
  s = s.replace(/^www\d?\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

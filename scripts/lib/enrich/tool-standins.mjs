// Named stand-ins for two of Clay's built-in tools whose logic is not in the
// export (D38): normalize-company-name (G#14, P#29) and normalize-phone-number
// (G#35, P#18). They are ours, not Clay's, and their answers can differ from
// what Clay gave; every value says so (stand_in: true).
//
// Shipped off. The template columns stay on the `waiting` action
// (pipeline-actions.mjs) until Akeesh says a stand-in may be used; only then
// does the column's action become one of these (at integration, in the
// template files). Until then nothing calls them.
//
// What the originals read from them (and so what these answer):
//   normalize_company_name  { companyName, titleCase }  -> { normalized_name }       (G#15, P#30 read ?.normalized_name)
//   normalize_phone_number  { phoneNumber, countryCode } -> { number: { national } } (G#36, P#19 read ?.number?.national)

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/** A word kept as written: an all-caps word of up to 4 letters ("HQ"), or one holding a digit or "&". */
const KEEP = /^(?:[A-Z]{1,4}|.*[0-9&].*)$/;
const SMALL = new Set(["and", "of", "the", "for", "at", "in", "on", "by", "to", "a", "an"]);

/**
 * The company-name stand-in: spaces collapsed, stray punctuation at the ends
 * dropped, and in title case when asked (short all-caps words, and words with
 * a digit or "&", kept as written; small joining words lower case inside the
 * name). Nothing is removed from the name (G#20 itself strips LLC and the like).
 *
 * @param {{ companyName?: unknown, titleCase?: unknown }} inputs
 * @returns {string}
 */
export function normalizeCompanyName({ companyName, titleCase = true } = {}) {
  let s = text(companyName).replace(/^[\s,;:.\-|]+|[\s,;:|\-]+$/g, "");
  if (!s) return "";
  if (titleCase === true || titleCase === "true") {
    s = s
      .split(" ")
      .map((w, i) => {
        if (KEEP.test(w)) return w;
        const lower = w.toLowerCase();
        if (i > 0 && SMALL.has(lower)) return lower;
        return lower.replace(/(^|[-'(/])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
      })
      .join(" ");
  }
  return s;
}

/**
 * The phone stand-in: a North American number (10 digits, or 11 starting
 * with 1, with a valid area code and exchange) in national format
 * "(312) 555-0100" and E.164; anything else gives nothing.
 *
 * @param {{ phoneNumber?: unknown, countryCode?: unknown }} inputs
 * @returns {{ national: string, e164: string, country: string } | null}
 */
export function normalizePhoneNumber({ phoneNumber, countryCode } = {}) {
  let d = text(phoneNumber).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  const cc = text(countryCode).toUpperCase();
  return {
    national: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    e164: `+1${d}`,
    country: cc === "CA" ? "CA" : "US",
  };
}

async function normalizeCompanyNameAction({ inputs }) {
  const name = normalizeCompanyName(inputs ?? {});
  if (!name) return { status: "empty", note: "No company name" };
  return {
    status: "done",
    value: { normalized_name: name, stand_in: true },
    display: name,
    note: "Our stand-in for Clay's normalize-company-name (its rules are not in the export)",
  };
}

async function normalizePhoneNumberAction({ inputs }) {
  const number = normalizePhoneNumber(inputs ?? {});
  if (!number) return { status: "empty", note: "Not a North American number: the stand-in formats only those" };
  return {
    status: "done",
    value: { number, stand_in: true },
    display: number.national,
    note: "Our stand-in for Clay's normalize-phone-number (its rules are not in the export)",
  };
}

/** The stand-in actions, registered beside the others in ACTIONS (actions.mjs) at integration; no column uses them until Akeesh says yes. */
export const TOOL_STANDIN_ACTIONS = Object.freeze({
  normalize_company_name: Object.freeze({ run: normalizeCompanyNameAction, cache: true }),
  normalize_phone_number: Object.freeze({ run: normalizePhoneNumberAction, cache: true }),
});

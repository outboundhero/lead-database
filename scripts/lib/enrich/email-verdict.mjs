// Who found or approved the address a contact is promoted with (2026-11-21:
// promotion as Clay does it). Clay sends a finder's address straight to Use
// Work Email (P#55) with no Reoon check, and Enrichley's approval counts as
// Reoon's does, so promotion takes every address P#55 or G#44 can be traced
// to: Reoon's stamp, Enrichley's stamp, or an email finder's own answer. The
// verdict says which, and the lead says so: its validation status (status
// here) and its source (verdictSource). An address traced to none of them is
// held back.
//
// Plain JavaScript with no database code: promotion (promote.mjs) and the AI
// Ark pulls' hand-back (pull-no-email.mjs) read the same cells the same way.
//
// A person's sources, in P#55's own order (P#50's, then P#15's, then P#51,
// P#52 and P#54); the first whose address is the promoted one wins:
//
//   find_work_email_findymail.email (P#46)                   found by Findymail
//   find_work_email_prospeo.email (P#47)                     found by Prospeo (valid when VERIFIED)
//   find_work_email_anymail_finder.results.email (P#48),
//     with results.validation "valid"                        found by Anymail Finder (valid)
//   validate_email_anymail_finder_find_work_email (P#49),
//     .valid true on .email                                  found by Anymail Finder, approved by Enrichley
//   email (P#9), reoon_stamp_of_approval true (P#12)         approved by Reoon (valid)
//   email (P#9), enrichly_stamp_of_approval true (P#14)      approved by Enrichley (P#13's result)
//   find_work_email_from_linkedin_url_findymail.email (P#51) found by Findymail
//   find_work_email_and_enrich_person_from_linkedin_url
//     .email.email (P#52)                                    found by Prospeo (valid when VERIFIED)
//   validate_email_anymail_finder_from_linkedin (P#54),
//     .valid true on .email                                  found by Anymail Finder, approved by Enrichley
//
// An inbox (G#13): Reoon's stamp (G#40), else Enrichley's (G#42, with G#41's
// result). Addresses are compared trimmed and in lower case, and a cell whose
// value is not the shape its vendor answers in never matches.
//
// status is what leads.validation_status takes: "valid", "catch_all" (an
// Enrichley result holding catch_all), or null (Findymail gives no verdict,
// and Prospeo only its VERIFIED one): the import then writes NULL, which is
// sendable and claims no check.

import { VENDOR_CAP_LABELS } from "./settings.mjs";

/** The cells the verdicts read (beside the address itself), by contact kind. */
export const VERDICT_CELLS = Object.freeze({
  general: Object.freeze(["general_email", "reoon_stamp_of_approval", "enrichly_stamp_of_approval", "enrichly_validation"]),
  person: Object.freeze([
    "use_work_email",
    "find_work_email_findymail",
    "find_work_email_prospeo",
    "find_work_email_anymail_finder",
    "validate_email_anymail_finder_find_work_email",
    "email",
    "reoon_stamp_of_approval",
    "enrichly_stamp_of_approval",
    "enrichly_validation",
    "find_work_email_from_linkedin_url_findymail",
    "find_work_email_and_enrich_person_from_linkedin_url",
    "validate_email_anymail_finder_from_linkedin",
  ]),
});

/** The vendors' names as the sources say them: the settings sheet's, and Reoon. */
const VENDOR_NAMES = Object.freeze({ ...VENDOR_CAP_LABELS, reoon: "Reoon" });

/**
 * @typedef {"findymail" | "prospeo" | "anymail_finder" | "enrichley" | "reoon"} Vendor
 * @typedef {{ address: string, found_by: Vendor | null, approved_by: Vendor, status: "valid" | "catch_all" | null }} Verdict
 */

/** An address as compared: trimmed, lower case; "" for anything that is not text. */
const addr = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
/** A vendor's answer object, or null for anything else. */
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/**
 * Enrichley's verdict on an answer as leads.validation_status: "catch_all"
 * when it approved a catch-all address (result catch_all or
 * catch_all_validated), "valid" for any other approval (ok), null when it did
 * not approve (valid is not true) or the answer is not one.
 *
 * @param {unknown} answer
 * @returns {"valid" | "catch_all" | null}
 */
export function enrichleyStatus(answer) {
  const a = obj(answer);
  if (!a || a.valid !== true) return null;
  return lower(a.result).includes("catch_all") ? "catch_all" : "valid";
}

/** Prospeo's own check: VERIFIED (any case) is valid; anything else claims nothing. */
const prospeoStatus = (status) => (lower(status) === "verified" ? "valid" : null);

/**
 * The verdict on a People row's promoted address (P#55, use_work_email): the
 * first of its sources, in P#55's order, whose address it is. Null when the
 * row has no address or none of them gave it.
 *
 * @param {Record<string, unknown> | null | undefined} cells  the row's done cells, by key (values as stored)
 * @returns {Verdict | null}
 */
export function personVerdict(cells) {
  const c = cells ?? {};
  const address = addr(c.use_work_email);
  if (!address) return null;
  const is = (v) => addr(v) === address;
  /** @returns {Verdict} */
  const verdict = (found_by, approved_by, status) => ({ address, found_by, approved_by, status });

  // P#50's sources.
  const fm = obj(c.find_work_email_findymail);
  if (fm && is(fm.email)) return verdict("findymail", "findymail", null);
  const pr = obj(c.find_work_email_prospeo);
  if (pr && is(pr.email)) return verdict("prospeo", "prospeo", prospeoStatus(pr.status));
  const am = obj(obj(c.find_work_email_anymail_finder)?.results);
  if (am && is(am.email) && lower(am.validation) === "valid") return verdict("anymail_finder", "anymail_finder", "valid");
  const amCheck = obj(c.validate_email_anymail_finder_find_work_email);
  if (amCheck && amCheck.valid === true && is(amCheck.email)) return verdict("anymail_finder", "enrichley", enrichleyStatus(amCheck));
  // P#15's: AI Ark's own address, approved by Reoon, else by Enrichley.
  if (is(c.email) && c.reoon_stamp_of_approval === true) return verdict(null, "reoon", "valid");
  if (is(c.email) && c.enrichly_stamp_of_approval === true) return verdict(null, "enrichley", enrichleyStatus(c.enrichly_validation));
  // P#51, P#52 and P#54: by the person's LinkedIn link.
  const fmIn = obj(c.find_work_email_from_linkedin_url_findymail);
  if (fmIn && is(fmIn.email)) return verdict("findymail", "findymail", null);
  const prIn = obj(obj(c.find_work_email_and_enrich_person_from_linkedin_url)?.email);
  if (prIn && is(prIn.email)) return verdict("prospeo", "prospeo", prospeoStatus(prIn.status));
  const amInCheck = obj(c.validate_email_anymail_finder_from_linkedin);
  if (amInCheck && amInCheck.valid === true && is(amInCheck.email)) return verdict("anymail_finder", "enrichley", enrichleyStatus(amInCheck));
  return null;
}

/**
 * The verdict on an inbox row's address (G#13, general_email): Reoon's stamp
 * (G#40), else Enrichley's (G#42). Null when neither approved it.
 *
 * @param {Record<string, unknown> | null | undefined} cells
 * @returns {Verdict | null}
 */
export function inboxVerdict(cells) {
  const c = cells ?? {};
  const address = addr(c.general_email);
  if (!address) return null;
  if (c.reoon_stamp_of_approval === true) return { address, found_by: null, approved_by: "reoon", status: "valid" };
  if (c.enrichly_stamp_of_approval === true) return { address, found_by: null, approved_by: "enrichley", status: enrichleyStatus(c.enrichly_validation) };
  return null;
}

/** A vendor's name as the sources say it. */
export const vendorName = (vendor) => VENDOR_NAMES[/** @type {keyof typeof VENDOR_NAMES} */ (vendor)] ?? String(vendor ?? "");

/**
 * What a lead's source adds after its label: who found the address and who
 * approved it. "" for Reoon's approval of AI Ark's own address (the source
 * stays the label alone, as before); "approved by Enrichley"; "found by
 * Findymail" (a finder that answers for its own address is named once);
 * "found by Anymail Finder, approved by Enrichley".
 *
 * @param {Verdict | null | undefined} v
 * @returns {string}
 */
export function verdictSource(v) {
  if (!v) return "";
  if (!v.found_by) return v.approved_by === "reoon" ? "" : `approved by ${vendorName(v.approved_by)}`;
  const found = `found by ${vendorName(v.found_by)}`;
  return v.approved_by && v.approved_by !== v.found_by ? `${found}, approved by ${vendorName(v.approved_by)}` : found;
}

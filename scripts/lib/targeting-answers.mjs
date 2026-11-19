// What a cell of the onboarding sheet really says, for the targeting sync
// (scripts/sync-client-targeting-from-sheet.mjs). Pure functions: no AI, no
// database, tested by scripts/test-targeting-answers.mjs.
//
// Two ways the sync used to store rules nobody gave:
//   - a cell that says nothing ("Already Provided", "N/A", a blank) went to the
//     AI as if it were a service area or an exclusion list;
//   - the model answered such a cell with the prompt's own worked example: the
//     21 exclusion terms (salons, residential, bakeries ...) or the 16 West
//     Texas towns.
// The sync now skips the first kind before the AI and treats the second as a
// failed pass, so the stored rules stay as they are.

// Whole-cell answers that give no rules. Only the whole cell counts:
// "No restaurants" is an answer, "No" is not.
const NON_ANSWER = new RegExp(
  "^(?:" +
    [
      "n\\s*[./]?\\s*a", // n/a, na, n.a.
      "none", "no", "nil", "null", "nothing", "x",
      "tbd", "tba", "unknown", "not sure", "not applicable",
      "same", "same as (?:above|before|previous)", "see (?:above|attached|email)", "as discussed",
      "(?:already\\s+)?(?:provided|sent|given|shared)(?:\\s+(?:above|before|earlier|previously|already))?",
      "[-\\u2013\\u2014_.]+", // dashes, dots, underscores
    ].join("|") +
    ")?$",
  "i"
);

/** True for a blank cell or one that gives no answer ("N/A", "none", "Already Provided", "see above", dashes). */
export function isNonAnswer(cell) {
  const text = String(cell ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "");
  return NON_ANSWER.test(text);
}

/** The cell's text, or "" when it gives no answer. */
export const said = (cell) => (isNonAnswer(cell) ? "" : String(cell).trim());

/**
 * The items of a prompt's worked example: the comma list on the line right
 * after `marker`, in lower case, with a leading "label:" dropped ("texas: a, b"
 * gives a and b). Empty when the marker is missing, so a reworded prompt turns
 * the check off rather than stopping the sync (the test catches it).
 */
export function exampleItems(prompt, marker) {
  const at = String(prompt ?? "").indexOf(marker);
  if (at < 0) return new Set();
  const line = String(prompt).slice(at + marker.length).split("\n")[0];
  return new Set(
    line
      .replace(/^[a-z ]+:\s*/i, "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * True when a reply repeats the prompt's worked example instead of answering
 * the client: at least 5 of its items are example items the client's own text
 * never mentions, and those are at least half of the example items it holds.
 * An item is mentioned when one of its words (4 letters or more) has its first
 * 5 letters in the text, so "salons" mentions "salon" and "condos" mentions
 * "condominium". `unlessText` lists words that make an echo impossible: a
 * client that names Texas may really work the example's Texas towns.
 */
export function echoesExample(items, example, input, { unlessText = [] } = {}) {
  const text = String(input ?? "").toLowerCase();
  if (unlessText.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text))) return false;
  const hits = [...new Set((items ?? []).map((s) => String(s ?? "").trim().toLowerCase()).filter((s) => example.has(s)))];
  const mentioned = (item) => item.split(/[^a-z]+/).some((w) => w.length >= 4 && text.includes(w.slice(0, 5)));
  const foreign = hits.filter((h) => !mentioned(h));
  return foreign.length >= 5 && foreign.length * 2 >= hits.length;
}

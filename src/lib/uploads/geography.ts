// Normalize state/province values from CSV imports to 2-letter codes.
// Covers US states + Canadian provinces. Falls back to the raw value if no match
// (so we don't drop unknown values — could be a real city or non-NA state).

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC", "washington, d.c.": "DC", dc: "DC",
};

const CA_PROVINCES: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", newfoundland: "NL", "nova scotia": "NS",
  ontario: "ON", "prince edward island": "PE", pei: "PE", quebec: "QC", québec: "QC",
  saskatchewan: "SK", yukon: "YT", "northwest territories": "NT", nunavut: "NU",
};

const VALID_CODES = new Set([
  ...Object.values(US_STATES),
  ...Object.values(CA_PROVINCES),
]);

export function normalizeStateValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already a 2-letter code?
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase();
    if (VALID_CODES.has(upper)) return upper;
  }

  const lower = trimmed.toLowerCase();
  return US_STATES[lower] ?? CA_PROVINCES[lower] ?? null;
}

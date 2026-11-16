// Shapes shared by the LinkedIn sources' routes and screens (phase 4, migration
// 128). The engine is plain JavaScript in scripts/lib/aiark/linkedin-*.mjs;
// these are what the routes answer and the pages send.
//
// Routes (manager and up, requireRole("manager"), as PUT /api/aiark/people-filters):
//   GET  /api/aiark/linkedin-settings?tag=TAG[&kind=people|companies]
//        -> LinkedinSettingsResponse (both kinds when kind is left out)
//   POST /api/aiark/linkedin-settings  body LinkedinPreviewRequest
//        -> 200 LinkedinPreview (the plan for lists not saved yet; nothing written, no AI Ark call)
//   PUT  /api/aiark/linkedin-settings  body LinkedinSettingsSave
//        -> 200 LinkedinSettingsSaved | 400 { error, errors } | 404 { error } | 409 { error, changed: true }
// Viewing and editing work with the linkedin_sources switch off: they spend nothing.
//
// Two overrides of the phase 4 contract shape what is shown:
//   O1  keywords AI Ark's request can't hold are "checked after the pull (AI
//       Ark limit)": every company and person a LinkedIn search finds is
//       checked against the client's whole keyword list before anything more
//       is spent on it or it is listed.
//   O2  a LinkedIn search covers only places the client's sending rules
//       (client_targeting) allow; the client's own places outside them are
//       "not searched: outside the client's sending rules". The stored lists
//       never change for it.

import type { EmployeeBand, PeopleFilters } from "@/lib/aiark/types";

export type LinkedinKind = "people" | "companies";
export const LINKEDIN_KINDS: LinkedinKind[] = ["people", "companies"];

/** A place in client_targeting's format: codes, the geo reference's city spelling. */
export interface PlaceEntry {
  country: string;
  state?: string;
  city?: string;
}

/** A place as the editor shows it: the entry and what AI Ark is sent ("Spokane, Washington"). */
export interface PlaceView {
  entry: PlaceEntry;
  text: string;
}

/** A Clay value the seed could not place: shown with why and what it may mean; never searched. */
export interface UnplacedValue {
  side: "include" | "exclude";
  /** Clay's field it came from (cities, states, free_text_places, ...). */
  field: string;
  value: string;
  why: string;
  suggestions: PlaceEntry[];
}

/** The lists a manager edits, per kind. Places as text (as shown) or entries. */
export interface LinkedinOwnInput {
  include_locations: Array<string | PlaceEntry>;
  exclude_locations: Array<string | PlaceEntry>;
  /** The unplaced values to keep: a stored one can be kept or removed, never added. */
  unplaced: UnplacedValue[];
  exclude_keywords: string[];
}

/** O1: what AI Ark is sent of the keywords, and what is checked after the pull instead. */
export interface LinkedinKeywordsView {
  /** The standard keywords and the client's own, once each. */
  union: number;
  /** Phrases AI Ark is sent (condensed: a phrase a shorter one covers is not sent again). */
  sent: number;
  /** Keywords AI Ark's request can't hold: checked after the pull (AI Ark limit), never dropped. */
  checkedAfter: string[];
}

/** O2: a state or country of the client's own places, searched as the rules' places inside it. */
export interface NarrowedPlace {
  entry: PlaceView;
  into: PlaceView[];
}

/** What a LinkedIn search of this kind would send now (no AI Ark call). */
export interface LinkedinPlan {
  searches: number;
  blockers: string[];
  pullBlockers: string[];
  notes: string[];
}

/** One kind of one client's LinkedIn settings, as the AI Ark tab shows them. */
export interface LinkedinSettingsView {
  tag: string;
  kind: LinkedinKind;
  /** row: the client's own row; rules_and_starter: no row yet, so its database rules' places and the starter keywords. */
  from: "row" | "rules_and_starter";
  /** The client's own lists: editable. Narrowing (O2) never changes them. */
  own: {
    include_locations: PlaceView[];
    exclude_locations: PlaceView[];
    unplaced: Array<UnplacedValue & { suggestionTexts: string[] }>;
    exclude_keywords: string[];
  };
  /** The same for every client (D-P4-1), read only: the standard filters, or the client's saved AI Ark people filters. */
  standard: {
    from: "saved" | "cleaning";
    titles: number;
    titleMode: string;
    excludeTitles: number;
    bands: EmployeeBand[];
    excludeIndustries: number;
    companyTypes: string[];
    /** The standard keywords, always sent first. */
    keywords: string[];
    /** The full filters, for a "show all" view. */
    filters: PeopleFilters;
  };
  /** D-P4-3 and O1: what AI Ark is sent, and what is checked after the pull instead. */
  keywords: LinkedinKeywordsView;
  /** O2: the places a search sends (the own places narrowed to the sending rules). */
  placesSent: PlaceView[];
  /** O2: own places outside the client's sending rules: not searched. Adding them to the rules brings them in. */
  notSearched: PlaceView[];
  /** O2: own states or countries searched as the rules' places inside them. */
  narrowed: NarrowedPlace[];
  /** The client's sending rules (client_targeting) as far as places go. No include places: nothing is narrowed. */
  rules: { exists: boolean; places: number; excludedPlaces: number };
  plan: LinkedinPlan;
  provenance: {
    source: "clay" | "manual" | null;
    clay: { sourceId: string | null; campaign: string | null; setUpAt: string | null; fingerprint: string | null } | null;
    copiedFrom: LinkedinKind | null;
    seededAt: string | null;
    updatedAt: string | null;
    /** The person who saved last (full name), when a person did. */
    updatedBy: string | null;
    notes: string[];
    /** Codes, with their plain words in flagWords. */
    flags: string[];
    flagWords: Record<string, string>;
  };
  /** For a client with no row: the starter list (loaded or not) its keywords come from. */
  starter: { loaded: boolean; items: number; version: number | null };
  /** The newest log entries: who, when, counts before and after. */
  log: LinkedinLogEntry[];
  /** Sent back with a save; a 409 answers any change since. */
  version: string;
  /** What a count, a pull or a run compares (the lists, the rules, the saved filters): sent back with them. */
  searchVersion: string;
}

export interface LinkedinLogEntry {
  id: number;
  action: "save" | "seed";
  at: string;
  byName: string | null;
  seededBy: string | null;
  before: LinkedinCounts | null;
  after: LinkedinCounts;
}

export interface LinkedinCounts {
  places: number;
  excluded_places: number;
  unplaced: number;
  keywords: number;
}

/** The LinkedIn switch as it stands for the client on the screen (read only here; the settings sheet edits it). */
export interface LinkedinSwitchView {
  enabled: boolean;
  onList: boolean;
  /** linkedin_companies and linkedin_people: the switch and the parent pipeline both on for the client. */
  companies: boolean;
  people: boolean;
  peoplePerCompany: number;
}

export interface LinkedinSettingsResponse {
  client: { tag: string; name: string | null; clientType: string | null; status: string | null };
  switch: LinkedinSwitchView;
  people?: LinkedinSettingsView;
  companies?: LinkedinSettingsView;
}

export interface LinkedinSettingsSave {
  tag: string;
  kind: LinkedinKind;
  value: LinkedinOwnInput;
  /** The view's version, as loaded. */
  version: string;
}

export interface LinkedinSettingsSaved {
  saved: boolean;
  /** Nothing changed on an existing row: nothing written, nothing logged. */
  unchanged: boolean;
  view: LinkedinSettingsView;
}

/** The editor's preview of lists not saved yet (POST /api/aiark/linkedin-settings). */
export interface LinkedinPreviewRequest {
  tag: string;
  kind: LinkedinKind;
  value: LinkedinOwnInput;
}

export interface LinkedinPreview {
  plan: LinkedinPlan;
  keywords: LinkedinKeywordsView;
  placesSent: PlaceView[];
  notSearched: PlaceView[];
  narrowed: NarrowedPlace[];
  /** Why a place, keyword or unplaced value would be refused by a save, each named. */
  errors: string[];
}

/** The editor card on the AI Ark tab (src/components/aiark/linkedin-settings-card.tsx), mounted after "People filters". */
export interface LinkedinSettingsCardProps {
  /** The client on the AI Ark tab (its ?client=). */
  tag: string;
  /** Called after a save, so the page can reload what depends on it. */
  onSaved?: (view: LinkedinSettingsView) => void;
}

/** The source picker on the Companies tab's pull and people panels. */
export type PullSource = "ai_ark" | "linkedin";
export const PULL_SOURCES: PullSource[] = ["ai_ark", "linkedin"];

/** What the Companies tab's panels show for a LinkedIn source (GET /api/companies/setup and /people/setup add it as `linkedin`). */
export interface LinkedinPlanView {
  kind: LinkedinKind;
  switch: LinkedinSwitchView;
  from: "row" | "rules_and_starter";
  /** The client's own include places (as stored), what is sent of them (O2), and what is not searched. */
  places: number;
  placesSent: number;
  notSearched: number;
  narrowed: number;
  excludedPlaces: number;
  unplaced: number;
  keywords: { union: number; sent: number; checkedAfter: number };
  searches: number;
  blockers: string[];
  pullBlockers: string[];
  notes: string[];
  /** Sent back with a count, a pull or a run; a 409 answers any change since. */
  version: string;
}

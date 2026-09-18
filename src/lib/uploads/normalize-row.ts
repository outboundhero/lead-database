import { detectEmailType } from "./detect-email-type";
import { normalizeStateValue } from "./geography";
import { isBlankish, normalizeEspLabel } from "./constants";

export interface FieldMapping {
  [csvIndex: number]: string; // maps CSV column index → DB field key
}

// Mirrors leads_validation_status_check / leads_category_source_check.
const VALIDATION_STATUSES = new Set(["valid", "catch_all", "invalid", "pending", "risky", "unknown"]);
const CATEGORY_SOURCES = new Set(["keyword", "ai", "manual", "bison", "clay", "upload"]);
const INT4_MIN = -2147483648, INT4_MAX = 2147483647;

/** "https://www.Example.com/path?x" -> "example.com"; null when nothing domain-like remains. */
export function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");   // scheme
  d = d.replace(/^www\./, "");
  d = d.split(/[/?#]/)[0];             // path, query, fragment
  d = d.replace(/^mailto:/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!d.includes(".") || /\s/.test(d)) return null;
  return d;
}

/** Client decision 2026-09-17: keep the first non-empty '|' part ("Valpro | California…" → "Valpro"). */
export function cleanCompanyName(raw: string): string | undefined {
  return raw.split("|").map((s) => s.replace(/\s+/g, " ").trim()).find(Boolean);
}

export function normalizeRow(
  csvRow: string[],
  headers: string[],
  fieldMapping: FieldMapping
): Record<string, unknown> {
  const lead: Record<string, unknown> = {};

  for (const [indexStr, dbField] of Object.entries(fieldMapping)) {
    const idx = Number(indexStr);
    const rawValue = csvRow[idx]?.trim() ?? "";
    // Placeholders ('--', 'N/A', 'none', …) are not values: a blank cell and a
    // placeholder cell must produce the same lead.
    if (!rawValue || isBlankish(rawValue)) continue;

    switch (dbField) {
      case "email":
        lead.email = rawValue.toLowerCase().trim();
        break;
      case "state": {
        // Normalize US states + Canadian provinces to 2-letter codes
        const normalized = normalizeStateValue(rawValue);
        lead.state = normalized ?? rawValue;
        break;
      }
      case "company":
        // The BEFORE trigger fn_clean_company_name (106/107) enforces the same
        // rule on every write path; doing it here too keeps in-memory
        // comparisons (company_key, dedupe) consistent with what will be stored.
        lead.company = cleanCompanyName(rawValue);
        break;
      case "title":
        // Kept readable ("President | CEO"); the trigger fn_sync_lead_job_titles
        // (106) splits it into one searchable job title per '|' / ';' part.
        lead.title = rawValue.replace(/\s+/g, " ").trim();
        break;
      case "domain": {
        // Website columns arrive as bare domains AND full URLs (6,568 of 88,772
        // rows in the 2026-09-15 file had https://, www., paths). Store the
        // bare domain so it matches how every other lead's domain is stored.
        const d = normalizeDomain(rawValue);
        if (d) lead.domain = d;
        break;
      }
      case "esp": {
        const v = normalizeEspLabel(rawValue);
        if (v) lead.esp = v;
        break;
      }
      case "company_size": {
        // Column is BIGINT — store raw number
        const n = parseInt(rawValue.replace(/[,$\s]/g, ""), 10);
        lead.company_size = isNaN(n) || n <= 0 ? null : n;
        break;
      }
      case "annual_revenue": {
        // Column is NUMERIC — store raw number
        const r = parseFloat(rawValue.replace(/[$,\s]/g, ""));
        lead.annual_revenue = isNaN(r) || r <= 0 ? null : r;
        break;
      }
      case "technologies": {
        // Column is TEXT[] — parse JSON array or comma-separated
        if (rawValue.startsWith("[")) {
          try {
            const arr = JSON.parse(rawValue);
            if (Array.isArray(arr) && arr.length > 0) {
              lead.technologies = arr.filter((t: string) => typeof t === "string" && t.trim());
            }
          } catch {
            lead.technologies = [rawValue];
          }
        } else {
          lead.technologies = rawValue.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
        break;
      }
      // Typed / CHECK-constrained columns: an unparseable cell is dropped rather
      // than stored, because the bulk engine writes 2,000 rows per statement and
      // one bad value would fail the whole chunk.
      case "emails_sent":
      case "opens":
      case "replies":
      case "bounces":
      case "unique_replies":
      case "unique_opens":
      case "workspace_id": {
        const n = parseInt(rawValue.replace(/[,\s]/g, ""), 10);
        if (!isNaN(n) && n >= INT4_MIN && n <= INT4_MAX) lead[dbField] = n;
        break;
      }
      case "bison_lead_id": {
        const n = parseInt(rawValue.replace(/[,\s]/g, ""), 10);
        if (!isNaN(n) && Number.isSafeInteger(n)) lead[dbField] = n;
        break;
      }
      case "is_bounced": {
        const v = rawValue.toLowerCase();
        if (["true", "yes", "y", "1", "t"].includes(v)) lead.is_bounced = true;
        else if (["false", "no", "n", "0", "f"].includes(v)) lead.is_bounced = false;
        break;
      }
      case "created_at":
      case "updated_at": {
        const d = new Date(rawValue);
        if (!isNaN(d.getTime()) && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 9999) lead[dbField] = d.toISOString();
        break;
      }
      case "validation_status": {
        const v = rawValue.toLowerCase().replace(/[\s-]+/g, "_");
        if (VALIDATION_STATUSES.has(v)) lead.validation_status = v;
        break;
      }
      case "category_source": {
        const v = rawValue.toLowerCase();
        if (CATEGORY_SOURCES.has(v)) lead.category_source = v;
        break;
      }
      case "category_confidence": {
        const n = parseFloat(rawValue.replace(/%/g, ""));
        if (!isNaN(n) && n >= 0 && n <= 100) lead.category_confidence = n > 1 ? n / 100 : n;
        break;
      }
      case "email_type": {
        const v = rawValue.toLowerCase();
        if (v === "general" || v === "personal") lead.email_type = v;
        break;
      }
      default:
        lead[dbField] = rawValue;
        break;
    }
  }

  // Auto-classify email type from name/title/email signals (Phase 3)
  if (!lead.email_type && (lead.email || lead.first_name || lead.last_name || lead.title)) {
    lead.email_type = detectEmailType({
      email: lead.email as string | undefined,
      first_name: lead.first_name as string | undefined,
      last_name: lead.last_name as string | undefined,
      job_title: lead.title as string | undefined,
    });
  }

  return lead;
}

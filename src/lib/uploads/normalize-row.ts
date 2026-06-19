import { detectEmailType } from "./detect-email-type";
import { normalizeStateValue } from "./geography";

export interface FieldMapping {
  [csvIndex: number]: string; // maps CSV column index → DB field key
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
    if (!rawValue) continue;

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
      case "emails_sent":
      case "opens":
      case "replies":
      case "bounces":
      case "unique_replies":
      case "unique_opens":
      case "workspace_id":
      case "bison_lead_id": {
        const n = parseInt(rawValue.replace(/[,\s]/g, ""), 10);
        if (!isNaN(n)) lead[dbField] = n;
        break;
      }
      default:
        lead[dbField] = rawValue;
        break;
    }
  }

  // Auto-classify email type from name/title/email signals (Phase 3)
  if (lead.email || lead.first_name || lead.last_name || lead.title) {
    lead.email_type = detectEmailType({
      email: lead.email as string | undefined,
      first_name: lead.first_name as string | undefined,
      last_name: lead.last_name as string | undefined,
      job_title: lead.title as string | undefined,
    });
  }

  return lead;
}

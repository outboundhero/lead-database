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
      case "keywords":
        lead.keywords = rawValue;
        break;
      default:
        lead[dbField] = rawValue;
        break;
    }
  }

  return lead;
}

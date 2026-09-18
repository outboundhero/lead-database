import Papa from "papaparse";

export interface ParseResult {
  headers: string[];
  preview: string[][];
  totalRows: number;
  /** Delimiter Papa detected (',' ';' '\t' …) — sent to the server so it parses the same columns. */
  delimiter: string;
}

/** Delimiter of one file (files in a multi-file upload can differ). Reads the first 64 KB only. */
export async function detectDelimiter(file: File): Promise<string> {
  try {
    const head = await file.slice(0, 65_536).text();
    const d = Papa.parse<string[]>(head, { preview: 1 }).meta?.delimiter;
    return typeof d === "string" && d.length === 1 ? d : ",";
  } catch {
    return ",";
  }
}

export function parseCSVFile(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const headers: string[] = [];
    const preview: string[][] = [];
    let totalRows = 0;
    let isHeader = true;
    let delimiter = ",";

    Papa.parse(file, {
      skipEmptyLines: true,
      step(results) {
        const row = results.data as string[];
        if (isHeader) {
          headers.push(...row);
          isHeader = false;
          if (results.meta?.delimiter) delimiter = results.meta.delimiter;
          return;
        }
        totalRows++;
        if (preview.length < 5) {
          preview.push(row);
        }
      },
      complete() {
        if (headers.length === 0) {
          reject(new Error("CSV file is empty"));
          return;
        }
        resolve({ headers, preview, totalRows, delimiter });
      },
      error(err) {
        reject(err);
      },
    });
  });
}

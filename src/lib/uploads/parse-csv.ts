import Papa from "papaparse";

export interface ParseResult {
  headers: string[];
  preview: string[][];
  totalRows: number;
}

export function parseCSVFile(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const headers: string[] = [];
    const preview: string[][] = [];
    let totalRows = 0;
    let isHeader = true;

    Papa.parse(file, {
      skipEmptyLines: true,
      step(results) {
        const row = results.data as string[];
        if (isHeader) {
          headers.push(...row);
          isHeader = false;
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
        resolve({ headers, preview, totalRows });
      },
      error(err) {
        reject(err);
      },
    });
  });
}

#!/usr/bin/env node
import { readdirSync, createReadStream, writeFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';

const INPUT_DIR = '/Users/akeesh/Downloads/All Enriched Leads';
const OUTPUT_FILE = '/Users/akeesh/Downloads/enriched_company_names_deduped.csv';

async function processFile(filePath) {
  const records = [];
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true })
  );
  for await (const row of parser) {
    const email = (row.email || '').trim().toLowerCase();
    const companyName = (row.company_name || '').trim();
    if (email && companyName) {
      records.push({ email, company_name: companyName });
    }
  }
  return records;
}

async function main() {
  const files = readdirSync(INPUT_DIR).filter(f => f.endsWith('.csv'));
  console.log(`Found ${files.length} CSV files`);

  const emailMap = new Map();
  let totalRows = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    try {
      const records = await processFile(join(INPUT_DIR, files[i]));
      for (const { email, company_name } of records) {
        if (!emailMap.has(email)) {
          emailMap.set(email, company_name);
        }
      }
      totalRows += records.length;
    } catch (err) {
      console.error(`Error: ${files[i]}: ${err.message}`);
      skipped++;
    }
    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${files.length} files... (${emailMap.size.toLocaleString()} unique)`);
  }

  console.log(`\nTotal rows with company: ${totalRows.toLocaleString()}`);
  console.log(`Unique emails: ${emailMap.size.toLocaleString()}`);
  console.log(`Skipped files: ${skipped}`);

  const output = [['email', 'company_name']];
  for (const [email, company_name] of emailMap) {
    output.push([email, company_name]);
  }

  const csv = stringify(output);
  writeFileSync(OUTPUT_FILE, csv);
  console.log(`Output: ${OUTPUT_FILE} (${(Buffer.byteLength(csv) / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(console.error);

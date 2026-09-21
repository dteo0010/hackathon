/**
 * Read every attachment in the dataset and report what came out.
 * This is the reading stage's own test: it proves the pipeline can see the
 * content before anyone tries to extract fields from it.
 *
 *   npm run coverage
 *   npm run coverage -- --failures   # only the files that could not be read
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readAttachment } from '../src/read.js';
import type { DocText } from '../src/types.js';
import { DATA_DIR } from './data-dir.js';

/**
 * Line-start label patterns for the 7 compared fields. Used only to MEASURE
 * the reader's output — the reader itself knows nothing about shipping.
 */
const FIELD_LABEL: Record<string, RegExp> = {
  shipper: /^\s*shipper\b/i,
  consignee: /^\s*(?:consignee|to the order of)\b/i,
  notify_party: /^\s*notify\b/i,
  port_of_loading: /^\s*(?:port of loading|load(?:ing)? port|POL)\b/i,
  port_of_discharge: /^\s*(?:port of discharge|discharge port|POD)\b/i,
  container_count: /^\s*(?:total containers|container count|no\.? of containers|number of containers|qty of containers)/i,
  gross_weight_kg: /^\s*(?:total\s+)?gross\s*(?:wt|weight)/i,
};

/**
 * Did the value land on the SAME line as its label, after a ":" or a tab?
 * That is what lets one extractor handle every format; a value stranded on
 * the next line, or glued to the label with a plain space, is the reader's
 * failure, not the extractor's.
 */
function pairing(doc: DocText): { found: number; paired: number } {
  let found = 0;
  let paired = 0;
  const lines = doc.text.split('\n');
  for (const re of Object.values(FIELD_LABEL)) {
    const line = lines.find((l) => re.test(l));
    if (!line) continue;
    found++;
    const rest = line.replace(re, '');
    if (/[:\t]\s*[A-Za-z0-9]/.test(rest)) paired++;
  }
  return { found, paired };
}

const onlyFailures = process.argv.includes('--failures');
const dir = join(DATA_DIR, 'attachments');
const files = (await readdir(dir)).sort();

const docs: DocText[] = [];
for (const name of files) {
  const bytes = new Uint8Array(await readFile(join(dir, name)));
  docs.push(await readAttachment(`attachments/${name}`, bytes));
}

const byFormat = new Map<string, { total: number; ok: number; chars: number }>();
for (const d of docs) {
  const row = byFormat.get(d.format) ?? { total: 0, ok: 0, chars: 0 };
  row.total++;
  if (d.readable) {
    row.ok++;
    row.chars += d.chars;
  }
  byFormat.set(d.format, row);
}

const failures = docs.filter((d) => !d.readable);

if (!onlyFailures) {
  console.log(`\nREAD COVERAGE — ${docs.length} attachments in ${dir}\n`);
  console.log('format   total   read   avg chars');
  for (const [format, r] of [...byFormat].sort()) {
    const avg = r.ok ? Math.round(r.chars / r.ok) : 0;
    console.log(
      `${format.padEnd(8)} ${String(r.total).padStart(5)} ${String(r.ok).padStart(6)}   ${String(avg).padStart(9)}`,
    );
  }
  const ok = docs.length - failures.length;
  console.log(
    `\nreadable: ${ok}/${docs.length} (${((ok / docs.length) * 100).toFixed(1)}%)\n`,
  );

  // Is every value on the same line as its label, per format?
  console.log('label + value on the same line (the extractor-facing measure):');
  console.log('format   labels found   paired on one line');
  const readable = docs.filter((d) => d.readable);
  for (const format of [...byFormat.keys()].sort()) {
    const set = readable.filter((d) => d.format === format);
    if (!set.length) continue;
    let found = 0;
    let paired = 0;
    for (const d of set) {
      const p = pairing(d);
      found += p.found;
      paired += p.paired;
    }
    const pct = found ? ((paired / found) * 100).toFixed(1) : '0.0';
    console.log(`${format.padEnd(8)} ${String(found).padStart(12)}   ${String(paired).padStart(6)}  ${pct.padStart(5)}%`);
  }
  console.log();
}

console.log(`unreadable: ${failures.length}`);
for (const f of failures) {
  console.log(`  ${f.path.padEnd(34)} ${f.failure}: ${f.readError}`);
}

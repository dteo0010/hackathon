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

/** Loose label patterns — the same field can be written many ways. */
const FIELD_HINTS: Record<string, RegExp> = {
  shipper: /\bshipper\b/i,
  consignee: /\bconsignee\b|\bto the order of\b/i,
  notify_party: /\bnotify\b/i,
  port_of_loading: /\bport of loading\b|\bload(ing)? port\b|\bPOL\b/i,
  port_of_discharge: /\bport of discharge\b|\bdischarge port\b|\bPOD\b/i,
  container_count: /\bcontainers?\b/i,
  gross_weight_kg: /\bgross (wt|weight)\b/i,
};

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

  // Can the 7 fields even be found in the text we produced?
  console.log('field labels present in readable documents:');
  const readable = docs.filter((d) => d.readable);
  for (const [field, re] of Object.entries(FIELD_HINTS)) {
    const hits = readable.filter((d) => re.test(d.text)).length;
    const pct = ((hits / readable.length) * 100).toFixed(0);
    console.log(`  ${field.padEnd(18)} ${String(hits).padStart(3)}/${readable.length}  ${pct}%`);
  }
  console.log();
}

console.log(`unreadable: ${failures.length}`);
for (const f of failures) {
  console.log(`  ${f.path.padEnd(34)} ${f.failure}: ${f.readError}`);
}

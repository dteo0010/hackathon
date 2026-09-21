/**
 * node scripts/make-public-seed.mjs <full-results-db.json> [deploy/results-seed.json]
 *
 * Turns a full local run into the results file the PUBLIC demo ships with.
 * Kept:    email id, subject, category, status, review reason, the 7 field values per
 *          document, the SI/BL comparison, issues, history, and one evidence line per field.
 * Removed: extracted document text, error traces, and any issue snippet longer than
 *          one short line. Email bodies and the original attachments are never in the
 *          results file to begin with (the public server has no inbox at all).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out = 'deploy/results-seed.json'] = process.argv.slice(2);
if (!src) { console.error('usage: node scripts/make-public-seed.mjs <full-db.json> [out.json]'); process.exit(1); }

const MAX = 120;
const oneLine = (s) => {
  if (s === null || s === undefined) return s;
  const line = String(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line.length > MAX ? `${line.slice(0, MAX - 1)}\u2026` : line;
};

const db = JSON.parse(readFileSync(src, 'utf8'));
let docs = 0;
/** Keep values, provenance (source), confidence and a one-line evidence; drop the document text
 *  (for a scan this is also where the vision model's draft transcription lives). */
function sanitizeDocs(result) {
  for (const d of result?.documents || []) {
    d.text = null;
    d.textWithheld = true;
    delete d.pages;
    if (d.transcription) d.transcription = { model: d.transcription.model ?? null, illegible: d.transcription.illegible ?? null };
    for (const f of Object.values(d.fields || {})) if (f) f.evidence = oneLine(f.evidence);
    docs += 1;
  }
}
for (const rec of Object.values(db.emails)) {
  rec.errorTrace = null;
  sanitizeDocs(rec.result);
  for (const i of rec.assessment?.issues || []) {
    for (const e of i.evidence || []) e.snippet = oneLine(e.snippet);
  }
}
for (const r of db.reviews || []) {
  if (!r || typeof r !== 'object') continue;
  if ('text' in r) r.text = null;
  sanitizeDocs(r.result);            // a correction stores the whole result it was made on
}

writeFileSync(out, JSON.stringify(db));
const size = Buffer.byteLength(JSON.stringify(db));
console.log(`Wrote ${out}: ${Object.keys(db.emails).length} emails, ${docs} documents (text removed), ${(size / 1024).toFixed(0)} KB`);

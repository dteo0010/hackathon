/**
 * Task D - calibration report for the "unreadable" thresholds.
 *
 *   npm run calibrate -- --data data          (or the organisers' server URL)
 *
 * Reads every attachment with readers.js and lists the readability numbers
 * assess() uses (text length, noise ratio, word ratio, OCR confidence),
 * worst first, marking which ones the current thresholds would escalate.
 * Look at the borderline rows and move the thresholds in DEFAULT_CONFIG if a
 * readable document is flagged, or a garbled one slips through.
 * Writes every row to calibration.csv.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inbox } from '../inbox.js';
import { readDocument } from '../readers.js';
import { DEFAULT_CONFIG, garbageRatio, wordRatio } from './assess.js';

export async function calibrationRows(inbox, cfg = DEFAULT_CONFIG) {
  const rows = [];
  for (const email of await inbox.emails()) {
    for (const p of email.attachments || []) {
      let r;
      try {
        r = await readDocument(p, await inbox.readBytes(p));
      } catch (err) {
        rows.push({ file: p, method: '-', chars: 0, noise: null, words: null, ocr: null, flagged: 'missing file', error: err.message });
        continue;
      }
      const text = (r.text || '').trim();
      const noise = text ? garbageRatio(text) : null;
      const words = text ? wordRatio(text) : null;
      let flagged = '';
      if (r.error) flagged = 'error';
      else if (text.length < cfg.minTextChars) flagged = 'too short';
      else if (r.ocrConfidence !== null && r.ocrConfidence !== undefined && r.ocrConfidence < cfg.minOcrConfidence) flagged = 'low OCR confidence';
      else if (noise > cfg.maxGarbageRatio) flagged = 'noise';
      else if (words < cfg.minWordRatio) flagged = 'few words';
      rows.push({ file: p, method: r.method, chars: text.length, noise, words, ocr: r.ocrConfidence ?? null, flagged, error: r.error });
    }
  }
  // worst first: errors, then flagged, then closest to the thresholds
  const risk = (x) => (x.error ? 3 : x.flagged ? 2 : 0) + (x.words === null ? 1 : 1 - x.words) + (x.noise ?? 0);
  return rows.sort((a, b) => risk(b) - risk(a));
}

const pct = (x) => (x === null || x === undefined ? '   -' : `${Math.round(x * 100)}%`.padStart(4));

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const data = opt('--data', process.env.PIPELINE_DATA || 'data');
  const out = opt('--out', 'calibration.csv');
  const top = Number(opt('--top', 30));
  const rows = await calibrationRows(new Inbox(data));
  const c = DEFAULT_CONFIG;
  console.log(`Thresholds: text >= ${c.minTextChars} chars, noise <= ${pct(c.maxGarbageRatio)}, words >= ${pct(c.minWordRatio)}, OCR >= ${pct(c.minOcrConfidence)}\n`);
  console.log('file'.padEnd(34), 'method', ' chars', 'noise', 'words', '  ocr', ' flagged');
  for (const r of rows.slice(0, top)) {
    console.log(path.basename(r.file).padEnd(34), String(r.method).padEnd(6), String(r.chars).padStart(6),
      pct(r.noise).padStart(5), pct(r.words).padStart(5), pct(r.ocr).padStart(5), ` ${r.flagged}${r.error ? ` (${r.error})` : ''}`);
  }
  const flagged = rows.filter((r) => r.flagged).length;
  const minWords = Math.min(...rows.filter((r) => !r.flagged && r.words !== null).map((r) => r.words));
  const maxNoise = Math.max(...rows.filter((r) => !r.flagged && r.noise !== null).map((r) => r.noise));
  console.log(`\n${rows.length} attachments, ${flagged} would be escalated as unreadable.`);
  console.log(`Among the rest: lowest word ratio ${pct(minWords)}, highest noise ${pct(maxNoise)} - headroom vs the thresholds.`);
  const csv = ['file,method,chars,noise,words,ocr_confidence,flagged,error',
    ...rows.map((r) => [r.file, r.method, r.chars, r.noise ?? '', r.words ?? '', r.ocr ?? '', r.flagged, JSON.stringify(r.error || '')].join(','))];
  writeFileSync(out, csv.join('\n'));
  console.log(`All rows written to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

/**
 * Print the text this reader gets out of one attachment.
 *   npm run read -- attachments/email_004_SI.txt
 *   npm run read -- attachments/email_512_BL.pdf --json
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readAttachment } from '../src/read.js';
import { DATA_DIR } from './data-dir.js';

const [rel, ...rest] = process.argv.slice(2);
if (!rel) {
  console.error('usage: npm run read -- <attachments/email_004_SI.txt> [--json]');
  process.exit(1);
}

const full = isAbsolute(rel) ? rel : join(DATA_DIR, rel);
const doc = await readAttachment(rel, new Uint8Array(await readFile(full)));

if (rest.includes('--json')) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  console.log(
    `${doc.path}\n  format ${doc.format} · method ${doc.method} · ${doc.chars} chars · ` +
      (doc.readable ? 'readable' : `UNREADABLE (${doc.failure}: ${doc.readError})`),
  );
  console.log('-'.repeat(72));
  console.log(doc.text);
}

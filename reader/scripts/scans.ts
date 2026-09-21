/**
 * Transcribe every scanned page in the dataset with Gemini and show what it saw.
 * Needs credentials: GEMINI_API_KEY (in .env here or at the repo root), or
 * GOOGLE_CLOUD_PROJECT with `gcloud auth application-default login`.
 *
 *   npm run scans
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readAttachment } from '../src/read.js';
import { geminiVision } from '../src/vision/gemini.js';
import { DATA_DIR } from './data-dir.js';

for (const env of ['.env', '../.env']) {
  if (existsSync(env)) {
    process.loadEnvFile(env);
    break;
  }
}

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_CLOUD_PROJECT) {
  console.error('No Gemini credentials. Put GEMINI_API_KEY in hackathon/.env, or set GOOGLE_CLOUD_PROJECT and run');
  console.error('  gcloud auth application-default login');
  process.exit(1);
}

const vision = geminiVision();
const dir = join(DATA_DIR, 'attachments');
let scans = 0;

for (const name of (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort()) {
  const bytes = new Uint8Array(await readFile(join(dir, name)));
  const t0 = Date.now();
  const doc = await readAttachment(`attachments/${name}`, bytes, { vision });
  if (doc.failure !== 'no_text_layer') continue;
  scans++;

  const t = doc.transcription;
  console.log(`\n${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!t) {
    console.log(`  no transcription: ${doc.readError}`);
    continue;
  }
  console.log(`  model ${t.model} · ${t.text.length} chars · ${t.illegible} illegible`);
  for (const line of t.text.split('\n').slice(0, 12)) console.log(`  | ${line}`);
}

console.log(`\n${scans} scanned pages processed.`);

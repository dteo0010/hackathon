/**
 * Demo-only stand-ins for tasks A, B and C, plus a small synthetic inbox that
 * hits every review path. Lets us build and demo task D before teammates'
 * code or the real dataset exist. Replace via PIPELINE_STAGES (see server.js).
 *
 *   npm run demo                                   seed ./demo_data, run into ./demo-db.json
 *   node src/reliability/demo.js --reset           same thing
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocType, FIELDS, makeDocument } from '../models.js';

// ---------------------------------------------------------------- A - classify
export function classify(email) {
  const text = `${email.subject || ''} ${email.body || ''}`.toLowerCase();
  if (/\b(winner|lottery|crypto|click here|free gift)\b/.test(text)) return 'SPAM';
  if (/\b(check|verify|compare|review)\b.*\b(bl|b\/l|bill of lading|draft)\b/.test(text)
    || /\bdraft (bl|b\/l|bill of lading)\b/.test(text)) return 'BL_COMPARISON';
  if (text.includes('shipping instruction') || /\bnew si\b/.test(text)) return 'SI_REQUEST';
  if (text.includes('invoice')) return 'INVOICE_QUERY';
  return 'GENERAL';
}

// ----------------------------------------------------------------- B - extract
export const LABELS = {
  shipper: ['shipper', 'exporter', 'shipper/exporter'],
  consignee: ['consignee'],
  notify_party: ['notify party', 'notify'],
  port_of_loading: ['port of loading', 'load port', 'loading port', 'pol'],
  port_of_discharge: ['port of discharge', 'discharge port', 'destination port', 'pod'],
  container_count: ['container count', 'no. of containers', 'number of containers', 'containers'],
  gross_weight_kg: ['gross weight (kg)', 'gross weight', 'total gross weight', 'g.w.'],
};
const LABEL_TO_FIELD = Object.fromEntries(
  Object.entries(LABELS).flatMap(([field, labels]) => labels.map((l) => [l, field])));

function detectType(text) {
  const head = text.slice(0, 200).toLowerCase();
  if (head.includes('shipping instruction')) return DocType.SI;
  if (head.includes('bill of lading')) return DocType.BL;
  if (head.includes('invoice') || head.includes('packing list')) return DocType.OTHER;
  return DocType.UNKNOWN;
}

export function extractText(p, content) {
  const text = content.toString('utf8');
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = LABEL_TO_FIELD[line.slice(0, i).trim().toLowerCase()];
    if (field && !(field in fields)) {
      fields[field] = { value: line.slice(i + 1).trim() || null, confidence: 0.95, evidence: line.trim() };
    }
  }
  for (const f of FIELDS) fields[f] ??= { value: null };
  return makeDocument({ path: p, docType: detectType(text), text, fields, method: 'text' });
}

/**
 * Wraps extractText with a simulated outage: any file containing
 * SIMULATE_OUTAGE fails its first 3 calls (so the first run ends FAILED),
 * then works - exactly what the Retry button demo needs.
 */
export function makeExtract(stateDir) {
  const counter = path.join(stateDir, '.outage_calls');
  return async (p, content) => {
    if (content.includes('SIMULATE_OUTAGE')) {
      const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
      writeFileSync(counter, String(n + 1));
      if (n < 3) {
        const err = new Error('document reader service unavailable (simulated)');
        err.name = 'ConnectionError';
        throw err;
      }
    }
    return extractText(p, content);
  };
}

// ----------------------------------------------------------------- C - compare
function toNumber(v, field) {
  if (!v) return null;
  const m = String(v).match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0].replace(/,/g, ''));
  if (field === 'gross_weight_kg' && /\b(t|mt|tonnes?|tons?)\b/i.test(v)) n *= 1000;
  return n;
}

const normText = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function compare(si, bl) {
  return {
    fields: FIELDS.map((f) => {
      const a = si.fields[f]?.value ?? null;
      const b = bl.fields[f]?.value ?? null;
      let match;
      if (f === 'container_count' || f === 'gross_weight_kg') {
        const na = toNumber(a, f);
        match = na !== null && na === toNumber(b, f);
      } else {
        match = normText(a) !== '' && normText(a) === normText(b);
      }
      return { field: f, siValue: a, blValue: b, match };
    }),
  };
}

/** Entry point used by the server (PIPELINE_STAGES default). */
export function stagesFor(source) {
  const stateDir = /^https?:\/\//.test(source) ? '.' : source;
  return { classify, extract: makeExtract(stateDir), compare };
}

// ------------------------------------------------------------- synthetic inbox
const BASE = {
  shipper: 'Acme Trading Sdn Bhd', consignee: 'Blue Ocean Imports B.V.',
  notify_party: 'Same as consignee', port_of_loading: 'Port Klang',
  port_of_discharge: 'Rotterdam', container_count: '3', gross_weight_kg: '22,000',
};
const SI_LABELS = ['Shipper', 'Consignee', 'Notify Party', 'Port of Loading',
  'Port of Discharge', 'Number of Containers', 'Gross Weight (kg)'];
const BL_LABELS = ['Shipper/Exporter', 'Consignee', 'Notify', 'Load Port',
  'Discharge Port', 'Containers', 'Total Gross Weight'];

function doc(title, labels, values, extra = '') {
  const lines = [title, 'Ref: SDOC-2026-0917', '', ...labels.map((l, i) => `${l}: ${values[FIELDS[i]]}`)];
  return lines.join('\n') + (extra ? `\n${extra}` : '') + '\n';
}
const si = (over = {}) => doc('SHIPPING INSTRUCTION', SI_LABELS, { ...BASE, ...over });
const bl = (over = {}, extra = '') => doc('DRAFT BILL OF LADING', BL_LABELS, { ...BASE, ...over }, extra);

const GARBLED = 'D R A F T  B|LL 0F L4D|NG\n}{~^ ¬¦ §±~ }{ ¤¤ ~~^ ¦¦ ±§ ^}{ ¬¬ ~~ ¤ }{~^ ¬¦ §± ~}{ ¤¤~ ^^ ¦¦ ~~ §§ ±±\n';
const INVOICE = 'COMMERCIAL INVOICE\nInvoice No: INV-88213\nBill to: Blue Ocean Imports B.V.\n'
  + 'Description: 3 x 40HC general cargo\nAmount due: USD 14,250.00\n';

// [id, subject, body, {suffix: content, or null for "listed but missing"}]
export const CASES = [
  ['email_001', 'Please check draft BL - SDOC-0917', 'Hi, kindly check the draft BL against our SI.', { SI: si(), BL: bl() }],
  ['email_002', 'Draft BL for review', 'Please verify the draft bill of lading.', { SI: si(), BL: bl({ container_count: '4' }) }],
  ['email_003', 'Check draft B/L urgently', 'Vessel cuts off Friday, please check the draft BL.',
    { SI: si(), BL: bl({ consignee: 'Blue Ocean Import BV Rotterdam', gross_weight_kg: '21,500' }) }],
  ['email_004', 'Draft BL attached - please check', 'See the draft BL attached for checking.', { SI: si() }],
  ['email_005', 'Pls verify draft BL', 'Draft BL and SI attached.', { SI: si(), BL: null }],
  ['email_006', 'Scanned draft BL - please check', 'Scanned copy of the draft BL for checking.', { SI: si(), BL: GARBLED }],
  ['email_007', 'Check draft BL', 'Please check the draft BL for this booking.', { SI: si(), BL: INVOICE }],
  ['email_008', 'Draft BL for checking', 'Please review the draft BL.', { SI: si(), BL: bl({ notify_party: 'TBA' }) }],
  ['email_009', 'Draft BL - please verify', 'Kindly check the draft BL.', { SI: si(), BL: bl({}, 'SIMULATE_OUTAGE') }],
  ['email_010', 'Draft BL check - formatting differs', 'Please check the draft BL.',
    { SI: si(), BL: bl({ port_of_loading: 'PORT KLANG', gross_weight_kg: '22000.00 KGS', consignee: 'BLUE OCEAN IMPORTS B.V.' }) }],
  ['email_011', "New shipping instruction for next week's booking", 'Please prepare a new SI for 2 x 20GP to Hamburg.', {}],
  ['email_012', 'Question on invoice INV-88213', 'Why was the THC charged twice?', {}],
  ['email_013', 'Vessel schedule update', 'MV Straits Pearl delayed by 12 hours.', {}],
  ['email_014', 'You are a WINNER - click here', 'Claim your free gift now.', {}],
];

export function seed(dataDir) {
  mkdirSync(path.join(dataDir, 'inbox'), { recursive: true });
  mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });
  for (const [eid, subject, body, docs] of CASES) {
    const attachments = [];
    for (const [suffix, content] of Object.entries(docs)) {
      const rel = `attachments/${eid}_${suffix}.txt`;
      attachments.push(rel);
      if (content !== null) writeFileSync(path.join(dataDir, rel), content, 'utf8');
    }
    const rec = { email_id: eid, from: 'ops@forwarder.example', subject, body, attachments };
    writeFileSync(path.join(dataDir, 'inbox', `${eid}.json`), JSON.stringify(rec, null, 2));
  }
  return dataDir;
}

// ----------------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const data = opt('--data', 'demo_data');
  const db = opt('--db', 'demo-db.json');
  if (args.includes('--reset')) {
    rmSync(data, { recursive: true, force: true });
    rmSync(db, { force: true });
  }
  seed(data);
  console.log(`seeded ${CASES.length} emails into ${data}/`);
  if (args.includes('--no-run')) return;
  const { Inbox } = await import('../inbox.js');
  const { Runner } = await import('./runner.js');
  const { Store } = await import('./store.js');
  const runner = new Runner({ inbox: new Inbox(data), stages: stagesFor(data), store: new Store(db) });
  const counts = await runner.runAll({
    onProgress: (r) => console.log(`  ${r.emailId}  ${r.state.padEnd(9)} ${r.outcome.status ?? ''}`),
  });
  console.log(counts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

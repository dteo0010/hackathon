// Part D: uncertainty escalation, provenance and evidence from C to D, review-reason statistics.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DocType, FIELDS, Reason, makeDocument } from '../src/models.js';
import { PIPELINE_ASSESS_CONFIG, assess } from '../src/reliability/assess.js';
import { reasonCounts, toSubmission } from '../src/reliability/report.js';
import { applyCorrections, fieldRows } from '../src/reliability/review.js';
import { Runner } from '../src/reliability/runner.js';
import { Store } from '../src/reliability/store.js';
import { createApp } from '../src/server.js';
import { PythonBridge, stagesFor } from '../src/stages.js';
import { bl, email, si } from './helpers.js';

process.env.SDOC_USE_LLM = '0';
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasPython = spawnSync(PY, ['--version']).status === 0;
const opts = { skip: hasPython ? false : `${PY} not found` };

// A BL whose container count differs from the SI; the BL value came from `source` at `confidence`.
function mismatchOn(source, confidence) {
  const b = bl({ overrides: { container_count: '4' } });
  Object.assign(b.fields.container_count, { source, confidence, evidence: 'Loading at: 4 x 40HC' });
  const r = email([si(), b]);
  r.comparison = { fields: FIELDS.map((f) => ({ field: f, siValue: r.documents[0].fields[f].value,
    blValue: b.fields[f].value, match: f !== 'container_count' })) };
  return r;
}

// ------------------------------------------------------------ the rule
test('pipeline threshold is 0.80', () => assert.equal(PIPELINE_ASSESS_CONFIG.minFieldConfidence, 0.8));

test('a mismatch that rests on a low-confidence AI read goes to review as low_confidence', () => {
  const a = assess(mismatchOn('llm', 0.55), PIPELINE_ASSESS_CONFIG);
  assert.equal(a.ok, false);
  assert.equal(a.reason, Reason.LOW_CONFIDENCE);
  assert.match(a.detail, /low-confidence AI BL read \(55%\)/);
  assert.equal(a.issues[0].evidence[0].snippet, 'Loading at: 4 x 40HC');
});

test('a confident AI read is NOT escalated just because it came from AI', () => {
  assert.equal(assess(mismatchOn('llm', 0.94), PIPELINE_ASSESS_CONFIG).ok, true);
});

test('a reliable deterministic mismatch stays a mismatch', () => {
  assert.equal(assess(mismatchOn('rule', 1), PIPELINE_ASSESS_CONFIG).ok, true);
  assert.equal(assess(mismatchOn('derived', 0.9), PIPELINE_ASSESS_CONFIG).ok, true);
});

test('a low-confidence read that matches still goes to review (the match itself is uncertain)', () => {
  const r = mismatchOn('llm', 0.4);
  r.comparison.fields.find((f) => f.field === 'container_count').match = true;
  const a = assess(r, PIPELINE_ASSESS_CONFIG);
  assert.equal(a.ok, false);
  assert.equal(a.reason, Reason.LOW_CONFIDENCE);
  assert.match(a.detail, /^container count match relies on a low-confidence AI BL read \(40%\)/);
});

test('a confident AI read that matches is not escalated', () => {
  const r = mismatchOn('llm', 0.94);
  r.comparison.fields.find((f) => f.field === 'container_count').match = true;
  assert.equal(assess(r, PIPELINE_ASSESS_CONFIG).ok, true);
});

test('a low-confidence SI read counts too, and every uncertain side is listed', () => {
  const r = mismatchOn('llm', 0.5);
  Object.assign(r.documents[0].fields.consignee, { source: 'ocr', confidence: 0.7 });
  const a = assess(r, PIPELINE_ASSESS_CONFIG);
  assert.equal(a.reason, Reason.LOW_CONFIDENCE);
  assert.deepEqual(a.issues.map((i) => i.evidence[0].field).sort(), ['consignee', 'container_count']);
});

test('a value typed by a reviewer is never treated as uncertain, matched or not', () => {
  assert.equal(assess(mismatchOn('reviewer', 0.1), PIPELINE_ASSESS_CONFIG).ok, true);
  const r = mismatchOn('reviewer', 0.1);
  r.comparison.fields.find((f) => f.field === 'container_count').match = true;
  assert.equal(assess(r, PIPELINE_ASSESS_CONFIG).ok, true);
});

test('earlier reasons keep their priority over low_confidence', () => {
  const r = mismatchOn('llm', 0.5);
  r.documents[0].fields.shipper.value = 'TBA';
  assert.equal(assess(r, PIPELINE_ASSESS_CONFIG).reason, Reason.MISSING_VALUE);
});

// ------------------------------------------------------ runner end to end
function runOne(blSource, blConfidence, blCount = '4') {
  const docs = {
    'a/e1_SI.txt': { docType: DocType.SI, count: '3', source: 'rule', confidence: 1 },
    'a/e1_BL.txt': { docType: DocType.BL, count: blCount, source: blSource, confidence: blConfidence },
  };
  const base = { shipper: 'A', consignee: 'B', notify_party: 'B', port_of_loading: 'X', port_of_discharge: 'Y', gross_weight_kg: '1000' };
  const stages = {
    classify: () => 'BL_COMPARISON',
    extract: (p) => {
      const d = docs[p];
      const fields = Object.fromEntries(Object.entries(base).map(([f, v]) => [f, { value: v, confidence: 1, source: 'rule', evidence: `${f}: ${v}` }]));
      fields.container_count = { value: d.count, confidence: d.confidence, source: d.source, evidence: `Containers: ${d.count}` };
      return makeDocument({ path: p, docType: d.docType, text: `${d.docType} document ${'with enough words to read '.repeat(4)}`, fields });
    },
    compare: (s, b) => ({ fields: FIELDS.map((f) => ({ field: f, siValue: s.fields[f].value, blValue: b.fields[f].value,
      match: s.fields[f].value === b.fields[f].value })) }),
  };
  const inbox = { isRemote: false, emails: async () => [], get: async () => null,
    readBytes: async (p) => Buffer.from(p) };
  const store = new Store(null);
  const runner = new Runner({ inbox, stages, store });  // pipeline default assess config
  return runner.process({ email_id: 'e1', subject: 's', body: 'Please check the attached SI and draft BL.',
    attachments: ['a/e1_SI.txt', 'a/e1_BL.txt'] }).then(() => store);
}

test('runner: uncertain BL value behind a mismatch -> NEEDS_REVIEW / low_confidence', async () => {
  const store = await runOne('llm', 0.6);
  const rec = store.get('e1');
  assert.equal(rec.outcome.status, 'NEEDS_REVIEW');
  assert.equal(rec.outcome.reviewReason, Reason.LOW_CONFIDENCE);
  // the organisers' file still gets the mismatch (submission semantics unchanged)
  const { submission } = toSubmission(store, ['e1']);
  assert.equal(submission.e1.status, 'MISMATCH');
  assert.deepEqual(submission.e1.defect_fields, ['container_count']);
});

test('runner: uncertain BL value that matches -> NEEDS_REVIEW / low_confidence, submission stays OK', async () => {
  const store = await runOne('llm', 0.6, '3');
  const rec = store.get('e1');
  assert.equal(rec.outcome.status, 'NEEDS_REVIEW');
  assert.equal(rec.outcome.reviewReason, Reason.LOW_CONFIDENCE);
  const { submission } = toSubmission(store, ['e1']);
  assert.equal(submission.e1.status, 'OK');
  assert.deepEqual(submission.e1.defect_fields, []);
});

test('runner: confident values -> plain MISMATCH', async () => {
  const rec = (await runOne('llm', 0.95)).get('e1');
  assert.equal(rec.outcome.status, 'MISMATCH');
  assert.deepEqual(rec.outcome.defectFields, ['container_count']);
});

test('reviewer correction clears a low-confidence case and is marked as the reviewer\'s value', async () => {
  const store = await runOne('llm', 0.6);
  const compare = (s, b) => ({ fields: FIELDS.map((f) => ({ field: f, siValue: s.fields[f].value, blValue: b.fields[f].value,
    match: s.fields[f].value === b.fields[f].value })) });
  const rec = await applyCorrections(store, store.get('e1'), { compare, blValues: { container_count: '3' }, reviewer: 'jw' });
  assert.equal(rec.outcome.status, 'OK');
  const row = fieldRows(rec.result).find((r) => r.field === 'container_count');
  assert.equal(row.blMeta.source, 'reviewer');
});

// ------------------------------------------------------ provenance C -> D -> API
const bridge = new PythonBridge();
after(() => bridge.stop());
const team = stagesFor('Bundle', { bridge, classifier: 'baseline' });
const SI_T = `SHIPPING INSTRUCTION
Shipper: APRIL FAR EAST (M) SDN BHD
Consignee: EAST BRIGHT FZ-LLC
Notify: EAST BRIGHT FZ-LLC
Port of Loading: NANTONG, CHINA
POD: KARACHI, PAKISTAN
Total Containers: 2 x 40'HC
Gross Weight (KG): 43,686 KG
`;
const BL_T = `BILL OF LADING (DRAFT)
Shipper: APRIL FAR EAST (M) SDN BHD
Consignee: EAST BRIGHT FZ-LLC
Notify Party: EAST BRIGHT FZ-LLC
Load Port: NANTONG, CHINA
Port of Discharge: KARACHI, PAKISTAN
CONTAINER NO.   GROSS WEIGHT (KG)
ABCD1234567   21,843
EFGH7654321   21,843
`;

test('provenance and evidence survive C -> D: rule and derived values keep their source', opts, async () => {
  const s = await team.extract('a/e_SI.txt', Buffer.from(SI_T));
  const b = await team.extract('a/e_BL.txt', Buffer.from(BL_T));
  assert.equal(s.fields.consignee.source, 'rule');
  assert.equal(s.fields.consignee.confidence, 1);
  assert.equal(s.fields.consignee.evidence, 'Consignee: EAST BRIGHT FZ-LLC');
  assert.equal(b.fields.gross_weight_kg.source, 'derived');
  assert.match(b.fields.gross_weight_kg.evidence, /container rows/);
  const rows = fieldRows({ documents: [s, b], comparison: await team.compare(s, b) });
  const gw = rows.find((r) => r.field === 'gross_weight_kg');
  assert.deepEqual(gw.siMeta, { source: 'rule', confidence: 1, evidence: 'Gross Weight (KG): 43,686 KG' });
  assert.equal(gw.blMeta.source, 'derived');
  assert.equal(gw.match, true);
});

test('API: email detail exposes source, confidence and evidence per value; report exposes reason counts', async () => {
  const store = await runOne('llm', 0.6);
  const inbox = { isRemote: false, emails: async () => [{ email_id: 'e1' }], get: async () => null, readBytes: async () => Buffer.from('') };
  const app = createApp({ inbox, store, runner: new Runner({ inbox, stages: { classify() {}, extract() {}, compare() {} }, store }), dataSource: 'x' });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const base = `http://localhost:${server.address().port}`;
    const d = await (await fetch(`${base}/api/emails/e1`)).json();
    const row = d.rows.find((r) => r.field === 'container_count');
    assert.deepEqual(row.blMeta, { source: 'llm', confidence: 0.6, evidence: 'Containers: 4' });
    const rep = await (await fetch(`${base}/api/report`)).json();
    assert.equal(rep.rows[0].reason, 'low_confidence');
    assert.equal(rep.reasons.find((x) => x.reason === 'low_confidence').count, 1);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------ statistics
test('reason counts come from the stored results, all reasons listed', () => {
  const recs = [
    { outcome: { status: 'NEEDS_REVIEW', reviewReason: 'unreadable' } },
    { outcome: { status: 'NEEDS_REVIEW', reviewReason: 'unreadable' } },
    { outcome: { status: 'NEEDS_REVIEW', reviewReason: 'low_confidence' } },
    { outcome: { status: 'MISMATCH', reviewReason: null } },
    { outcome: { status: 'OK', reviewReason: null } },
  ];
  const counts = Object.fromEntries(reasonCounts({ list: () => recs }).map((x) => [x.reason, x.count]));
  assert.deepEqual(counts, { missing_attachment: 0, unreadable: 2, wrong_doc_type: 0, missing_value: 0, low_confidence: 1 });
});

// ------------------------------------------------------ public seed
test('public seed keeps provenance but no document text or transcription text', async () => {
  const store = await runOne('llm', 0.6);
  const tmp = mkdtempSync(path.join(tmpdir(), 'sdoc-rel-'));
  const full = path.join(tmp, 'full.json');
  const pub = path.join(tmp, 'pub.json');
  const data = { emails: { e1: store.get('e1') }, reviews: [], events: [] };
  data.emails.e1.result.documents[1].transcription = { text: 'SECRET SCAN TEXT', model: 'gemini', illegible: 2 };
  data.emails.e1.result.documents[1].text = 'SECRET SCAN TEXT';
  writeFileSync(full, JSON.stringify(data));
  execFileSync(process.execPath, ['scripts/make-public-seed.mjs', full, pub]);
  const out = readFileSync(pub, 'utf8');
  assert.ok(!out.includes('SECRET SCAN TEXT'));
  const d = JSON.parse(out).emails.e1.result.documents[1];
  assert.deepEqual(d.transcription, { model: 'gemini', illegible: 2 });
  assert.equal(d.fields.container_count.source, 'llm');
  assert.equal(d.fields.container_count.confidence, 0.6);
});

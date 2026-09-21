// Team stages (src/stages.js): Node <-> Python bridge to A (classifier.py) and C (sdoc_compare).
// Skipped automatically when Python isn't installed on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { PythonBridge, stagesFor } from '../src/stages.js';
import { assess, isBlank } from '../src/reliability/assess.js';
import { makeEmailResult } from '../src/models.js';

process.env.SDOC_USE_LLM = '0'; // tests never call an API
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasPython = spawnSync(PY, ['--version']).status === 0;
const opts = { skip: hasPython ? false : `${PY} not found` };

const bridge = new PythonBridge();
const team = stagesFor('Bundle', { bridge, classifier: 'team' });
after(() => bridge.stop());

const SI = `SHIPPING INSTRUCTION
Shipper: APRIL FAR EAST (M) SDN BHD
  TOWER 2, AVENUE 5, LEVEL 6
Consignee (Non-Negotiable): EAST BRIGHT FZ-LLC
Notify: SAME AS CONSIGNEE
Port of Loading (POL): NANTONG, CHINA (CNNTG)
POD: KARACHI, PAKISTAN (PKKHI)
Total Containers: 6 x 40'HC
Gross Wt (kgs): 131,058 KG
NET WEIGHT: 120,000 KG
`;
const BL = `BILL OF LADING (DRAFT)
SHIPPER: APRIL FAR EAST (M) SDN BHD
To the Order of: EAST BRIGHT FZ-LLC
Notify Party: EAST BRIGHT FZ-LLC
Load Port: NANTONG, CHINA
Discharge Port: KARACHI, PAKISTAN (PKKHI)
Container Count: 7 x 40'HC
Gross Weight (KG): 131058
`;
const buf = (s) => Buffer.from(s, 'utf8');

test('extract: label synonyms, raw value kept for reviewers, evidence attached', opts, async () => {
  const d = await team.extract('attachments/email_001_BL.txt', buf(BL));
  assert.equal(d.docType, 'BL');
  assert.equal(d.fields.consignee.value, 'EAST BRIGHT FZ-LLC');
  assert.equal(d.fields.consignee.evidence, 'To the Order of: EAST BRIGHT FZ-LLC');
  assert.equal(d.fields.gross_weight_kg.value, '131058');
  assert.equal(d.fields.gross_weight_kg.confidence, 1);
});

test('compare: formatting differences match, the planted defect does not', opts, async () => {
  const si = await team.extract('attachments/email_001_SI.txt', buf(SI));
  const bl = await team.extract('attachments/email_001_BL.txt', buf(BL));
  const r = await team.compare(si, bl);
  assert.equal(r.fields.length, 7);
  const bad = r.fields.filter((f) => !f.match).map((f) => f.field);
  assert.deepEqual(bad, ['container_count']); // SAME AS CONSIGNEE, missing port code, 131,058 KG vs 131058 all match
});

test('blank SI value keeps its text and D escalates missing_value instead of reporting a mismatch', opts, async () => {
  const si = await team.extract('attachments/email_002_SI.txt', buf(SI.replace('131,058 KG', 'N/A')));
  assert.equal(si.fields.gross_weight_kg.value, 'N/A'); // raw text kept for the reviewer
  const bl = await team.extract('attachments/email_002_BL.txt', buf(BL.replace('7 x', '6 x')));
  const comparison = await team.compare(si, bl);
  const a = assess(makeEmailResult({
    emailId: 'email_002', category: 'BL_COMPARISON',
    attachments: [si.path, bl.path], documents: [si, bl], comparison,
  }));
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'missing_value');
});

test('fill-in blanks count as missing values in D', () => {
  for (const v of ['____MT', '_______', '???', '??? MTS', 'TBA', 'N/A', '']) assert.equal(isBlank(v), true, v);
  for (const v of ['SINGAPORE', '6 x 40HC', '0']) assert.equal(isBlank(v), false, v);
});

test('wrong document is typed OTHER', opts, async () => {
  const d = await team.extract('attachments/email_003_BL.txt', buf('COMMERCIAL INVOICE\nInvoice No.: 1\nSeller: X\n'));
  assert.equal(d.docType, 'OTHER');
});

test('classify: A\'s classifier through the bridge, attachments beat the subject', opts, async () => {
  const cat = await team.classify({
    email_id: 'email_004', from: 'a@b.c', subject: 'LOCAL CHARGES', body: 'Please check the attached SI and draft BL.',
    attachments: ['attachments/email_004_SI.txt', 'attachments/email_004_BL.txt'],
  });
  assert.equal(cat, 'BL_COMPARISON');
});

test('python errors are reported, not swallowed', opts, async () => {
  await assert.rejects(bridge.call('no_such_op'), /python no_such_op: KeyError/);
  assert.equal(await bridge.call('ping'), 'pong'); // bridge still alive afterwards
});

test('classifier switch: baseline by default, invalid value refused', () => {
  const prev = process.env.SDOC_CLASSIFIER;
  delete process.env.SDOC_CLASSIFIER;
  try {
    assert.equal(stagesFor('Bundle', { bridge }).classifier, 'baseline');
    assert.throws(() => stagesFor('Bundle', { bridge, classifier: 'x' }), /SDOC_CLASSIFIER/);
  } finally {
    if (prev !== undefined) process.env.SDOC_CLASSIFIER = prev;
  }
});

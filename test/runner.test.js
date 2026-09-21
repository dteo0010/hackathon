// Phase 2: runner (retries, visible failures, retry button) + store.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocType, FIELDS, makeDocument } from '../src/models.js';
import { PermanentError, Runner } from '../src/reliability/runner.js';
import { Store, makeOutcome } from '../src/reliability/store.js';

const SI_TEXT = 'SHIPPING INSTRUCTION\nShipper: Acme Trading\nConsignee: Blue Ocean\nPort of Loading: Port Klang';
const BL_TEXT = 'DRAFT BILL OF LADING\nShipper: Acme Trading\nConsignee: Blue Ocean\nLoad Port: Port Klang';
const VALUES = { shipper: 'Acme', consignee: 'Blue Ocean', notify_party: 'Same as consignee', port_of_loading: 'Port Klang',
  port_of_discharge: 'Rotterdam', container_count: '3', gross_weight_kg: '22000' };

class FakeInbox {
  constructor(emails, files) { this.list = emails; this.files = files; this.isRemote = false; }
  async emails() { return this.list; }
  async get(id) { return this.list.find((e) => e.email_id === id); }
  async readBytes(p) {
    if (!(p in this.files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return Buffer.from(this.files[p]);
  }
}

const mkEmail = (eid, { subject = 'Pls check draft BL', n = 2 } = {}) =>
  ({ email_id: eid, subject, body: '', attachments: [`attachments/${eid}_SI.txt`, `attachments/${eid}_BL.txt`].slice(0, n) });
const files = (...ids) => Object.fromEntries(ids.flatMap((e) => [[`attachments/${e}_SI.txt`, SI_TEXT], [`attachments/${e}_BL.txt`, BL_TEXT]]));

const classify = (e) => (e.attachments.length || e.subject.includes('BL') ? 'BL_COMPARISON' : 'SPAM');
function extract(p, content) {
  const text = content.toString();
  const docType = text.startsWith('SHIPPING') ? DocType.SI : text.startsWith('DRAFT') ? DocType.BL : DocType.OTHER;
  const vals = { ...VALUES, ...(text.includes('4 CONTAINERS') ? { container_count: '4' } : {}) };
  return makeDocument({ path: p, docType, text: `${text} ${'padding words '.repeat(5)}`, fields: vals });
}
const compare = (si, bl) => ({ fields: FIELDS.map((f) => ({ field: f, siValue: si.fields[f].value, blValue: bl.fields[f].value, match: si.fields[f].value === bl.fields[f].value })) });

function setup(emails, fileMap, stageOverrides = {}, store = new Store(null)) {
  const inbox = new FakeInbox(emails, fileMap);
  const runner = new Runner({ inbox, store, stages: { classify, extract, compare, ...stageOverrides }, retry: { sleep: async () => {} } });
  return { inbox, runner, store };
}

// --- happy paths
test('clean email is ok', async () => {
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'));
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'DONE');
  assert.equal(rec.outcome.status, 'OK');
  assert.ok(rec.result.comparison);
});

test('mismatch reports fields', async () => {
  const f = files('e1');
  f['attachments/e1_BL.txt'] = `${BL_TEXT}\n4 CONTAINERS`;
  const { runner, inbox } = setup([mkEmail('e1')], f);
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.outcome.status, 'MISMATCH');
  assert.deepEqual(rec.outcome.defectFields, ['container_count']);
});

test('non-comparison skips extraction', async () => {
  const called = [];
  const { runner, inbox } = setup([mkEmail('e1', { subject: 'cheap watches', n: 0 })], {}, { extract: (p) => called.push(p) });
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'DONE');
  assert.equal(rec.outcome.category, 'SPAM');
  assert.equal(rec.outcome.status, null);
  assert.deepEqual(called, []);
});

test('async stages work', async () => {
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), {
    classify: async (e) => classify(e), extract: async (p, c) => extract(p, c), compare: async (a, b) => compare(a, b),
  });
  assert.equal((await runner.process(await inbox.get('e1'))).outcome.status, 'OK');
});

// --- escalation
test('missing file escalates, not fails', async () => {
  const f = files('e1');
  delete f['attachments/e1_BL.txt'];
  const { runner, inbox } = setup([mkEmail('e1')], f);
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'IN_REVIEW');
  assert.equal(rec.outcome.reviewReason, 'missing_attachment');
  assert.ok(rec.assessment.issues[0].detail);
});

test('escalated email is not compared', async () => {
  const compared = [];
  const { runner, inbox } = setup([mkEmail('e1', { n: 1 })], files('e1'), { compare: () => compared.push(1) });
  await runner.process(await inbox.get('e1'));
  assert.deepEqual(compared, []);
});

// --- retries & visible failures
test('transient error is retried', async () => {
  let n = 0;
  const flaky = (p, c) => { n += 1; if (n === 1) throw new Error('LLM timed out'); return extract(p, c); };
  const { runner, inbox, store } = setup([mkEmail('e1')], files('e1'), { extract: flaky });
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'DONE');
  assert.equal(rec.attempts, 2);
  assert.ok(store.events('e1').some((e) => e.kind === 'attempt_failed'));
});

test('persistent error fails visibly', async () => {
  const { runner, inbox, store } = setup([mkEmail('e1')], files('e1'), { extract: () => { throw new Error('vision API down'); } });
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'FAILED');
  assert.match(rec.errorStage, /^extract/);
  assert.match(rec.errorMessage, /vision API down/);
  assert.match(rec.errorTrace, /at /);
  assert.equal(rec.attempts, 3);
  assert.deepEqual(store.reviewQueue().map((r) => r.emailId), ['e1']);
});

test('permanent error does not retry', async () => {
  let n = 0;
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), { extract: () => { n += 1; throw new PermanentError('unsupported .xyz'); } });
  assert.equal((await runner.process(await inbox.get('e1'))).state, 'FAILED');
  assert.equal(n, 1);
});

test('bad stage output fails clearly', async () => {
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), { classify: () => 'SHIPPING' });
  const rec = await runner.process(await inbox.get('e1'));
  assert.equal(rec.state, 'FAILED');
  assert.match(rec.errorMessage, /classify returned "SHIPPING"/);
});

test('extract returning junk fails clearly', async () => {
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), { extract: () => 'text' });
  assert.match((await runner.process(await inbox.get('e1'))).errorMessage, /expected a DocumentResult/);
});

test('classify is case-insensitive', async () => {
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), { classify: () => 'bl_comparison' });
  assert.equal((await runner.process(await inbox.get('e1'))).state, 'DONE');
});

test('one failure does not stop the batch', async () => {
  const picky = (p, c) => { if (p.includes('e1')) throw new Error('boom'); return extract(p, c); };
  const { runner } = setup([mkEmail('e1'), mkEmail('e2')], files('e1', 'e2'), { extract: picky });
  const counts = await runner.runAll();
  assert.equal(counts.FAILED, 1);
  assert.equal(counts.DONE, 1);
});

test('concurrent run', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `e${i}`);
  const { runner } = setup(ids.map((i) => mkEmail(i)), files(...ids), {
    extract: async (p, c) => { await new Promise((r) => setTimeout(r, Math.random() * 5)); return extract(p, c); },
  });
  assert.equal((await runner.runAll({ concurrency: 4 })).DONE, 20);
});

// --- retry button + resume
test('retry button recovers a failed email', async () => {
  let down = true;
  const { runner, inbox, store } = setup([mkEmail('e1')], files('e1'), {
    extract: (p, c) => { if (down) throw new Error('down'); return extract(p, c); },
  });
  assert.equal((await runner.process(await inbox.get('e1'))).state, 'FAILED');
  down = false;
  const rec = await runner.retry('e1');
  assert.equal(rec.state, 'DONE');
  assert.equal(rec.errorMessage, null);
  const kinds = store.events('e1').map((e) => e.kind);
  assert.ok(kinds.includes('failed') && kinds.includes('retry_requested'));
  assert.equal(kinds.at(-1), 'done');
});

test('re-running skips finished emails', async () => {
  let calls = 0;
  const { runner } = setup([mkEmail('e1')], files('e1'), { classify: () => { calls += 1; return 'BL_COMPARISON'; } });
  await runner.runAll();
  await runner.runAll();
  assert.equal(calls, 1);
});

test('retry refuses to overwrite a human review', async () => {
  const { runner, inbox, store } = setup([mkEmail('e1', { n: 1 })], files('e1'));
  await runner.process(await inbox.get('e1'));
  store.saveReview('e1', 'override', makeOutcome('BL_COMPARISON', 'OK'), { reviewer: 'sy' });
  await assert.rejects(runner.retry('e1'), /already reviewed/);
  assert.equal((await runner.retry('e1', { allowReviewed: true })).state, 'IN_REVIEW');
});

// --- store
test('store survives reopen', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sdoc-')), 'db.json');
  const { runner, inbox } = setup([mkEmail('e1')], files('e1'), {}, new Store(file));
  await runner.process(await inbox.get('e1'));
  runner.store.flush();
  const rec = new Store(file).get('e1');
  assert.equal(rec.outcome.status, 'OK');
  assert.equal(rec.result.documents[1].docType, 'BL');
});

test('store returns copies, not live objects', async () => {
  const { runner, inbox, store } = setup([mkEmail('e1')], files('e1'));
  const rec = await runner.process(await inbox.get('e1'));
  rec.outcome.status = 'HACKED';
  assert.equal(store.get('e1').outcome.status, 'OK');
});

test('reviews are audited', async () => {
  const { runner, inbox, store } = setup([mkEmail('e1', { n: 1 })], files('e1'));
  await runner.process(await inbox.get('e1'));
  store.saveReview('e1', 'correct', makeOutcome('BL_COMPARISON', 'MISMATCH', null, ['consignee']),
    { reviewer: 'sy', note: 'BL attached separately', corrections: { x: { consignee: 'Y' } } });
  const rec = store.get('e1');
  assert.equal(rec.state, 'REVIEWED');
  assert.deepEqual(rec.outcome.defectFields, ['consignee']);
  const [rv] = store.reviews('e1');
  assert.equal(rv.before.status, 'NEEDS_REVIEW');
  assert.equal(rv.after.status, 'MISMATCH');
  assert.deepEqual(store.reviewQueue(), []);
});

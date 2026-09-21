// Phase 3: review actions, report/submission, demo pipeline.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Inbox } from '../src/inbox.js';
import { compare, seed, stagesFor } from '../src/reliability/demo.js';
import { reportRows, summary, toSubmission } from '../src/reliability/report.js';
import * as review from '../src/reliability/review.js';
import { Runner } from '../src/reliability/runner.js';
import { Store } from '../src/reliability/store.js';

let store;
let runner;
beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sdoc-demo-'));
  seed(dir);
  store = new Store(null);
  runner = new Runner({ inbox: new Inbox(dir), stages: stagesFor(dir), store, retry: { sleep: async () => {} } });
  await runner.runAll();
});
const outcome = (id) => store.get(id).outcome;

// --- demo pipeline hits every path
test('demo covers every path', () => {
  const expected = {
    email_001: ['OK', null], email_002: ['MISMATCH', null], email_003: ['MISMATCH', null],
    email_004: ['NEEDS_REVIEW', 'missing_attachment'], email_005: ['NEEDS_REVIEW', 'missing_attachment'],
    email_006: ['NEEDS_REVIEW', 'unreadable'], email_007: ['NEEDS_REVIEW', 'wrong_doc_type'],
    email_008: ['NEEDS_REVIEW', 'missing_value'], email_010: ['OK', null],
  };
  for (const [id, [status, reason]] of Object.entries(expected)) {
    assert.deepEqual([outcome(id).status, outcome(id).reviewReason], [status, reason], id);
  }
  assert.deepEqual(outcome('email_002').defectFields, ['container_count']);
  assert.deepEqual(new Set(outcome('email_003').defectFields), new Set(['consignee', 'gross_weight_kg']));
  assert.equal(store.get('email_009').state, 'FAILED');
  assert.deepEqual(['email_011', 'email_012', 'email_013', 'email_014'].map((id) => outcome(id).category),
    ['SI_REQUEST', 'INVOICE_QUERY', 'GENERAL', 'SPAM']);
});

test('formatting differences are not mismatches', () => assert.equal(outcome('email_010').status, 'OK'));
test('retry recovers the simulated outage', async () => assert.equal((await runner.retry('email_009')).outcome.status, 'OK'));

// --- review actions
test('correct a missing value then recompare', async () => {
  const rec = await review.applyCorrections(store, store.get('email_008'),
    { compare, blValues: { notify_party: 'Same as consignee' }, reviewer: 'sy' });
  assert.equal(rec.state, 'REVIEWED');
  assert.equal(rec.outcome.status, 'OK');
  const [rv] = store.reviews('email_008');
  assert.deepEqual(rv.corrections['attachments/email_008_BL.txt'].notify_party, { from: 'TBA', to: 'Same as consignee' });
});

test('a correction can reveal a mismatch', async () => {
  const rec = await review.applyCorrections(store, store.get('email_008'), { compare, blValues: { notify_party: 'Someone Else Ltd' } });
  assert.equal(rec.outcome.status, 'MISMATCH');
  assert.deepEqual(rec.outcome.defectFields, ['notify_party']);
  assert.match(summary(rec), /Notify party: SI Same as consignee \/ BL Someone Else Ltd/);
});

test('correction rejected while values are blank', async () => {
  await assert.rejects(review.applyCorrections(store, store.get('email_008'), { compare }), /BL notify party/);
  assert.equal(store.get('email_008').state, 'IN_REVIEW'); // nothing saved
});

test('correction needs both documents', async () => {
  await assert.rejects(review.applyCorrections(store, store.get('email_004'), { compare }), /Override/);
});

test('reviewer types in values for an unreadable scan', async () => {
  const rec = store.get('email_006');
  const values = Object.fromEntries(review.fieldRows(rec.result).map((r) => [r.field, r.si]));
  assert.equal((await review.applyCorrections(store, rec, { compare, blValues: values })).outcome.status, 'OK');
});

test('roles fix wrong doc type', () => {
  const rec = store.get('email_007');
  const { si, bl } = review.pickPair(rec.result, { 'attachments/email_007_SI.txt': 'SI', 'attachments/email_007_BL.txt': 'IGNORE' });
  assert.match(si.path, /SI\.txt$/);
  assert.equal(bl, null);
});

test('override requires a note', () => {
  assert.throws(() => review.override(store, store.get('email_004'),
    { category: 'BL_COMPARISON', status: 'NEEDS_REVIEW', reviewReason: 'missing_attachment', note: ' ' }), /note/);
});

test('override can recategorise', () => {
  const rec = review.override(store, store.get('email_013'), { category: 'SPAM', note: 'phishing', reviewer: 'sy' });
  assert.equal(rec.outcome.category, 'SPAM');
  assert.equal(rec.outcome.status, null);
});

test('override MISMATCH needs fields', () => {
  assert.throws(() => review.override(store, store.get('email_001'),
    { category: 'BL_COMPARISON', status: 'MISMATCH', defectFields: [], note: 'x' }), /field/);
});

test('confirm keeps the outcome and closes the case', () => {
  const rec = review.confirm(store, store.get('email_004'), { reviewer: 'sy' });
  assert.equal(rec.state, 'REVIEWED');
  assert.equal(rec.outcome.status, 'NEEDS_REVIEW');
  assert.ok(!store.reviewQueue().some((r) => r.emailId === 'email_004'));
});

// --- report / submission
test('report summaries', () => {
  const rows = Object.fromEntries(reportRows(store).map((r) => [r.emailId, r]));
  assert.equal(rows.email_001.details, 'No mismatch detected.');
  assert.equal(rows.email_002.details, 'Container count: SI 3 / BL 4');
  assert.equal(rows.email_009.category, 'BL_COMPARISON');
  assert.match(rows.email_009.details, /failed/);
});

test('submission shape', () => {
  const { submission, warnings } = toSubmission(store);
  assert.equal(Object.keys(submission).length, 14);
  assert.deepEqual(submission.email_002, { category: 'BL_COMPARISON', status: 'MISMATCH', review_reason: null, has_defect: true, defect_fields: ['container_count'] });
  assert.equal(submission.email_004.review_reason, 'missing_attachment');
  assert.deepEqual(submission.email_014, { category: 'SPAM', status: 'OK', review_reason: null, has_defect: false, defect_fields: [] });
  assert.ok(warnings.some((w) => w.includes('email_009')));
});

test('submission reflects a review', async () => {
  await review.applyCorrections(store, store.get('email_008'), { compare, blValues: { notify_party: 'Someone Else Ltd' } });
  const { submission } = toSubmission(store);
  assert.equal(submission.email_008.status, 'MISMATCH');
  assert.deepEqual(submission.email_008.defect_fields, ['notify_party']);
});

test('unprocessed emails are warned', () => {
  const { submission, warnings } = toSubmission(store, ['email_001', 'email_999']);
  assert.ok('email_999' in submission);
  assert.ok(warnings.some((w) => w.includes('email_999')));
});

// Phase 4 tools: waiting-for-documents, security banners, format check, score history, CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main as cli } from '../src/cli.js';
import { makeEmailResult } from '../src/models.js';
import { assess, mentionsAttachments } from '../src/reliability/assess.js';
import { seed } from '../src/reliability/demo.js';
import { checkFormat } from '../src/reliability/report.js';
import { compareScores, confusionErrors, listScores, saveScore, summarize } from '../src/reliability/scores.js';

test('a request to SEND the BL is waiting for documents, not escalated', () => {
  const email = { subject: 'TO CONFIRM DOCS', body: 'Please assist to send the draft BL for X for checking asap.' };
  const a = assess(makeEmailResult({ emailId: 'e', category: 'BL_COMPARISON', mentionsAttachments: mentionsAttachments(email) }));
  assert.equal(a.ok, true);
  assert.equal(a.awaiting, true);
});

test('an email that says documents are attached but has none is escalated', () => {
  const email = { subject: 'x', body: 'Please compare the SI and draft BL for X (attachments appear to be missing).' };
  const a = assess(makeEmailResult({ emailId: 'e', category: 'BL_COMPARISON', mentionsAttachments: mentionsAttachments(email) }));
  assert.equal(a.reason, 'missing_attachment');
});

test('security banners do not count as mentioning attachments', () => {
  const body = 'WARNING: This email originated outside of our organisation. As a security measure, please exercise caution with E-Mail content and any links or attachments.\n\nDear Arlene,\nPlease assist to send the draft BL for X for checking asap.';
  assert.equal(mentionsAttachments({ subject: 'RE_ AFRT', body }), false);
  assert.equal(mentionsAttachments({ subject: 'x', body: 'Attached are the SI and draft BL.' }), true);
});

const sample = { email_001: { category: 'GENERAL', status: 'OK', review_reason: null, defect_fields: [], has_defect: false } };
const good = { email_001: { category: 'GENERAL', status: 'OK', review_reason: null, has_defect: false, defect_fields: [] } };

test('format check passes a correct submission', () => assert.deepEqual(checkFormat(good, sample), []));
test('format check catches missing ids, wrong types and bad values', () => {
  const problems = checkFormat({ email_002: { category: 'SPAMMY', status: null, review_reason: null, has_defect: 'no', defect_fields: [] } }, sample);
  assert.ok(problems.some((p) => /missing/.test(p)));
  assert.ok(problems.some((p) => /has_defect.*boolean/.test(p)));
  assert.ok(problems.some((p) => /SPAMMY/.test(p)));
});

const board = (final, e2e, perReasonCaught = 5) => ({
  final_score: final, n_emails: 520,
  stage1: { accuracy: 0.9, macro_f1: 0.86, confusion: { BL_COMPARISON: { BL_COMPARISON: 129, GENERAL: 91 }, SPAM: { SPAM: 40 } } },
  stage3: { defect_f1: 0.94, field_f1: 0.87 },
  end_to_end: { success: e2e, total: 46, rate: e2e / 46 },
  reliability: { escalation_precision: 1, escalation_recall: 0.85, pred_review: 17, per_reason: { unreadable: { total: 5, caught: perReasonCaught } } },
});

test('score history: save, list newest first, compare, confusion', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scores-'));
  saveScore(dir, board(0.784, 31, 2), { note: 'first' });
  await new Promise((r) => setTimeout(r, 1100)); // file names are per second
  saveScore(dir, board(0.825, 31, 5), { note: 'second' });
  const list = listScores(dir);
  assert.deepEqual(list.map((s) => s.meta.note), ['second', 'first']);
  assert.equal(summarize(list[0].scoreboard).perReason.unreadable, '5/5');
  const rows = compareScores(list[0].scoreboard, list[1].scoreboard);
  assert.ok(Math.abs(rows.find((r) => r.label === 'Final score').delta - 0.041) < 1e-9);
  assert.deepEqual(confusionErrors(list[0].scoreboard), [{ actual: 'BL_COMPARISON', predicted: 'GENERAL', count: 91 }]);
});

test('CLI runs the demo inbox end to end and checks the format', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const data = seed(path.join(dir, 'demo_data'));
  writeFileSync(path.join(data, 'sample_submission.json'), JSON.stringify(Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`email_${String(i + 1).padStart(3, '0')}`, sample.email_001]))));
  const out = path.join(dir, 'submission.json');
  const log = [];
  const orig = console.log;
  console.log = (...a) => log.push(a.join(' '));
  try {
    await cli(['--data', data, '--db', path.join(dir, 'db.json'), '--stages', 'demo', '--out', out]);
  } finally {
    console.log = orig;
  }
  const sub = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(Object.keys(sub).length, 14);
  assert.equal(sub.email_002.status, 'MISMATCH');
  assert.ok(log.some((l) => /Format matches sample_submission\.json/.test(l)), log.join('\n'));
});

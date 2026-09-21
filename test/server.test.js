// Phase 3: the HTTP API end to end, as the review screen uses it.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Inbox } from '../src/inbox.js';
import { seed, stagesFor } from '../src/reliability/demo.js';
import { Runner } from '../src/reliability/runner.js';
import { Store } from '../src/reliability/store.js';
import { createApp } from '../src/server.js';

let server;
let base;
let app;

before(async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'sdoc-srv-')), 'demo_data');
  const inbox = new Inbox(dir);
  const store = new Store(null);
  const runner = new Runner({ inbox, stages: stagesFor(dir), store, retry: { sleep: async () => {} } });
  app = createApp({ inbox, store, runner, dataSource: dir, isDemo: true, seedDemo: () => seed(dir) });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('serves the review screen', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /SI \/ BL check/);
});

test('full review flow', async () => {
  let s = (await call('GET', '/api/summary')).body;
  assert.equal(s.dataAvailable, false);

  assert.equal((await call('POST', '/api/demo')).status, 202);
  for (let i = 0; i < 100 && app.locals.job.running; i++) await new Promise((r) => setTimeout(r, 20));
  s = (await call('GET', '/api/summary')).body;
  assert.deepEqual([s.counts.IN_REVIEW, s.counts.FAILED, s.counts.DONE], [5, 1, 8]);

  const q = (await call('GET', '/api/queue')).body;
  assert.equal(q.items.find((i) => i.emailId === 'email_009').label, 'Processing failed');

  const retried = (await call('POST', '/api/emails/email_009/retry')).body;
  assert.equal(retried.record.state, 'DONE');

  const corrected = await call('POST', '/api/emails/email_008/corrections',
    { blValues: { notify_party: 'Someone Else Ltd' }, reviewer: 'sy' });
  assert.equal(corrected.body.summary, 'Notify party: SI Same as consignee / BL Someone Else Ltd');

  const bad = await call('POST', '/api/emails/email_004/corrections', {});
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Override/);

  const over = await call('POST', '/api/emails/email_004/override',
    { category: 'BL_COMPARISON', status: 'NEEDS_REVIEW', reviewReason: 'missing_attachment', note: 'Requested BL' });
  assert.equal(over.body.record.state, 'REVIEWED');

  const detail = (await call('GET', '/api/emails/email_007')).body;
  assert.equal(detail.needsRoles, true);
  assert.equal(detail.rows.length, 7);

  const sub = (await call('GET', '/api/submission')).body;
  assert.equal(Object.keys(sub).length, 14);
  assert.equal(sub.email_008.status, 'MISMATCH');
});

test('unknown email is a 404', async () => {
  assert.equal((await call('GET', '/api/emails/nope')).status, 404);
});

test('attachment endpoint only serves listed attachments', async () => {
  assert.equal((await call('GET', '/api/attachment?path=../../etc/passwd')).status, 404);
  const ok = await call('GET', '/api/attachment?path=attachments/email_001_SI.txt');
  assert.match(ok.body, /SHIPPING INSTRUCTION/);
});

test('scoring needs the organisers server', async () => {
  const r = await call('POST', '/api/score');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /organisers/);
});

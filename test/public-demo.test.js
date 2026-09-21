// Public, results-only deployment: processed results from a seed, no inbox and no source files.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Inbox } from '../src/inbox.js';
import { seed, stagesFor } from '../src/reliability/demo.js';
import { Runner } from '../src/reliability/runner.js';
import { Store } from '../src/reliability/store.js';
import { createApp, cors } from '../src/server.js';
import { execFileSync } from 'node:child_process';

let server;
let base;
let full;

before(async () => {
  // 1. process the demo inbox locally, like a full run on the real bundle
  const tmp = mkdtempSync(path.join(tmpdir(), 'sdoc-pub-'));
  const dir = path.join(tmp, 'demo_data');
  seed(dir);
  full = path.join(tmp, 'full-db.json');
  const store = new Store(full);
  const runner = new Runner({ inbox: new Inbox(dir), stages: stagesFor(dir), store, retry: { sleep: async () => {} } });
  await runner.runAll({ emails: await new Inbox(dir).emails() });
  store.flush();

  // 2. sanitise it, 3. serve it with NO inbox at all
  const pub = path.join(tmp, 'public-db.json');
  execFileSync(process.execPath, ['scripts/make-public-seed.mjs', full, pub]);
  const noInbox = new Inbox(path.join(tmp, 'does-not-exist'));
  const pubStore = new Store(pub);
  const app = createApp({ inbox: noInbox, store: pubStore, runner: new Runner({ inbox: noInbox, stages: stagesFor(dir), store: pubStore }),
    dataSource: 'x', publicDemo: true });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('public seed keeps results but no document text', () => {
  const pub = JSON.parse(readFileSync(full.replace('full-db', 'public-db'), 'utf8'));
  const docs = Object.values(pub.emails).flatMap((r) => r.result?.documents || []);
  assert.ok(docs.length > 0);
  assert.ok(docs.every((d) => d.text === null && d.textWithheld === true));
  const ev = docs.flatMap((d) => Object.values(d.fields).map((f) => f?.evidence)).filter(Boolean);
  assert.ok(ev.length > 0 && ev.every((e) => !e.includes('\n') && e.length <= 120));
});

test('every email is listed and reported without an inbox', async () => {
  const s = (await call('GET', '/api/summary')).body;
  assert.equal(s.publicDemo, true);
  assert.equal(s.dataAvailable, false);
  assert.equal(s.dataSource, null);
  const rep = (await call('GET', '/api/report')).body;
  assert.equal(rep.rows.length, s.total);
  assert.ok(rep.warnings.every((w) => !/not processed/.test(w)), 'every email has a result'); // the demo's simulated outage may still show as failed
});

test('source files, processing and retry are refused with a clear message', async () => {
  const id = (await call('GET', '/api/report')).body.rows[0].emailId;
  const a = await call('GET', '/api/attachment?path=anything.pdf');
  assert.equal(a.status, 404);
  assert.match(a.body.error, /public demo/);
  assert.equal((await call('POST', '/api/process')).status, 403);
  assert.equal((await call('POST', `/api/emails/${id}/retry`)).status, 403);
  assert.equal((await call('GET', `/api/emails/${id}`)).body.email, null);
});

test('a reviewer can still correct values and recompare', async () => {
  const rows = (await call('GET', '/api/report')).body.rows;
  const mm = rows.find((x) => x.result === 'MISMATCH');
  assert.ok(mm, 'demo data has a mismatch');
  const d = (await call('GET', `/api/emails/${mm.emailId}`)).body;
  const blValues = Object.fromEntries(d.rows.filter((r) => r.match === false).map((r) => [r.field, r.si]));
  const r = await call('POST', `/api/emails/${mm.emailId}/corrections`, { blValues, reviewer: 'judge' });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.outcome.status, 'OK');
});

test('CORS: only the configured origin is allowed', () => {
  const mw = cors(['https://a.example']);
  const run = (origin, method = 'GET') => {
    const headers = {};
    let status = null;
    let nexted = false;
    mw({ headers: { origin }, method }, { set: (k, v) => { headers[k] = v; }, sendStatus: (s) => { status = s; } }, () => { nexted = true; });
    return { headers, status, nexted };
  };
  assert.equal(run('https://a.example').headers['Access-Control-Allow-Origin'], 'https://a.example');
  assert.equal(run('https://b.example').headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(run('https://a.example', 'OPTIONS').status, 204);
});

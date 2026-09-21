/**
 * Express server: runs the pipeline and serves the review screen.
 *
 *   npm start            -> http://localhost:3000
 *
 * Config (environment variables):
 *   PIPELINE_DATA    inbox folder or organisers' server URL   default: demo_data
 *   PIPELINE_DB      JSON store file                           default: demo-db.json
 *   PIPELINE_STAGES  "demo", "baseline" or "path/to/module.js#exportName"
 *                    default: demo for demo_data, otherwise baseline (see loadStages.js)
 *   PORT             default: 3000
 *   CORS_ORIGINS     comma-separated origins allowed to call the API from another host,
 *                    e.g. the Vercel frontend "https://blint.vercel.app" ("*" = any)
 *   PIPELINE_SEED_DB results processed ahead of time; copied to PIPELINE_DB when that
 *                    file doesn't exist yet, so a fresh deploy opens with all emails done
 *   PUBLIC_DEMO=1    results-only public site: no inbox, no source files. Reading results,
 *                    review, correct + recompare work; processing, retry and file
 *                    downloads are switched off (see scripts/make-public-seed.mjs)
 */
import './env.js'; // .env -> process.env, before anything reads it
import express from 'express';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BL_COMPARISON, CATEGORIES, FIELDS, OFFICIAL_REASONS } from './models.js';
import { Inbox } from './inbox.js';
import { REASON_LABELS, categoryOf, checkFormat, prettyField, reasonCounts, reportRows, summary, toSubmission } from './reliability/report.js';
import { ROLES, STATUSES, ReviewError, applyCorrections, confirm, fieldRows, override, pickPair } from './reliability/review.js';
import { Runner } from './reliability/runner.js';
import { compareScores, confusionErrors, listScores, saveScore, summarize } from './reliability/scores.js';
import { FAILED, IN_REVIEW, REVIEWED, Store } from './reliability/store.js';
import { defaultStagesFor, loadStages } from './loadStages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} deps
 * @param {Inbox} deps.inbox
 * @param {Store} deps.store
 * @param {Runner} deps.runner
 * @param {string} deps.dataSource
 * @param {boolean} [deps.isDemo]
 * @param {Function} [deps.seedDemo]   () => void, writes the demo inbox (demo mode only)
 */
export const PUBLIC_DEMO_MESSAGE = 'Not available in the public demo: the source emails and documents are not published. '
  + 'All emails were processed ahead of time; the results, field values and evidence are shown here.';

export function createApp({ inbox, store, runner, dataSource, isDemo = false, seedDemo = null, scoresDir = 'scores', stagesName = null, publicDemo = false }) {
  const app = express();
  app.use(cors((process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(HERE, '..', 'public')));

  // ---------------------------------------------------------- background job
  // Processing 520 emails with LLM calls takes a while, so it runs in the
  // background and the screen polls /api/summary for progress.
  const job = { running: false, done: 0, total: 0, error: null, finishedAt: null };
  function startJob(before = async () => {}) {
    if (job.running) return false;
    Object.assign(job, { running: true, done: 0, total: 0, error: null });
    (async () => {
      try {
        await before();
        const emails = await inbox.emails();
        job.total = emails.length;
        await runner.runAll({ emails, concurrency: Number(process.env.PIPELINE_CONCURRENCY || 1), onProgress: () => { job.done += 1; } });
      } catch (err) {
        job.error = err.message; // e.g. inbox not reachable - shown on screen
      } finally {
        job.running = false;
        job.finishedAt = new Date().toISOString();
      }
    })();
    return true;
  }

  const dataAvailable = () => inbox.isRemote || existsSync(path.join(dataSource, 'inbox'));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const mustGet = (id) => {
    const rec = store.get(id);
    if (!rec) throw Object.assign(new Error(`Unknown email ${id}`), { status: 404 });
    return rec;
  };

  // ------------------------------------------------------------------- reads
  app.get('/api/summary', (req, res) => {
    res.json({
      counts: store.counts(), job, dataSource: publicDemo ? null : dataSource, isDemo, publicDemo,
      dataAvailable: !publicDemo && dataAvailable(), canScore: !publicDemo && inbox.isRemote,
      total: store.list().length,
      meta: { fields: FIELDS.map((f) => ({ id: f, label: prettyField(f) })), categories: CATEGORIES,
        statuses: STATUSES, roles: ROLES,
        reasons: OFFICIAL_REASONS.map((r) => ({ id: r, label: REASON_LABELS[r] })) },
    });
  });

  app.get('/api/queue', (req, res) => {
    const scope = req.query.scope || 'attention';
    let items;
    if (scope === 'attention') items = store.reviewQueue();
    else if (scope === 'reviewed') items = store.list(REVIEWED);
    else if (scope === 'mismatch') items = store.list().filter((r) => r.outcome.status === 'MISMATCH');
    else items = store.list().filter((r) => categoryOf(r) === BL_COMPARISON || r.state === FAILED);
    res.json({ total: store.list().length, items: items.map((r) => ({
      emailId: r.emailId, subject: r.subject, state: r.state, status: r.outcome.status,
      reason: r.outcome.reviewReason, label: queueLabel(r),
    })) });
  });

  app.get('/api/emails/:id', wrap(async (req, res) => {
    const rec = mustGet(req.params.id);
    let roles = null;
    if (req.query.roles) {
      try { roles = JSON.parse(req.query.roles); } catch { roles = null; }
    }
    let email = null;
    if (!publicDemo) {
      try { email = await inbox.get(rec.emailId); } catch { email = null; }
    }
    const docs = rec.result?.documents || [];
    const { si, bl } = pickPair(rec.result, roles);
    res.json({
      record: rec,
      email,
      category: categoryOf(rec),
      summary: summary(rec),
      reasonLabel: REASON_LABELS[rec.outcome.reviewReason] || null,
      rows: fieldRows(rec.result, roles).map((r) => ({ ...r, label: prettyField(r.field) })),
      roles: Object.fromEntries(docs.filter((d) => d.found).map((d) =>
        [d.path, roles?.[d.path] || (d === si ? 'SI' : d === bl ? 'BL' : 'IGNORE')])),
      needsRoles: rec.outcome.reviewReason === 'wrong_doc_type' || docs.filter((d) => d.found).length > 2,
      reviews: store.reviews(rec.emailId),
      events: store.events(rec.emailId),
    });
  }));

  const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
  app.get('/api/attachment', wrap(async (req, res) => {
    if (publicDemo) return res.status(404).json({ error: PUBLIC_DEMO_MESSAGE });
    const p = String(req.query.path || '');
    const listed = store.list().some((r) => r.result?.attachments?.includes(p));
    if (!listed) return res.status(404).json({ error: 'Not an attachment of any processed email.' });
    let data;
    try {
      data = await inbox.readBytes(p);
    } catch (err) {
      return res.status(err.code === 'ENOENT' || err.status === 404 ? 404 : 502).json({ error: err.message });
    }
    const ext = path.extname(p).toLowerCase();
    res.type(TYPES[ext] || 'application/octet-stream');
    if (!TYPES[ext] || req.query.download) res.attachment(path.basename(p));
    res.send(data);
  }));

  app.get('/api/report', wrap(async (req, res) => {
    const { warnings } = toSubmission(store, publicDemo ? null : await allIds(inbox));
    res.json({ rows: reportRows(store), reasons: reasonCounts(store), warnings });
  }));

  app.get('/api/submission', wrap(async (req, res) => {
    const { submission } = toSubmission(store, publicDemo ? null : await allIds(inbox));
    res.attachment('submission.json').type('application/json').send(JSON.stringify(submission, null, 2));
  }));

  // ------------------------------------------------------------------ writes
  app.post('/api/process', (req, res) => {
    if (publicDemo) return res.status(403).json({ error: PUBLIC_DEMO_MESSAGE });
    if (!dataAvailable()) return res.status(400).json({ error: `Inbox not found at ${dataSource}. Set PIPELINE_DATA.` });
    res.status(startJob() ? 202 : 409).json({ job });
  });

  app.post('/api/demo', (req, res) => {
    if (!isDemo || !seedDemo) return res.status(400).json({ error: 'Demo inbox is only available with the demo stages.' });
    res.status(startJob(async () => seedDemo()) ? 202 : 409).json({ job });
  });

  app.post('/api/emails/:id/retry', wrap(async (req, res) => {
    if (publicDemo) return res.status(403).json({ error: PUBLIC_DEMO_MESSAGE });
    mustGet(req.params.id);
    const rec = await runner.retry(req.params.id);
    res.json({ record: rec, summary: summary(rec) });
  }));

  app.post('/api/emails/:id/confirm', wrap(async (req, res) => {
    const rec = confirm(store, mustGet(req.params.id), { reviewer: req.body.reviewer || null, note: req.body.note || null });
    res.json({ record: rec, summary: summary(rec) });
  }));

  app.post('/api/emails/:id/corrections', wrap(async (req, res) => {
    const b = req.body;
    const rec = await applyCorrections(store, mustGet(req.params.id), {
      compare: runner.stages.compare, siValues: b.siValues, blValues: b.blValues,
      roles: b.roles || null, reviewer: b.reviewer || null, note: b.note || null,
    });
    res.json({ record: rec, summary: summary(rec) });
  }));

  app.post('/api/emails/:id/override', wrap(async (req, res) => {
    const b = req.body;
    const rec = override(store, mustGet(req.params.id), {
      category: b.category, status: b.status ?? null, defectFields: b.defectFields || [],
      reviewReason: b.reviewReason ?? null, reviewer: b.reviewer || null, note: b.note || '',
    });
    res.json({ record: rec, summary: summary(rec) });
  }));

  app.post('/api/score', wrap(async (req, res) => {
    if (publicDemo) return res.status(403).json({ error: PUBLIC_DEMO_MESSAGE });
    const { submission } = toSubmission(store, await allIds(inbox));
    const scoreboard = await inbox.submit(submission);
    const previous = listScores(scoresDir)[0]?.scoreboard;
    saveScore(scoresDir, scoreboard, { stages: stagesName, data: dataSource, note: req.body?.note || null });
    res.json({ summary: summarize(scoreboard), comparison: compareScores(scoreboard, previous), mixups: confusionErrors(scoreboard) });
  }));

  app.get('/api/scores', (req, res) => {
    res.json(listScores(scoresDir).map((s) => ({ savedAt: s.savedAt, meta: s.meta, summary: summarize(s.scoreboard) })));
  });

  app.get('/api/format', wrap(async (req, res) => {
    if (publicDemo) return res.json({ checked: false, problems: [] });
    let sample;
    try { sample = await inbox.sampleSubmission(); } catch { return res.json({ checked: false, problems: [] }); }
    const { submission } = toSubmission(store, await allIds(inbox));
    res.json({ checked: true, problems: checkFormat(submission, sample) });
  }));

  // ------------------------------------------------------------------ errors
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof ReviewError ? 400 : err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  app.locals.job = job;
  return app;
}

function queueLabel(r) {
  if (r.state === FAILED) return 'Processing failed';
  if (r.state === REVIEWED) return `Reviewed: ${r.outcome.status || r.outcome.category}`;
  if (r.state === IN_REVIEW) return REASON_LABELS[r.outcome.reviewReason] || 'Needs review';
  return r.outcome.status || r.outcome.category || r.state;
}

async function allIds(inbox) {
  try {
    return (await inbox.emails()).map((e) => e.email_id);
  } catch {
    return null;
  }
}

/** Let a frontend on another host (Vercel) call the API. Same-origin requests are unaffected. */
export function cors(allowed) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  };
}

// ---------------------------------------------------------------------- main
async function main() {
  const dataSource = process.env.PIPELINE_DATA || 'demo_data';
  const dbPath = process.env.PIPELINE_DB || 'demo-db.json';
  const stagesSpec = process.env.PIPELINE_STAGES || defaultStagesFor(dataSource);
  const isDemo = stagesSpec === 'demo';
  const port = Number(process.env.PORT || 3000);

  const seed = process.env.PIPELINE_SEED_DB;
  if (seed && existsSync(seed) && !existsSync(dbPath)) {
    copyFileSync(seed, dbPath);
    console.log(`Seeded ${dbPath} from ${seed}`);
  }
  const inbox = new Inbox(dataSource);
  const store = new Store(dbPath);
  const runner = new Runner({ inbox, stages: await loadStages(stagesSpec, dataSource), store });
  const seedDemo = isDemo ? async () => (await import('./reliability/demo.js')).seed(dataSource) : null;

  const publicDemo = process.env.PUBLIC_DEMO === '1';
  const app = createApp({ inbox, store, runner, dataSource, isDemo, seedDemo, stagesName: stagesSpec, publicDemo });
  const server = app.listen(port, () => {
    console.log(`Review screen: http://localhost:${port}`);
    console.log(`Inbox: ${dataSource}   Store: ${dbPath}   Stages: ${stagesSpec}`);
  });
  const shutdown = () => { store.flush(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

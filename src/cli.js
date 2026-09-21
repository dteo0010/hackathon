/**
 * Run the whole pipeline from the terminal, no browser needed.
 *
 *   npm run pipeline -- --data data                          process the bundle folder
 *   npm run pipeline -- --data http://localhost:8080 --score  ...and score it with the organisers' server
 *
 * Options:
 *   --data <folder|url>   inbox (default: PIPELINE_DATA or "data")
 *   --db <file>           results store (default: PIPELINE_DB or "pipeline-db.json")
 *   --stages <spec>       "baseline" (default), "demo", or "path/file.js#name"
 *   --fresh               start from scratch (ignore earlier results and reviews)
 *   --concurrency <n>     emails in parallel (default 1; raise when stages call an LLM)
 *   --out <file>          submission file (default "submission.json")
 *   --score [url]         send to the organisers' /submit (default: --data when it is a URL)
 *   --note "<text>"       saved with the score, e.g. what you changed
 *
 * Emails already finished (or reviewed by a person) are kept unless --fresh,
 * so human review decisions survive a re-run. Failed emails are retried.
 */
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inbox } from './inbox.js';
import { defaultStagesFor, loadStages } from './loadStages.js';
import { checkFormat, toSubmission } from './reliability/report.js';
import { Runner } from './reliability/runner.js';
import { compareScores, confusionErrors, listScores, saveScore, summarize } from './reliability/scores.js';
import { Store } from './reliability/store.js';

function parseArgs(argv) {
  const o = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { o[a.slice(2)] = next; i++; } else o.flags.add(a.slice(2));
  }
  return o;
}

const fmt = (x) => (typeof x === 'number' ? x.toFixed(3) : x ?? '-');

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const data = o.data || process.env.PIPELINE_DATA || 'data';
  const db = o.db || process.env.PIPELINE_DB || 'pipeline-db.json';
  const stagesSpec = o.stages || process.env.PIPELINE_STAGES || defaultStagesFor(data);
  const out = o.out || 'submission.json';
  if (o.flags.has('fresh')) for (const s of ['', '.tmp']) rmSync(db + s, { force: true });

  const inbox = new Inbox(data);
  const store = new Store(db);
  const runner = new Runner({ inbox, stages: await loadStages(stagesSpec, data), store });
  const emails = await inbox.emails();
  console.log(`Processing ${emails.length} emails from ${data} with "${stagesSpec}" stages -> ${db}`);

  let done = 0;
  const t0 = Date.now();
  const counts = await runner.runAll({
    emails, concurrency: Number(o.concurrency || 1),
    onProgress: () => { if (++done % 50 === 0 || done === emails.length) process.stdout.write(`  ${done}/${emails.length}\n`); },
  });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, counts);

  const { submission, warnings } = toSubmission(store, emails.map((e) => e.email_id));
  writeFileSync(out, JSON.stringify(submission, null, 2));
  const byStatus = {};
  for (const e of Object.values(submission)) {
    const k = e.category === 'BL_COMPARISON' ? `BL_COMPARISON/${e.status}` : e.category;
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  console.log(`\nWrote ${out}:`, byStatus);
  for (const w of warnings) console.log(`  warning: ${w}`);

  try {
    const problems = checkFormat(submission, await inbox.sampleSubmission());
    console.log(problems.length ? `\nFormat problems vs sample_submission.json:\n  ${problems.join('\n  ')}` : '\nFormat matches sample_submission.json.');
  } catch {
    console.log('\n(no sample_submission.json found - format not checked)');
  }

  const scoreUrl = o.score || (o.flags.has('score') ? (inbox.isRemote ? data : null) : null);
  if (o.flags.has('score') && !scoreUrl) {
    console.log('\n--score needs the organisers\' server: pass --score http://localhost:8080 or use --data <url>.');
  }
  if (scoreUrl) {
    const scoreboard = await new Inbox(scoreUrl).submit(submission);
    const history = listScores('scores');
    saveScore('scores', scoreboard, { stages: stagesSpec, data, note: o.note || null });
    console.log('\nScore (vs previous run):');
    for (const r of compareScores(scoreboard, history[0]?.scoreboard)) {
      const d = r.delta === null ? '' : `  (${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)})`;
      console.log(`  ${r.label.padEnd(32)} ${fmt(r.now)}${d}`);
    }
    const s = summarize(scoreboard);
    console.log(`  End-to-end defects caught        ${s.endToEnd}`);
    console.log(`  Escalations caught by reason     ${Object.entries(s.perReason).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const errs = confusionErrors(scoreboard);
    if (errs.length) console.log(`  Classification mix-ups           ${errs.map((e) => `${e.actual}->${e.predicted} x${e.count}`).join(', ')}`);
    console.log('Saved to scores/.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

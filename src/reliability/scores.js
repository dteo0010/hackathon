/**
 * Task D - keep every scoreboard from the organisers' self-evaluation, so you
 * can see whether a change helped or hurt. One JSON file per run in scores/.
 * Only the organisers' totals are stored - never any answers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function saveScore(dir, scoreboard, meta = {}) {
  mkdirSync(dir, { recursive: true });
  const savedAt = new Date().toISOString();
  const file = path.join(dir, `score-${savedAt.replace(/[-:]/g, '').replace(/\..*/, '')}.json`);
  writeFileSync(file, JSON.stringify({ savedAt, meta, scoreboard }, null, 2));
  return file;
}

export function listScores(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^score-.*\.json$/.test(f)).sort().reverse()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

/** The numbers worth watching, flattened. */
export function summarize(sb) {
  const r = sb.reliability || {};
  const perReason = Object.fromEntries(Object.entries(r.per_reason || {}).map(([k, v]) => [k, `${v.caught}/${v.total}`]));
  return {
    final: sb.final_score,
    endToEnd: sb.end_to_end ? `${sb.end_to_end.success}/${sb.end_to_end.total}` : null,
    endToEndRate: sb.end_to_end?.rate ?? null,
    classificationMacroF1: sb.stage1?.macro_f1 ?? null,
    classificationAccuracy: sb.stage1?.accuracy ?? null,
    defectF1: sb.stage3?.defect_f1 ?? null,
    fieldF1: sb.stage3?.field_f1 ?? null,
    escalationPrecision: r.escalation_precision ?? null,
    escalationRecall: r.escalation_recall ?? null,
    escalated: r.pred_review ?? null,
    perReason,
  };
}

export const METRICS = [
  ['final', 'Final score'],
  ['endToEndRate', 'End-to-end (50%)'],
  ['classificationMacroF1', 'Classification macro-F1 (30%)'],
  ['defectF1', 'Defect F1 (20%)'],
  ['fieldF1', 'Field F1'],
  ['escalationPrecision', 'Escalation precision'],
  ['escalationRecall', 'Escalation recall'],
];

/** Rows of { label, now, before, delta } for the headline metrics. */
export function compareScores(now, before) {
  const a = summarize(now);
  const b = before ? summarize(before) : null;
  return METRICS.map(([key, label]) => ({
    label, now: a[key], before: b ? b[key] : null,
    delta: b && typeof a[key] === 'number' && typeof b[key] === 'number' ? a[key] - b[key] : null,
  }));
}

/** Where classification goes wrong: actual -> predicted counts, off-diagonal only. */
export function confusionErrors(sb) {
  const out = [];
  for (const [actual, preds] of Object.entries(sb.stage1?.confusion || {})) {
    for (const [pred, n] of Object.entries(preds)) if (pred !== actual && n) out.push({ actual, predicted: pred, count: n });
  }
  return out.sort((x, y) => y.count - x.count);
}

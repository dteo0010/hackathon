/**
 * Task D - turn the store into (a) the human-readable report and (b) the
 * organisers' submission.json. Human review decisions are already the stored
 * outcome, so the report updates as soon as a reviewer saves.
 */
import { BL_COMPARISON, OFFICIAL_REASONS, Reason, mismatched } from '../models.js';
import { FAILED, PENDING, REVIEWED } from './store.js';

export const REASON_LABELS = Object.freeze({
  missing_attachment: 'Missing attachment',
  unreadable: 'Unreadable document',
  wrong_doc_type: 'Wrong document type',
  missing_value: 'Missing value',
  low_confidence: 'Low-confidence read',
});

export function prettyField(field) {
  if (field === 'gross_weight_kg') return 'Gross weight (kg)';
  const s = field.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function categoryOf(rec) {
  return rec.outcome?.category || rec.result?.category || null;
}

/** Side-by-side values for the fields in the outcome's defect list. */
export function mismatches(rec) {
  const comp = Object.fromEntries((rec.result?.comparison?.fields || []).map((f) => [f.field, f]));
  return (rec.outcome.defectFields || []).map((field) => ({
    field, si: comp[field]?.siValue ?? null, bl: comp[field]?.blValue ?? null,
  }));
}

export function summary(rec) {
  const o = rec.outcome;
  if (rec.state === FAILED) return `Processing failed at ${rec.errorStage}: ${rec.errorMessage}`;
  if (rec.state === PENDING) return 'Not processed yet';
  if (o.category !== BL_COMPARISON) return 'Not a document check';
  if (o.status === 'OK') return 'No mismatch detected.';
  if (o.status === 'AWAITING_DOCS') return 'Waiting for documents - the email asks for the draft BL to be sent; nothing to compare yet.';
  if (o.status === 'MISMATCH') {
    const parts = mismatches(rec).map((m) => `${prettyField(m.field)}: SI ${m.si ?? '?'} / BL ${m.bl ?? '?'}`);
    return parts.join('; ') || 'Mismatch (fields set by reviewer)';
  }
  if (o.status === 'NEEDS_REVIEW') {
    const label = REASON_LABELS[o.reviewReason] || 'Needs review';
    return `${label}. ${rec.assessment?.detail || ''}`.trim();
  }
  return '';
}

export function reportRows(store) {
  return store.list().map((rec) => ({
    emailId: rec.emailId,
    subject: rec.subject,
    category: categoryOf(rec),
    result: rec.outcome.status || (rec.state === FAILED ? 'FAILED' : null),
    details: summary(rec),
    mismatches: rec.outcome.status === 'MISMATCH' ? mismatches(rec) : [],
    reviewed: rec.state === REVIEWED,
    state: rec.state,
  }));
}

/**
 * Organisers' format, keyed by email_id. Returns { submission, warnings }.
 *  - low_confidence is internal: export what compare() found instead, so a
 *    real mismatch still counts on the end-to-end metric.
 *  - FAILED emails are exported with whatever category we got (or GENERAL)
 *    and listed in warnings - fix them before submitting.
 * checkFormat() compares the result against the organisers' sample_submission.json.
 */
export function toSubmission(store, allEmailIds = null) {
  const records = Object.fromEntries(store.list().map((r) => [r.emailId, r]));
  const ids = allEmailIds || Object.keys(records).sort();
  const submission = {};
  const warnings = [];
  for (const eid of ids) {
    const rec = records[eid];
    if (!rec || rec.state === PENDING) {
      warnings.push(`${eid}: not processed`);
      submission[eid] = entry('GENERAL', 'OK', null, []);
      continue;
    }
    const category = categoryOf(rec) || 'GENERAL';
    if (rec.state === FAILED) warnings.push(`${eid}: failed at ${rec.errorStage} - ${rec.errorMessage}`);
    if (category !== BL_COMPARISON) {
      submission[eid] = entry(category, 'OK', null, []); // sample_submission uses OK here; the scorer ignores it
      continue;
    }
    let { status, reviewReason: reason, defectFields: fields } = rec.outcome;
    if (status === 'NEEDS_REVIEW' && reason === Reason.LOW_CONFIDENCE) {
      fields = mismatched(rec.result?.comparison);
      status = fields.length ? 'MISMATCH' : 'OK';
      reason = null;
    }
    if (status === 'AWAITING_DOCS') status = 'OK'; // nothing to check yet; OK is the neutral value in the organisers' format
    if (!status) status = 'NEEDS_REVIEW'; // FAILED part-way through a document check
    submission[eid] = entry(category, status, OFFICIAL_REASONS.includes(reason) ? reason : null, fields || []);
  }
  return { submission, warnings };
}

function entry(category, status, reason, fields) {
  return {
    category,
    status,
    review_reason: status === 'NEEDS_REVIEW' ? reason : null,
    has_defect: status === 'MISMATCH',
    defect_fields: status === 'MISMATCH' ? fields : [],
  };
}

/**
 * Compare our submission with the organisers' sample_submission.json: same
 * email ids, same keys per entry, same value types, allowed values.
 * Returns a list of problems (empty = format is right).
 */
export function checkFormat(submission, sample) {
  const problems = [];
  const ours = Object.keys(submission);
  const theirs = Object.keys(sample);
  const missing = theirs.filter((id) => !(id in submission));
  const extra = ours.filter((id) => !(id in sample));
  if (missing.length) problems.push(`${missing.length} email ids missing, e.g. ${missing.slice(0, 3).join(', ')}`);
  if (extra.length) problems.push(`${extra.length} unexpected email ids, e.g. ${extra.slice(0, 3).join(', ')}`);
  const template = sample[theirs[0]] || {};
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const allowed = {
    category: ['BL_COMPARISON', 'SI_REQUEST', 'INVOICE_QUERY', 'GENERAL', 'SPAM'],
    status: ['OK', 'MISMATCH', 'NEEDS_REVIEW'],
    review_reason: [null, ...OFFICIAL_REASONS],
  };
  const seen = new Set();
  for (const [id, entryValue] of Object.entries(submission)) {
    const keys = Object.keys(entryValue);
    const lacking = Object.keys(template).filter((k) => !keys.includes(k));
    if (lacking.length) seen.add(`entries missing keys: ${lacking.join(', ')} (e.g. ${id})`);
    for (const [k, v] of Object.entries(entryValue)) {
      if (k in template && typeOf(template[k]) !== 'null' && typeOf(v) !== typeOf(template[k])) {
        seen.add(`"${k}" should be ${typeOf(template[k])}, got ${typeOf(v)} (e.g. ${id})`);
      }
      if (allowed[k] && !allowed[k].includes(v)) seen.add(`"${k}" has unexpected value ${JSON.stringify(v)} (e.g. ${id})`);
    }
    if (entryValue.has_defect !== (entryValue.status === 'MISMATCH')) seen.add(`has_defect must be true exactly when status is MISMATCH (e.g. ${id})`);
  }
  return [...problems, ...seen];
}

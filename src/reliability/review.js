/**
 * Task D - what a reviewer can do with an email. UI-agnostic; the Express
 * API calls these.
 *
 *   confirm           keep the current outcome, close the case
 *   applyCorrections  fix extracted values (and/or which file is SI vs BL),
 *                     re-run compare(); outcome becomes OK or MISMATCH
 *   override          set the outcome by hand (e.g. wrong category, or keep
 *                     NEEDS_REVIEW because the BL must be requested). Needs a note.
 *
 * Every action goes through store.saveReview, so it lands in the audit trail
 * with the outcome before and after.
 */
import { BL_COMPARISON, CATEGORIES, DocType, FIELDS, OFFICIAL_REASONS, mismatched } from '../models.js';
import { isBlank, selectPair } from './assess.js';
import { makeOutcome } from './store.js';

export const REVIEWER_EVIDENCE = 'entered by reviewer';
export const STATUSES = Object.freeze(['OK', 'MISMATCH', 'NEEDS_REVIEW']);
export const ROLES = Object.freeze(['SI', 'BL', 'IGNORE']);

/** Reviewer input that can't be applied. Message is shown on screen (HTTP 400). */
export class ReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewError';
  }
}

// ------------------------------------------------------------------- reading
/**
 * SI and BL for display/correction. `roles` ({path: SI|BL|IGNORE}) is the
 * reviewer's choice and wins. Otherwise use assess's choice, then a
 * best-effort guess so the screen can still show something useful.
 */
export function pickPair(result, roles = null) {
  if (!result) return { si: null, bl: null };
  const docs = result.documents.filter((d) => d.found);
  if (roles && Object.keys(roles).length) {
    return {
      si: docs.find((d) => roles[d.path] === 'SI') ?? null,
      bl: docs.find((d) => roles[d.path] === 'BL') ?? null,
    };
  }
  const chosen = selectPair(docs);
  if (chosen.si && chosen.bl) return chosen;
  let si = docs.find((d) => d.docType === DocType.SI) ?? null;
  let bl = docs.find((d) => d.docType === DocType.BL && d !== si) ?? null;
  const rest = docs.filter((d) => d !== si && d !== bl);
  si = si ?? rest.shift() ?? null;
  bl = bl ?? rest.shift() ?? null;
  return { si, bl };
}

/**
 * One row per compared field: SI value, BL value, whether they match, and for each
 * side how the value was obtained (source, confidence, the line it came from).
 */
export function fieldRows(result, roles = null) {
  const { si, bl } = pickPair(result, roles);
  const comp = Object.fromEntries((result?.comparison?.fields || []).map((f) => [f.field, f]));
  return FIELDS.map((field) => ({
    field,
    si: valueOf(si, field),
    bl: valueOf(bl, field),
    match: comp[field] ? comp[field].match : null,
    siMeta: metaOf(si, field),
    blMeta: metaOf(bl, field),
  }));
}

function metaOf(doc, field) {
  const fv = doc?.fields?.[field];
  if (!fv) return null;
  return { source: fv.source ?? null, confidence: fv.confidence ?? null, evidence: fv.evidence ?? null };
}

function valueOf(doc, field) {
  return doc?.fields?.[field]?.value ?? null;
}

// ------------------------------------------------------------------- actions
export function confirm(store, rec, { reviewer = null, note = null } = {}) {
  store.saveReview(rec.emailId, 'confirm', rec.outcome, { reviewer, note });
  return store.get(rec.emailId);
}

export function override(store, rec, { category, status = null, defectFields = [], reviewReason = null,
  reviewer = null, note = '' }) {
  if (!String(note || '').trim()) throw new ReviewError('Add a note explaining the override - it goes in the audit trail.');
  if (!CATEGORIES.includes(category)) throw new ReviewError(`Unknown category "${category}".`);
  let outcome;
  if (category !== BL_COMPARISON) {
    outcome = makeOutcome(category);
  } else {
    if (!STATUSES.includes(status)) throw new ReviewError('Choose OK, MISMATCH or NEEDS_REVIEW for a document check.');
    const fields = (defectFields || []).filter((f) => FIELDS.includes(f));
    if (status === 'MISMATCH' && !fields.length) throw new ReviewError('Pick at least one mismatched field.');
    if (status === 'NEEDS_REVIEW' && !OFFICIAL_REASONS.includes(reviewReason)) {
      throw new ReviewError('Pick a reason for keeping it in review.');
    }
    outcome = makeOutcome(category, status,
      status === 'NEEDS_REVIEW' ? reviewReason : null,
      status === 'MISMATCH' ? fields : []);
  }
  store.saveReview(rec.emailId, 'override', outcome, { reviewer, note: String(note).trim() });
  return store.get(rec.emailId);
}

/**
 * Apply the reviewer's values, re-run compare(), save as a review.
 * A reviewer-entered value is trusted: we don't re-run the readability
 * checks, because the person has read the document themselves.
 */
export async function applyCorrections(store, rec, { compare, siValues = {}, blValues = {}, roles = null,
  reviewer = null, note = null }) {
  if (!rec.result) throw new ReviewError('Nothing was extracted for this email yet. Retry processing first.');
  const result = structuredClone(rec.result);
  const { si, bl } = pickPair(result, roles);
  if (!si || !bl) {
    throw new ReviewError('Both an SI and a BL are needed to compare. If a document is missing, use Override instead.');
  }
  si.docType = DocType.SI;
  bl.docType = DocType.BL;

  const corrections = {};
  for (const [doc, values] of [[si, siValues], [bl, blValues]]) {
    for (const [field, raw] of Object.entries(values || {})) {
      if (!FIELDS.includes(field)) continue;
      const next = typeof raw === 'string' ? raw.trim() || null : raw ?? null;
      const prev = valueOf(doc, field);
      if ((next || null) !== (prev || null)) {
        doc.fields[field] = { value: next, confidence: 1, evidence: REVIEWER_EVIDENCE, page: null, source: 'reviewer' };
        (corrections[doc.path] ??= {})[field] = { from: prev, to: next };
      }
    }
  }
  if (roles && Object.keys(roles).length) corrections._roles = roles;

  const blanks = [];
  for (const [doc, label] of [[si, 'SI'], [bl, 'BL']]) {
    for (const f of FIELDS) if (isBlank(valueOf(doc, f))) blanks.push(`${label} ${f.replace(/_/g, ' ')}`);
  }
  if (blanks.length) throw new ReviewError(`Still missing: ${blanks.join(', ')}. Fill them in, or use Override.`);

  const comparison = await compare(si, bl);
  if (!comparison || !Array.isArray(comparison.fields)) {
    throw new ReviewError('compare() did not return { fields: [...] }.');
  }
  result.comparison = comparison;
  const fields = mismatched(comparison);
  const outcome = makeOutcome(BL_COMPARISON, fields.length ? 'MISMATCH' : 'OK', null, fields);
  store.saveReview(rec.emailId, 'correct', outcome, {
    reviewer, note, corrections: Object.keys(corrections).length ? corrections : null, result,
  });
  return store.get(rec.emailId);
}

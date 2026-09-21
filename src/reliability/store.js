/**
 * Task D - persistent store for pipeline results, the review queue, human
 * decisions and an audit trail. One JSON file, no dependencies.
 *
 * Two separate ideas are tracked per email:
 *   state   - where the email is in the WORKFLOW
 *             PENDING -> DONE          decided automatically
 *                     -> IN_REVIEW     assess() escalated it, waiting for a human
 *                     -> FAILED        processing crashed after all retries
 *             IN_REVIEW / DONE -> REVIEWED   a human confirmed or corrected it
 *   outcome - what goes in the REPORT
 *             { category, status: OK|MISMATCH|NEEDS_REVIEW|null, reviewReason, defectFields }
 *
 * Why a JSON file over SQLite: the pipeline and review screen run in one Node
 * process, so there are no concurrent writers, and it avoids native modules
 * that often fail to build on Windows. Trade-off: run one server at a time.
 *
 * Writes are atomic (write temp file, then rename). Pipeline updates are
 * batched (flushed within ~200 ms); human reviews are flushed immediately.
 * Pass path = null for an in-memory store (tests).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const PENDING = 'PENDING';
export const DONE = 'DONE';
export const IN_REVIEW = 'IN_REVIEW';
export const FAILED = 'FAILED';
export const REVIEWED = 'REVIEWED';
export const STATES = Object.freeze([PENDING, DONE, IN_REVIEW, FAILED, REVIEWED]);
export const REVIEW_ACTIONS = Object.freeze(['confirm', 'correct', 'override']);

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const clone = (x) => (x === undefined || x === null ? x ?? null : structuredClone(x));

/** @returns {{category: string|null, status: string|null, reviewReason: string|null, defectFields: string[]}} */
export function makeOutcome(category = null, status = null, reviewReason = null, defectFields = []) {
  return { category, status, reviewReason, defectFields: [...(defectFields || [])] };
}

export class Store {
  constructor(path = 'pipeline-db.json') {
    this.path = path;
    this.data = { emails: {}, reviews: [], events: [] };
    if (path && existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8'));
    this._timer = null;
    this._nextReviewId = this.data.reviews.length + 1;
  }

  // -------------------------------------------------------------- persistence
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }

  _changed({ immediate = false } = {}) {
    if (immediate) return this.flush();
    if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), 200);
      this._timer.unref?.();
    }
  }

  // ------------------------------------------------------------------ writes
  ensure(emailId, subject = null) {
    if (!this.data.emails[emailId]) {
      this.data.emails[emailId] = {
        emailId, subject, state: PENDING, outcome: makeOutcome(), result: null, assessment: null,
        errorStage: null, errorMessage: null, errorTrace: null, attempts: 0, updatedAt: now(),
      };
      this._changed();
    }
  }

  markStarted(emailId) {
    Object.assign(this._row(emailId), {
      state: PENDING, errorStage: null, errorMessage: null, errorTrace: null, updatedAt: now(),
    });
    this._event(emailId, 'started');
  }

  saveResult(result, assessment, outcome, attempts) {
    const state = outcome.status === 'NEEDS_REVIEW' ? IN_REVIEW : DONE;
    Object.assign(this._row(result.emailId), {
      state, outcome: clone(outcome), result: clone(result), assessment: clone(assessment),
      errorStage: null, errorMessage: null, errorTrace: null, attempts, updatedAt: now(),
    });
    this._event(result.emailId, state === IN_REVIEW ? 'escalated' : 'done',
      state === IN_REVIEW ? outcome.reviewReason : outcome.status);
  }

  markFailed(emailId, stage, message, trace, attempts, partial = null) {
    const row = this._row(emailId);
    Object.assign(row, {
      state: FAILED, errorStage: stage, errorMessage: message, errorTrace: trace, attempts, updatedAt: now(),
    });
    if (partial) row.result = clone(partial);
    this._event(emailId, 'failed', `${stage}: ${message}`);
  }

  logEvent(emailId, kind, detail = null) {
    this._event(emailId, kind, detail);
  }

  /** Record a human decision and make it the email's outcome. */
  saveReview(emailId, action, outcome, { reviewer = null, note = null, corrections = null, result = null } = {}) {
    if (!REVIEW_ACTIONS.includes(action)) throw new Error(`unknown review action: ${action}`);
    const row = this.data.emails[emailId];
    if (!row) throw new Error(`unknown email: ${emailId}`);
    this.data.reviews.push({
      id: this._nextReviewId++, emailId, reviewer, action,
      before: clone(row.outcome), after: clone(outcome), corrections: clone(corrections), note, createdAt: now(),
    });
    Object.assign(row, { state: REVIEWED, outcome: clone(outcome), updatedAt: now() });
    if (result) row.result = clone(result);
    this.data.events.push({ emailId, kind: 'reviewed', detail: `${action} -> ${outcome.status ?? outcome.category}`, createdAt: now() });
    this._changed({ immediate: true });
  }

  _row(emailId) {
    const row = this.data.emails[emailId];
    if (!row) throw new Error(`unknown email: ${emailId} (call ensure first)`);
    return row;
  }

  _event(emailId, kind, detail = null) {
    this.data.events.push({ emailId, kind, detail, createdAt: now() });
    this._changed();
  }

  // ------------------------------------------------------------------- reads
  /** A copy - callers can't accidentally mutate stored data. */
  get(emailId) {
    return clone(this.data.emails[emailId]);
  }

  list(...states) {
    return Object.values(this.data.emails)
      .filter((r) => !states.length || states.includes(r.state))
      .sort((a, b) => a.emailId.localeCompare(b.emailId))
      .map(clone);
  }

  /** Everything a human needs to look at: escalations and hard failures. */
  reviewQueue() {
    return this.list(IN_REVIEW, FAILED);
  }

  counts() {
    const out = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const r of Object.values(this.data.emails)) out[r.state] += 1;
    return out;
  }

  events(emailId) {
    return this.data.events.filter((e) => e.emailId === emailId).map(clone);
  }

  reviews(emailId) {
    return this.data.reviews.filter((r) => r.emailId === emailId).map(clone);
  }
}

/**
 * Shared data contract for the pipeline (tasks A-D).
 *
 * Flow per email:
 *   A classify  -> category string
 *   B extract   -> one DocumentResult per attachment
 *   C compare   -> ComparisonResult
 *   D assess    -> Assessment (ok / needs review with a reason)
 *
 * Rules for B (extraction) that D relies on:
 *  - Return a DocumentResult for the attachment you were given. The runner
 *    already handles files that don't exist (found: false).
 *  - `error` is for problems with the FILE itself (corrupt, encrypted, empty,
 *    image with no text). Transient problems (LLM timeout, network error)
 *    must be THROWN, not stored here - the runner retries those.
 *  - `text` is the raw text you extracted (or OCR output). D uses it to judge
 *    readability and the review screen shows it as source evidence.
 *  - `docType` is detected from CONTENT, not the file name. Use "UNKNOWN" if
 *    you can't tell; D falls back to the file name only in that case.
 *  - Put every one of the 7 FIELDS in `fields`; value null if not found.
 *
 * Field names and categories stay snake_case / UPPER_CASE because they are
 * the exact strings the organisers' scorer expects.
 */

export const FIELDS = Object.freeze([
  'shipper',
  'consignee',
  'notify_party',
  'port_of_loading',
  'port_of_discharge',
  'container_count',
  'gross_weight_kg',
]);

export const CATEGORIES = Object.freeze(['BL_COMPARISON', 'SI_REQUEST', 'INVOICE_QUERY', 'GENERAL', 'SPAM']);
export const BL_COMPARISON = 'BL_COMPARISON';

export const DocType = Object.freeze({ SI: 'SI', BL: 'BL', OTHER: 'OTHER', UNKNOWN: 'UNKNOWN' });

export const Reason = Object.freeze({
  // Official reasons accepted by the organisers' scorer
  MISSING_ATTACHMENT: 'missing_attachment',
  UNREADABLE: 'unreadable',
  WRONG_DOC_TYPE: 'wrong_doc_type',
  MISSING_VALUE: 'missing_value',
  // Internal only - never written to submission.json as-is (see report.js)
  LOW_CONFIDENCE: 'low_confidence',
});

export const OFFICIAL_REASONS = Object.freeze([
  Reason.MISSING_ATTACHMENT, Reason.UNREADABLE, Reason.WRONG_DOC_TYPE, Reason.MISSING_VALUE,
]);

/**
 * @typedef {{value: string|null, confidence?: number|null, evidence?: string|null, page?: number|null}} FieldValue
 *
 * @typedef {object} DocumentResult
 * @property {string} path            exactly as in email.attachments
 * @property {boolean} found
 * @property {'SI'|'BL'|'OTHER'|'UNKNOWN'} docType
 * @property {string|null} text
 * @property {Record<string, FieldValue>} fields
 * @property {string|null} method     "text" | "pdf" | "docx" | "xlsx" | "ocr" | "vision"
 * @property {number|null} ocrConfidence  0..1
 * @property {string|null} error
 *
 * @typedef {{field: string, siValue: string|null, blValue: string|null, match: boolean}} FieldComparison
 * @typedef {{fields: FieldComparison[]}} ComparisonResult
 *
 * @typedef {object} EmailResult
 * @property {string} emailId
 * @property {string} category
 * @property {string|null} subject
 * @property {string[]} attachments
 * @property {DocumentResult[]} documents
 * @property {ComparisonResult|null} comparison
 * @property {boolean|null} mentionsAttachments  does the email say documents are attached?
 *
 * @typedef {{doc?: string|null, field?: string|null, snippet?: string|null, page?: number|null}} Evidence
 * @typedef {{reason: string, detail: string, evidence: Evidence[]}} Issue
 * @typedef {{ok: boolean, reason: string|null, detail: string, issues: Issue[], awaiting?: boolean}} Assessment
 */

/** Build a DocumentResult with every property present. @returns {DocumentResult} */
export function makeDocument(props) {
  const fields = {};
  for (const [k, v] of Object.entries(props.fields || {})) {
    fields[k] = typeof v === 'object' && v !== null
      ? { value: v.value ?? null, confidence: v.confidence ?? null, evidence: v.evidence ?? null, page: v.page ?? null }
      : { value: v ?? null, confidence: null, evidence: null, page: null };
  }
  return {
    path: props.path,
    found: props.found ?? true,
    docType: props.docType ?? DocType.UNKNOWN,
    text: props.text ?? null,
    fields,
    method: props.method ?? null,
    ocrConfidence: props.ocrConfidence ?? null,
    error: props.error ?? null,
  };
}

/** @returns {EmailResult} */
export function makeEmailResult(props) {
  return {
    emailId: props.emailId,
    category: props.category ?? '',
    subject: props.subject ?? null,
    attachments: [...(props.attachments || [])],
    documents: props.documents || [],
    comparison: props.comparison ?? null,
    mentionsAttachments: props.mentionsAttachments ?? null, // null = unknown (treated as "yes")
  };
}

/** @param {ComparisonResult|null} comparison */
export function mismatched(comparison) {
  return comparison ? comparison.fields.filter((f) => !f.match).map((f) => f.field) : [];
}

export function passed() {
  return { ok: true, reason: null, detail: '', issues: [] };
}

/** @param {Issue[]} issues */
export function needsReview(issues) {
  if (!issues.length) throw new Error('needsReview requires at least one issue');
  return { ok: false, reason: issues[0].reason, detail: issues[0].detail, issues };
}

export function issue(reason, detail, evidence = []) {
  return { reason, detail, evidence };
}

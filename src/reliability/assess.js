/**
 * Task D - decide whether a BL_COMPARISON result can be trusted or must go
 * to a human:  assess(result) -> { ok: true } | { ok: false, reason, detail, issues }
 *
 * Precedence (first failing check becomes `reason`; all its issues are kept):
 *   1. missing_attachment   fewer than 2 attachments actually present
 *   2. unreadable           a present attachment can't be read reliably
 *   3. wrong_doc_type       we don't have exactly one SI and one BL
 *   4. missing_value        a required field is absent in the SI or BL
 *   5. low_confidence       (internal, OFF by default) - see DEFAULT_CONFIG
 *
 * Each check needs the previous one to pass to be meaningful: you can't judge
 * doc type on an unreadable file, or say a value is missing from the wrong doc.
 *
 * Design stance: escalate only on hard evidence. The scorer drops a real
 * MISMATCH from the 50%-weight end-to-end metric if we escalate it, while a
 * missed escalation only costs the separate diagnostic axis. So a mismatch on
 * its own is NEVER a reason to escalate - that's C's job to report.
 */
import {
  BL_COMPARISON, DocType, FIELDS, Reason, issue, makeDocument, mismatched, needsReview, passed,
} from '../models.js';

const SNIPPET_LEN = 300;

export const DEFAULT_CONFIG = Object.freeze({
  // readability - tune against the real scanned samples
  minTextChars: 40,          // below this the doc is effectively empty
  maxGarbageRatio: 0.30,     // share of non-text symbols, e.g. OCR noise
  minWordRatio: 0.50,        // share of tokens that look like real words
  minOcrConfidence: 0.90,    // OCR'd documents below this go to a person to confirm the values
  // values that mean "not filled in"
  placeholderValues: new Set([
    '', '-', '--', 'n/a', 'na', 'nil', 'none', 'null', 'tba', 'tbc', 'tbd',
    'to be advised', 'to be confirmed', '?', 'xxx', 'unknown',
  ]),
  // Off by default. If set, a field whose extraction confidence is below this
  // AND which compare() reports as mismatched gets an internal low_confidence issue.
  minFieldConfidence: null,
});

/**
 * @param {import('../models.js').EmailResult} result
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @returns {import('../models.js').Assessment}
 */
export function assess(result, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (result.category !== BL_COMPARISON) return passed();

  // A request to SEND the draft BL has no documents yet and doesn't claim any.
  // Nothing to check, but nothing wrong either: don't flood the review queue.
  if (!result.attachments.length && result.mentionsAttachments === false) return awaitingDocuments();

  const docs = documentsFor(result);
  const present = docs.filter((d) => d.found);
  const missing = docs.filter((d) => !d.found);

  // 1. missing_attachment
  if (present.length < 2) return needsReview([missingAttachmentIssue(result, present, missing)]);

  // 2. unreadable
  const unreadable = present.map((d) => readabilityIssue(d, cfg)).filter(Boolean);
  if (unreadable.length) return needsReview(unreadable);

  // 3. wrong_doc_type
  const { si, bl, typeIssue } = pickSiBl(present);
  if (typeIssue) return needsReview([typeIssue]);

  // 4. missing_value, 5. low_confidence
  const issues = [...missingValueIssues(si, bl, cfg), ...lowConfidenceIssues(result, si, bl, cfg)];
  return issues.length ? needsReview(issues) : passed();
}

/** Does the email say documents are attached / should be compared? */
export function mentionsAttachments(email) {
  // Ignore security banners ("exercise caution with links or attachments").
  const sentences = `${email.subject || ''}\n${email.body || ''}`.split(/(?<=[.!?])\s+|\n+/)
    .filter((x) => !/originated outside|exercise caution|security measure|do not click|unless you recogni[sz]e/i.test(x));
  return sentences.some((x) => /\b(attach(ed|ment|ments)?|enclosed|compare the si|check the draft bl against)\b/i.test(x));
}

function awaitingDocuments() {
  return { ok: true, reason: null, detail: 'No documents attached yet - the email asks for them to be sent.', issues: [], awaiting: true };
}

/** Which present docs are the SI and the BL; {si: null, bl: null} if ambiguous. */
export function selectPair(documents) {
  const { si, bl, typeIssue } = pickSiBl(documents.filter((d) => d.found));
  return typeIssue ? { si: null, bl: null } : { si, bl };
}

/** Fill-in blanks: "____", "???", "____ MT", "??? KGS" (only symbols, maybe a unit). */
const FILL_IN = /^[\s_?.\-]*(?:mts?|kgs?|tons?|containers?)?[\s.]*$/i;

/** null, empty, or a placeholder like "TBA" / "N/A" / "____MT". */
export function isBlank(value, cfg = DEFAULT_CONFIG) {
  if (value === null || value === undefined) return true;
  const v = String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  return cfg.placeholderValues.has(v) || FILL_IN.test(v);
}

// ---------------------------------------------------------------- attachments
/** Every listed attachment must have a result; if B skipped one, treat it as missing. */
function documentsFor(result) {
  const byPath = new Set(result.documents.map((d) => d.path));
  const docs = [...result.documents];
  for (const p of result.attachments) {
    if (!byPath.has(p)) docs.push(makeDocument({ path: p, found: false, error: 'no extraction result' }));
  }
  return docs;
}

function missingAttachmentIssue(result, present, missing) {
  let detail;
  if (!result.attachments.length) {
    detail = 'Classified as a document check but the email has no attachments.';
    if (result.subject) detail += ` Subject: "${result.subject}".`;
  } else if (missing.length) {
    detail = `${missing.length} listed attachment(s) could not be found: ${missing.map((d) => d.path).join(', ')}.`;
  } else {
    detail = `Only ${present.length} attachment present; need both an SI and a BL.`;
  }
  const evidence = [
    ...present.map((d) => ({ doc: d.path, snippet: snippet(d.text) })),
    ...missing.map((d) => ({ doc: d.path, snippet: '(file not found)' })),
  ];
  return issue(Reason.MISSING_ATTACHMENT, detail, evidence);
}

// --------------------------------------------------------------- readability
const WORD_CHARS = String.raw`\p{L}\p{N}_.,:;/&'()\-#@+`;
const WORDLIKE = new RegExp(`^[${WORD_CHARS}]*[A-Za-z0-9][${WORD_CHARS}]*$`, 'u');
const ALLOWED_CHAR = /[\p{L}\p{N}_\s.,:;/&'()\-#@+%"*|=]/u;

function readabilityIssue(doc, cfg) {
  const ev = [{ doc: doc.path, snippet: snippet(doc.text) }];
  const name = baseName(doc.path);
  if (doc.error) return issue(Reason.UNREADABLE, `${name}: could not be read (${doc.error}).`, ev);

  const text = (doc.text || '').trim();
  if (text.length < cfg.minTextChars) {
    return issue(Reason.UNREADABLE,
      `${name}: almost no text extracted (${text.length} chars) - possibly a blank or image-only page.`, ev);
  }
  if (doc.ocrConfidence !== null && doc.ocrConfidence !== undefined && doc.ocrConfidence < cfg.minOcrConfidence) {
    return issue(Reason.UNREADABLE,
      `${name}: scanned document read by OCR at ${pct(doc.ocrConfidence)} confidence (below ${pct(cfg.minOcrConfidence)}). `
      + 'Please confirm the values against the scan.', ev);
  }
  const garbage = garbageRatio(text);
  if (garbage > cfg.maxGarbageRatio) {
    return issue(Reason.UNREADABLE, `${name}: ${pct(garbage)} of characters look like noise.`, ev);
  }
  const words = wordRatio(text);
  if (words < cfg.minWordRatio) {
    return issue(Reason.UNREADABLE, `${name}: only ${pct(words)} of tokens look like words.`, ev);
  }
  return null;
}

export function garbageRatio(text) {
  const visible = [...text].filter((c) => !/\s/u.test(c));
  if (!visible.length) return 1;
  return visible.filter((c) => !ALLOWED_CHAR.test(c)).length / visible.length;
}

export function wordRatio(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  return tokens.filter((t) => WORDLIKE.test(t)).length / tokens.length;
}

// ------------------------------------------------------------ document types
const NAME_HINTS = {
  [DocType.SI]: /(^|[_\-\s.])(si|shipping[_\-\s]?instruction)([_\-\s.]|$)/i,
  [DocType.BL]: /(^|[_\-\s.])(bl|b[_-]l|bill[_\-\s]?of[_\-\s]?lading|draft[_-]?bl)([_\-\s.]|$)/i,
};

/** Content wins. File name is only a fallback when content was UNKNOWN,
 *  because the wrong-doc cases likely have a BL-looking name on an invoice. */
function effectiveType(doc) {
  if (doc.docType !== DocType.UNKNOWN) return doc.docType;
  const stem = baseName(doc.path).replace(/\.[^.]+$/, '');
  const hits = Object.entries(NAME_HINTS).filter(([, rx]) => rx.test(stem)).map(([t]) => t);
  return hits.length === 1 ? hits[0] : DocType.UNKNOWN;
}

function pickSiBl(docs) {
  const typed = docs.map((d) => [d, effectiveType(d)]);
  const sis = typed.filter(([, t]) => t === DocType.SI).map(([d]) => d);
  const bls = typed.filter(([, t]) => t === DocType.BL).map(([d]) => d);
  if (sis.length === 1 && bls.length === 1) return { si: sis[0], bl: bls[0], typeIssue: null }; // extras are fine

  const problems = [];
  if (!sis.length) problems.push('no Shipping Instruction found');
  else if (sis.length > 1) problems.push(`${sis.length} documents look like an SI`);
  if (!bls.length) problems.push('no Bill of Lading found');
  else if (bls.length > 1) problems.push(`${bls.length} documents look like a BL`);
  const text = problems.join('; ');
  const detail = text.charAt(0).toUpperCase() + text.slice(1)
    + `. Detected: ${typed.map(([d, t]) => `${baseName(d.path)} = ${t}`).join(', ')}.`;
  const evidence = typed.map(([d]) => ({ doc: d.path, snippet: snippet(d.text) }));
  return { si: null, bl: null, typeIssue: issue(Reason.WRONG_DOC_TYPE, detail, evidence) };
}

// -------------------------------------------------------------------- values
function missingValueIssues(si, bl, cfg) {
  const out = [];
  for (const [doc, label] of [[si, 'SI'], [bl, 'BL']]) {
    for (const name of FIELDS) {
      const fv = doc.fields[name];
      const raw = fv ? fv.value : null;
      if (isBlank(raw, cfg)) {
        const shown = raw === null || raw === undefined ? 'not found' : `placeholder "${raw}"`;
        out.push(issue(Reason.MISSING_VALUE, `${label} is missing ${pretty(name)} (${shown}).`, [{
          doc: doc.path, field: name, snippet: fv?.evidence || snippet(doc.text), page: fv?.page ?? null,
        }]));
      }
    }
  }
  return out;
}

function lowConfidenceIssues(result, si, bl, cfg) {
  if (cfg.minFieldConfidence === null || cfg.minFieldConfidence === undefined || !result.comparison) return [];
  const out = [];
  for (const name of mismatched(result.comparison)) {
    for (const [doc, label] of [[si, 'SI'], [bl, 'BL']]) {
      const fv = doc.fields[name];
      if (fv && fv.confidence !== null && fv.confidence !== undefined && fv.confidence < cfg.minFieldConfidence) {
        out.push(issue(Reason.LOW_CONFIDENCE,
          `${pretty(name)} mismatch relies on a low-confidence ${label} read (${pct(fv.confidence)}): "${fv.value}".`,
          [{ doc: doc.path, field: name, snippet: fv.evidence, page: fv.page }]));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- helpers
function snippet(text) {
  if (!text) return null;
  const t = text.trim();
  return t.length <= SNIPPET_LEN ? t : t.slice(0, SNIPPET_LEN) + '…';
}

export function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

export function pretty(field) {
  return field.replace(/_/g, ' ').replace(' kg', ' (kg)');
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

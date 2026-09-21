/**
 * Template for the team's real stages (tasks A, B, C). Copy to src/stages.js,
 * fill in, then start the server with:
 *
 *   PIPELINE_STAGES=src/stages.js#stagesFor   (PowerShell: $env:PIPELINE_STAGES="src/stages.js#stagesFor")
 *
 * Each function may be sync or async. Throw normally for temporary problems
 * (timeouts, rate limits) - the runner retries them. Throw PermanentError when
 * retrying can't help. See src/models.js for the full data contract.
 */
import { DocType, FIELDS, makeDocument } from './models.js';
// import { PermanentError } from './reliability/runner.js';

export function stagesFor(source) {
  return {
    /** Task A. email = { email_id, from, subject, body, attachments } -> one of CATEGORIES */
    async classify(email) {
      throw new Error('TODO: classify');
    },

    /** Task B. One attachment -> DocumentResult. `content` is a Buffer (txt, pdf, docx, xlsx, image). */
    async extract(path, content) {
      const text = content.toString('utf8'); // TODO: real parsing / OCR for pdf, docx, scans
      return makeDocument({
        path,
        docType: DocType.UNKNOWN,            // SI | BL | OTHER | UNKNOWN - judged from content
        text,                                // raw text, shown to reviewers as evidence
        fields: Object.fromEntries(FIELDS.map((f) => [f, { value: null, confidence: null, evidence: null }])),
        method: 'text',
        ocrConfidence: null,
        error: null,                         // set only when the FILE itself can't be read
      });
    },

    /** Task C. -> { fields: [{ field, siValue, blValue, match }] } for all 7 FIELDS */
    async compare(si, bl) {
      throw new Error('TODO: compare');
    },
  };
}

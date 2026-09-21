/**
 * Task D - runs the pipeline for each email so failures are visible and
 * retryable, never silent.
 *
 *   classify -> fetch + extract (each attachment) -> assess -> compare -> assess
 *                                                       |                   |
 *                                        needs review --+    low_confidence-+
 *
 * Every stage call goes through #call(), which:
 *  - retries transient errors with exponential backoff (1s, 2s, 4s ... )
 *  - stops immediately on PermanentError (retrying won't help)
 *  - validates the stage's return value, so a teammate's bug surfaces as a
 *    clear FAILED record instead of a crash three stages later
 *  - after the last attempt, records stage, message and stack in the store
 *    (state FAILED) - that is what the review screen's Retry button acts on
 *
 * Stages teammates implement (plain functions, sync or async):
 *   classify(email)            -> category string                     // task A
 *   extract(path, buffer)      -> DocumentResult                      // task B
 *   compare(si, bl)            -> ComparisonResult                    // task C
 */
import { BL_COMPARISON, CATEGORIES, makeDocument, makeEmailResult, mismatched } from '../models.js';
import { assess, mentionsAttachments, selectPair } from './assess.js';
import { DONE, IN_REVIEW, REVIEWED, makeOutcome } from './store.js';

/** Throw from any stage when retrying cannot help (bad input, unsupported format). */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
  }
}

class StageFailed extends Error {
  constructor(stage, cause, attempts) {
    super(`${stage}: ${describe(cause)}`);
    Object.assign(this, { stage, cause, attempts });
  }
}

export const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 20000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export class Runner {
  /**
   * @param {object} opts
   * @param {import('../inbox.js').Inbox} opts.inbox
   * @param {{classify: Function, extract: Function, compare: Function}} opts.stages
   * @param {import('./store.js').Store} opts.store
   * @param {object} [opts.assessConfig]
   * @param {Partial<typeof DEFAULT_RETRY>} [opts.retry]
   */
  constructor({ inbox, stages, store, assessConfig = {}, retry = {} }) {
    for (const s of ['classify', 'extract', 'compare']) {
      if (typeof stages?.[s] !== 'function') throw new Error(`stages.${s} must be a function`);
    }
    Object.assign(this, { inbox, stages, store, assessConfig });
    this.retryPolicy = { ...DEFAULT_RETRY, ...retry };
  }

  /**
   * Process the whole inbox. One email failing never stops the rest.
   * Finished emails are skipped unless force, so a crashed run can simply be
   * restarted. concurrency > 1 helps when stages call an LLM.
   */
  async runAll({ emails = null, concurrency = 1, force = false, onProgress = null } = {}) {
    const list = emails ?? (await this.inbox.emails());
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const rec = await this.process(list[next++], { force });
        onProgress?.(rec);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    this.store.flush();
    return this.store.counts();
  }

  /** The review screen's Retry button. Won't overwrite a human decision unless allowed. */
  async retry(emailId, { allowReviewed = false } = {}) {
    const rec = this.store.get(emailId);
    if (rec?.state === REVIEWED && !allowReviewed) {
      throw new Error(`${emailId} was already reviewed by a person; pass allowReviewed to reprocess it`);
    }
    this.store.logEvent(emailId, 'retry_requested');
    const rec2 = await this.process(await this.inbox.get(emailId), { force: true });
    this.store.flush();
    return rec2;
  }

  async process(email, { force = false } = {}) {
    const eid = email.email_id;
    this.store.ensure(eid, email.subject ?? null);
    const existing = this.store.get(eid);
    if (!force && [DONE, IN_REVIEW, REVIEWED].includes(existing.state)) return existing;

    this.store.markStarted(eid);
    const ctx = { emailId: eid, attempts: 1 };
    const result = makeEmailResult({
      emailId: eid, subject: email.subject, attachments: email.attachments || [], mentionsAttachments: mentionsAttachments(email),
    });
    try {
      const { outcome, assessment } = await this.#pipeline(email, result, ctx);
      this.store.saveResult(result, assessment, outcome, ctx.attempts);
    } catch (err) {
      if (err instanceof StageFailed) {
        this.store.markFailed(eid, err.stage, describe(err.cause), stackOf(err.cause), err.attempts, result);
      } else {
        // a bug in our own glue code - still make it visible
        this.store.markFailed(eid, 'pipeline', describe(err), stackOf(err), ctx.attempts, result);
      }
    }
    return this.store.get(eid);
  }

  // ------------------------------------------------------------------ pipeline
  async #pipeline(email, result, ctx) {
    const category = await this.#call('classify', ctx, () => this.#classify(email));
    result.category = category;
    if (category !== BL_COMPARISON) return { outcome: makeOutcome(category), assessment: null };

    for (const p of result.attachments) {
      const content = await this.#call(`fetch ${p}`, ctx, () => this.#fetch(p));
      result.documents.push(content === null
        ? makeDocument({ path: p, found: false, error: 'file not found' })
        : await this.#call(`extract ${p}`, ctx, () => this.#extract(p, content)));
    }

    // Pre-check: don't compare documents we can't trust.
    const pre = assess(result, this.assessConfig);
    if (pre.awaiting) return { outcome: makeOutcome(category, 'AWAITING_DOCS'), assessment: pre };
    if (!pre.ok) return { outcome: escalated(category, pre), assessment: pre };

    const { si, bl } = selectPair(result.documents);
    result.comparison = await this.#call('compare', ctx, () => this.#compare(si, bl));

    // Post-check: only adds the opt-in low-confidence rule.
    const post = assess(result, this.assessConfig);
    if (!post.ok) return { outcome: escalated(category, post), assessment: post };

    const fields = mismatched(result.comparison);
    return { outcome: makeOutcome(category, fields.length ? 'MISMATCH' : 'OK', null, fields), assessment: post };
  }

  // ------------------------------------------------ stage wrappers + checks
  async #classify(email) {
    const cat = await this.stages.classify(email);
    const norm = cat === null || cat === undefined ? '' : String(cat).trim().toUpperCase();
    if (!CATEGORIES.includes(norm)) {
      throw new PermanentError(`classify returned ${JSON.stringify(cat)}; expected one of ${CATEGORIES.join(', ')}`);
    }
    return norm;
  }

  /** null = the attachment genuinely doesn't exist (-> missing_attachment). Other errors are retried. */
  async #fetch(p) {
    try {
      return await this.inbox.readBytes(p);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.status === 404) return null;
      throw err;
    }
  }

  async #extract(p, content) {
    const doc = await this.stages.extract(p, content);
    if (!doc || typeof doc !== 'object' || typeof doc.fields !== 'object' || doc.fields === null) {
      throw new PermanentError(`extract returned ${typeName(doc)}, expected a DocumentResult with a fields object`);
    }
    return makeDocument({ ...doc, path: p }); // normalise + line up with the attachment list
  }

  async #compare(si, bl) {
    const comp = await this.stages.compare(si, bl);
    if (!comp || !Array.isArray(comp.fields)) {
      throw new PermanentError(`compare returned ${typeName(comp)}, expected { fields: [...] }`);
    }
    return comp;
  }

  async #call(stage, ctx, fn) {
    const { maxAttempts, baseDelayMs, maxDelayMs, sleep } = this.retryPolicy;
    for (let attempt = 1; ; attempt++) {
      ctx.attempts = Math.max(ctx.attempts, attempt);
      try {
        return await fn();
      } catch (err) {
        if (err instanceof PermanentError || attempt >= maxAttempts) throw new StageFailed(stage, err, attempt);
        this.store.logEvent(ctx.emailId, 'attempt_failed', `${stage} #${attempt}: ${describe(err)}`);
        await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
      }
    }
  }
}

function escalated(category, assessment) {
  return makeOutcome(category, 'NEEDS_REVIEW', assessment.reason, []);
}

function describe(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function stackOf(err) {
  return err instanceof Error && err.stack ? err.stack : String(err);
}

function typeName(x) {
  return x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x;
}

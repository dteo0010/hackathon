/**
 * The team's stages: A (classify) and C (extract + compare) are the Python
 * modules in Bundle/, B (reading files) is readers.js. Use with:
 *
 *   node --no-deprecation src/cli.js --data Bundle --stages src/stages.js#stagesFor
 *   PowerShell: $env:PIPELINE_STAGES="src/stages.js#stagesFor"; npm start
 *
 *   classify  Bundle/classifier.py      rules first, LLM (Gemini/Anthropic) when unsure
 *   extract   readers.js -> text -> Bundle/sdoc_compare extract_fields
 *             rules first, LLM fallback for unknown labels, answers grounded in the text
 *   compare   Bundle/sdoc_compare compare  (normalised values, deterministic)
 *
 * Scanned PDFs (method "ocr") keep the baseline's fuzzy extract/compare, because
 * OCR misreads single letters and the Python rules match labels exactly.
 *
 * Python runs as ONE long-lived child process (Bundle/bridge.py), JSON lines over
 * stdin/stdout. Env:
 *   PYTHON            default "python" on Windows, else "python3"
 *   SDOC_USE_LLM=0    rules only (no API calls)
 *   GEMINI_API_KEY / ANTHROPIC_API_KEY   enable the LLM fallbacks
 *   SDOC_CLASSIFIER   "team" = Bundle/classifier.py (task A), "baseline" = baseline.js rules.
 *                     Default "baseline" until A's rules cover SI requests (see README note).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocType, FIELDS, makeDocument } from './models.js';
import { readDocument } from './readers.js';
import * as baseline from './baseline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..', 'Bundle', 'bridge.py');
const OTHER = new Set(['COMMERCIAL_INVOICE', 'PACKING_LIST', 'CERTIFICATE_OF_ORIGIN']);

/** One Python process, request/response matched by id. */
export class PythonBridge {
  constructor({ python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), script = BRIDGE, timeoutMs = 120000 } = {}) {
    Object.assign(this, { python, script, timeoutMs, child: null, pending: new Map(), nextId: 1, buf: '' });
  }

  start() {
    if (this.child) return;
    const child = spawn(this.python, ['-u', this.script], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.onData(d));
    const fail = (err) => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
      this.pending.clear();
      this.child = null;          // next call starts a fresh process
    };
    child.on('error', (e) => fail(new Error(`cannot start Python bridge (${this.python}): ${e.message}`)));
    child.on('exit', (code) => fail(new Error(`Python bridge exited (code ${code})`)));
    this.child = child;
    this.idle();
  }

  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(`python ${p.op}: ${msg.error}`));
      if (!this.pending.size) this.idle();
    }
  }

  /** Keep Node alive only while a request is in flight, so the CLI can exit. */
  busy() { this.child?.ref(); this.child?.stdout.ref(); this.child?.stdin.ref?.(); }
  idle() { this.child?.unref(); this.child?.stdout.unref(); this.child?.stdin.unref?.(); }

  call(op, payload = {}) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`python ${op} timed out after ${this.timeoutMs} ms`)); // thrown -> runner retries
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      this.busy();
      this.child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
    });
  }

  stop() { this.child?.kill(); this.child = null; }
}

const docTypeOf = (t) => (t === 'SI' ? DocType.SI : t === 'BL' ? DocType.BL : OTHER.has(t) ? DocType.OTHER : DocType.UNKNOWN);

export function stagesFor(_source, { bridge = new PythonBridge(), classifier = process.env.SDOC_CLASSIFIER || 'baseline' } = {}) {
  if (!['team', 'baseline'].includes(classifier)) throw new Error(`SDOC_CLASSIFIER must be "team" or "baseline", got "${classifier}"`);
  return {
    bridge,
    classifier,

    /** Task A */
    async classify(email) {
      if (classifier === 'baseline') return baseline.classify(email);
      const c = await bridge.call('classify', { email });
      return c.category;
    },

    /** Task B (readers.js) + C extraction */
    async extract(filePath, content) {
      const r = await readDocument(filePath, content);
      if (r.error) {
        // Unreadable. For an image-only page, r.text may hold a vision model's draft
        // transcription (Task B, trustVision=false): kept for the reviewer, never compared.
        return makeDocument({ path: filePath, text: r.text, method: r.method, error: r.error, ocrConfidence: r.ocrConfidence,
          transcription: r.transcription && r.transcription.text ? r.transcription : null });
      }
      if (r.method === 'ocr') {               // reuse the OCR text, don't OCR twice
        return makeDocument({
          path: filePath, docType: baseline.detectType(r.text), text: r.text,
          fields: baseline.extractFieldsFuzzy(r.text, r.ocrConfidence), method: r.method, ocrConfidence: r.ocrConfidence,
        });
      }
      const x = await bridge.call('extract', { text: r.text || '' });
      const fields = Object.fromEntries(FIELDS.map((f) => {
        const v = x.fields[f] || {};
        // a blank ("TBA", "____MT") keeps its raw text so the reviewer sees what was written;
        // assess.isBlank() turns it into missing_value before compare runs
        const value = v.value ?? (v.reason === 'blank' ? v.raw ?? null : null);
        // provenance from C: "rule" | "derived" | "llm" (null when nothing was found)
        return [f, { value, confidence: v.confidence ?? null, evidence: v.evidence ?? null,
          source: value === null ? null : v.decided_by ?? null }];
      }));
      return makeDocument({
        path: filePath, docType: docTypeOf(x.doc_type), text: r.text, fields,
        method: r.method, ocrConfidence: r.ocrConfidence,
      });
    },

    /** Task C */
    async compare(si, bl) {
      if (si.method === 'ocr' || bl.method === 'ocr') return baseline.compare(si, bl);
      // Compare the field VALUES held for each document (what reviewers see and may correct),
      // not a fresh read of the text - otherwise a reviewer's correction would be ignored.
      const values = (d) => Object.fromEntries(FIELDS.map((f) => [f, d.fields?.[f]?.value ?? null]));
      const res = await bridge.call('compare_values', { si: values(si), bl: values(bl) });
      return { fields: res.fields.map(({ field, siValue, blValue, match }) => ({ field, siValue, blValue, match })) };
    },
  };
}

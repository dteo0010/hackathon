/**
 * BASELINE stages for the real dataset - a working placeholder for tasks A, B
 * and C so the whole pipeline (and task D) can run end to end today.
 * Teammates replace any of these by pointing PIPELINE_STAGES at their module.
 *
 *   classify  keyword rules on the email BODY (subjects are deliberately misleading)
 *   extract   readers.js -> text, then "label: value" parsing with label synonyms
 *   compare   normalised text / numbers, so formatting differences aren't mismatches
 *
 * Scanned PDFs are OCR'd by readers.js; their labels are matched fuzzily and
 * names compared by similarity, because OCR misreads single letters.
 */
import { DocType, FIELDS, makeDocument } from './models.js';
import { readDocument } from './readers.js';

// =================================================================== A: classify
const SPAM = /\b(bitcoin|crypto|congratulations|click here|you have won|won a brand new|lottery|prize|unpaid customs fee|verify (your )?account|storage limit|avoid (suspension|deactivation)|bank details|bank officer|business proposal|limited time offer|weird trick|guaranteed \d+% returns|% off)\b/i;
const CLAIMS_DOCS = /\b(attached (are|is)?\s*the si|find attached the (si|shipping instruction)|attached si|compare the si and (the )?draft bl|check the draft bl against the si|si and (the )?draft (bl|b\/l|bill of lading))\b/i;
const SI_REQUEST = /\b(please find shipping instruction|shipping instruction for|new si\b|prepare (a |the )?(new )?si\b)/i;
const INVOICE = /\b(invoice|detention|d&d|local charges?|thc|debit note|credit note|freight charges|confirm the amount|billed)\b/i;

export function classify(email) {
  const body = String(email.body || '').replace(/^WARNING:[^\n]*\n/i, '');
  const subject = String(email.subject || '');
  const all = `${subject}\n${body}`;
  if (SPAM.test(all)) return 'SPAM';
  if ((email.attachments || []).length) return 'BL_COMPARISON';
  if (CLAIMS_DOCS.test(body)) return 'BL_COMPARISON'; // says documents are attached, but none are
  if (/\bsend the draft (bl|b\/l|bill of lading)\b.*\bfor checking\b/i.test(body)) return 'BL_COMPARISON'; // BL-check workflow, docs to follow
  if (SI_REQUEST.test(body)) return 'SI_REQUEST';
  if (/automated notification|berthing report|update summary|outstanding bl|reminder|happy and prosperous/i.test(body)) return 'GENERAL';
  if (INVOICE.test(body)) return 'INVOICE_QUERY';
  return 'GENERAL';
}

// ==================================================================== B: extract
/** Label patterns, tested against a cleaned label (lowercase, no non-ASCII bits, no leading "total"). */
const LABELS = [
  ['shipper', /^(shipper|exporter)\b/],
  ['consignee', /^(consignee|to (the )?order( of)?)\b/],
  ['notify_party', /^notify\b/],
  ['port_of_loading', /^(port of loading|load(ing)? port|pol|place of loading|port of shipment)\b/],
  ['port_of_discharge', /^(port of discharge|discharge port|pod|destination port|port of destination)\b/],
  ['container_count', /^(containers?( count| qty)?|container count|no\.? of containers|number of containers|qty of containers)\b/],
  ['gross_weight_kg', /^(gross (weight|wt)|g\.? ?w\.?|gross)\b/],
];

function cleanLabel(label) {
  return label
    .replace(/\([^)]*[^\x00-\x7F][^)]*\)/g, ' ')  // bilingual bits like (发货人)
    .replace(/[^\x00-\x7F]+/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/^total\s+/, '');
}

/** "Label: value" or PDF layout "Label   value"; indented lines continue the value. */
export function parsePairs(text) {
  const pairs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s{2,}/.test(raw) && pairs.length) {
      pairs[pairs.length - 1].more.push(raw.trim());
      continue;
    }
    const line = raw.trim();
    const m = line.match(/^([^:]{1,70}?)\s*:\s*(.*)$/) || line.match(/^(.{1,60}?)\s{3,}(.+)$/);
    if (m) pairs.push({ label: m[1].trim(), value: m[2].trim(), more: [] });
    else pairs.push({ label: line, value: '', more: [] });
  }
  return pairs;
}

export function extractFields(text) {
  const fields = {};
  for (const p of parsePairs(text)) {
    const label = cleanLabel(p.label);
    if (/^container (no|number|#)/.test(label)) continue; // table header / container IDs, not a count
    const hit = LABELS.find(([, rx]) => rx.test(label));
    if (!hit) continue;
    const [field] = hit;
    const value = p.value || p.more[0] || '';
    if (!value) continue;
    const isTotal = /^total\b/i.test(p.label.trim());
    if (!fields[field] || (isTotal && !fields[field].total)) {
      fields[field] = { value, confidence: 0.9, evidence: `${p.label}: ${value}`, total: isTotal, source: 'rule' };
    }
  }
  // PDF container tables: count container rows / sum their weights if no labelled total
  const rows = String(text || '').split('\n').filter((l) => /^\s*[A-Z]{4}\d{7}\b/.test(l));
  if (rows.length && !fields.container_count) {
    fields.container_count = { value: String(rows.length), confidence: 0.7, evidence: `${rows.length} container rows`, source: 'derived' };
  }
  if (rows.length && !fields.gross_weight_kg) {
    const sum = rows.reduce((s, l) => s + (toNumber(l.trim().split(/\s{3,}/).pop()) || 0), 0);
    if (sum) fields.gross_weight_kg = { value: String(sum), confidence: 0.7, evidence: 'sum of container rows', source: 'derived' };
  }
  for (const f of FIELDS) {
    if (fields[f]) delete fields[f].total;
    fields[f] ??= { value: null, confidence: null, evidence: null };
  }
  return fields;
}

// OCR text: labels may be misspelt ("Portof Lcading") and lack a colon, so match
// the first 1-4 words against compact synonyms allowing 1-2 wrong letters.
const SYNONYMS = {
  shipper: ['shipper', 'exporter'],
  consignee: ['consignee', 'totheorderof'],
  notify_party: ['notifyparty', 'notify'],
  port_of_loading: ['portofloading', 'loadport', 'loadingport', 'pol'],
  port_of_discharge: ['portofdischarge', 'dischargeport', 'destinationport', 'pod'],
  container_count: ['totalcontainers', 'containercount', 'noofcontainers', 'numberofcontainers', 'containers'],
  gross_weight_kg: ['totalgrossweight', 'grossweight', 'grosswt', 'gw'],
};
const compact = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function extractFieldsFuzzy(text, confidence = null) {
  const fields = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    let found = null;
    for (let k = Math.min(4, tokens.length - 1); k >= 1 && !found; k--) {
      if (tokens.slice(0, k).some((t) => /\d/.test(t))) continue; // labels never contain digits
      const label = compact(tokens.slice(0, k).join(''));
      for (const [field, syns] of Object.entries(SYNONYMS)) {
        const hit = syns.find((syn) => (syn.length < 5 ? label === syn : levenshtein(label, syn) <= (syn.length >= 10 ? 2 : 1)));
        if (hit && !fields[field]) { found = { field, value: tokens.slice(k).join(' ').replace(/^[:.;,]\s*/, '') }; break; }
      }
    }
    if (found?.value) fields[found.field] = { value: found.value, confidence, evidence: raw.trim(), source: 'ocr' };
  }
  for (const f of FIELDS) fields[f] ??= { value: null, confidence: null, evidence: null };
  return fields;
}

export function detectType(text) {
  const head = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ').toLowerCase();
  if (/shipping instruction|bill of lading instruction|b\/l instruction|\bsi\b/.test(head)) return DocType.SI;
  if (/commercial invoice|packing list|certificate of origin|arrival notice|\binvoice\b/.test(head)) return DocType.OTHER;
  if (/bill of lading|\bb\/l\b|draft bl/.test(head)) return DocType.BL;
  return DocType.UNKNOWN; // assess() falls back to the file name
}

export async function extract(path, content) {
  const r = await readDocument(path, content);
  if (r.error) {
    return makeDocument({ path, text: r.text, method: r.method, error: r.error, ocrConfidence: r.ocrConfidence,
      transcription: r.transcription && r.transcription.text ? r.transcription : null });
  }
  const fields = r.method === 'ocr' ? extractFieldsFuzzy(r.text, r.ocrConfidence) : extractFields(r.text);
  return makeDocument({ path, docType: detectType(r.text), text: r.text, fields, method: r.method, ocrConfidence: r.ocrConfidence });
}

// ==================================================================== C: compare
const SUFFIXES = [
  [/\bprivate limited\b/g, 'pte ltd'], [/\blimited\b/g, 'ltd'], [/\bincorporated\b/g, 'inc'],
  [/\bcompany\b/g, 'co'], [/\bcorporation\b/g, 'corp'], [/\bsdn\s+bhd\b/g, 'sdn bhd'],
];

export function normName(v) {
  let s = String(v ?? '').toLowerCase().replace(/[.,'"()]/g, '').replace(/[-/&]/g, ' ');
  for (const [rx, rep] of SUFFIXES) s = s.replace(rx, rep);
  return s.replace(/\s+/g, ' ').trim();
}

const portCode = (v) => String(v ?? '').toUpperCase().match(/\(([A-Z]{2}[A-Z0-9]{3})\)/)?.[1] ?? null;

export function normPort(v) {
  return normName(String(v ?? '').split(',')[0].replace(/\(.*?\)/g, ''));
}

/**
 * City name (before the first comma) must match; when BOTH sides carry a
 * UN/LOCODE it must match too. Never trust the code alone: a changed city with
 * the old code copied across is a real defect.
 */
export function portsMatch(a, b) {
  const [ca, cb] = [portCode(a), portCode(b)];
  if (ca && cb && ca !== cb) return false;
  return normPort(a) !== '' && normPort(a) === normPort(b);
}

export function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = s.match(/\d[\d.,\s]*\d|\d/);
  if (!m) return null;
  let t = m[0].replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 131.058,00
  else t = t.replace(/,/g, '');
  let n = Number(t);
  if (/\b(mt|t|tons?|tonnes?)\b/i.test(s) && !/kg/i.test(s)) n *= 1000;
  return Number.isFinite(n) ? n : null;
}

export function toCount(v) {
  const s = String(v ?? '');
  const parts = [...s.matchAll(/(\d+)\s*[x×*]\s*\d{2}/gi)].map((m) => Number(m[1]));
  if (parts.length) return parts.reduce((a, b) => a + b, 0);
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : null;
}

function resolveNotify(doc) {
  const n = doc.fields.notify_party?.value;
  return /^same as consignee$/i.test(String(n || '').trim()) ? doc.fields.consignee?.value : n;
}

/** 0..1 similarity of the letters/digits, ignoring spaces and punctuation. */
export function similarity(a, b) {
  const [x, y] = [compact(a), compact(b)];
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export function compare(si, bl) {
  // OCR misreads single letters ("AL GURS" for "AL GURG"). When either side was
  // OCR'd, names and ports only need to be 85% alike; numbers must still match.
  // Planted name defects are different companies, far below 85%.
  const ocr = si.method === 'ocr' || bl.method === 'ocr';
  const same = (a, b, exact) => (ocr ? similarity(a, b) >= 0.85 : exact);
  return {
    fields: FIELDS.map((f) => {
      const rawA = si.fields[f]?.value ?? null;
      const rawB = bl.fields[f]?.value ?? null;
      // "SAME AS CONSIGNEE" is resolved only when the two texts differ; identical text always matches
      const sameText = normName(rawA) !== '' && normName(rawA) === normName(rawB);
      const a = f === 'notify_party' && !sameText ? resolveNotify(si) : rawA;
      const b = f === 'notify_party' && !sameText ? resolveNotify(bl) : rawB;
      let match;
      if (f === 'notify_party' && sameText) match = true;
      else if (f === 'container_count') match = toCount(a) !== null && toCount(a) === toCount(b);
      else if (f === 'gross_weight_kg') match = toNumber(a) !== null && Math.abs(toNumber(a) - toNumber(b)) < 0.5;
      else if (f.startsWith('port_')) {
        match = ocr ? similarity(a, b) >= 0.85 || similarity(normPort(a), normPort(b)) >= 0.85 : portsMatch(a, b);
      }
      else match = same(a, b, normName(a) !== '' && normName(a) === normName(b));
      return { field: f, siValue: si.fields[f]?.value ?? null, blValue: bl.fields[f]?.value ?? null, match };
    }),
  };
}

export function stagesFor() {
  return { classify, extract, compare };
}

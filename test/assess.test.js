// Phase 1: assess() escalation rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocType, Reason, makeDocument } from '../src/models.js';
import { assess } from '../src/reliability/assess.js';
import { SI_TEXT, bl, doc, email, si } from './helpers.js';

// --- ok paths
test('non-comparison email is always ok', () => assert.ok(assess(email([], { category: 'SPAM' })).ok));
test('clean pair is ok', () => assert.ok(assess(email([si(), bl()])).ok));

test('a real mismatch is not escalated', () => {
  const r = email([si(), bl({ overrides: { container_count: '4' } })]);
  r.comparison = { fields: [{ field: 'container_count', siValue: '3', blValue: '4', match: false }] };
  assert.ok(assess(r).ok); // C reports it; D must not steal it from end-to-end
});

test('extra attachment is ignored', () => {
  const extra = doc('attachments/email_001_packing.pdf', DocType.OTHER, { text: SI_TEXT });
  assert.ok(assess(email([si(), bl(), extra])).ok);
});

test('unknown type falls back to filename', () => {
  const a = doc('attachments/email_001_SI.txt', DocType.UNKNOWN);
  const b = doc('attachments/email_001_BL.txt', DocType.UNKNOWN);
  assert.ok(assess(email([a, b])).ok);
});

// --- 1. missing_attachment
test('no attachments', () => {
  const a = assess(email([], { subject: 'Please check attached draft BL' }));
  assert.equal(a.reason, Reason.MISSING_ATTACHMENT);
  assert.match(a.detail, /no attachments/);
});
test('only one attachment', () => assert.equal(assess(email([si()])).reason, Reason.MISSING_ATTACHMENT));
test('listed but file not found', () => {
  const a = assess(email([si(), makeDocument({ path: 'attachments/email_001_BL.pdf', found: false })]));
  assert.equal(a.reason, Reason.MISSING_ATTACHMENT);
  assert.match(a.detail, /email_001_BL\.pdf/);
});
test('extractor skipped an attachment', () => {
  const r = email([si()], { attachments: ['attachments/email_001_SI.pdf', 'attachments/email_001_BL.pdf'] });
  assert.equal(assess(r).reason, Reason.MISSING_ATTACHMENT);
});

// --- 2. unreadable
test('parse error', () => {
  const a = assess(email([si(), bl({ error: 'PDF is encrypted' })]));
  assert.equal(a.reason, Reason.UNREADABLE);
  assert.match(a.detail, /encrypted/);
});
test('empty text', () => assert.equal(assess(email([si(), bl({ text: '  \n ' })])).reason, Reason.UNREADABLE));
test('OCR noise', () => {
  const noise = '}{~^ ¬¦ §±~ }{ ¤¤ ~~^ ¦¦ ±§ ^}{ ¬¬ ~~ ¤ }{~^ ¬¦ §± ~}{ ¤¤~ ^^ ¦¦';
  assert.equal(assess(email([si(), bl({ text: noise })])).reason, Reason.UNREADABLE);
});
test('low OCR confidence', () => {
  assert.equal(assess(email([si(), bl({ ocrConfidence: 0.2, method: 'ocr' })])).reason, Reason.UNREADABLE);
});
test('good OCR confidence passes', () => assert.ok(assess(email([si(), bl({ ocrConfidence: 0.9, method: 'ocr' })])).ok));
test('both unreadable reports both', () => {
  assert.equal(assess(email([si({ error: 'corrupt' }), bl({ error: 'corrupt' })])).issues.length, 2);
});
test('non-English names are not noise', () => {
  const text = 'SHIPPING INSTRUCTION\nShipper: Müller Logistik GmbH\nConsignee: Société Générale Maritime\nNotify: 株式会社 海運';
  assert.ok(assess(email([si({ text }), bl()])).ok);
});

// --- 3. wrong_doc_type
test('invoice instead of BL', () => {
  const inv = doc('attachments/email_001_BL.pdf', DocType.OTHER, { text: `COMMERCIAL INVOICE ${SI_TEXT}` });
  const a = assess(email([si(), inv]));
  assert.equal(a.reason, Reason.WRONG_DOC_TYPE);
  assert.match(a.detail.toLowerCase(), /no bill of lading/);
});
test('content beats filename', () => {
  assert.equal(assess(email([si(), doc('x/email_001_BL.pdf', DocType.OTHER)])).reason, Reason.WRONG_DOC_TYPE);
});
test('two SIs', () => {
  assert.equal(assess(email([si(), doc('attachments/email_001_SI_v2.pdf', DocType.SI)])).reason, Reason.WRONG_DOC_TYPE);
});

// --- 4. missing_value
test('missing field in BL', () => {
  const a = assess(email([si(), bl({ overrides: { gross_weight_kg: null } })]));
  assert.equal(a.reason, Reason.MISSING_VALUE);
  assert.equal(a.issues[0].evidence[0].field, 'gross_weight_kg');
  assert.match(a.detail, /BL/);
});
for (const placeholder of ['TBA', 'n/a', '  -  ', 'To Be Advised', '']) {
  test(`placeholder "${placeholder}" counts as missing`, () => {
    assert.equal(assess(email([si({ overrides: { notify_party: placeholder } }), bl()])).reason, Reason.MISSING_VALUE);
  });
}
test('absent field key counts as missing', () => {
  const s = si();
  delete s.fields.consignee;
  assert.equal(assess(email([s, bl()])).reason, Reason.MISSING_VALUE);
});
test('all missing values are listed', () => {
  const a = assess(email([si({ overrides: { shipper: null } }), bl({ overrides: { consignee: null } })]));
  assert.deepEqual(new Set(a.issues.map((i) => i.evidence[0].field)), new Set(['shipper', 'consignee']));
});

// --- precedence
test('unreadable beats missing value', () => {
  assert.equal(assess(email([si({ overrides: { shipper: null } }), bl({ error: 'corrupt' })])).reason, Reason.UNREADABLE);
});
test('missing attachment beats unreadable', () => {
  assert.equal(assess(email([si({ error: 'corrupt' })])).reason, Reason.MISSING_ATTACHMENT);
});

// --- 5. low confidence (opt-in)
function lowConfEmail() {
  const b = bl({ overrides: { container_count: '4' } });
  b.fields.container_count.confidence = 0.3;
  const r = email([si(), b]);
  r.comparison = { fields: [{ field: 'container_count', siValue: '3', blValue: '4', match: false }] };
  return r;
}
test('low confidence is off by default', () => assert.ok(assess(lowConfEmail()).ok));
test('low confidence when enabled', () => {
  assert.equal(assess(lowConfEmail(), { minFieldConfidence: 0.6 }).reason, Reason.LOW_CONFIDENCE);
});

test('assessment is JSON-safe', () => {
  const a = JSON.parse(JSON.stringify(assess(email([si(), bl({ overrides: { shipper: null } })]))));
  assert.equal(a.reason, 'missing_value');
  assert.equal(a.ok, false);
});

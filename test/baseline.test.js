// Baseline stages (stand-ins for A, B, C) on the patterns seen in the real data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classify, compare, detectType, extractFields, extractFieldsFuzzy, portsMatch, similarity, toCount, toNumber,
} from '../src/baseline.js';
import { makeDocument } from '../src/models.js';

test('classify uses the body, not the misleading subject', () => {
  const e = (subject, body, attachments = []) => ({ subject, body, attachments });
  assert.equal(classify(e('Re: Invoice payment - confirm bank details', 'I am a bank officer with a business proposal')), 'SPAM');
  assert.equal(classify(e('REQUEST BL DRAFT', 'Please find Shipping instruction for 5RUS-1. POL: X')), 'SI_REQUEST');
  assert.equal(classify(e('TO CONFIRM DOCS', 'Please assist to send the draft BL for X1 for checking asap.')), 'BL_COMPARISON');
  assert.equal(classify(e('x', 'Please compare the SI and draft BL for X and confirm (attachments appear to be missing)')), 'BL_COMPARISON');
  assert.equal(classify(e('x', 'Query on invoice 525: is the THC included?')), 'INVOICE_QUERY');
  assert.equal(classify(e('x', 'Kindly find the daily berthing report attached.')), 'GENERAL');
  assert.equal(classify(e('Draft BL', 'see files', ['a_SI.txt', 'a_BL.txt'])), 'BL_COMPARISON');
});

test('label synonyms across formats', () => {
  const f = extractFields(`BILL OF LADING (DRAFT)
To the Order of: UAB NOVAKOPA
  RAKEZ AMENITY CENTER
Port of Loading (POL): NANTONG, CHINA (CNNTG)
Consignee (Non-Negotiable): X
Notify (通知人): UAB NOVAKOPA
POD: KARACHI, PAKISTAN
CONTAINER NO.   DESCRIPTION   GROSS WEIGHT (KG)
No. of Containers or Packages: 6 x 40'HC
TOTAL Gross Wt (kgs): 131,058 KG
SHIPPER: APRIL FAR EAST (M) SDN BHD`);
  assert.equal(f.consignee.value, 'UAB NOVAKOPA');       // first match wins, address line ignored
  assert.equal(f.port_of_loading.value, 'NANTONG, CHINA (CNNTG)');
  assert.equal(f.notify_party.value, 'UAB NOVAKOPA');
  assert.equal(f.container_count.value, "6 x 40'HC");     // not the "CONTAINER NO." table header
  assert.equal(f.gross_weight_kg.value, '131,058 KG');
  assert.equal(f.shipper.value, 'APRIL FAR EAST (M) SDN BHD');
});

test('PDF container table is counted and summed when no totals are given', () => {
  const f = extractFields('Shipper   A\nPURJ4736471   40\'HC PAPER   21,887\nWBFO6773592   40\'HC PAPER   21,887');
  assert.equal(toCount(f.container_count.value), 2);
  assert.equal(toNumber(f.gross_weight_kg.value), 43774);
});

test('document type from content, including "BILL OF LADING INSTRUCTION" = SI', () => {
  assert.equal(detectType('BILL OF LADING INSTRUCTION\nB/L NUMBER: X'), 'SI');
  assert.equal(detectType('SHIPPING INSTRUCTION\n===='), 'SI');
  assert.equal(detectType('BILL OF LADING (DRAFT)'), 'BL');
  assert.equal(detectType('ACME PTE LTD\nBILL OF LADING: 3154303911'), 'BL');
  assert.equal(detectType('PACKING LIST\nShipper: X'), 'OTHER');
  assert.equal(detectType('CERTIFICATE OF ORIGIN'), 'OTHER');
});

test('numbers: thousands separators, European format, tonnes', () => {
  assert.equal(toNumber('131,058 KG'), 131058);
  assert.equal(toNumber('131.058,50'), 131058.5);
  assert.equal(toNumber('138 MT'), 138000);
  assert.equal(toCount("3 x 20'GP + 2 x 40'HC"), 5);
});

test('ports: a changed city with the old UN/LOCODE is a mismatch', () => {
  assert.equal(portsMatch('MOMBASA, KENYA (KEMBA)', 'TUTICORIN, INDIA (KEMBA)'), false);
  assert.equal(portsMatch('NANTONG, CHINA (CNNTG)', 'NANTONG'), true);
  assert.equal(portsMatch('KOPER, SLOVENIA', 'KOPER'), true);
  assert.equal(portsMatch('BUSAN (KRPUS)', 'BUSAN (KRINC)'), false);
});

const doc = (fields, method = 'text') => makeDocument({ path: 'x', fields, method });
const base = { shipper: 'ACME PTE. LTD.', consignee: 'BLUE LLC', notify_party: 'SAME AS CONSIGNEE', port_of_loading: 'PORT KLANG (WESTPORT), MALAYSIA',
  port_of_discharge: 'KOPER, SLOVENIA', container_count: "3 x 40'HC", gross_weight_kg: '22,000 KG' };

test('compare ignores formatting, catches real differences', () => {
  const same = compare(doc(base), doc({ ...base, shipper: 'Acme Pte Ltd', notify_party: 'BLUE LLC', gross_weight_kg: '22000' }));
  assert.deepEqual(same.fields.filter((f) => !f.match).map((f) => f.field), []);
  const diff = compare(doc(base), doc({ ...base, consignee: 'OTHER LLC', container_count: "4 x 40'HC" }));
  assert.deepEqual(diff.fields.filter((f) => !f.match).map((f) => f.field), ['consignee', 'container_count']);
});

test('OCR: fuzzy labels without colons, digits never part of a label', () => {
  const f = extractFieldsFuzzy("Portof Lcading: NAN TONG, CHINA\nfotify: AL GURG LLC\nContainers 6 x 40'HC\nGross Weight 128544 KG", 0.8);
  assert.equal(f.port_of_loading.value, 'NAN TONG, CHINA');
  assert.equal(f.notify_party.value, 'AL GURG LLC');
  assert.equal(f.container_count.value, "6 x 40'HC");
  assert.equal(f.gross_weight_kg.confidence, 0.8);
});

test('OCR: one-letter misreads still match, different companies do not', () => {
  assert.ok(similarity('AL GURS STATIONERY LLC', 'AL GURG STATIONERY LLC') >= 0.85);
  assert.ok(similarity('EAST BRIGHT FZ-LLC', 'UAB NOVAKOPA') < 0.5);
  const r = compare(doc({ ...base, consignee: 'BLUE LLC' }, 'ocr'), doc({ ...base, consignee: 'BLUF LLC', port_of_discharge: 'KOPER SLOVENIA' }, 'ocr'));
  assert.deepEqual(r.fields.filter((f) => !f.match).map((f) => f.field), []);
});

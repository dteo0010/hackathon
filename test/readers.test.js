// Document readers: every format becomes "label: value" text; broken files say so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readDocument } from '../src/readers.js';

/** Smallest valid PDF with text drawn at (x, y) positions. */
function makePdf(lines) {
  const content = lines.map(([x, y, s]) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

async function makeDocx(rows) {
  const cell = (paras) => `<w:tc>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:tc>`;
  const body = `<w:p><w:r><w:t>BILL OF LADING (DRAFT)</w:t></w:r></w:p><w:tbl>${rows.map(([l, v]) => `<w:tr>${cell([l])}${cell(v)}</w:tr>`).join('')}</w:tbl>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('txt is read as-is', async () => {
  const r = await readDocument('a/x_SI.txt', Buffer.from('SHIPPING INSTRUCTION\nShipper: ACME'));
  assert.equal(r.method, 'text');
  assert.match(r.text, /Shipper: ACME/);
});

test('xlsx rows become label: value, "|" splits address lines', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BL');
  ws.addRow(['BILL OF LADING', '31543']);
  ws.addRow(['CONSIGNEE', 'BALL & DOGGETT PTY LTD | 43-45 METROPOLITAN ROAD']);
  ws.addRow(['Gross Weight (KG)', 341715]);
  const r = await readDocument('x_BL.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(r.error, null);
  assert.match(r.text, /^CONSIGNEE: BALL & DOGGETT PTY LTD\n {4}43-45 METROPOLITAN ROAD$/m);
  assert.match(r.text, /Gross Weight \(KG\): 341715/);
});

test('docx table rows become label: value with continuation lines', async () => {
  const buf = await makeDocx([['Consignee (收货人)', ['AL GURG STATIONERY LLC', 'P.O. BOX 5069']], ['POD (卸货港)', ['KARACHI, PAKISTAN']]]);
  const r = await readDocument('x_BL.docx', buf);
  assert.equal(r.error, null);
  assert.match(r.text, /^Consignee \(收货人\): AL GURG STATIONERY LLC\n {4}P\.O\. BOX 5069$/m);
  assert.match(r.text, /POD \(卸货港\): KARACHI, PAKISTAN/);
});

test('pdf keeps label / value columns, even after a long label', async () => {
  const pdf = makePdf([[57, 740, 'BILL OF LADING (DRAFT)'], [57, 700, 'Shipper'], [170, 700, 'APRIL FINE PAPER TRADING'],
    [170, 687, '77 ROBINSON ROAD'], [57, 660, 'Consignee (Non-Negotiable)'], [170, 660, 'BALL AND DOGGETT'], [170, 647, 'ENFIELD NSW']]);
  const r = await readDocument('x_BL.pdf', pdf);
  assert.equal(r.error, null);
  assert.match(r.text, /^Shipper {3}APRIL FINE PAPER TRADING$/m);
  assert.match(r.text, /^Consignee \(Non-Negotiable\) {3}BALL AND DOGGETT$/m);
  assert.match(r.text, /^ {4}77 ROBINSON ROAD$/m);
});

test('corrupt pdf is reported, not guessed', async () => {
  const r = await readDocument('x_BL.pdf', Buffer.concat([Buffer.from('%PDF-1.5\n'), Buffer.from([0x94, 0x76, 0xc2, 0xf0, 0x0c, 0x7c])]));
  assert.match(r.error, /corrupt or not a valid PDF/);
  assert.equal(r.text, '');
});

test('unsupported type is reported', async () => {
  assert.match((await readDocument('x.png', Buffer.from('x'))).error, /unsupported/);
});

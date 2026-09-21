/**
 * Turn any attachment into plain text, and say honestly when that isn't possible.
 *
 *   readDocument(path, buffer) -> { text, method, error, imageOnly, pages }
 *
 * Output text is normalised to "Label: value" lines wherever the source has a
 * label/value layout (Excel rows, Word table rows), so one field parser works
 * for every format. PDFs keep their visual layout (label, gap, value), which
 * the parser also understands.
 *
 * Supported: .txt, .pdf (text layer), scanned .pdf (offline OCR), .docx, .xlsx.
 * A corrupt file, or a scan OCR can't read, comes back with `error` set, so
 * task D escalates it as unreadable instead of pretending it was read.
 */
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

export async function readDocument(path, buffer) {
  const ext = String(path).toLowerCase().split('.').pop();
  try {
    switch (ext) {
      case 'txt': return ok(buffer.toString('utf8'), 'text');
      case 'pdf': return await readPdf(buffer);
      case 'docx': return ok(await readDocx(buffer), 'docx');
      case 'xlsx': return ok(await readXlsx(buffer), 'xlsx');
      default: return fail(`unsupported file type .${ext}`, 'none');
    }
  } catch (err) {
    return fail(`could not parse ${ext.toUpperCase()}: ${err.message}`, ext);
  }
}

const ok = (text, method, extra = {}) => ({ text, method, error: null, imageOnly: false, pages: null, ...extra });
const fail = (error, method, extra = {}) => ({ text: '', method, error, imageOnly: false, pages: null, ...extra });

// ----------------------------------------------------------------------- PDF
let pdfjs;
async function readPdf(buffer) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer), verbosity: 0, disableFontFace: true, useSystemFonts: false, isEvalSupported: false,
    }).promise;
  } catch (err) {
    return fail(`corrupt or not a valid PDF (${err.message})`, 'pdf');
  }
  const lines = [];
  let images = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    lines.push(...layoutLines(content.items));
    const ops = await page.getOperatorList();
    images += ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length;
  }
  const pages = doc.numPages;
  const text = lines.join('\n');
  if (!text.trim() && images) {
    const scanned = await ocrPdf(doc, pdfjs);
    await doc.destroy();
    return { ...scanned, pages };
  }
  await doc.destroy();
  if (!text.trim()) return fail('PDF contains no text', 'pdf', { pages });
  return ok(text, 'pdf', { pages });
}

// ----------------------------------------------------------------------- OCR
/**
 * Scanned PDFs: pull the page image out of the PDF, enlarge it 4x and turn it
 * black/white (small scanned text reads far better that way), then OCR with
 * tesseract.js. Fully offline: the English model ships in node_modules.
 * Returns ocrConfidence (0..1) so task D can escalate a scan that reads badly.
 */
async function ocrPdf(doc, pdfjs) {
  let Tesseract, PNG, langPath;
  try {
    Tesseract = await import('tesseract.js');
    ({ PNG } = await import('pngjs'));
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    langPath = require.resolve('@tesseract.js-data/eng/package.json').replace(/package\.json$/, '4.0.0_best_int');
  } catch {
    return fail('scanned PDF with no text layer - OCR is not installed', 'pdf', { imageOnly: true });
  }
  const { tmpdir } = await import('node:os');
  const worker = await Tesseract.createWorker('eng', 1, { langPath, gzip: true, cachePath: tmpdir() });
  try {
    const texts = [];
    const confs = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const img = await new Promise((resolve) => page.objs.get(ops.argsArray[i][0], resolve));
        if (!img?.data || img.width < 200) continue; // skip logos / stamps
        const { data } = await worker.recognize(toPng(img, PNG));
        texts.push(data.text);
        confs.push(data.confidence / 100);
      }
    }
    const text = texts.join('\n').trim();
    if (!text) return fail('scanned PDF, OCR found no text', 'ocr', { imageOnly: true, ocrConfidence: 0 });
    const ocrConfidence = Math.min(...confs);
    return ok(text, 'ocr', { imageOnly: true, ocrConfidence });
  } catch (err) {
    return fail(`scanned PDF, OCR failed: ${err.message}`, 'ocr', { imageOnly: true });
  } finally {
    await worker.terminate();
  }
}

/** pdf.js image -> 4x enlarged black/white PNG. kind 1 = 1-bit, 2 = RGB, 3 = RGBA. */
function toPng(img, PNG, scale = 4, threshold = 170) {
  const { width: w, height: h, kind, data } = img;
  const grey = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) {
    if (kind === 3) grey[k] = (data[k * 4] + data[k * 4 + 1] + data[k * 4 + 2]) / 3;
    else if (kind === 2) grey[k] = (data[k * 3] + data[k * 3 + 1] + data[k * 3 + 2]) / 3;
    else grey[k] = (data[(k / 8 + (Math.floor(k / w) * (Math.ceil(w / 8) * 8 - w)) / 8) | 0] >> (7 - (k % w) % 8)) & 1 ? 255 : 0;
  }
  const W = w * scale;
  const H = h * scale;
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    const fy = Math.min(y / scale, h - 1.001);
    const y0 = Math.floor(fy);
    const dy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(x / scale, w - 1.001);
      const x0 = Math.floor(fx);
      const dx = fx - x0;
      const v = grey[y0 * w + x0] * (1 - dx) * (1 - dy) + grey[y0 * w + x0 + 1] * dx * (1 - dy)
        + grey[(y0 + 1) * w + x0] * (1 - dx) * dy + grey[(y0 + 1) * w + x0 + 1] * dx * dy;
      const o = (y * W + x) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = v < threshold ? 0 : 255;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Rebuild lines from positioned text items; wide horizontal gaps become 3 spaces. */
function layoutLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue; // blank items span gaps; the gap itself is what we measure
    const y = Math.round(it.transform[5]);
    const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: it.transform[4], w: it.width, s: it.str, h: Math.abs(it.transform[3]) || 10 });
  }
  // The value column: where continuation lines (addresses) start. Anything that
  // starts there is a value, even when a long label leaves only a tiny gap.
  const starts = new Map();
  for (const parts of rows.values()) {
    const x = Math.round(Math.min(...parts.map((p) => p.x)));
    if (x > 120) starts.set(x, (starts.get(x) || 0) + 1);
  }
  const valueCol = [...starts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const out = [];
  for (const y of [...rows.keys()].sort((a, b) => b - a)) {
    const parts = rows.get(y).sort((a, b) => a.x - b.x);
    let line = '';
    let end = null;
    const indent = parts[0].x > 120; // value-column continuation lines start far right
    for (const p of parts) {
      const atValueCol = valueCol !== null && Math.abs(p.x - valueCol) <= 3;
      if (end !== null) line += atValueCol || p.x - end > p.h * 1.5 ? '   ' : p.x - end > p.h * 0.15 ? ' ' : '';
      line += p.s;
      end = p.x + p.w;
    }
    out.push((indent ? '    ' : '') + line.trim());
  }
  return out;
}

// ---------------------------------------------------------------------- DOCX
async function readDocx(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const lines = [];
  // walk top-level blocks in order: tables become "label: value" rows
  const blocks = html.match(/<table[\s\S]*?<\/table>|<p[\s\S]*?<\/p>|<h\d[\s\S]*?<\/h\d>/g) || [];
  for (const block of blocks) {
    if (!block.startsWith('<table')) {
      const t = cellText(block);
      if (t) lines.push(t);
      continue;
    }
    for (const row of block.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellParagraphs);
      pushRow(lines, cells);
    }
  }
  return lines.join('\n');
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cellText = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function cellParagraphs(cellHtml) {
  const paras = cellHtml.match(/<p[\s\S]*?<\/p>/g) || [cellHtml];
  return paras.flatMap((p) => p.split(/<br\s*\/?>/)).map(cellText).filter(Boolean);
}

/** Two-column row -> "label: first value line" + indented continuation lines. */
function pushRow(lines, cells) {
  const nonEmpty = cells.filter((c) => c.length);
  if (nonEmpty.length === 2 && nonEmpty[0].length === 1) {
    const [[label], [first, ...rest]] = nonEmpty;
    lines.push(`${label}: ${first}`);
    for (const r of rest) lines.push(`    ${r}`);
  } else if (nonEmpty.length) {
    lines.push(nonEmpty.map((c) => c.join(' / ')).join('   '));
  }
}

// ---------------------------------------------------------------------- XLSX
async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const lines = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (c) => {
        const v = cellValue(c.value);
        if (v !== '') cells.push(v.split(/\s+\|\s+/)); // "NAME | address" -> lines
      });
      pushRow(lines, cells);
    });
  });
  return lines.join('\n');
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if (v.text) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

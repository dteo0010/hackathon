import type { DocFormat, DocText, ReadFailure, ReadOptions } from './types.js';

const CONTENT_TYPES: Record<DocFormat, string> = {
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  unknown: 'application/octet-stream',
};

/**
 * readAttachment — the only function the rest of the pipeline needs.
 *
 *   const doc = await readAttachment('attachments/email_004_SI.txt', bytes);
 *   if (!doc.readable) escalate(doc.failure);   // -> review_reason 'unreadable'
 *   extractFields(doc.text);
 *
 * Handles every format in the dataset: .txt, .pdf (text layer), .docx, .xlsx.
 * Tables are flattened so that a label and its value stay on the same line,
 * which is what field extraction needs.
 */
export async function readAttachment(
  path: string,
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<DocText> {
  const declared = formatOf(path);
  const base: DocText = {
    path,
    format: declared,
    text: '',
    readable: false,
    method: 'none',
    chars: 0,
  };

  if (bytes.byteLength === 0) {
    return fail(base, 'empty_file', 'file is 0 bytes');
  }

  // Trust the bytes over the extension: a .pdf that is really a zip, or a
  // truncated file, should be reported as corrupt rather than parsed blindly.
  const actual = sniff(bytes);
  if (actual && declared !== 'unknown' && !compatible(declared, actual)) {
    return fail(
      base,
      'wrong_extension',
      `named .${declared} but the bytes look like ${actual}`,
    );
  }

  let parsed: DocText;
  try {
    switch (declared) {
      case 'txt':
        parsed = finish({ ...base, text: decodeText(bytes), method: 'plain' });
        break;
      case 'pdf':
        parsed = finish(await readPdf(base, bytes));
        break;
      case 'docx':
        parsed = finish(await readDocx(base, bytes));
        break;
      case 'xlsx':
        parsed = finish(await readXlsx(base, bytes));
        break;
      default:
        return fail(base, 'unsupported_format', `no reader for ${path}`);
    }
  } catch (err) {
    return fail(base, 'corrupt_file', `${declared} parse failed: ${(err as Error).message}`);
  }

  // Image-only page: the file is fine, there is just no text in it. Ask the
  // vision reader if one was provided. A failing model must not turn a
  // readable-by-a-human scan into a crash, so errors fall back to "unreadable".
  if (parsed.failure === 'no_text_layer' && options.vision) {
    let seen: Awaited<ReturnType<NonNullable<ReadOptions['vision']>>> = null;
    try {
      seen = await options.vision({ path, bytes, contentType: CONTENT_TYPES[declared] });
    } catch (err) {
      return { ...parsed, readError: `${parsed.readError}; vision read failed: ${(err as Error).message}` };
    }
    if (seen && seen.text.trim().length >= 40) {
      if (options.trustVision) {
        return { ...finish({ ...base, text: seen.text, method: 'vision' }), transcription: seen };
      }
      return {
        ...parsed,
        transcription: seen,
        readError: 'scanned page, no text layer: AI transcription attached for the reviewer to confirm',
      };
    }
  }
  return parsed;
}

async function readPdf(base: DocText, bytes: Uint8Array): Promise<DocText> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(bytes, { verbosity: 0 });
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(tidy(layoutPdfLines(content.items as PdfItem[])));
  }
  return { ...base, text: pages.join('\n\n'), pages, method: 'pdf-text' };
}

interface PdfItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Rebuild table columns from text positions. A plain text dump of these PDFs
 * reads "Shipper APRIL FINE PAPER TRADING" — the label/value boundary is gone.
 * But the label and the value are separate text runs with a wide gap between
 * them, so: group runs into lines by their baseline, then treat a wide gap as
 * a cell boundary. A two-cell line becomes "label: value", like every other
 * format this reader produces.
 */
function layoutPdfLines(items: PdfItem[]): string {
  const runs = items
    .filter((i) => i.str && i.str.trim() && i.transform)
    .map((i) => {
      const [, , , d, x, y] = i.transform!;
      return { str: i.str!, x, y, w: i.width ?? 0, h: Math.abs(d) || i.height || 10 };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x); // PDF origin is bottom-left

  const lines: (typeof runs)[] = [];
  for (const run of runs) {
    const line = lines.find((l) => Math.abs(l[0].y - run.y) <= Math.max(2, run.h * 0.4));
    if (line) line.push(run);
    else lines.push([run]);
  }

  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x);
      const cells: string[] = [];
      let cell = line[0].str;
      let end = line[0].x + line[0].w;
      for (const run of line.slice(1)) {
        const gap = run.x - end;
        // A word space is ~0.25 of the font height; a column gap is several
        // times that. Measured on this corpus: the tightest label/value gap is
        // "Shipper (Principal or Seller)" at 1.0x the height (8pt at 8pt type).
        if (gap > Math.max(3, run.h * 0.6)) {
          cells.push(cell.trim());
          cell = run.str;
        } else {
          const space = gap > 0.5 && !cell.endsWith(' ') && !run.str.startsWith(' ');
          cell += (space ? ' ' : '') + run.str;
        }
        end = run.x + run.w;
      }
      cells.push(cell.trim());
      const filled = cells.filter(Boolean);
      return filled.length === 2 ? `${filled[0]}: ${filled[1]}` : filled.join('\t');
    })
    .join('\n');
}

async function readDocx(base: DocText, bytes: Uint8Array): Promise<DocText> {
  const mammoth = (await import('mammoth')).default;
  // HTML rather than raw text: raw text drops table structure, and these
  // documents put "Port of Loading | NANTONG" in table cells.
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return { ...base, text: flattenHtml(html), method: 'docx' };
}

async function readXlsx(base: DocText, bytes: Uint8Array): Promise<DocText> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as never);
  const sheets: string[] = [];
  wb.eachSheet((sheet) => {
    const lines: string[] = [`### SHEET: ${sheet.name}`];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map(cellText).filter((c) => c !== '');
      if (!cells.length) return;
      // A two-cell row is nearly always label + value; keep them together.
      lines.push(cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join('\t'));
    });
    sheets.push(lines.join('\n'));
  });
  return { ...base, text: sheets.join('\n\n'), pages: sheets, method: 'xlsx' };
}

/**
 * Word HTML -> the same layout the .txt attachments use, so one extractor
 * handles both:
 *
 *   <tr><td>Consignee (收货人)</td><td>AL GURG LLC<br>P.O. BOX 5069<br>DUBAI</td></tr>
 *   ->  Consignee (收货人): AL GURG LLC
 *         P.O. BOX 5069; DUBAI
 *
 * Rows are handled as rows. Line breaks inside a cell are resolved per cell,
 * never before the cells are joined — otherwise a multi-line address tears
 * the label away from its value.
 */
function flattenHtml(html: string): string {
  const out: string[] = [];
  for (const part of html.split(/(<table[^>]*>[\s\S]*?<\/table>)/i)) {
    if (!/^<table/i.test(part)) {
      out.push(...htmlLines(part));
      continue;
    }
    for (const row of part.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? [])
        .map(htmlLines)
        .filter((c) => c.length > 0);
      if (cells.length === 2) {
        const [label, value] = cells;
        out.push(`${label.join(' ')}: ${value[0]}`);
        if (value.length > 1) out.push(`  ${value.slice(1).join('; ')}`);
      } else if (cells.length) {
        out.push(cells.map((c) => c.join('; ')).join('\t'));
      }
    }
  }
  return out.join('\n');
}

/** A fragment of HTML as its non-empty text lines. */
function htmlLines(fragment: string): string[] {
  return fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeEntities(l).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: Array<{ text: string }>; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return '';
  }
  return String(v).trim();
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function tidy(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function finish(doc: DocText): DocText {
  const text = tidy(doc.text);
  const chars = text.length;
  // Parsed, but nothing came out: an image-only PDF or a blank sheet. For the
  // pipeline that is the same as unreadable — escalate rather than compare.
  if (chars < 40) {
    return {
      ...doc,
      text,
      chars,
      readable: false,
      failure: 'no_text_layer',
      readError:
        doc.method === 'pdf-text'
          ? 'no text layer (scanned or image-only PDF)'
          : 'document contains no extractable text',
    };
  }
  return { ...doc, text, chars, readable: true };
}

function fail(base: DocText, failure: ReadFailure, readError: string): DocText {
  return { ...base, readable: false, failure, readError };
}

function formatOf(path: string): DocFormat {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return ext === 'txt' || ext === 'pdf' || ext === 'docx' || ext === 'xlsx'
    ? (ext as DocFormat)
    : 'unknown';
}

/** Magic bytes: %PDF for pdf, PK.. for the zip-based OOXML formats. */
function sniff(bytes: Uint8Array): 'pdf' | 'zip' | 'text' | null {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  }
  const head = bytes.subarray(0, 256);
  return head.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128)
    ? 'text'
    : null;
}

function compatible(declared: DocFormat, actual: 'pdf' | 'zip' | 'text'): boolean {
  if (declared === 'pdf') return actual === 'pdf';
  if (declared === 'docx' || declared === 'xlsx') return actual === 'zip';
  if (declared === 'txt') return actual === 'text';
  return true;
}

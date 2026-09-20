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
  // vision reader if one was provided; otherwise report it for human review.
  if (parsed.failure === 'no_text_layer' && options.vision) {
    const seen = await options.vision({
      path,
      bytes,
      contentType: CONTENT_TYPES[declared],
    });
    if (seen && seen.text.trim().length >= 40) {
      return {
        ...finish({ ...base, text: seen.text, method: 'vision' }),
        confidence: seen.confidence,
      };
    }
  }
  return parsed;
}

async function readPdf(base: DocText, bytes: Uint8Array): Promise<DocText> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [String(text)]).map(tidy);
  return { ...base, text: pages.join('\n\n'), pages, method: 'pdf-text' };
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

/** <table> rows become "cell: cell" or tab-separated; paragraphs become lines. */
function flattenHtml(html: string): string {
  const rows = html
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>\s*/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n');
  return rows
    .map((line) => {
      const cells = line.split('\t').map((c) => decodeEntities(c).trim()).filter(Boolean);
      if (cells.length === 2) return `${cells[0]}: ${cells[1]}`;
      return cells.join('\t');
    })
    .filter((l) => l.trim() !== '')
    .join('\n');
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

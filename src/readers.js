import { readAttachment, geminiVision } from '../reader/lib/index.js';

function legacyMethod(method) {
  switch (method) {
    case 'plain':
      return 'text';
    case 'pdf-text':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'xlsx':
      return 'xlsx';
    case 'vision':
      return 'ocr';
    default:
      return method;
  }
}

function legacyText(text = '') {
  // Task B uses two-space continuation lines.
  // The existing pipeline/tests use four spaces.
  let out = text.replace(/^ {2}(?=\S)/gm, '    ');

  // Preserve the previous reader contract for spreadsheet/address cells:
  // "NAME | ADDRESS" -> label line + indented continuation line.
  out = out.replace(
    /^([^:\n]+:\s*[^|\n]+?)\s+\|\s+(.+)$/gm,
    (_, first, rest) => `${first}\n    ${rest}`
  );

  return out;
}

function legacyError(doc) {
  if (doc.readable) return null;

  switch (doc.failure) {
    case 'corrupt_file':
      return `corrupt or not a valid PDF: ${doc.readError || 'parse failed'}`;

    case 'unsupported_format':
      return `unsupported format: ${doc.readError || 'no reader available'}`;

    case 'no_text_layer':
      return doc.readError || 'no text layer';

    case 'empty_file':
      return doc.readError || 'empty file';

    case 'wrong_extension':
      return doc.readError || 'wrong extension';

    default:
      return doc.readError || doc.failure || 'unreadable';
  }
}

/**
 * Adapter around Task B (@sdoc/reader).
 * Keeps the existing readDocument() contract used by stages.js.
 */
export async function readDocument(path, buffer) {
  // unpdf rejects Node Buffer even though Buffer extends Uint8Array.
  // Make it a plain Uint8Array.
  const bytes =
    Buffer.isBuffer(buffer)
      ? Uint8Array.from(buffer)
      : buffer;

  const options = {};

  // Gemini Vision is only used for image-only documents.
  // trustVision=false means the transcription is still human-review only.
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT) {
    options.vision = geminiVision();
    options.trustVision = false;
  }

  const doc = await readAttachment(path, bytes, options);

  const sourceText =
    doc.text ||
    doc.transcription?.text ||
    '';

  return {
    text: legacyText(sourceText),
    pages: doc.pages?.map(legacyText),

    method: legacyMethod(doc.method),
    error: legacyError(doc),

    imageOnly: doc.failure === 'no_text_layer',
    transcription: doc.transcription ?? null,

    // Task B does not manufacture an OCR confidence score.
    ocrConfidence: null,

    readable: doc.readable,
    failure: doc.failure ?? null,
    format: doc.format,
    chars: doc.chars,
  };
}
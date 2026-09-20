/** Contract for the reading stage: bytes in, text out. Nothing shipping-specific. */

export type DocFormat = 'txt' | 'pdf' | 'docx' | 'xlsx' | 'unknown';

export type ReadMethod = 'plain' | 'pdf-text' | 'docx' | 'xlsx' | 'vision' | 'none';

/**
 * Last resort for image-only pages: hand the bytes to a vision model (or OCR)
 * and get text back. Injected so this package stays free of AI dependencies —
 * the pipeline decides which model pays for it.
 */
export interface VisionReader {
  (input: { path: string; bytes: Uint8Array; contentType: string }): Promise<{
    text: string;
    confidence?: number;
  } | null>;
}

export interface ReadOptions {
  /** Called only when a document parses but yields no text (scanned PDF). */
  vision?: VisionReader;
}

/** Why a document could not be turned into text — maps to review_reason 'unreadable'. */
export type ReadFailure =
  | 'empty_file'
  | 'no_text_layer'
  | 'corrupt_file'
  | 'wrong_extension'
  | 'unsupported_format';

export interface DocText {
  /** Path exactly as it appears in email.attachments */
  path: string;
  format: DocFormat;
  /** Flattened plain text. Tables become "label: value" lines or tab-separated rows. */
  text: string;
  /** One entry per page (pdf) or per sheet (xlsx); undefined for single-body formats */
  pages?: string[];
  readable: boolean;
  failure?: ReadFailure;
  /** Human-readable detail for the review queue */
  readError?: string;
  method: ReadMethod;
  /** Character count of the extracted text — a cheap quality signal */
  chars: number;
  /** 0..1, set only when a vision model produced the text */
  confidence?: number;
}

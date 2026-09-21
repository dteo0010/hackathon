/** Contract for the reading stage: bytes in, text out. Nothing shipping-specific. */

export type DocFormat = 'txt' | 'pdf' | 'docx' | 'xlsx' | 'unknown';

export type ReadMethod = 'plain' | 'pdf-text' | 'docx' | 'xlsx' | 'vision' | 'none';

/** What a vision model (or OCR engine) saw on an image-only page. */
export interface Transcription {
  text: string;
  /** Which model produced it, for the audit trail */
  model?: string;
  /** How many spots the model marked [illegible] — a cheap legibility signal */
  illegible?: number;
}

/**
 * Last resort for image-only pages: hand the bytes to a vision model (or OCR)
 * and get text back. Injected so the core reader stays free of AI calls — the
 * pipeline decides which model pays for it. See ./vision/gemini.ts.
 */
export interface VisionReader {
  (input: { path: string; bytes: Uint8Array; contentType: string }): Promise<Transcription | null>;
}

export interface ReadOptions {
  /** Called only when a document parses but yields no text (a scan). */
  vision?: VisionReader;
  /**
   * Treat a vision transcription as the document's text (readable: true).
   *
   * Off by default, on purpose. Text an AI read off an image has not been
   * verified by anyone, so by default a scan stays `readable: false` and the
   * transcription rides along in `doc.transcription` for the human reviewer.
   * Existing "unreadable -> escalate" logic keeps working unchanged, and the
   * reviewer starts from a draft instead of a blank page.
   */
  trustVision?: boolean;
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
  /** A vision model's reading of a scan, for the reviewer. Unverified. */
  transcription?: Transcription;
}

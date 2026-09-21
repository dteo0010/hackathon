export { readAttachment } from './read.js';
export { geminiVision, DEFAULT_VISION_MODEL, TRANSCRIBE_PROMPT } from './vision/gemini.js';
export type { GeminiVisionOptions } from './vision/gemini.js';
export type {
  DocText,
  DocFormat,
  ReadFailure,
  ReadMethod,
  ReadOptions,
  Transcription,
  VisionReader,
} from './types.js';

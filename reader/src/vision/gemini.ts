import type { Transcription, VisionReader } from '../types.js';

/**
 * A VisionReader backed by Gemini, which reads PDFs and images natively.
 *
 *   import { readAttachment, geminiVision } from '@sdoc/reader';
 *   const doc = await readAttachment(path, bytes, { vision: geminiVision() });
 *
 * Auth, first match wins:
 *   GEMINI_API_KEY                  Gemini Developer API (AI Studio key)
 *   GOOGLE_CLOUD_PROJECT            Vertex AI via Application Default Credentials
 *                                   (`gcloud auth application-default login`
 *                                   locally; automatic in Cloud Functions)
 */
export interface GeminiVisionOptions {
  model?: string;
  apiKey?: string;
  project?: string;
  location?: string;
  /** Inject a client (tests, or a shared instance). Skips the SDK import. */
  client?: GenerateClient;
}

/** The one method we use, so tests can fake it without the SDK. */
export interface GenerateClient {
  models: {
    generateContent(params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }): Promise<{ text?: string | undefined }>;
  };
}

export const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';

/**
 * Same layout conventions the rest of this reader produces, so a transcribed
 * scan can go through the same extractor as any other document once a person
 * has confirmed it. Transcribe, never interpret.
 */
export const TRANSCRIBE_PROMPT = [
  'Transcribe this document exactly as printed.',
  'Put each label on the same line as its value, as "Label: value".',
  'Put each table row on one line, with cells separated by a single tab.',
  'Keep the original spelling, numbers, units and capitalisation.',
  'Do not summarise, translate, correct, or fill in anything.',
  'Where text cannot be read, write [illegible] in its place.',
  'Output only the transcription.',
].join('\n');

export function geminiVision(options: GeminiVisionOptions = {}): VisionReader {
  const model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_VISION_MODEL;
  let client: GenerateClient | undefined = options.client;

  return async ({ bytes, contentType }): Promise<Transcription | null> => {
    client ??= await createClient(options);
    const response = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: contentType, data: Buffer.from(bytes).toString('base64') } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
      config: { temperature: 0 },
    });
    const text = (response.text ?? '').trim();
    if (!text) return null;
    return { text, model, illegible: (text.match(/\[illegible\]/gi) ?? []).length };
  };
}

async function createClient(options: GeminiVisionOptions): Promise<GenerateClient> {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (apiKey) return new GoogleGenAI({ apiKey }) as unknown as GenerateClient;

  const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (project) {
    return new GoogleGenAI({
      vertexai: true,
      project,
      location: options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    }) as unknown as GenerateClient;
  }
  throw new Error('no Gemini credentials: set GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT with ADC');
}

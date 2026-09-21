import { afterEach, describe, expect, it } from 'vitest';
import { geminiVision, TRANSCRIBE_PROMPT, type GenerateClient } from '../src/vision/gemini.js';

type Request = Parameters<GenerateClient['models']['generateContent']>[0];

function fakeClient(reply: string | undefined) {
  const requests: Request[] = [];
  const client: GenerateClient = {
    models: {
      async generateContent(params) {
        requests.push(params);
        return { text: reply };
      },
    },
  };
  return { client, requests };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const input = { path: 'attachments/x.pdf', bytes: PDF, contentType: 'application/pdf' };

describe('geminiVision', () => {
  it('sends the file inline with its mime type and the transcription prompt', async () => {
    const { client, requests } = fakeClient('Shipper: ACME');
    await geminiVision({ client, model: 'gemini-test' })(input);

    const req = requests[0];
    expect(req.model).toBe('gemini-test');
    const parts = (req.contents as Array<{ parts: Array<Record<string, any>> }>)[0].parts;
    expect(parts[0].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: Buffer.from(PDF).toString('base64'),
    });
    expect(parts[1].text).toBe(TRANSCRIBE_PROMPT);
    expect(req.config).toMatchObject({ temperature: 0 });
  });

  it('returns the text, the model, and how much was illegible', async () => {
    const { client } = fakeClient('Shipper: [illegible]\nGross Wt: [ILLEGIBLE] KG');
    const out = await geminiVision({ client, model: 'gemini-test' })(input);
    expect(out).toEqual({
      text: 'Shipper: [illegible]\nGross Wt: [ILLEGIBLE] KG',
      model: 'gemini-test',
      illegible: 2,
    });
  });

  it('returns null when the model sends back nothing', async () => {
    const { client } = fakeClient('   ');
    expect(await geminiVision({ client })(input)).toBeNull();
  });

  describe('without credentials', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('fails with a message that says what to set', async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      await expect(geminiVision()(input)).rejects.toThrow(/GEMINI_API_KEY/);
    });
  });
});

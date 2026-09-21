import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAttachment } from '../src/read.js';
import { DATA_DIR } from '../scripts/data-dir.js';

const att = (name: string) => join(DATA_DIR, 'attachments', name);
const bytesOf = async (name: string) => new Uint8Array(await readFile(att(name)));
const read = async (name: string) => readAttachment(`attachments/${name}`, await bytesOf(name));

describe('plain text', () => {
  it('keeps label and value on one line', async () => {
    const doc = await read('email_004_SI.txt');
    expect(doc.readable).toBe(true);
    expect(doc.method).toBe('plain');
    expect(doc.text).toMatch(/Shipper: APRIL FAR EAST/);
    expect(doc.text).toMatch(/Port of Loading \(POL\): NANTONG/);
  });
});

describe('spreadsheets', () => {
  it('flattens a two-column row into "label: value"', async () => {
    const doc = await read('email_005_SI.xlsx');
    expect(doc.readable).toBe(true);
    expect(doc.method).toBe('xlsx');
    expect(doc.text).toMatch(/:/);
    expect(doc.chars).toBeGreaterThan(100);
  });
});

describe('word documents', () => {
  it('keeps a table row together, bilingual label and all', async () => {
    const doc = await read('email_055_BL.docx');
    expect(doc.readable).toBe(true);
    expect(doc.text).toContain('Shipper (Principal or Seller) (发货人): APRIL FINE PAPER TRADING');
    expect(doc.text).toContain('PORT OF LOADING (装货港): SINGAPORE');
  });

  it('puts the rest of a multi-line cell on one indented continuation line', async () => {
    const doc = await read('email_055_BL.docx');
    expect(doc.text).toMatch(/Consignee \(收货人\): AL GURG STATIONERY LLC\n {2}P\.O\. BOX 5069; DUBAI/);
  });
});

describe('pdf column layout', () => {
  it('recovers the label/value boundary a plain text dump loses', async () => {
    const doc = await read('email_059_SI.pdf');
    expect(doc.method).toBe('pdf-text');
    expect(doc.text).toContain('Shipper: APRIL FINE PAPER TRADING');
    expect(doc.text).toContain('POL: BUATAN, INDONESIA');
    expect(doc.text).toContain('Port of Discharge (POD): FREMANTLE, AUSTRALIA');
  });

  it('splits even when a long label nearly fills its column', async () => {
    const doc = await read('email_160_BL.pdf');
    expect(doc.text).toContain('Shipper (Principal or Seller): APRIL FINE PAPER TRADING');
  });

  it('keeps multi-column tables as tab-separated rows', async () => {
    const doc = await read('email_059_SI.pdf');
    expect(doc.text).toMatch(/CONTAINER NO\.\tDESCRIPTION\tGROSS WEIGHT \(KG\)/);
  });
});

describe('unreadable documents', () => {
  it('reports a corrupt pdf rather than throwing', async () => {
    const doc = await read('email_511_BL.pdf');
    expect(doc.readable).toBe(false);
    expect(doc.failure).toBe('corrupt_file');
  });

  it('reports an image-only pdf as no_text_layer', async () => {
    const doc = await read('email_512_BL.pdf');
    expect(doc.readable).toBe(false);
    expect(doc.failure).toBe('no_text_layer');
  });

  it('treats a zero-byte file as empty', async () => {
    const doc = await readAttachment('attachments/fake.pdf', new Uint8Array(0));
    expect(doc.failure).toBe('empty_file');
  });

  it('catches a file whose bytes disagree with its extension', async () => {
    const doc = await readAttachment('attachments/fake.pdf', new TextEncoder().encode('hello'));
    expect(doc.failure).toBe('wrong_extension');
  });
});

describe('scanned pages', () => {
  const SEEN = { text: 'BILL OF LADING (DRAFT)\nShipper: TEST CO\nPort of Loading: SINGAPORE', model: 'fake' };
  const scan = () => bytesOf('email_512_BL.pdf');

  it('by default keeps the scan for review, with the transcription attached', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await scan(), {
      vision: async ({ contentType }) => {
        expect(contentType).toBe('application/pdf');
        return SEEN;
      },
    });
    // unverified AI output must not flow into an automatic comparison
    expect(doc.readable).toBe(false);
    expect(doc.failure).toBe('no_text_layer');
    expect(doc.transcription?.text).toContain('Shipper: TEST CO');
    expect(doc.readError).toMatch(/transcription attached/);
  });

  it('promotes the transcription only when asked to trust vision', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await scan(), {
      vision: async () => SEEN,
      trustVision: true,
    });
    expect(doc.readable).toBe(true);
    expect(doc.method).toBe('vision');
    expect(doc.text).toContain('Port of Loading: SINGAPORE');
  });

  it('stays unreadable when the model sees nothing', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await scan(), {
      vision: async () => null,
    });
    expect(doc.readable).toBe(false);
    expect(doc.transcription).toBeUndefined();
  });

  it('reports a model failure instead of throwing', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await scan(), {
      vision: async () => {
        throw new Error('429 quota exceeded');
      },
    });
    expect(doc.readable).toBe(false);
    expect(doc.readError).toMatch(/vision read failed: 429 quota exceeded/);
  });

  it('never calls the model for a document that has a text layer', async () => {
    let calls = 0;
    await readAttachment('attachments/email_059_SI.pdf', await bytesOf('email_059_SI.pdf'), {
      vision: async () => {
        calls++;
        return SEEN;
      },
    });
    expect(calls).toBe(0);
  });
});

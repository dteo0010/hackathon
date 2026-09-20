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

describe('vision fallback', () => {
  it('uses the injected reader when there is no text layer', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await bytesOf('email_512_BL.pdf'), {
      vision: async ({ contentType }) => {
        expect(contentType).toBe('application/pdf');
        return { text: 'BILL OF LADING (DRAFT)\nShipper: TEST CO\nPort of Loading: SINGAPORE', confidence: 0.9 };
      },
    });
    expect(doc.readable).toBe(true);
    expect(doc.method).toBe('vision');
    expect(doc.confidence).toBe(0.9);
  });

  it('stays unreadable when the vision reader finds nothing', async () => {
    const doc = await readAttachment('attachments/email_512_BL.pdf', await bytesOf('email_512_BL.pdf'), {
      vision: async () => null,
    });
    expect(doc.readable).toBe(false);
    expect(doc.failure).toBe('no_text_layer');
  });
});

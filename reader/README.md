# @sdoc/reader — the document reading stage

Turns an attachment into text the rest of the pipeline can work with. Knows
nothing about shipping: no field names, no comparison logic. One function.

```ts
import { readAttachment } from '@sdoc/reader';

const doc = await readAttachment(path, bytes);
if (!doc.readable) {
  escalate(doc.failure, doc.readError);   // -> review_reason 'unreadable'
} else {
  extractFields(doc.text);                // label and value on the same line
}
```

## What it handles

| Format | How | In the dataset |
|---|---|---|
| `.txt` | decoded directly | 192 files |
| `.pdf` | text layer via `unpdf`, per page | 28 files |
| `.docx` | `mammoth` to HTML, then tables flattened | 8 files |
| `.xlsx` | `exceljs`, two-column rows become `label: value` | 22 files |

Tables are flattened so a label stays on the same line as its value, which is
what field extraction needs. Sheets and pages are also kept separately in
`doc.pages`.

## When it cannot read something

`readable: false` plus a `failure` code, never an exception:

| `failure` | Meaning |
|---|---|
| `empty_file` | 0 bytes |
| `corrupt_file` | parser rejected it |
| `no_text_layer` | parsed fine, but the page is an image (scan) |
| `wrong_extension` | the bytes disagree with the file extension |
| `unsupported_format` | no reader for this type |

## Scanned pages

Image-only PDFs are real in this dataset (`email_512`, `email_513`,
`email_514`). Rather than depend on an AI SDK, this package takes an injected
reader and calls it only when a document has no text layer:

```ts
const doc = await readAttachment(path, bytes, {
  vision: async ({ bytes, contentType }) => {
    const text = await askGeminiToTranscribe(bytes, contentType);
    return { text, confidence: 0.9 };
  },
});
// doc.method === 'vision', doc.confidence set
```

So the pipeline decides which model pays for it, and this package stays
dependency-light and testable.

## Commands

```bash
npm install
npm run coverage                                  # read all 250 attachments, report
npm run coverage -- --failures                    # just the ones that failed
npm run read -- attachments/email_004_SI.txt      # dump one document's text
npm run read -- attachments/email_005_SI.xlsx --json
npm test                                          # 8 tests against real files
```

The dataset is found automatically at `../data/bundle`, or set `SDOC_DATA_DIR`.

## Current coverage

242 of 250 attachments readable (96.8%). The 8 that are not: 2 corrupt PDFs
and 6 image-only pages, all correctly reported rather than silently empty.
Across readable documents, each of the 7 compared field labels appears in
98–100% of them, so extraction has something to work with.

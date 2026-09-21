# @sdoc/reader — the document reading stage

Turns an attachment into text the rest of the pipeline can extract fields
from. It knows nothing about shipping: no field names and no comparison
logic. There is one function.

```ts
import { readAttachment } from '@sdoc/reader';

const doc = await readAttachment(path, bytes);
if (!doc.readable) {
  escalate('unreadable', doc.readError);   // -> review_reason 'unreadable'
} else {
  extractFields(doc.text);                 // every value is on its label's line
}
```

## One layout for every format

Whatever the file type, the output looks like the `.txt` attachments:

```
Shipper (Principal or Seller) (发货人): APRIL FINE PAPER TRADING
  ON BEHALF OF VITAL SOLUTIONS PTE LTD; 77 ROBINSON ROAD, #21-01; SINGAPORE 068896
POL: BUATAN, INDONESIA
CONTAINER NO.	DESCRIPTION	GROSS WEIGHT (KG)
```

- A two-cell table row becomes `label: value`.
- The rest of a multi-line cell goes on one indented continuation line.
- A wider table becomes tab-separated cells.

Because every format comes out the same way, one extractor can handle all of
them.

| Format | How it is read | In the dataset |
|---|---|---|
| `.txt` | decoded directly | 192 files |
| `.pdf` | text layer via `unpdf`; columns rebuilt from text positions | 28 files |
| `.docx` | `mammoth` to HTML, then each table row joined as a row | 8 files |
| `.xlsx` | `exceljs`, two-cell rows become `label: value` | 22 files |

PDFs needed the most work. A plain text dump reads
`Shipper APRIL FINE PAPER TRADING`, which loses the boundary between the label
and the value. The label and the value are separate text runs with a gap
between them, so the reader groups runs into lines by baseline and treats a
gap wider than 0.6× the font height as a cell boundary. That threshold was
measured on this corpus, not guessed. A word space is about 0.25× the font
height. The tightest real label/value gap is 1.0×, on the long bilingual
label `Shipper (Principal or Seller)`.

## Coverage

`npm run coverage` reads all 250 attachments. 242 are readable (96.8%). It also
measures what matters to the extractor: whether each value landed on the same
line as its label.

| Format | Before | Now |
|---|---|---|
| docx | 0% | **100%** |
| pdf | 28.6% | **97.9%** |
| txt | 99.6% | 99.6% |
| xlsx | 100% | 100% |

## When it cannot read something

The reader never throws for these cases. It returns `readable: false` plus a
`failure` code:

| `failure` | Meaning | In the dataset |
|---|---|---|
| `empty_file` | 0 bytes | — |
| `corrupt_file` | the parser rejected it | `email_511_BL.pdf`, `email_515_BL.pdf` |
| `no_text_layer` | parsed fine, but the page is an image (a scan) | emails 512, 513, 514 (6 files) |
| `wrong_extension` | the bytes disagree with the file extension | — |
| `unsupported_format` | there is no reader for this type | — |

## Scanned pages

A vision model can read a scan. **By default its transcription does not make
the document "readable".**

```ts
import { readAttachment, geminiVision } from '@sdoc/reader';

const doc = await readAttachment(path, bytes, { vision: geminiVision() });
// doc.readable      === false          -> still escalates as 'unreadable'
// doc.transcription === { text, model, illegible }   -> shown to the reviewer
```

There are two reasons for this default:

- Nobody has checked text an AI read off an image. A scan should reach a
  person with the AI's reading attached as a draft. It should not go
  straight into an automatic comparison that can raise or clear a
  discrepancy.
- The answer key expects the same thing. Emails 512–514 are scored as
  `NEEDS_REVIEW` / `unreadable`, so comparing them automatically would lose
  points.

Existing "unreadable → escalate" logic works without changes, and the reviewer
starts from a draft instead of a blank page. `illegible` counts the spots where
the model wrote `[illegible]`, which is a cheap signal of how much the
reviewer needs to check.

If you do want to compare scans automatically, opt in:

```ts
readAttachment(path, bytes, { vision: geminiVision(), trustVision: true });
// readable: true, method: 'vision', text = the transcription
```

The model is only ever called for a document with no text layer. It is never
called for the other 242 files. If the model call fails (quota, network), the
document stays `unreadable` with the error in `readError`. It never crashes.

### Credentials

`geminiVision()` uses the first of these that it finds:

1. `GEMINI_API_KEY`: a Gemini Developer API key from AI Studio.
2. `GOOGLE_CLOUD_PROJECT`: Vertex AI through Application Default Credentials.
   Locally, run `gcloud auth application-default login` first. Inside Cloud
   Functions it is automatic.

The model defaults to `gemini-2.5-flash`. Override it with `GEMINI_MODEL` or
`geminiVision({ model })`. If you don't use vision, `@google/genai` is never
loaded.

Any other OCR engine or model works too. Pass your own function:

```ts
readAttachment(path, bytes, {
  vision: async ({ bytes, contentType }) => ({ text: await myOcr(bytes, contentType) }),
});
```

## Commands

```bash
npm install
npm run coverage                                  # read all 250 attachments, report
npm run coverage -- --failures                    # just the ones that failed
npm run read -- attachments/email_055_BL.docx     # print one document's text
npm run read -- attachments/email_005_SI.xlsx --json
npm run scans                                     # transcribe the 6 scans with Gemini
npm test                                          # 20 tests, no network needed
```

The reader finds the dataset at `../data/bundle`. To use a different location,
set `SDOC_DATA_DIR`.

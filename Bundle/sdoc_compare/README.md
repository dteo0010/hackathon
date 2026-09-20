# sdoc_compare — Person C: extract → normalise → compare

Pure functions. Text in, facts out. Never reads files, never decides the final status.

```
B: readDocument(file) -> text
        │
        ▼
C: extract_fields(text) -> DocumentExtraction      (doc_type + 7 FieldResult)
   compare(si, bl)      -> ComparisonResult        (mismatched / uncomparable facts)
        │
        ▼
D: assess(result) -> OK | MISMATCH | NEEDS_REVIEW(reason)
```

## Use

```python
from sdoc_compare.comparator import compare_text
r = compare_text(si_text, bl_text)          # use_llm=False to force pure rules
r.mismatched_fields    # ['consignee']       comparable and different  -> defect_fields
r.uncomparable_fields  # ['gross_weight_kg'] a side was blank/absent   -> D decides review
r.si_doc_type, r.bl_doc_type   # 'SI' | 'BL' | 'COMMERCIAL_INVOICE' | 'PACKING_LIST' | 'CERTIFICATE_OF_ORIGIN' | 'UNKNOWN'
r.to_dict()            # JSON for the UI: per field raw / value / evidence / decided_by / confidence
```

## Contract with B (text shapes the extractor understands)

| format | expected text |
|---|---|
| txt | file content as is |
| pdf | `pdftotext -layout` output (label, spaces, value on one line; tables aligned) |
| xlsx | one row per line, cells joined by TAB |
| docx | paragraphs, tables as `\| label \| value \|`; multi-line cells joined with ` ; ` |
| unreadable / empty / missing | `""` — every field comes back `found=False, reason="label_not_found"`, `doc_type="UNKNOWN"` |

Party values may be `NAME | ADDRESS` (xlsx) or `NAME ; ADDRESS` (docx) or `NAME\n  ADDRESS` (txt/pdf); only NAME is compared.

## Contract with D (what each FieldResult tells you)

| found | reason | meaning |
|---|---|---|
| True | — | usable value; branch on `decided_by` first: `rule` (trust_score 1.0) / `derived` (0.9, e.g. weight summed from container rows, evidence lists the rows) / `llm` (trust_score = model self-report, apply your own threshold). `trust_score` is a trust level, not a probability. |
| False | `blank` | label present, value is `N/A`, `TBA`, `???`, `____`, empty → **missing_value** |
| False | `label_not_found` | no such label anywhere; if all 7 are like this and `doc_type` is not SI/BL → **wrong_doc_type**; if text was empty → **unreadable** |
| False | `unparseable` | label and text present but no number/name could be read |
| False | `llm_not_grounded` | the model answered but its quoted evidence/value does not occur in the source text → rejected |

`compare` only compares when both sides `found`. `None == None` can never become a match.

## Where the AI is

Rules first: a synonym table of every label seen in real SI/BL layouts (`Port of Loading` / `Load Port` / `POL`, `Consignee (Non-Negotiable)` / `To the Order of`, bilingual `Notify (通知人)` ...). The LLM (`llm_fallback.py`, needs `ANTHROPIC_API_KEY`) is called **only** for fields whose label was never seen, returns `raw` + `evidence` + `confidence`, and its value goes through the same normaliser and the same deterministic comparison. A label that is present but blank is a missing value and is never sent to the model. Every LLM answer is grounded before acceptance: the quoted evidence and the raw value must literally occur in the source text, otherwise the field is reported as `found=False, reason="llm_not_grounded"`.

## Normalisation (formatting noise only, never a tolerance band)

- party: first line / before `|` or ` ; `, uppercase, punctuation stripped
- port: trailing `(XXXXX)` LOCODE removed (codes in the data are wrong on purpose, never used as truth), `X, X` → `X`
- container_count: leading integer of `6 x 40'HC`
- gross_weight_kg: thousands separators removed, `MT` × 1000, equality within 0.5 kg

## Dev

```
python -m sdoc_compare.test_compare                                 # unit + synthetic generalisation tests
python -m sdoc_compare.run_eval --data ./data --regress prev.json   # build, diff against previous build
python -m sdoc_compare.run_eval --data ./data --submit http://host:8080   # official scoreboard only
```
`run_eval` uses `dev_reader.py` as a stand-in for B and a placeholder classifier, writes `submission.json` + `comparison_detail.json`. Scoring goes only through the official `POST /submit` scoreboard (aggregate numbers). It never opens `ground_truth.json` and never diffs per email against labels. Generalisation is tested with our own synthetic cases in `test_compare.py` (unknown labels, blank header then populated summary, container table with extra columns, ungrounded LLM output), not with the organiser generator.

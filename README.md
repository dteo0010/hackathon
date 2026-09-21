# SI / BL document check

## What this project does

A shipping team's inbox gets many kinds of email. For each one we decide what kind it is.
When it's a request to check documents, we compare the Shipping Instruction (SI, the
reference) with the draft Bill of Lading (BL) on 7 fields and report any mismatch.
When the system can't decide safely (missing file, unreadable scan, wrong document,
blank value), it sends the email to a person instead of guessing.

The work is split into four tasks:

- **A, classify:** what kind of email is it?
- **B, extract:** read the SI and BL and pull out the 7 fields.
- **C, compare:** do the SI and BL values match?
- **D, reliability and human review (this part):** decide when to trust the result and
  when to ask a person, show the review screen, and make failures visible and retryable.

## Quick start

```powershell
npm install
npm test                                     # 97 tests
npm start                                    # review screen at http://localhost:3000
```

Run everything on the real data and write submission.json:

```powershell
node --no-deprecation src/cli.js --data data     # data = the unzipped participant bundle
```

Run with the organisers' server and get a score (add `--fresh` to reprocess everything):

```powershell
node --no-deprecation src/cli.js --data http://localhost:8080 --score --note "what I changed"
```

Check the "unreadable" thresholds against the real attachments:

```powershell
node --no-deprecation src/reliability/calibrate.js --data data
```

> On Windows PowerShell, don't pass options through `npm run ... -- --option`:
> PowerShell removes the `--` and npm swallows the options. Call `node` directly as above.
> (`npm run pipeline` with no options is fine.)

Open the review screen on real data:

```powershell
$env:PIPELINE_DATA="data"; $env:PIPELINE_DB="real-db.json"; npm start
```

Use the team's own classify/extract/compare instead of the baseline:

```powershell
$env:PIPELINE_STAGES="src/stages.js#stagesFor"; npm start
node --no-deprecation src/cli.js --data Bundle --stages src/stages.js#stagesFor
```

`src/stages.js` runs the team's Python code (task A `Bundle/classifier.py`, task C
`Bundle/sdoc_compare/`) through one long-lived Python process, `Bundle/bridge.py`.
Reading files stays in `readers.js`; scanned PDFs keep the baseline's OCR-tolerant
extract/compare. Needs Python 3.10+ on the PATH (`$env:PYTHON` to point elsewhere).

| Env var | Effect |
|---|---|
| `SDOC_CLASSIFIER` | `baseline` (default) or `team` (A's classifier.py). Default stays `baseline` until A's rules cover SI-request emails. |
| `SDOC_USE_LLM=0` | rules only, no API calls |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | turn on the LLM fallbacks in A and C |

On the bundle, team C (with the baseline classifier) gives exactly the same submission
as the baseline on all 520 emails; `test/stages.test.js` covers the bridge.

## Team notes (read this first)

**Who built what.** Task D is complete: everything in `src/reliability/` and `public/`,
plus the plumbing (`cli.js`, `server.js`, `models.js`, `inbox.js`). To test D on the real
emails it needed real classify/extract/compare output, so `src/baseline.js` and
`src/readers.js` are **placeholder versions of tasks A, B and C**. If you've built your
own, plug it in (below) and we keep whichever scores better.

**Current score** (organisers' self-evaluation, baseline A/B/C + D): 1.000 on every
metric, 46/46 defects, 20/20 review cases, no false alarms. The baseline was tuned on
this same dataset, so expect lower on a hidden test set.

**Plug in your own part.** Copy `src/stages.example.js` to `src/stages.js`, fill in the
function(s) you own (you can import the baseline ones for the rest), then run:

```powershell
node --no-deprecation src/cli.js --data http://localhost:8080 --stages src/stages.js#stagesFor --score --note "what changed"
```

The score is saved to `scores/` and shown on the Report page next to earlier runs.

**Traps in the data** (worth knowing even with your own code):

- Subjects are misleading, so classify on the email **body**. The 91 "please send the draft BL
  for checking" emails have no attachments but count as BL_COMPARISON.
- Many emails carry a security banner mentioning "links or attachments". It doesn't
  mean documents are attached.
- Some port defects change the city but keep the old UN code, e.g. MOMBASA (KEMBA) vs
  TUTICORIN (KEMBA). Compare city **and** code.
- Some SI PDFs are titled "BILL OF LADING INSTRUCTION". They're SIs.
- PDF container count and weight come from totals lines (or the container table).
- Edge cases: 3 scanned PDFs (OCR), 2 corrupt PDFs, 5 non-BL documents (invoice,
  packing list, certificate of origin), 5 missing attachments, 5 blank / "TBA" values.

**The answer key.** `sdoc-hackathon-docker.zip` contains `data_v2/ground_truth.json`.
Don't open it, and don't unzip it inside this repo. Only use the `/submit` score. Worth
confirming with the organisers that we were meant to receive that package.

## What each file does

### src/ - the pipeline

| File | In plain words |
|---|---|
| `models.js` | The shared "shape" of the data all four tasks pass around: the 7 field names, the categories, what a document result looks like. |
| `inbox.js` | Reads the emails and attachments, from the bundle folder or the organisers' server. Also sends submissions for scoring. |
| `readers.js` | Turns any attachment (txt, pdf, docx, xlsx) into text. Scanned PDFs are read with offline OCR. Corrupt files are reported as errors, never guessed. |
| `baseline.js` | Stand-in versions of tasks A, B and C that work on the real data. Teammates can replace them. |
| `stages.example.js` | A template for teammates: fill in classify / extract / compare here. |
| `loadStages.js` | Chooses which classify/extract/compare to use: demo, baseline, or the team's own file. |
| `cli.js` | `node src/cli.js` (or `npm run pipeline`). Processes the whole inbox, writes `submission.json`, checks its format, and optionally scores it. |
| `server.js` | `npm start`. The web server behind the review screen. |

### src/reliability/ - task D (our part)

| File | In plain words |
|---|---|
| `assess.js` | The "can we trust this?" gate. Returns OK, or needs review with a reason: missing attachment, unreadable, wrong document type, or missing value. A real mismatch is never escalated; that's a result, not a problem. Requests to *send* a BL are marked "waiting for documents". |
| `runner.js` | Runs each email through all steps. Retries temporary errors (like a timeout) 3 times, records failures with the exact step and error, and never lets one bad email stop the rest. |
| `store.js` | Saves every result, the review queue, every human decision, and a history of what happened to each email (one JSON file). |
| `review.js` | What a reviewer can do: confirm, correct values and recompare, or override the result (a note is required). |
| `report.js` | Builds the report ("No mismatch detected." / "Container count: SI 3 / BL 4") and the `submission.json` in the organisers' format, and checks it against their sample. |
| `scores.js` | Keeps every scoreboard from the organisers' server in `scores/`, so you can see if a change helped. |
| `calibrate.js` | `node src/reliability/calibrate.js`. Lists how readable every attachment is, worst first, so thresholds can be set on real data. |
| `demo.js` | 14 made-up emails covering every case, plus simple stages for them, for demos without the real data. |

### public/ - the review screen (plain HTML, CSS and JavaScript)

| File | In plain words |
|---|---|
| `index.html` | The page layout. |
| `styles.css` | How it looks. Mismatched rows are red, review cases amber. |
| `app.js` | The screen's behaviour: review queue, SI vs BL table, source documents, confirm/correct/override, retry button, report, score history. |

### test/ - automatic checks (`npm test`)

| File | What it checks |
|---|---|
| `assess.test.js` | Every escalation rule and its priority order. |
| `runner.test.js` | Retries, visible failures, the retry button, saving and reloading. |
| `review.test.js` | Reviewer actions, the report, the submission format. |
| `server.test.js` | The web API end to end. |
| `readers.test.js` | Reading txt, xlsx, docx, pdf (small files built during the test) and corrupt PDFs. |
| `baseline.test.js` | Label synonyms, number and port matching, OCR tolerance, classification. |
| `tools.test.js` | Waiting-for-documents, security banners, format check, score history, the CLI. |
| `helpers.js` | Shared fake emails and documents for the tests. |

### Created when you run things (not committed)

`pipeline-db.json` / `demo-db.json` (results and reviews), `submission.json`,
`calibration.csv`, `demo_data/`. The `scores/` folder (score history) is small and
worth committing so the team shares it.

## Decisions worth knowing

- **Only escalate on real evidence.** Escalating a genuine mismatch hides it from the
  headline score, so mismatches are reported, never escalated.
- **Scans are OCR'd, then confirmed by a person.** Below 90% OCR confidence, the email
  goes to review with the OCR'd values pre-filled, because OCR misreads single letters.
- **"Please send the draft BL" emails** are document-check emails with nothing to check
  yet. They show as "Waiting for documents" and are not escalated.
- **Security banners** ("be careful with attachments") are ignored when deciding
  whether an email says documents are attached.
- **Ports** must match on both the city and the UN code.
- **Storage is one JSON file**, since one Node process does everything and it avoids
  database installs on Windows. Run only one server against the same file.

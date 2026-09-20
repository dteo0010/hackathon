"""
Dev harness for Person C. Builds submission.json and scores it ONLY through the
official self-evaluation endpoint (POST /submit -> aggregate scoreboard). It never
opens ground_truth.json and never diffs per email against labels.

    python -m sdoc_compare.run_eval --data ./data                       # build only
    python -m sdoc_compare.run_eval --data ./data --submit http://host:8080
    python -m sdoc_compare.run_eval --data ./data --regress prev_submission.json

Placeholders (not C's deliverable):
  - classifier: 2 attachments => BL_COMPARISON, 1 => BL_COMPARISON, else GENERAL
  - assess():   mismatched -> MISMATCH, else OK       (D owns the real one)
  - dev_reader: stand-in for B
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from .comparator import compare
from .dev_reader import read_document
from .extractor import extract_fields


def build_submission(data: Path, use_llm: bool) -> tuple[dict, dict]:
    sample = json.loads((data / "sample_submission.json").read_text())
    sub, detail = {}, {}
    for eid in sample:
        e = json.loads((data / "inbox" / f"{eid}.json").read_text())
        rec = {"category": "GENERAL", "status": "OK", "review_reason": None,
               "defect_fields": [], "has_defect": False}
        atts = e.get("attachments", [])
        if len(atts) == 2:
            rec["category"] = "BL_COMPARISON"
            si_txt = read_document(str(data / atts[0]))
            bl_txt = read_document(str(data / atts[1]))
            res = compare(extract_fields(si_txt["text"], use_llm), extract_fields(bl_txt["text"], use_llm))
            detail[eid] = res.to_dict() | {"si_read": si_txt["method"], "bl_read": bl_txt["method"]}
            if res.mismatched_fields:
                rec.update(status="MISMATCH", has_defect=True, defect_fields=res.mismatched_fields)
        elif len(atts) == 1:
            rec["category"] = "BL_COMPARISON"
        sub[eid] = rec
    return sub, detail


def submit(url: str, sub: dict) -> dict:
    req = urllib.request.Request(url.rstrip("/") + "/submit", data=json.dumps(sub).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data", help="participant bundle folder")
    ap.add_argument("--submit", metavar="URL", help="official scoring server, e.g. http://host:8080")
    ap.add_argument("--regress", metavar="PREV.json", help="diff defect_fields against a previous submission")
    ap.add_argument("--no-llm", action="store_true")
    a = ap.parse_args()

    t0 = time.time()
    sub, detail = build_submission(Path(a.data), use_llm=not a.no_llm)
    Path("submission.json").write_text(json.dumps(sub, indent=2))
    Path("comparison_detail.json").write_text(json.dumps(detail, indent=2))
    n_mm = sum(1 for r in sub.values() if r["has_defect"])
    n_unc = sum(1 for d in detail.values() if d["uncomparable_fields"])
    print(f"built {len(sub)} records in {time.time()-t0:.1f}s | compared={len(detail)} "
          f"mismatch={n_mm} with-uncomparable-fields={n_unc}")

    if a.regress:
        prev = json.loads(Path(a.regress).read_text())
        changed = [e for e in sub if sorted(sub[e]["defect_fields"]) != sorted(prev.get(e, {}).get("defect_fields", []))]
        print(f"regression vs {a.regress}: {len(changed)} emails changed defect_fields")
        for e in changed[:20]:
            print(f"  {e}: {prev.get(e, {}).get('defect_fields')} -> {sub[e]['defect_fields']}")

    if a.submit:
        s = submit(a.submit, sub)
        s3 = s.get("stage3", {})
        print(f"stage3 defect  P={s3.get('defect_precision', 0):.3f} R={s3.get('defect_recall', 0):.3f} "
              f"F1={s3.get('defect_f1', 0):.3f}")
        print(f"final_score    {s.get('final_score', 0):.3f}  (stage-1 is a placeholder here)")


if __name__ == "__main__":
    main()

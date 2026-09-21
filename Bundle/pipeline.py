"""
End-to-end glue:  email record -> classify -> (BL_COMPARISON) read -> extract -> compare -> assess

    python -m sdoc_compare.pipeline --data ./data                       # build submission.json
    python -m sdoc_compare.pipeline --data ./data --submit http://host:8080
    python -m sdoc_compare.pipeline --data ./data --no-llm

Replaces the placeholder classifier in run_eval.py. `assess()` below is a minimal
stand-in for D's real one; swap it out when that lands.

Outputs
  submission.json         {email_id: {category, status, review_reason, has_defect,
                                      defect_fields, decided_by}}   (scoring shape)
  comparison_detail.json  per email: classification (with the signals that decided it),
                          the human-readable report line, and for NEEDS_REVIEW the
                          evidence a reviewer needs (reason, fields, source lines)
"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Callable

from .classifier import Classification, classify_email
from .comparator import compare
from .extractor import extract_fields
from .models import ComparisonResult, DocumentExtraction

OTHER_DOCS = {"COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"}


def _fmt(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return f"{v:,.0f}"
    return str(v)


def report_line(res: ComparisonResult) -> str:
    """'No mismatch detected.' or 'container_count - SI: 3 / BL: 4' per mismatched field."""
    if not res.mismatched_fields:
        return "No mismatch detected."
    by = {f.field: f for f in res.fields}
    return "; ".join(f"{n} - SI: {_fmt(by[n].si.value)} / BL: {_fmt(by[n].bl.value)}"
                     for n in res.mismatched_fields)


def _wrong_doc(x: DocumentExtraction, text: str) -> bool:
    if x.doc_type in OTHER_DOCS:
        return True
    # README contract: nothing recognisable at all and not typed as SI/BL -> wrong document
    return (x.doc_type not in ("SI", "BL") and bool(text.strip())
            and all(f.reason == "label_not_found" for f in x.fields.values()))


def assess(res: ComparisonResult, si_x: DocumentExtraction, bl_x: DocumentExtraction,
           si_text: str, bl_text: str) -> tuple[str, str | None]:
    """(status, review_reason). Order matters: a definite mismatch is reported even if
    other fields are blank; blanks only escalate when nothing else was found."""
    if _wrong_doc(si_x, si_text) or _wrong_doc(bl_x, bl_text):
        return "NEEDS_REVIEW", "wrong_doc_type"
    if res.mismatched_fields:
        return "MISMATCH", None
    if res.uncomparable_fields:
        return "NEEDS_REVIEW", "missing_value"
    return "OK", None


def process_email(email: dict, data: Path, use_llm: bool = True,
                  reader: Callable[[str], dict] | None = None) -> tuple[dict, dict]:
    if reader is None:
        from .dev_reader import read_document as reader     # swap for B's reader

    def peek(rel: str) -> str:
        return (reader(str(data / rel)) or {}).get("text", "")[:1500]

    cls: Classification = classify_email(email, use_llm=use_llm, peek=peek)
    rec = cls.to_record()
    detail: dict = {"email_id": cls.email_id, "subject": email.get("subject"),
                    "classification": cls.to_dict()}
    if cls.category != "BL_COMPARISON":
        return rec, detail

    if cls.review_hint == "missing_attachment":
        detail["report"] = "Cannot compare: SI/BL attachment pair is incomplete."
        detail["review"] = {"reason": "missing_attachment", "attachments": cls.attachment_roles}
        return rec, detail

    si_r, bl_r = reader(str(data / cls.si_path)), reader(str(data / cls.bl_path))
    si_text, bl_text = si_r.get("text", ""), bl_r.get("text", "")
    detail["si_read"], detail["bl_read"] = si_r.get("method"), bl_r.get("method")
    if not (si_r.get("ok") and bl_r.get("ok")):
        rec.update(status="NEEDS_REVIEW", review_reason="unreadable")
        detail["report"] = "Cannot compare: a document is unreadable (empty, corrupt or image-only)."
        detail["review"] = {"reason": "unreadable", "si_read": si_r.get("method"),
                            "bl_read": bl_r.get("method")}
        return rec, detail

    si_x, bl_x = extract_fields(si_text, use_llm), extract_fields(bl_text, use_llm)
    res = compare(si_x, bl_x)
    status, reason = assess(res, si_x, bl_x, si_text, bl_text)
    rec.update(status=status, review_reason=reason)
    if status == "MISMATCH":
        rec.update(has_defect=True, defect_fields=res.mismatched_fields)

    detail["comparison"] = res.to_dict()
    detail["report"] = report_line(res) if status in ("OK", "MISMATCH") else f"Needs review: {reason}"
    if status == "NEEDS_REVIEW":
        detail["review"] = {
            "reason": reason, "si_doc_type": res.si_doc_type, "bl_doc_type": res.bl_doc_type,
            "uncomparable_fields": res.uncomparable_fields,
            "evidence": {f.field: {"si": f.si.evidence, "bl": f.bl.evidence}
                         for f in res.fields if not f.comparable},
        }
    return rec, detail


def build_submission(data: Path, use_llm: bool) -> tuple[dict, dict]:
    sub, detail = {}, {}
    for p in sorted((data / "inbox").glob("email_*.json")):
        email = json.loads(p.read_text())
        eid = email.get("email_id", p.stem)
        try:
            sub[eid], detail[eid] = process_email(email, data, use_llm)
        except Exception as e:                      # visible failure, never a silent drop
            sub[eid] = {"category": "GENERAL", "status": "NEEDS_REVIEW", "review_reason": "unreadable",
                        "has_defect": False, "defect_fields": [], "decided_by": "default"}
            detail[eid] = {"email_id": eid, "error": f"{type(e).__name__}: {e}"}
    return sub, detail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data")
    ap.add_argument("--submit", metavar="URL")
    ap.add_argument("--no-llm", action="store_true")
    a = ap.parse_args()

    t0 = time.time()
    sub, detail = build_submission(Path(a.data), use_llm=not a.no_llm)
    Path("submission.json").write_text(json.dumps(sub, indent=2))
    Path("comparison_detail.json").write_text(json.dumps(detail, indent=2))
    cats = Counter(r["category"] for r in sub.values())
    stat = Counter(r["status"] for r in sub.values() if r["category"] == "BL_COMPARISON")
    by = Counter(r["decided_by"] for r in sub.values())
    errs = sum(1 for d in detail.values() if "error" in d)
    print(f"built {len(sub)} records in {time.time()-t0:.1f}s | categories={dict(cats)}")
    print(f"comparison statuses={dict(stat)} | decided_by={dict(by)} | processing errors={errs}")

    if a.submit:
        from .run_eval import submit
        s = submit(a.submit, sub)
        s1, s3 = s.get("stage1", {}), s.get("stage3", {})
        print(f"stage1 acc={s1.get('accuracy', 0):.3f} macroF1={s1.get('macro_f1', 0):.3f}")
        print(f"stage3 defect P={s3.get('defect_precision', 0):.3f} R={s3.get('defect_recall', 0):.3f}")
        print(f"final_score {s.get('final_score', 0):.3f}")


if __name__ == "__main__":
    main()

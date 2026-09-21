"""
bridge.py - lets the Node pipeline (src/stages.js) call the team's Python stages.

    python bridge.py        (started by src/stages.js; one long-lived process)

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
    -> {"id": 1, "op": "classify", "email": {...}}
    <- {"id": 1, "ok": true, "result": {...}}      or   {"id": 1, "ok": false, "error": "..."}

Ops
    classify  A: classifier.classify_email(email)            -> Classification.to_dict()
    extract   C: sdoc_compare.extract_fields(text)           -> doc_type + 7 fields
    compare   C: sdoc_compare.compare(extract(si), extract(bl)) -> per-field match

Text reading stays in Node (readers.js, task B): this process never opens files.
Nothing but protocol lines is written to stdout; logs go to stderr.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classifier import classify_email                      # noqa: E402  (A)
from sdoc_compare.comparator import compare                # noqa: E402  (C)
from sdoc_compare.extractor import extract_fields          # noqa: E402  (C)

USE_LLM = os.environ.get("SDOC_USE_LLM", "1") != "0"
_cache: dict[str, object] = {}


def _extract(text: str):
    key = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    if key not in _cache:                     # extract once per text, even if LLM is used
        _cache[key] = extract_fields(text, use_llm=USE_LLM)
    return _cache[key]


def _num(v):
    return v if v is None or isinstance(v, (int, str)) else (int(v) if float(v).is_integer() else v)


def op_classify(msg):
    return classify_email(msg["email"], use_llm=USE_LLM).to_dict()


def op_extract(msg):
    x = _extract(msg.get("text") or "")
    return {
        "doc_type": x.doc_type,
        "fields": {
            f: {
                "value": r.raw if r.found else None,      # null for blanks; see "raw" below
                "normalized": _num(r.value) if r.found else None,
                "confidence": r.trust_score,
                "evidence": r.evidence,
                "decided_by": r.decided_by,
                "reason": r.reason,
                "raw": r.raw,                              # blanks keep "TBA" / "____MT" for reviewers
            }
            for f, r in x.fields.items()
        },
    }


def op_compare(msg):
    res = compare(_extract(msg.get("si_text") or ""), _extract(msg.get("bl_text") or ""))
    return {
        "fields": [
            {"field": c.field, "comparable": c.comparable,
             "match": bool(c.match) if c.comparable else False,
             "siValue": c.si.raw if c.si.found else None,
             "blValue": c.bl.raw if c.bl.found else None}
            for c in res.fields
        ],
        "mismatched": res.mismatched_fields,
        "uncomparable": res.uncomparable_fields,
    }


OPS = {"classify": op_classify, "extract": op_extract, "compare": op_compare, "ping": lambda m: "pong"}


def main(out):
    for line in sys.stdin:
        if not line.strip():
            continue
        mid = None
        try:
            msg = json.loads(line)
            mid = msg.get("id")
            reply = {"id": mid, "ok": True, "result": OPS[msg["op"]](msg)}
        except Exception as e:                    # report, never crash the bridge
            reply = {"id": mid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    # stdout is the protocol channel: keep it for replies, send any stray print() to stderr
    sys.stdin.reconfigure(encoding="utf-8")
    proto = open(sys.stdout.fileno(), "w", encoding="utf-8", closefd=False)
    sys.stdout = sys.stderr
    main(proto)

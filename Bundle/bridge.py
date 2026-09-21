"""
bridge.py - lets the Node pipeline (src/stages.js) call the team's Python stages.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.

Ops:
classify  -> Task A classifier
extract   -> Task C extraction
compare   -> Task C deterministic comparison

Text reading stays in Node (readers.js / Task B).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
from pathlib import Path

# Node (src/env.js) already loads .env and passes it down. python-dotenv is only
# a convenience for running this file on its own, so it is optional.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except ImportError:
    pass

# Allow imports from Bundle/
sys.path.insert(0, str(Path(__file__).resolve().parent))

from classifier import classify_email  # noqa: E402
from sdoc_compare.comparator import compare  # noqa: E402
from sdoc_compare.extractor import extract_fields  # noqa: E402
from sdoc_compare import normalizer as N  # noqa: E402
from sdoc_compare.models import FIELDS, DocumentExtraction, FieldResult  # noqa: E402


# LLM fallbacks on by default; they only run when a key is set. SDOC_USE_LLM=0 turns them off.
USE_LLM = os.environ.get("SDOC_USE_LLM", "1") != "0"

_cache: dict[str, object] = {}


def _extract(text: str):
    key = hashlib.sha1(
        text.encode("utf-8", "replace")
    ).hexdigest()

    if key not in _cache:
        _cache[key] = extract_fields(
            text,
            use_llm=USE_LLM,
        )

    return _cache[key]


def _num(v):
    if v is None or isinstance(v, (int, str)):
        return v

    try:
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return v


def op_classify(msg):
    return classify_email(
        msg["email"],
        use_llm=USE_LLM,
    ).to_dict()


def op_extract(msg):
    x = _extract(msg.get("text") or "")

    return {
        "doc_type": x.doc_type,
        "fields": {
            f: {
                # Normal application value.
                # Blank/TBA remains null so D can review it.
                "value": (str(_num(r.value)) if r.decided_by == "derived" else r.raw) if r.found else None,

                # Deterministic normalized comparison value.
                "normalized": _num(r.value) if r.found else None,

                "confidence": r.trust_score,
                "evidence": r.evidence,
                "decided_by": r.decided_by,
                "reason": r.reason,

                # Keep original text for human review.
                "raw": r.raw,
            }
            for f, r in x.fields.items()
        },
    }


def op_compare(msg):
    si = _extract(msg.get("si_text") or "")
    bl = _extract(msg.get("bl_text") or "")

    res = compare(si, bl)

    return {
        "fields": [
            {
                "field": c.field,
                "comparable": c.comparable,
                "match": bool(c.match) if c.comparable else False,
                "siValue": c.si.raw if c.si.found else None,
                "blValue": c.bl.raw if c.bl.found else None,
            }
            for c in res.fields
        ],
        "mismatched": res.mismatched_fields,
        "uncomparable": res.uncomparable_fields,
    }


def _from_values(values: dict) -> DocumentExtraction:
    """Rebuild an extraction from plain field values, e.g. after a reviewer corrected one."""
    fields = {}
    for f in FIELDS:
        raw = values.get(f)
        fr = FieldResult(field=f, raw=None if raw is None else str(raw))
        if raw is None:
            fr.reason = "label_not_found"
        elif N.is_blank(str(raw)):
            fr.reason = "blank"
        else:
            v = N.normalize(f, str(raw))
            if v is None or v == "":
                fr.reason = "unparseable"
            else:
                fr.value, fr.found = v, True
        fields[f] = fr
    return DocumentExtraction(doc_type="UNKNOWN", fields=fields)


def op_compare_values(msg):
    res = compare(_from_values(msg.get("si") or {}), _from_values(msg.get("bl") or {}))
    return {
        "fields": [
            {
                "field": c.field,
                "comparable": c.comparable,
                "match": bool(c.match) if c.comparable else False,
                "siValue": c.si.raw,
                "blValue": c.bl.raw,
            }
            for c in res.fields
        ],
        "mismatched": res.mismatched_fields,
        "uncomparable": res.uncomparable_fields,
    }


OPS = {
    "classify": op_classify,
    "extract": op_extract,
    "compare": op_compare,
    "compare_values": op_compare_values,
    "ping": lambda msg: "pong",
}


def main(out):
    for line in sys.stdin:
        if not line.strip():
            continue

        mid = None

        try:
            msg = json.loads(line)
            mid = msg.get("id")

            op = msg.get("op")

            if op not in OPS:
                raise ValueError(f"Unknown bridge op: {op!r}")

            reply = {
                "id": mid,
                "ok": True,
                "result": OPS[op](msg),
            }

        except Exception as exc:
            # Full details go to stderr, never corrupt stdout protocol.
            traceback.print_exc(file=sys.stderr)

            reply = {
                "id": mid,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

        out.write(
            json.dumps(
                reply,
                ensure_ascii=False,
            )
            + "\n"
        )
        out.flush()


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")

    # Keep fd 1 exclusively for JSON protocol replies.
    proto = open(
        sys.stdout.fileno(),
        "w",
        encoding="utf-8",
        closefd=False,
    )

    # Any accidental print() from imported Python code goes to stderr.
    sys.stdout = sys.stderr

    main(proto)
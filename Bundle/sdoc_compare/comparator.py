"""
compare(si, bl) -> ComparisonResult

Deterministic. Compares normalised values only when BOTH sides were found.
Never decides NEEDS_REVIEW - that is D's call, using:
  - uncomparable_fields   (a side was blank / not found)
  - si_doc_type / bl_doc_type   (wrong document attached)
  - per-field decided_by / confidence
"""
from __future__ import annotations

import re
from typing import Optional

from .models import FIELDS, ComparisonResult, DocumentExtraction, FieldComparison
from .normalizer import values_equal

_SAME_AS_CONSIGNEE = "SAME AS CONSIGNEE"
_LOCODE = re.compile(r"\(\s*([A-Z]{2}[A-Z0-9]{3})\s*\)\s*$")


def _locode(raw: Optional[str]) -> Optional[str]:
    m = _LOCODE.search((raw or "").strip().upper())
    return m.group(1) if m else None


def _notify_value(doc: DocumentExtraction):
    """'SAME AS CONSIGNEE' on the notify line means the consignee."""
    n, c = doc.fields["notify_party"], doc.fields["consignee"]
    if n.found and n.value == _SAME_AS_CONSIGNEE and c.found:
        return c.value
    return n.value


def _match(f: str, si: DocumentExtraction, bl: DocumentExtraction) -> bool:
    s, b = si.fields[f], bl.fields[f]
    if f == "notify_party":
        if values_equal(f, s.value, b.value):        # identical text always matches
            return True
        return values_equal(f, _notify_value(si), _notify_value(bl))
    if f in ("port_of_loading", "port_of_discharge"):
        # Team rule: the city must match; when BOTH sides carry a UN/LOCODE it must
        # match too. The code alone is never trusted (a changed city can keep the old code).
        cs, cb = _locode(s.raw), _locode(b.raw)
        if cs and cb and cs != cb:
            return False
    return values_equal(f, s.value, b.value)


def compare(si: DocumentExtraction, bl: DocumentExtraction) -> ComparisonResult:
    rows: list[FieldComparison] = []
    mismatched: list[str] = []
    uncomparable: list[str] = []
    for f in FIELDS:
        s, b = si.fields[f], bl.fields[f]
        comparable = s.found and b.found
        match = _match(f, si, bl) if comparable else None
        rows.append(FieldComparison(field=f, comparable=comparable, match=match, si=s, bl=b))
        if not comparable:
            uncomparable.append(f)
        elif not match:
            mismatched.append(f)
    return ComparisonResult(
        si_doc_type=si.doc_type,
        bl_doc_type=bl.doc_type,
        fields=rows,
        mismatched_fields=mismatched,
        uncomparable_fields=uncomparable,
    )


def compare_text(si_text: str, bl_text: str, use_llm: bool = True) -> ComparisonResult:
    """Convenience: plain text in, comparison facts out."""
    from .extractor import extract_fields
    return compare(extract_fields(si_text, use_llm=use_llm), extract_fields(bl_text, use_llm=use_llm))

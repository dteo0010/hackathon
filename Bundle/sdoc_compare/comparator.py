"""
compare(si, bl) -> ComparisonResult

Deterministic. Compares normalised values only when BOTH sides were found.
Never decides NEEDS_REVIEW - that is D's call, using:
  - uncomparable_fields   (a side was blank / not found)
  - si_doc_type / bl_doc_type   (wrong document attached)
  - per-field decided_by / confidence
"""
from __future__ import annotations

from .models import FIELDS, ComparisonResult, DocumentExtraction, FieldComparison
from .normalizer import values_equal


def compare(si: DocumentExtraction, bl: DocumentExtraction) -> ComparisonResult:
    rows: list[FieldComparison] = []
    mismatched: list[str] = []
    uncomparable: list[str] = []
    for f in FIELDS:
        s, b = si.fields[f], bl.fields[f]
        comparable = s.found and b.found
        match = values_equal(f, s.value, b.value) if comparable else None
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

"""
Data contracts for the extract -> normalise -> compare module (Person C).

Boundary:
  input  : plain text of ONE document (B turns files into text)
  output : facts only. Never a final status - D decides OK / MISMATCH / NEEDS_REVIEW.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional

FIELDS = [
    "shipper",
    "consignee",
    "notify_party",
    "port_of_loading",
    "port_of_discharge",
    "container_count",
    "gross_weight_kg",
]

DOC_TYPES = ["SI", "BL", "COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN", "UNKNOWN"]


@dataclass
class FieldResult:
    field: str
    raw: Optional[str] = None          # exactly as it appeared in the document
    value: Any = None                  # normalised value used for comparison
    found: bool = False                # True only if a usable value was obtained
    evidence: Optional[str] = None     # the source line(s) the value came from
    decided_by: str = "rule"           # "rule" | "derived" | "llm"
    trust_score: Optional[float] = None # NOT a probability. rule=1.0, derived=0.9 are fixed trust levels;
                                       # llm = model self-reported. D should branch on decided_by first.
    reason: Optional[str] = None       # why not found: "label_not_found" | "blank" | "unparseable"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DocumentExtraction:
    doc_type: str                                   # one of DOC_TYPES
    fields: dict[str, FieldResult] = field(default_factory=dict)
    text_length: int = 0

    def to_dict(self) -> dict:
        return {
            "doc_type": self.doc_type,
            "text_length": self.text_length,
            "fields": {k: v.to_dict() for k, v in self.fields.items()},
        }


@dataclass
class FieldComparison:
    field: str
    comparable: bool                 # both sides found
    match: Optional[bool]            # None when not comparable
    si: FieldResult
    bl: FieldResult

    def to_dict(self) -> dict:
        return {
            "field": self.field,
            "comparable": self.comparable,
            "match": self.match,
            "si": self.si.to_dict(),
            "bl": self.bl.to_dict(),
        }


@dataclass
class ComparisonResult:
    si_doc_type: str
    bl_doc_type: str
    fields: list[FieldComparison]
    mismatched_fields: list[str]     # comparable and different
    uncomparable_fields: list[str]   # at least one side not found

    def to_dict(self) -> dict:
        return {
            "si_doc_type": self.si_doc_type,
            "bl_doc_type": self.bl_doc_type,
            "mismatched_fields": self.mismatched_fields,
            "uncomparable_fields": self.uncomparable_fields,
            "fields": [f.to_dict() for f in self.fields],
        }

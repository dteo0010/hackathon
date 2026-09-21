"""
extract_fields(text) -> DocumentExtraction

Input is PLAIN TEXT of one document, as produced by B's readDocument():
  .txt  -> file content
  .pdf  -> `pdftotext -layout` style (label, 2+ spaces, value; tables kept aligned)
  .xlsx -> one row per line, cells separated by TAB
  .docx -> paragraphs, tables as markdown rows `| label | value |`

Strategy (rules first, AI as fallback):
  1. label table   - known label synonyms, longest-prefix match per line   decided_by="rule"
  2. derived       - gross weight / count summed from a container table   decided_by="derived"
  3. llm fallback  - only for fields whose LABEL was never seen            decided_by="llm"
     (a label that IS present but blank is a missing value, not an
      extraction failure - it is reported as found=False, reason="blank"
      and NOT sent to the LLM)
"""
from __future__ import annotations

import re
from typing import Optional

from .models import FIELDS, DocumentExtraction, FieldResult
from . import llm_fallback
from . import normalizer as N

# label table
# All lowercase, ASCII only (non-ASCII such as Chinese is stripped before matching).
LABELS: dict[str, list[str]] = {
    "shipper": [
        "shipper", "shipper (principal or seller)", "shipper/exporter", "shipper / exporter",
        "exporter", "shipper name", "shipper/exporter (complete name and address)",
    ],
    "consignee": [
        "consignee", "consignee (non-negotiable)", "consignee (non negotiable)",
        "to the order of", "to order of", "consigned to", "consignee name",
    ],
    "notify_party": [
        "notify", "notify party", "notify party/intermediate consignee",
        "notify party / intermediate consignee", "notify address", "also notify",
    ],
    "port_of_loading": [
        "port of loading", "port of loading (pol)", "pol", "load port", "loading port",
        "port of receipt/loading", "port of load",
    ],
    "port_of_discharge": [
        "port of discharge", "port of discharge (pod)", "pod", "discharge port",
        "discharging port", "port of unloading", "port of discharging",
    ],
    "container_count": [
        "no. of containers", "no of containers", "number of containers",
        "no. of containers or packages", "no of containers or packages",
        "total containers", "container count", "containers", "total no. of containers",
        "qty of containers", "container qty",
    ],
    "gross_weight_kg": [
        "gross weight", "gross weight (kg)", "gross weight (kgs)", "gross wt (kgs)",
        "gross wt (kg)", "gross wt", "g.w.", "gw", "total gross weight",
        "total gross weight (kg)", "total gross weight (kgs)", "total gross wt (kgs)",
        "total gross wt", "gross weight kgs", "gross weight kg",
    ],
}

# Labels that must never be confused with the ones above (checked first, then ignored).
NEGATIVE_LABELS = ["net weight", "net wt", "n.w.", "nw", "tare weight", "volume", "measurement"]

DOC_TYPE_PATTERNS = [
    ("COMMERCIAL_INVOICE", r"commercial\s+invoice"),
    ("PACKING_LIST", r"packing\s+list"),
    ("CERTIFICATE_OF_ORIGIN", r"certificate\s+of\s+origin"),
    ("SI", r"shipping\s+instruction|bill\s+of\s+lading\s+instruction|bl\s+instruction|b/l\s+instruction|\bs\.?i\.?\b"),
    ("BL", r"bill\s+of\s+lading|\bb/l\b|draft\s+bl\b"),
]


def _norm_label(s: str) -> str:
    s = re.sub(r"[^\x20-\x7e]", "", s)          # Chinese, '■', etc.
    s = s.lower()
    s = re.sub(r"\(\s*\)", "", s)               # parentheses emptied by the strip above
    s = re.sub(r"\s+", " ", s).strip(" :\t-")
    return s


def _build_index() -> list[tuple[str, str]]:
    """[(normalised_label, field)] sorted longest label first for prefix matching."""
    idx = []
    for field, labels in LABELS.items():
        for lab in labels:
            idx.append((_norm_label(lab), field))
    idx.sort(key=lambda t: -len(t[0]))
    return idx


_INDEX = _build_index()
_NEG = sorted((_norm_label(l) for l in NEGATIVE_LABELS), key=len, reverse=True)

def _label_regex(label: str) -> re.Pattern:
    """'gross weight (kgs)' -> matches 'Gross Weight(KGS)', 'GROSS  WEIGHT (kgs)', ..."""
    parts = re.split(r"(\s+|\(|\)|/)", label)
    pat = ""
    for t in parts:
        if not t:
            continue
        if t.isspace():
            pat += r"\s*"
        elif t in "()/":
            pat += r"\s*" + re.escape(t) + r"\s*"
        else:
            pat += re.escape(t)
    # optional emptied '( )' left by stripping non-ASCII (中文), then a separator
    return re.compile(r"^\s*" + pat + r"\s*(?:\(\s*\))?\s*(?::|\t|\||\s{2,}|\s|$)(?P<value>.*)$", re.I)


_LABEL_RX: list[tuple[re.Pattern, str, str]] = [(_label_regex(lab), f, lab) for lab, f in _INDEX]
_NEG_RX: list[re.Pattern] = [_label_regex(l) for l in _NEG]


def _split_label_value(line: str) -> Optional[tuple[str, str, str]]:
    """
    Return (field, raw_value, matched_label) if the line starts with a known label.
    Handles: 'Label: value' | 'Label<TAB>value' | 'Label      value' (pdf) |
             '| Label | value |' (docx table) | 'Label(中文): value'
    """
    s = line.rstrip()
    if not s.strip():
        return None
    if s.lstrip().startswith("|"):                       # markdown table row
        cells = [c.strip() for c in s.strip().strip("|").split("|")]
        if len(cells) < 2:
            return None
        s = cells[0] + ": " + " | ".join(cells[1:])      # keep 'NAME | ADDRESS' shape
    if "\t" in s:                                         # xlsx row
        parts = s.split("\t")
        s = parts[0] + ": " + "\t".join(parts[1:]).strip()
    stripped = re.sub(r"[^\x20-\x7e]", "", s)
    for rx in _NEG_RX:
        if rx.match(stripped):
            return None
    for rx, field, label in _LABEL_RX:
        m = rx.match(stripped)
        if m:
            raw = re.sub(r"^[:\s|]+", "", m.group("value")).strip()
            return field, raw, label
    return None


# container tables

_CONTAINER_ID = re.compile(r"^\s*([A-Z]{4}\s?\d{6,7})\b")
_NUM_TOKEN = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?")
_GW_HEADER = re.compile(r"gross\s*w(?:eigh)?t", re.I)


def _container_rows(lines: list[str]) -> list[tuple[str, float, str]]:
    """
    Rows under a header that has a CONTAINER column and a GROSS WEIGHT column,
    e.g. 'GSLB0479748   40'HC ...   21,887'  -> (container_no, weight, line).
    The weight is the numeric token whose position is closest to the GROSS WEIGHT
    header column, so a trailing PACKAGES / CBM column is not mistaken for it.
    """
    rows, gw_col, gw_idx, n_cols = [], None, None, None
    for ln in lines:
        low = ln.lower()
        m_h = _GW_HEADER.search(ln)
        if "container" in low and m_h and ("no" in low or "number" in low or "|" in ln):
            gw_col = m_h.start()
            cells = _cells(ln)
            n_cols = len(cells)
            gw_idx = next((i for i, c in enumerate(cells) if _GW_HEADER.search(c)), None)
            continue
        if gw_col is None:
            continue
        m = _CONTAINER_ID.match(ln)
        if not m:
            continue
        tok = None
        cells = _cells(ln)
        if gw_idx is not None and len(cells) == n_cols:
            tok = _NUM_TOKEN.search(cells[gw_idx])
        if tok is None:
            nums = [(abs(t.start() - gw_col), t) for t in _NUM_TOKEN.finditer(ln, m.end())]
            if not nums:
                continue
            _, tok = min(nums, key=lambda x: x[0])
        rows.append((m.group(1), float(tok.group(1).replace(",", "")), ln.strip()))
    return rows


def _cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        return [c.strip() for c in s.strip("|").split("|")]
    return [c for c in re.split(r"\t|\s{2,}", s) if c]


# doc type

def detect_doc_type(text: str) -> str:
    head = "\n".join([l for l in text.splitlines() if l.strip()][:6]).lower()
    # explicit disclaimers in edge-case docs win
    for dt, pat in DOC_TYPE_PATTERNS[:3]:
        if re.search(pat, head):
            return dt
    if re.search(r"instruction", head):
        return "SI"
    for dt, pat in DOC_TYPE_PATTERNS[3:]:
        if re.search(pat, head):
            return dt
    return "UNKNOWN"


# main

def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _grounded(snippet: Optional[str], text: str) -> bool:
    """True if the snippet appears in the source text (ignoring case/spacing/punctuation)."""
    if not snippet:
        return False
    sq = _squash(snippet)
    return len(sq) >= 3 and sq in _squash(text)


def extract_fields(text: str, use_llm: bool = True) -> DocumentExtraction:
    text = text or ""
    lines = text.splitlines()
    out = DocumentExtraction(doc_type=detect_doc_type(text), text_length=len(text.strip()))
    results: dict[str, FieldResult] = {f: FieldResult(field=f, reason="label_not_found") for f in FIELDS}

    # 1. rule pass: first occurrence of each label wins
    for i, line in enumerate(lines):
        hit = _split_label_value(line)
        if not hit:
            continue
        field, raw, label = hit
        fr = results[field]
        if fr.found:
            continue                                    # first usable value wins
        if fr.reason == "blank" and N.is_blank(raw):
            continue                                    # keep the first blank evidence
        # party names that wrap: pdf puts the name on the label line, address below.
        # Some layouts put the label alone and the name on the NEXT line.
        if raw == "" and field in ("shipper", "consignee", "notify_party"):
            for nxt in lines[i + 1:i + 3]:
                if nxt.strip() and not _split_label_value(nxt):
                    raw = nxt.strip()
                    line = line.rstrip() + " / " + nxt.strip()
                    break
        fr.raw = raw
        fr.evidence = line.strip()
        if N.is_blank(raw):
            fr.found, fr.reason = False, "blank"
            continue
        val = N.normalize(field, raw)
        if val is None or val == "":
            fr.found, fr.reason = False, "unparseable"
            continue
        fr.value, fr.found, fr.decided_by, fr.trust_score, fr.reason = val, True, "rule", 1.0, None

    # 2. derived from a container table (pdf BL layouts often leave the total blank)
    rows = _container_rows(lines)
    if rows:
        gw = results["gross_weight_kg"]
        if not gw.found:
            total = sum(w for _, w, _ in rows)
            gw.value, gw.found, gw.decided_by, gw.trust_score, gw.reason = total, True, "derived", 0.9, None
            gw.raw = " + ".join(f"{w:,.0f}" for _, w, _ in rows)
            gw.evidence = f"sum of {len(rows)} container rows: " + gw.raw
        cc = results["container_count"]
        if not cc.found:
            cc.value, cc.found, cc.decided_by, cc.trust_score, cc.reason = len(rows), True, "derived", 0.9, None
            cc.raw = str(len(rows))
            cc.evidence = f"{len(rows)} container rows: " + ", ".join(c for c, _, _ in rows)

    # 3. LLM fallback for fields whose label was never seen
    missing = [f for f, r in results.items() if not r.found and r.reason == "label_not_found"]
    if use_llm and missing and out.text_length > 0:
        try:
            llm = llm_fallback.llm_extract(text, missing)
        except Exception:      # no key / no network / bad response -> stay with rules
            llm = {}
        for f, hit in (llm or {}).items():
            if f not in results or results[f].found:
                continue
            raw = hit.get("raw")
            fr = results[f]
            fr.decided_by, fr.trust_score = "llm", hit.get("confidence")
            fr.evidence = hit.get("evidence")
            # grounding: the quoted evidence AND the raw value must exist in the source
            if raw is not None and not (_grounded(fr.evidence, text) and _grounded(str(raw), fr.evidence or "")):
                fr.found, fr.reason, fr.raw = False, "llm_not_grounded", str(raw)
                fr.evidence = None
                continue
            if raw is None or N.is_blank(str(raw)):
                fr.found, fr.reason = False, "blank" if raw is not None else "label_not_found"
                continue
            val = N.normalize(f, str(raw))
            if val is None or val == "":
                fr.raw, fr.found, fr.reason = str(raw), False, "unparseable"
                continue
            fr.raw, fr.value, fr.found, fr.reason = str(raw), val, True, None

    out.fields = results
    return out

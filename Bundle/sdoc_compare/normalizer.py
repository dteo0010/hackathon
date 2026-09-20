"""
Value normalisation for the 7 compared fields.

Principle: strip FORMATTING noise only. Never make two genuinely different
values look the same (injected defects are plausible real alternatives:
another real port, +-1 container, another real customer name).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

BLANK_MARKERS = {"", "-", "--", "n/a", "na", "nil", "none", "null", "tba", "tbc", "tbd", "???", "?"}


def is_blank(raw: Optional[str]) -> bool:
    """Placeholder / empty values. A blank is uncertainty, not a discrepancy."""
    if raw is None:
        return True
    s = raw.strip().lower()
    if s in BLANK_MARKERS:
        return True
    # "_______", "____MT", "??? MTS", "_____ KG"
    if re.fullmatch(r"[_\?\.\-\s]*(mts?|kgs?|kg|containers?)?\s*", s):
        return True
    return False


def _ascii_fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def _strip_non_ascii(s: str) -> str:
    return re.sub(r"[^\x20-\x7e]", " ", s)


# ---------------------------------------------------------------- parties

def normalize_party(raw: str) -> str:
    """
    Company / party name.
    - keep only the NAME line: text before '|' (xlsx), or the first line (txt/pdf/docx)
    - uppercase, drop punctuation, collapse whitespace
    Address lines are noise and are never compared.
    """
    s = raw.strip()
    s = s.split("|", 1)[0]          # xlsx: 'NAME | ADDRESS'
    s = s.split(" ; ", 1)[0]        # docx cell flattened by the reader: 'NAME ; ADDR ; ADDR'
    s = s.splitlines()[0] if s else s
    s = _strip_non_ascii(_ascii_fold(s)).upper()
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ------------------------------------------------------------------ ports

_LOCODE_TAIL = re.compile(r"\s*\(\s*[A-Z]{5}\s*\)\s*$")


def normalize_port(raw: str) -> str:
    """
    Port name.
    - drop a trailing UN/LOCODE in parentheses. The code is NOT used as truth:
      in this dataset the codes are frequently wrong on purpose.
    - keep inner parentheses that are part of the name (PORT KLANG (WESTPORT))
    - collapse 'X, X' to 'X' (SINGAPORE, SINGAPORE)
    - uppercase, drop punctuation, collapse whitespace
    """
    s = raw.strip().splitlines()[0] if raw.strip() else ""
    s = _strip_non_ascii(_ascii_fold(s)).upper()
    s = _LOCODE_TAIL.sub("", s)
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) == 2 and parts[0] == parts[1]:
        parts = parts[:1]
    s = " ".join(parts)
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ------------------------------------------------------------- containers

_LEADING_INT = re.compile(r"^\s*(\d+)\s*(?:x|X|\*|×)?")
_CONTAINER_WORD = re.compile(r"(\d+)\s*(?:x\s*)?(?:\d{2}'?\s*(?:GP|HC|FCL|RF|OT|DV|HQ)|containers?|ctnrs?|boxes|units)", re.I)


def normalize_container_count(raw: str) -> Optional[int]:
    """'6 x 40'HC' -> 6, '3 containers' -> 3, '12' -> 12. None if no integer."""
    s = raw.strip()
    m = _CONTAINER_WORD.search(s) or _LEADING_INT.match(s)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


# ----------------------------------------------------------------- weight

_NUM = re.compile(r"(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d+))?")


def normalize_weight_kg(raw: str) -> Optional[float]:
    """
    '243,588 KG' -> 243588.0, '243588' -> 243588.0, '131.322 KGS' (EU style) -> 131322.0,
    '138 MT' -> 138000.0. None if no number.
    """
    s = _strip_non_ascii(raw).strip()
    m = _NUM.search(s)
    if not m:
        return None
    whole = re.sub(r"[,\s]", "", m.group(1))
    frac = m.group(2)
    # European thousands separator: 131.322 with exactly 3 decimals and no comma
    if frac and len(frac) == 3 and "," not in m.group(0):
        whole, frac = whole + frac, None
    value = float(whole + ("." + frac if frac else ""))
    unit = s[m.end():].strip().upper()
    if re.match(r"^(MT|MTS|TON|TONS|TONNE|TONNES)\b", unit):
        value *= 1000.0
    return value


# --------------------------------------------------------------- dispatch

def normalize(field: str, raw: str):
    if field in ("shipper", "consignee", "notify_party"):
        return normalize_party(raw)
    if field in ("port_of_loading", "port_of_discharge"):
        return normalize_port(raw)
    if field == "container_count":
        return normalize_container_count(raw)
    if field == "gross_weight_kg":
        return normalize_weight_kg(raw)
    raise KeyError(field)


def values_equal(field: str, a, b) -> bool:
    if a is None or b is None:
        return False
    if field == "gross_weight_kg":
        return abs(float(a) - float(b)) < 0.5   # rounding only, never a tolerance band
    return a == b

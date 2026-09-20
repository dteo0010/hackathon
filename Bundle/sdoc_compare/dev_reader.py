"""
DEV-ONLY stand-in for B's readDocument(). Not part of C's deliverable.

Produces the text shapes extractor.py expects, so C can be tested end to end
before B's reader lands. Replace with B's function when it exists.
  .txt  -> content
  .pdf  -> pdftotext -layout  (empty text => unreadable, e.g. image-only scan)
  .xlsx -> one line per row, cells joined by TAB
  .docx -> paragraphs; table rows as '| cell | cell |'
"""
from __future__ import annotations

import subprocess
import docx
import openpyxl
from pathlib import Path


def read_document(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {"text": "", "method": "missing", "ok": False}
    if p.stat().st_size == 0:
        return {"text": "", "method": "empty", "ok": False}
    ext = p.suffix.lower()
    try:
        if ext == ".txt":
            return {"text": p.read_text(errors="replace"), "method": "txt", "ok": True}
        if ext == ".pdf":
            r = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True)
            txt = r.stdout if r.returncode == 0 else ""
            return {"text": txt, "method": "pdftotext", "ok": bool(txt.strip())}
        if ext == ".xlsx":
            wb = openpyxl.load_workbook(str(p), read_only=True, data_only=True)
            lines = []
            for ws in wb:
                for row in ws.iter_rows(values_only=True):
                    cells = ["" if c is None else str(c) for c in row]
                    if any(cells):
                        lines.append("\t".join(cells))
            return {"text": "\n".join(lines), "method": "openpyxl", "ok": bool(lines)}
        if ext == ".docx":
            d = docx.Document(str(p))
            lines = [para.text for para in d.paragraphs if para.text.strip()]
            for t in d.tables:
                for row in t.rows:
                    # multi-line cells: first line is the name, rest is address -> join
                    # with ' ; ' so the row stays on one line; the '|' cell separator
                    # is what the extractor splits on.
                    lines.append("| " + " | ".join(c.text.replace("\n", " ; ") for c in row.cells) + " |")
            return {"text": "\n".join(lines), "method": "python-docx", "ok": bool(lines)}
    except Exception as e:  # garbled pdf, corrupt zip, ...
        return {"text": "", "method": f"error:{type(e).__name__}", "ok": False}
    return {"text": "", "method": "unsupported", "ok": False}

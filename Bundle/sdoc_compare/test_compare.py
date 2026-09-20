"""python -m pytest sdoc_compare/test_compare.py -q   (or: python -m sdoc_compare.test_compare)"""
from sdoc_compare.comparator import compare_text
from sdoc_compare.extractor import extract_fields
import sdoc_compare.extractor as ex
import sdoc_compare.llm_fallback as lf

from sdoc_compare.normalizer import (
    normalize_container_count,
    normalize_party,
    normalize_port,
    normalize_weight_kg,
    is_blank,
)

SI = """SHIPPING INSTRUCTION
Shipper: APRIL FAR EAST (M) SDN BHD
  TOWER 2, AVENUE 5, LEVEL 6; 59200 KUALA LUMPUR, MALAYSIA
Consignee (Non-Negotiable): EAST BRIGHT FZ-LLC
Notify: EAST BRIGHT FZ-LLC
Port of Loading (POL): PORT KLANG (WESTPORT), MALAYSIA (MYPKG)
POD: KARACHI, PAKISTAN (PKKHI)
Total Containers: 6 x 40'HC
Gross Wt (kgs): 131,058 KG
NET WEIGHT: 120,000 KG
"""

BL_PDF = """BILL OF LADING (DRAFT)
Shipper                        APRIL FAR EAST (M) SDN BHD
                               TOWER 2, AVENUE 5, LEVEL 6
To the Order of                UAB NOVAKOPA
Notify Party                   EAST BRIGHT FZ-LLC
Load Port                      PORT KLANG (WESTPORT), MALAYSIA (SGSIN)
Port of Discharge              KARACHI, PAKISTAN

CONTAINER NO.                  DESCRIPTION            GROSS WEIGHT (KG)
GSLB0479748                    40'HC PAPER            21,843
ADNE4565060                    40'HC PAPER            21,843
SRGL8416878                    40'HC PAPER            21,843
ITVT1216558                    40'HC PAPER            21,843
LYEG9868000                    40'HC PAPER            21,843
EWKZ7872982                    40'HC PAPER            21,843

TOTAL Gross Weight■■(KGS):
"""

BL_DOCX = """# BILL OF LADING (DRAFT)
| Shipper (Principal or Seller) (发货人) | APRIL FAR EAST (M) SDN BHD ; TOWER 2, AVENUE 5 |
| Consignee (收货人) | EAST BRIGHT FZ-LLC ; RAKEZ AMENITY CENTER |
| Notify (通知人) | EAST BRIGHT FZ-LLC |
| PORT OF LOADING (装货港) | PORT KLANG (WESTPORT), MALAYSIA |
| POD (卸货港) | KARACHI, PAKISTAN |
| Total Containers (箱数) | 7 x 40'HC |
| Gross Wt (kgs) (毛重 KGS) | 131,058 |
"""

BL_XLSX = "BILL OF LADING\t123\nSHIPPER\tAPRIL FAR EAST (M) SDN BHD | TOWER 2\nCONSIGNEE\tEAST BRIGHT FZ-LLC | RAKEZ\nNOTIFY PARTY\tEAST BRIGHT FZ-LLC\nLoad Port\tPORT KLANG (WESTPORT), MALAYSIA\nPOD\tKARACHI, PAKISTAN\nNo. of Containers or Packages\t6 x 40'HC\nGross Weight (KG)\t131058\n"


def test_normalizers():
    assert normalize_party("APRIL FAR EAST (M) SDN BHD\n  TOWER 2") == "APRIL FAR EAST M SDN BHD"
    assert normalize_party("ABC | 12 JALAN") == "ABC"
    assert normalize_port("PORT KLANG (WESTPORT), MALAYSIA (MYPKG)") == "PORT KLANG WESTPORT MALAYSIA"
    assert normalize_port("SINGAPORE, SINGAPORE (SGSIN)") == normalize_port("SINGAPORE")
    assert normalize_container_count("6 x 40'HC") == 6
    assert normalize_container_count("12") == 12
    assert normalize_weight_kg("243,588 KG") == 243588.0
    assert normalize_weight_kg("243588") == 243588.0
    assert normalize_weight_kg("138 MT") == 138000.0
    for b in ["", "N/A", "TBA", "???", "_______", "____MT", "??? MTS"]:
        assert is_blank(b), b
    assert not is_blank("SINGAPORE")


def test_pdf_layout_and_derived_weight():
    r = compare_text(SI, BL_PDF, use_llm=False)
    assert r.mismatched_fields == ["consignee"], r.mismatched_fields
    assert r.uncomparable_fields == []
    gw = r.fields[6].bl
    assert gw.decided_by == "derived" and gw.value == 6 * 21843
    # NET WEIGHT must never be picked up as gross weight
    assert extract_fields(SI, use_llm=False).fields["gross_weight_kg"].value == 131058.0


def test_docx_and_xlsx_shapes():
    r = compare_text(SI, BL_DOCX, use_llm=False)
    assert r.mismatched_fields == ["container_count"], r.mismatched_fields
    r = compare_text(SI, BL_XLSX, use_llm=False)
    assert r.mismatched_fields == [] and r.uncomparable_fields == []


def test_blank_is_not_a_mismatch():
    si_blank = SI.replace("Gross Wt (kgs): 131,058 KG", "Gross Wt (kgs): N/A")
    r = compare_text(si_blank, BL_XLSX, use_llm=False)
    assert "gross_weight_kg" in r.uncomparable_fields
    assert "gross_weight_kg" not in r.mismatched_fields
    assert r.fields[6].si.reason == "blank"


def test_wrong_doc_type_reported():
    inv = "COMMERCIAL INVOICE\nInvoice No.: 1\nSeller: X\nBuyer: Y\n"
    r = compare_text(SI, inv, use_llm=False)
    assert r.bl_doc_type == "COMMERCIAL_INVOICE"
    assert len(r.uncomparable_fields) == 7 and r.mismatched_fields == []


def test_blank_then_populated_summary():
    bl = BL_XLSX.replace("Gross Weight (KG)\t131058", "Gross Weight (KG)\t\nTOTAL GROSS WEIGHT\t131,058 KG")
    fr = extract_fields(bl, use_llm=False).fields["gross_weight_kg"]
    assert fr.found and fr.value == 131058.0, fr


def test_table_with_trailing_packages_column():
    bl = """BILL OF LADING
Shipper: A
Consignee: B
Notify Party: B
Load Port: X
Port of Discharge: Y
CONTAINER NO.   GROSS WEIGHT (KG)   PACKAGES   CBM
ABCD1234567     21,843              80         55.2
EFGH7654321     21,843              80         55.2
"""
    f = extract_fields(bl, use_llm=False).fields
    assert f["gross_weight_kg"].value == 2 * 21843 and f["gross_weight_kg"].decided_by == "derived"
    assert f["container_count"].value == 2


def test_unknown_label_goes_to_llm_only_when_label_missing(monkeypatch=None):
    calls = []

    def fake_llm(text, fields):
        calls.append(fields)
        return {
            "port_of_loading": {
                "raw": "PORT KLANG",
                "evidence": "Loading at: PORT KLANG",
                "confidence": 0.9,
            },
            "consignee": {
                "raw": "GHOST CO",
                "evidence": "Consignee: GHOST CO",
                "confidence": 0.95,
            },
        }

    orig = lf.llm_extract
    lf.llm_extract = fake_llm

    try:
        txt = (
            "SHIPPING INSTRUCTION\n"
            "Shipper: A\n"
            "Consignee: REAL CO\n"
            "Notify: B\n"
            "Loading at: PORT KLANG\n"
            "POD: Y\n"
            "Total Containers: 1 x 20'GP\n"
            "Gross Weight: 1,000 KG\n"
        )

        f = ex.extract_fields(txt, use_llm=True).fields

        assert calls == [["port_of_loading"]], calls

        assert (
            f["port_of_loading"].found
            and f["port_of_loading"].decided_by == "llm"
        )

        assert (
            f["consignee"].decided_by == "rule"
            and f["consignee"].value == "REAL CO"
        )

        # Ungrounded answer must be rejected
        calls.clear()

        lf.llm_extract = lambda t, fs: {
            "port_of_loading": {
                "raw": "ROTTERDAM",
                "evidence": "Load Port: ROTTERDAM",
                "confidence": 0.99,
            }
        }

        f = ex.extract_fields(txt, use_llm=True).fields

        assert not f["port_of_loading"].found
        assert f["port_of_loading"].reason == "llm_not_grounded"

    finally:
        lf.llm_extract = orig


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)

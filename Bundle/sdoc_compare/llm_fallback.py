"""
LLM structured extraction, used ONLY for fields the rule table could not locate.

Set GEMINI_API_KEY (and optionally SDOC_LLM_MODEL).

Without a key this returns {} and the pipeline stays pure-rule.

Provider-independent contract:
{
    field: {
        "raw": ...,
        "evidence": ...,
        "confidence": ...
    }
}
"""

from __future__ import annotations

import json
import os

from google import genai
from google.genai import types


FIELD_HELP = {
    "shipper": "the shipper / exporter company name (name only, no address)",
    "consignee": "the consignee / 'to the order of' company name (name only, no address)",
    "notify_party": "the notify party company name (name only, no address)",
    "port_of_loading": "port of loading / load port (name as written, keep any code in parentheses)",
    "port_of_discharge": "port of discharge / discharge port (name as written, keep any code in parentheses)",
    "container_count": "the total number of containers, as written (e.g. \"6 x 40'HC\")",
    "gross_weight_kg": "the TOTAL gross weight with unit as written (e.g. \"131,322 KG\"); not net weight",
}


SYSTEM = (
    "You extract fields from shipping documents "
    "(Shipping Instruction and Bill of Lading). "
    "Return only valid JSON. "
    "For each requested field return: "
    "\"raw\" (the value exactly as written in the document, or null if absent "
    "or a placeholder such as N/A, TBA, ???, ____), "
    "\"evidence\" (the exact source line containing that value, or null), "
    "\"confidence\" (a number from 0 to 1). "
    "Never guess or infer a value that is not explicitly written in the text. "
    "The raw value MUST appear inside the evidence text. "
    "The evidence MUST come directly from the supplied document. "
    "If the document is not a Shipping Instruction or Bill of Lading, "
    "return null values for every requested field."
)


def _client():
    key = os.environ.get("GEMINI_API_KEY")

    if not key:
        return None

    return genai.Client(api_key=key)


def llm_extract(text: str, fields: list[str]) -> dict:
    client = _client()

    if client is None or not fields:
        return {}

    model = os.environ.get(
        "SDOC_LLM_MODEL",
        "gemini-3.6-flash",
    )

    wanted = "\n".join(
        f"- {field}: {FIELD_HELP[field]}"
        for field in fields
    )

    prompt = (
        f"Fields to extract:\n"
        f"{wanted}\n\n"
        f"Document text:\n"
        f"<<<\n{text[:12000]}\n>>>"
    )

    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM,
                temperature=0,
                response_mime_type="application/json",
            ),
        )

        if not response.text:
            return {}

        data = json.loads(response.text)

    except Exception:
        return {}

    out = {}

    for field in fields:
        hit = data.get(field)

        if isinstance(hit, dict):
            out[field] = {
                "raw": hit.get("raw"),
                "evidence": hit.get("evidence"),
                "confidence": hit.get("confidence"),
            }

    return out
"""meta.py - read/write the hidden extra fields that live at the end of some text columns.

The browser keeps fields the database has no column for (task title, priority, approval status, comments...)
as JSON after a marker:   "Fix kitchen sink\n<!--HCRM:{"priority":"High"}-->"
This is the Python twin of unpack/packTextAndMeta in static/api.js. The server uses it to ENFORCE approval
rules (an Employee can't approve their own work just by sending a different JSON).

Which column holds the meta for each table:
"""
import json

MARKER = "\n<!--HCRM:"
END = "-->"

META_COLUMN = {
    "clients": "notes",
    "projects": "estimate_description",
    "visits": "planned_work",
    "receipts": "store",
    "invoices": "description",
}


def unpack(raw) -> tuple[str, dict]:
    """'text\\n<!--HCRM:{...}-->' -> ('text', {...}). Broken JSON -> keep the text, empty meta."""
    s = str(raw or "")
    i = s.find(MARKER)
    if i == -1:
        return s.strip(), {}
    text, tail = s[:i].strip(), s[i + len(MARKER):]
    j = tail.rfind(END)
    try:
        meta = json.loads(tail[:j] if j != -1 else tail)
        return text, meta if isinstance(meta, dict) else {}
    except ValueError:
        return text, {}


def pack(text, meta: dict) -> str:
    """Opposite of unpack. Empty values are not stored; no meta at all -> just the text."""
    text = str(text or "").strip()
    meta = {k: v for k, v in (meta or {}).items() if v not in (None, "")}
    if not meta:
        return text
    return f"{text}{MARKER}{json.dumps(meta, ensure_ascii=False, separators=(',', ':'))}{END}"

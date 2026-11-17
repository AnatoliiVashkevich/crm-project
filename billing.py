"""billing.py - all money math: line items, new estimates and invoices, the Income & Expense report.

Pure functions: they get plain dicts (database rows) and return numbers / lists. No database, no web,
so they are easy to test (tests/test_billing.py). Money is Decimal rounded to cents - never float - so
$0.10 + $0.20 is exactly $0.30. Values become float only at the very end, for JSON.

Estimates and invoices are the SAME kind of document (table `invoices`, column `kind`):
    line item = {"description", "qty", "rate", "amount", "type": "labor" | "material" | "other",
                 optional "receipt_id" (material from a receipt)}
    An estimate is the early version; "Convert to invoice" copies its lines into a new invoice.
"""
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from meta import unpack

CENT = Decimal("0.01")
ZERO = Decimal("0.00")
MAX_LINES = 200
LINE_TYPES = {"labor", "material", "other"}

# The browser stores extra fields after this marker inside text columns (see meta.py). Documents show text only.
META_START = "<!--HCRM:"


def strip_meta(text) -> str:
    """Human-readable text only: drops the hidden '<!--HCRM:{...}-->' tail."""
    s = str(text or "")
    i = s.find(META_START)
    return (s[:i] if i != -1 else s).strip()


def money(x) -> Decimal:
    """Anything (None, "", "12.5", 12.499) -> Decimal rounded to cents. Empty or garbage means $0.00."""
    try:
        return Decimal(str(x if x not in (None, "") else 0)).quantize(CENT, rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return ZERO


def task_title(visit: dict) -> str:
    """A task's title as the browser shows it: meta title, else the first line of Planned Work."""
    text, meta = unpack(visit.get("planned_work"))
    return (meta.get("title") or text.split("\n")[0] or "Work").strip()


# =====================================================================================================
# Line items
# =====================================================================================================
def line(description, qty, rate, kind="labor", **extra) -> dict:
    """One clean line item with its amount (qty x rate) worked out."""
    q, r = money(qty), money(rate)
    item = {"description": str(description or "").strip()[:500], "qty": float(q), "rate": float(r),
            "amount": float((q * r).quantize(CENT, rounding=ROUND_HALF_UP)),
            "type": kind if kind in LINE_TYPES else "other"}
    item.update({k: v for k, v in extra.items() if v})
    return item


def clean_line_items(items) -> list[dict]:
    """Line items sent by the browser -> safe list (amounts are always recalculated here, never trusted)."""
    if not isinstance(items, list):
        raise ValueError("line_items must be a list")
    if len(items) > MAX_LINES:
        raise ValueError(f"At most {MAX_LINES} lines")
    out = []
    for it in items:
        if not isinstance(it, dict):
            raise ValueError("Each line must be an object")
        if not str(it.get("description") or "").strip() and not money(it.get("rate")):
            continue   # empty row in the editor
        out.append(line(it.get("description"), it.get("qty", 1), it.get("rate"), it.get("type", "other"),
                        receipt_id=it.get("receipt_id")))
    return out


def document_totals(items: list[dict]) -> dict:
    """labor = everything that isn't materials; total = sum of all lines (as strings for the database)."""
    materials = sum((money(i["amount"]) for i in items if i.get("type") == "material"), ZERO)
    total = sum((money(i["amount"]) for i in items), ZERO)
    labor_qty = sum((money(i["qty"]) for i in items if i.get("type") == "labor"), ZERO)
    return {"labor_amount": str(total - materials), "materials_amount": str(materials),
            "total": str(total), "hours": str(labor_qty)}


def legacy_line_items(invoice: dict, receipts: list[dict]) -> list[dict]:
    """Invoices made before line items existed: rebuild their lines from the old columns."""
    items = []
    labor, rate = money(invoice.get("labor_amount")), money(invoice.get("hourly_rate"))
    desc = strip_meta(invoice.get("description")) or "Labor"
    if labor:
        items.append(line(desc, invoice.get("hours"), rate, "labor") if rate else line(desc, 1, labor, "labor"))
    materials = money(invoice.get("materials_amount"))
    if materials:
        stores = ", ".join(dict.fromkeys(strip_meta(r.get("store")) for r in receipts if strip_meta(r.get("store"))))
        items.append(line("Materials" + (f": {stores}" if stores else ""), 1, materials, "material"))
    return items


def receipt_lines(receipts: list[dict]) -> list[dict]:
    """Billable receipts -> material lines (one per receipt, so removing one line releases that receipt)."""
    return [line(f"Materials: {strip_meta(r.get('store')) or 'receipt'}"
                 + (f" ({r['receipt_date']})" if r.get("receipt_date") else ""),
                 1, r.get("amount"), "material", receipt_id=r["id"]) for r in receipts]


# =====================================================================================================
# New documents
# =====================================================================================================
def estimate_lines(tasks: list[dict], rate) -> list[dict]:
    """New estimate = Planned Work of the project's tasks: one line per open task (planned hours x rate)."""
    lines = []
    for t in tasks:
        if t.get("status") == "Canceled":
            continue
        planned = unpack(t.get("planned_work"))[1].get("planned_hours")
        lines.append(line(task_title(t), planned or 1, rate, "labor"))
    return lines


def invoice_lines(tasks: list[dict], billed_visit_ids: set, rate, receipts: list[dict],
                  estimate: dict | None = None, include_visit: str | None = None) -> tuple[list[dict], list[str]]:
    """Lines for a new invoice + the task ids it bills (so they are never billed twice).

    - From an estimate (Convert, or the project's first invoice): copy the estimate's lines; it covers
      every open task of the project at that moment.
    - Otherwise: one labor line per COMPLETED task that no invoice has billed yet (actual hours x rate),
      plus the task you were looking at, if any.
    - Always: billable receipts not invoiced yet, one material line each.
    """
    open_tasks = [t for t in tasks if t.get("status") != "Canceled"]
    if estimate:
        lines = [line(i.get("description"), i.get("qty"), i.get("rate"), i.get("type", "labor"))
                 for i in (estimate.get("line_items") or []) if i.get("type") != "material"]
        visit_ids = [t["id"] for t in open_tasks if t["id"] not in billed_visit_ids]
    else:
        todo = [t for t in open_tasks if t["id"] not in billed_visit_ids
                and (t.get("status") == "Completed" or t["id"] == include_visit)]
        lines = [line(task_title(t), t.get("time_spent"), rate, "labor") for t in todo]
        visit_ids = [t["id"] for t in todo]
    return lines + receipt_lines(receipts), visit_ids


def latest_estimates(documents: list[dict]) -> dict:
    """{project_id: the newest estimate document} - the one used for "Estimate vs. Invoice"."""
    newest = {}
    for d in documents:
        if d.get("kind") != "estimate":
            continue
        key = (d.get("invoice_date") or "", d.get("created_at") or "")
        old = newest.get(d["project_id"])
        if not old or key > (old.get("invoice_date") or "", old.get("created_at") or ""):
            newest[d["project_id"]] = d
    return newest


# =====================================================================================================
# Income & Expense report
# =====================================================================================================
def _in_range(d, start: str, end: str) -> bool:
    """Date filter on ISO strings (YYYY-MM-DD). No range at all = everything counts."""
    if not start and not end:
        return True
    if not d:
        return False
    d = str(d)[:10]
    return (not start or d >= start) and (not end or d <= end)


def compute_report(documents: list[dict], receipts: list[dict], projects: list[dict],
                   start: str = "", end: str = "", labels: dict | None = None, with_estimate: bool = True) -> dict:
    """Income & Expense numbers for any scope (whole business, client, project or visit). Each figure has its own date:
    - Revenue (Paid):    invoices with status Paid, by paid date
    - Unpaid / Pending:  invoices with status Unpaid, by invoice date
    - Total Expenses:    ALL receipts (billable + internal), by receipt date
    - Net Profit:        Revenue (Paid) - Total Expenses
    - Estimate vs Invoice: invoiced - newest estimate, only for projects that HAVE an estimate
    `documents` may contain estimates too; they never count as money.
    """
    labels = labels or {}
    invoices = [d for d in documents if d.get("kind", "invoice") == "invoice"]
    revenue = sum((money(i["total"]) for i in invoices
                   if i["status"] == "Paid" and _in_range(i.get("paid_date"), start, end)), ZERO)
    unpaid = sum((money(i["total"]) for i in invoices
                  if i["status"] == "Unpaid" and _in_range(i.get("invoice_date"), start, end)), ZERO)
    spent = [r for r in receipts if _in_range(r.get("receipt_date"), start, end)]
    expenses = sum((money(r.get("amount")) for r in spent), ZERO)
    billable = sum((money(r.get("amount")) for r in spent if r.get("billable")), ZERO)

    comparison = None
    if with_estimate:
        estimates = latest_estimates(documents)
        invoiced = defaultdict(lambda: ZERO)
        for i in invoices:
            if _in_range(i.get("invoice_date"), start, end):
                invoiced[i["project_id"]] += money(i["total"])
        rows = []
        for p in projects:
            est = money(estimates[p["id"]]["total"]) if p["id"] in estimates else ZERO
            if est > 0 and p["id"] in invoiced:
                rows.append({"project": labels.get(p["id"], p.get("name") or ""), "estimate": float(est),
                             "invoiced": float(invoiced[p["id"]]), "diff": float(invoiced[p["id"]] - est)})
        if rows:
            comparison = {"diff": round(sum(r["diff"] for r in rows), 2), "rows": rows}

    return {
        "start": start, "end": end,
        "revenue": float(revenue), "unpaid": float(unpaid),
        "expenses": float(expenses), "expenses_billable": float(billable), "expenses_internal": float(expenses - billable),
        "net": float(revenue - expenses),
        "estimate_vs_invoice": comparison,
    }

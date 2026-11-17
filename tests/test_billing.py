"""Tests for billing.py - line items, new estimates/invoices, the report (no database needed)."""
from billing import (clean_line_items, compute_report, document_totals, estimate_lines, invoice_lines,
                     latest_estimates, legacy_line_items, strip_meta)


# ---------- hidden "<!--HCRM:" extras never reach documents ----------
def test_strip_meta_keeps_only_human_text():
    assert strip_meta('Fix sink\n<!--HCRM:{"priority":"High"}-->') == "Fix sink"
    assert strip_meta(None) == ""


# ---------- line items ----------
def test_line_amounts_are_recalculated_and_empty_rows_dropped():
    items = clean_line_items([
        {"description": "Labor", "qty": 2.5, "rate": 80, "amount": 999, "type": "labor"},   # wrong amount ignored
        {"description": "", "qty": 1, "rate": 0},                                            # empty editor row
        {"description": "Pipe", "qty": 1, "rate": "12.10", "type": "material"},
    ])
    assert [i["amount"] for i in items] == [200.0, 12.1]
    totals = document_totals(items)
    assert totals == {"labor_amount": "200.00", "materials_amount": "12.10", "total": "212.10", "hours": "2.50"}


def test_bad_line_items_are_refused():
    for bad in ("text", [1, 2]):
        try:
            clean_line_items(bad)
            assert False, "should have failed"
        except ValueError:
            pass


# ---------- Planned Work -> Estimate ----------
TASKS = [
    {"id": "v1", "status": "Completed", "time_spent": 3, "planned_work": 'Fix sink\n<!--HCRM:{"planned_hours":2}-->'},
    {"id": "v2", "status": "Scheduled", "time_spent": 0, "planned_work": "Paint door"},
    {"id": "v3", "status": "Canceled", "time_spent": 1, "planned_work": "Old job"},
]


def test_estimate_has_one_line_per_open_task():
    lines = estimate_lines(TASKS, 80)
    assert [(l["description"], l["qty"], l["amount"]) for l in lines] == [("Fix sink", 2.0, 160.0), ("Paint door", 1.0, 80.0)]


# ---------- Estimate -> Invoice, or straight from tasks ----------
RECEIPTS = [{"id": "r1", "store": "Home Depot", "amount": 40.10, "receipt_date": "2026-11-01"}]


def test_invoice_without_estimate_bills_completed_unbilled_tasks_and_receipts():
    lines, visits = invoice_lines(TASKS, set(), 80, RECEIPTS)
    assert visits == ["v1"]                                   # only the completed task
    assert lines[0]["amount"] == 240.0                        # ACTUAL hours (3) x rate
    assert lines[1]["type"] == "material" and lines[1]["receipt_id"] == "r1"


def test_task_you_are_looking_at_is_included_and_billed_tasks_are_skipped():
    _, visits = invoice_lines(TASKS, {"v1"}, 80, [], include_visit="v2")
    assert visits == ["v2"]


def test_invoice_from_estimate_copies_its_lines_and_covers_open_tasks():
    estimate = {"line_items": [{"description": "Whole job", "qty": 1, "rate": 1500, "type": "labor"}]}
    lines, visits = invoice_lines(TASKS, set(), 80, [], estimate=estimate)
    assert [l["amount"] for l in lines] == [1500.0]
    assert visits == ["v1", "v2"]                             # so they are never billed again


def test_newest_estimate_per_project():
    docs = [{"kind": "estimate", "project_id": "p1", "invoice_date": "2026-01-01", "id": "old"},
            {"kind": "estimate", "project_id": "p1", "invoice_date": "2026-02-01", "id": "new"},
            {"kind": "invoice", "project_id": "p1", "invoice_date": "2026-03-01", "id": "inv"}]
    assert latest_estimates(docs)["p1"]["id"] == "new"


def test_old_invoices_get_their_lines_rebuilt():
    old = {"description": "Fix sink", "hours": 3, "hourly_rate": 80, "labor_amount": 240, "materials_amount": 40}
    lines = legacy_line_items(old, [{"store": "Home Depot"}])
    assert [(l["description"], l["amount"]) for l in lines] == [("Fix sink", 240.0), ("Materials: Home Depot", 40.0)]


# ---------- Income & Expense report ----------
def test_report_numbers_and_date_filters():
    docs = [
        {"kind": "invoice", "project_id": "p1", "status": "Paid", "total": 500, "paid_date": "2026-03-10", "invoice_date": "2026-02-20"},
        {"kind": "invoice", "project_id": "p1", "status": "Unpaid", "total": 200, "invoice_date": "2026-03-05"},
        {"kind": "estimate", "project_id": "p1", "status": "Unpaid", "total": 600, "invoice_date": "2026-01-05"},
    ]
    receipts = [{"amount": 100, "billable": True, "receipt_date": "2026-03-01"},
                {"amount": 30, "billable": False, "receipt_date": "2026-03-02"}]
    r = compute_report(docs, receipts, [{"id": "p1", "name": "Kitchen"}], "2026-03-01", "2026-03-31")
    assert r["revenue"] == 500           # by PAID date
    assert r["unpaid"] == 200            # by INVOICE date; the estimate is NOT money
    assert r["expenses"] == 130 and r["net"] == 370
    assert r["estimate_vs_invoice"]["diff"] == -400   # 200 invoiced in March - 600 estimate


def test_report_skips_projects_without_estimate():
    docs = [{"kind": "invoice", "project_id": "p1", "status": "Paid", "total": 100, "paid_date": "2026-01-01", "invoice_date": "2026-01-01"}]
    assert compute_report(docs, [], [{"id": "p1", "name": "x"}])["estimate_vs_invoice"] is None

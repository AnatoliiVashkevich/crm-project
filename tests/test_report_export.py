"""Tests for report_export.py - the Income & Expense report as CSV / PDF."""
from decimal import Decimal

from report_export import period_label, report_rows, to_csv, to_pdf

PROJECTS = [{"id": "p1", "client_id": "c1", "name": "Kitchen"}]
CLIENTS = {"c1": "Avery Brookfield"}
DOCS = [
    {"kind": "invoice", "project_id": "p1", "invoice_number": "INV-0001", "status": "Paid", "total": 500,
     "paid_date": "2026-03-10", "invoice_date": "2026-02-20"},
    {"kind": "invoice", "project_id": "p1", "invoice_number": "INV-0002", "status": "Unpaid", "total": 200, "invoice_date": "2026-03-05"},
    {"kind": "estimate", "project_id": "p1", "invoice_number": "EST-0001", "status": "Unpaid", "total": 900, "invoice_date": "2026-03-01"},
]
RECEIPTS = [{"project_id": "p1", "amount": 40.5, "store": 'Home Depot\n<!--HCRM:{"x":1}-->', "billable": True,
             "category": "Construction", "receipt_date": "2026-03-02"}]


def test_rows_follow_the_same_rules_as_the_cards():
    income, expenses, totals = report_rows(DOCS, RECEIPTS, PROJECTS, CLIENTS, "2026-03-01", "2026-03-31")
    assert [x["number"] for x in income] == ["INV-0002", "INV-0001"]      # estimate left out, sorted by date
    assert income[1]["date"] == "2026-03-10"                              # paid invoice dated by PAID date
    assert expenses[0]["store"] == "Home Depot" and expenses[0]["client"] == "Avery Brookfield"
    assert totals == {"revenue": Decimal("500.00"), "unpaid": Decimal("200.00"),
                      "expenses": Decimal("40.50"), "net": Decimal("459.50")}


def test_csv_has_lines_and_totals():
    text = to_csv(*report_rows(DOCS, RECEIPTS, PROJECTS, CLIENTS), title="Test").decode("utf-8-sig")
    assert "Income (Paid),2026-03-10,INV-0001,Avery Brookfield,Kitchen,Paid,500.00" in text
    assert "Expense (Billable)" in text and "-40.50" in text
    assert "Net Profit (Revenue - Expenses),,,,,,459.50" in text


def test_pdf_is_a_pdf():
    assert to_pdf(*report_rows(DOCS, RECEIPTS, PROJECTS, CLIENTS), title="Test", company="Acme").startswith(b"%PDF")


def test_period_label():
    assert period_label("", "") == "All time"
    assert period_label("2026-01-01", "2026-01-31") == "2026-01-01 to 2026-01-31"

"""Tests for reports.py - Overview blocks and the detailed reports."""
from reports import dataset, make_ctx, overview

TEAM = [{"id": "m1", "name": "Sam", "hourly_cost": 30}]
CLIENTS = [{"id": "c1", "name": "Avery"}]
PROJECTS = [{"id": "p1", "client_id": "c1", "name": "Kitchen"}]
VISITS = [
    {"id": "v1", "project_id": "p1", "visit_date": "2026-11-05", "status": "Completed", "time_spent": 4,
     "assigned_to": "m1", "planned_work": 'Fix sink\n<!--HCRM:{"title":"Fix sink","planned_hours":3}-->'},
    {"id": "v2", "project_id": "p1", "visit_date": "2026-11-06", "status": "Canceled", "time_spent": 9, "planned_work": "x"},
]
DOCS = [
    {"id": "i1", "kind": "invoice", "project_id": "p1", "client_id": "c1", "invoice_number": "INV-0001", "status": "Paid",
     "total": 600, "labor_amount": 500, "materials_amount": 100, "invoice_date": "2026-11-01", "paid_date": "2026-11-08"},
    {"id": "i2", "kind": "invoice", "project_id": "p1", "client_id": "c1", "invoice_number": "INV-0002", "status": "Unpaid",
     "total": 250, "invoice_date": "2026-08-01"},
    {"id": "e1", "kind": "estimate", "project_id": "p1", "client_id": "c1", "status": "Unpaid", "total": 800, "invoice_date": "2026-10-01"},
]
RECEIPTS = [{"id": "r1", "project_id": "p1", "amount": 100, "store": "Home Depot", "billable": True,
             "receipt_date": "2026-11-03", "created_by": "m1", "invoice_id": "i1"}]
CTX = make_ctx(CLIENTS, PROJECTS, VISITS, DOCS, RECEIPTS, TEAM)
NOV = ("2026-11-01", "2026-11-30")
TODAY = "2026-11-17"


def test_overview_money_owed_trend_jobs_team():
    o = overview(CTX, *NOV, "2026-10-01", "2026-10-31", TODAY, with_cost=True)
    assert o["current"] == {"revenue": 600.0, "expenses": 100.0, "labor": 120.0, "net": 380.0}   # 4 h x $30 labor
    assert o["previous"]["revenue"] == 0
    assert o["owed"]["total"] == 250 and o["owed"]["buckets"]["90+ days"] == 250              # Aug 1 -> 108 days
    assert o["owed"]["debtors"][0]["client"] == "Avery"
    assert len(o["trend"]) == 12 and o["trend"][-1] == {"month": "2026-11", "income": 600.0, "expenses": 220.0}
    job = o["jobs"][0]
    assert job["profit"] == 380.0 and job["per_hour"] == 125.0                                  # (600-100)/4
    assert o["team"][0] == {"employee": "Sam", "member_id": "m1", "done": 1, "planned": 3.0, "actual": 4.0,
                            "over_pct": 33.3, "labor_cost": 120.0}


def test_manager_never_gets_cost_or_profit():
    o = overview(CTX, *NOV, "", "", TODAY, with_cost=False)
    assert "labor" not in o["current"] and "profit" not in o["jobs"][0] and "labor_cost" not in o["team"][0]
    d = dataset("jobs", CTX, *NOV, TODAY, with_cost=False)
    assert all(not c["cost"] for c in d["columns"]) and "profit" not in d["rows"][0]


def test_detailed_reports():
    income = dataset("income", CTX, *NOV, TODAY, True)["rows"]
    assert [(r["number"], r["days_to_pay"], r["client"]) for r in income] == [("INV-0001", 7, "Avery")]
    expenses = dataset("expenses", CTX, *NOV, TODAY, True)["rows"]
    assert expenses[0]["entered_by"] == "Sam" and expenses[0]["invoiced"] == "Yes"
    debts = dataset("debts", CTX, *NOV, TODAY, True)
    assert debts["as_of_today"] and [r["number"] for r in debts["rows"]] == ["INV-0002"]   # period ignored
    team = dataset("team", CTX, *NOV, TODAY, True)["rows"]
    assert len(team) == 1 and team[0]["diff"] == 1.0                                       # canceled task left out
    jobs = dataset("jobs", CTX, *NOV, TODAY, True)["rows"]
    assert jobs[0]["vs_estimate"] == 50.0                                                  # all invoices 850 - estimate 800

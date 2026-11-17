"""Tests for the API rules in main.py: who may do what, approvals, invoices.
The database is a tiny in-memory fake and the signed-in person is chosen per test (no Supabase, no login)."""
import itertools

import pytest
from fastapi.testclient import TestClient

import main
from auth import current_member
from meta import pack, unpack

OWNER = {"id": "m-own", "user_id": "u1", "name": "Olga", "role": "Owner", "active": True}
MANAGER = {"id": "m-mgr", "user_id": "u2", "name": "Max", "role": "Manager", "active": True}
EMPLOYEE = {"id": "m-emp", "user_id": "u3", "name": "Eve", "role": "Employee", "active": True}


class FakeDB:
    """Just enough of database.py: rows live in dicts, ids are generated."""

    def __init__(self):
        self.ids = itertools.count(1)
        self.tables = {
            "profile": {1: {"id": 1, "default_hourly_rate": 80, "expense_threshold": 150, "approvals_required": True}},
            "team_members": {m["id"]: dict(m) for m in (OWNER, MANAGER, EMPLOYEE)},
            "clients": {}, "projects": {}, "visits": {}, "receipts": {}, "invoices": {},
        }
        self.deleted_photos = []

    def get_row(self, table, row_id):
        row = self.tables[table].get(row_id)
        return dict(row) if row else None

    def select_where(self, table, column, value, columns="*", order=None, desc=False):
        return [dict(r) for r in self.tables[table].values() if r.get(column) == value]

    def fetch_all(self, table, columns="*", **eq):
        return [dict(r) for r in self.tables[table].values() if all(r.get(k) == v for k, v in eq.items())]

    def insert_row(self, table, data):
        row = {"id": f"{table[:3]}{next(self.ids)}", **data}
        self.tables[table][row["id"]] = row
        return dict(row)

    def update_row(self, table, row_id, data):
        self.tables[table][row_id].update(data)
        return dict(self.tables[table][row_id])

    def delete_row(self, table, row_id):
        self.tables[table].pop(row_id, None)

    def delete_photos(self, urls):
        self.deleted_photos += list(urls)

    def collect_photo_urls(self, table, row_id):
        return []

    def today_local(self):
        return "2026-11-16"


@pytest.fixture
def fake(monkeypatch):
    f = FakeDB()
    for name in ("get_row", "select_where", "fetch_all", "insert_row", "update_row", "delete_row",
                 "delete_photos", "collect_photo_urls", "today_local"):
        monkeypatch.setattr(main.db, name, getattr(f, name))
    monkeypatch.setattr(main.db, "supabase", _NoopSupabase())
    yield f
    main.app.dependency_overrides.clear()


class _NoopSupabase:
    """Swallows the few direct supabase calls (bulk receipt updates) - they're checked elsewhere."""
    def __getattr__(self, _):
        return self

    def __call__(self, *a, **k):
        return self


client = TestClient(main.app)


def as_user(member):
    main.app.dependency_overrides[current_member] = lambda: member


def status_of(row, column):
    return unpack(row.get(column))[1].get("approval_status")


# ---------- not signed in -> 401 ----------
def test_requests_without_login_are_refused(fake):
    main.app.dependency_overrides.clear()
    assert client.get("/api/bootstrap").status_code == 401


# ---------- whitelist ----------
@pytest.mark.parametrize("field", ["id", "client_id", "total", "created_at"])
def test_patch_rejects_protected_fields(fake, field):
    as_user(OWNER)
    fake.tables["projects"]["p1"] = {"id": "p1"}
    assert client.patch("/api/projects/p1", json={field: "x"}).status_code == 400


def test_patch_rejects_unknown_status(fake):
    as_user(OWNER)
    fake.tables["visits"]["v1"] = {"id": "v1", "status": "Scheduled"}
    assert client.patch("/api/visits/v1", json={"status": "Done"}).status_code == 400
    assert client.patch("/api/visits/v1", json={"status": "Completed"}).status_code == 200


# ---------- Employees never receive money data ----------
def test_employee_bootstrap_has_no_money_and_only_own_tasks(fake):
    fake.tables["projects"]["p1"] = {"id": "p1", "client_id": "c1", "name": "Kitchen", "estimate_fixed": 900}
    fake.tables["visits"].update({"v1": {"id": "v1", "project_id": "p1", "assigned_to": "m-emp"},
                                  "v2": {"id": "v2", "project_id": "p1", "assigned_to": "m-mgr"}})
    fake.tables["invoices"]["i1"] = {"id": "i1", "project_id": "p1", "client_id": "c1", "status": "Unpaid", "total": 450}
    as_user(EMPLOYEE)
    data = client.get("/api/bootstrap").json()
    assert [v["id"] for v in data["visits"]] == ["v1"]
    assert data["invoices"] == [] and data["client_debt"] == {}
    assert "estimate_fixed" not in data["projects"][0]
    assert "default_hourly_rate" not in data["profile"]
    assert "email" not in data["team"][0]


@pytest.mark.parametrize("method,url", [("get", "/api/report"), ("get", "/api/invoices/i1/pdf"),
                                        ("post", "/api/documents"), ("patch", "/api/invoices/i1"),
                                        ("patch", "/api/profile"), ("delete", "/api/clients/c1")])
def test_employee_is_refused_money_settings_and_delete(fake, method, url):
    as_user(EMPLOYEE)
    kwargs = {"json": {}} if method in ("post", "patch") else {}
    assert getattr(client, method)(url, **kwargs).status_code == 403


def test_employee_cannot_touch_someone_elses_task(fake):
    fake.tables["visits"]["v2"] = {"id": "v2", "assigned_to": "m-mgr"}
    as_user(EMPLOYEE)
    assert client.patch("/api/visits/v2", json={"status": "Completed"}).status_code == 403


# ---------- approvals (switch ON) ----------
def test_employee_cannot_approve_own_client(fake):
    as_user(EMPLOYEE)
    row = client.post("/api/clients", json={"name": "Ann", "notes": pack("", {"approval_status": "Approved"})}).json()
    assert status_of(row, "notes") == "PendingApproval"


def test_employee_field_note_keeps_approval_but_real_edit_resets_it(fake):
    approved = pack("Fix sink", {"title": "Fix sink", "approval_status": "Approved"})
    fake.tables["visits"]["v1"] = {"id": "v1", "assigned_to": "m-emp", "planned_work": approved, "visit_date": "2026-11-20"}
    as_user(EMPLOYEE)
    note = pack("Fix sink", {"title": "Fix sink", "approval_status": "Approved", "comments": [{"text": "need parts"}]})
    assert status_of(client.patch("/api/visits/v1", json={"planned_work": note}).json(), "planned_work") == "Approved"
    moved = client.patch("/api/visits/v1", json={"visit_date": "2026-11-25"}).json()
    assert status_of(moved, "planned_work") == "PendingApproval"


def test_employee_receipt_above_threshold_waits(fake):
    as_user(EMPLOYEE)
    small = client.post("/api/receipts", json={"project_id": "p1", "amount": 40, "store": "HD"}).json()
    big = client.post("/api/receipts", json={"project_id": "p1", "amount": 400, "store": "HD"}).json()
    assert status_of(small, "store") == "Approved" and status_of(big, "store") == "PendingApproval"
    assert big["created_by"] == "m-emp"


def test_approvals_switch_off_approves_everything(fake):
    fake.tables["profile"][1]["approvals_required"] = False
    as_user(EMPLOYEE)
    row = client.post("/api/clients", json={"name": "Ann"}).json()
    assert status_of(row, "notes") in (None, "Approved")


# ---------- estimates & invoices ----------
def make_project(fake):
    fake.tables["projects"]["p1"] = {"id": "p1", "client_id": "c1", "name": "Kitchen"}
    fake.tables["visits"].update({
        "v1": {"id": "v1", "project_id": "p1", "status": "Completed", "time_spent": 3, "planned_work": "Fix sink"},
        "v2": {"id": "v2", "project_id": "p1", "status": "Canceled", "time_spent": 0, "planned_work": "Old"},
    })


def test_manager_invoice_waits_for_owner_and_manager_cannot_approve_it(fake):
    make_project(fake)
    as_user(MANAGER)
    inv = client.post("/api/documents", json={"kind": "invoice", "project_id": "p1"}).json()
    assert inv["invoice_number"] == "INV-0001" and inv["total"] == "240.00"
    assert status_of(inv, "description") == "PendingApproval"
    tried = client.patch(f"/api/invoices/{inv['id']}", json={"description": pack("", {"approval_status": "Approved"})}).json()
    assert status_of(tried, "description") == "PendingApproval"
    as_user(OWNER)
    ok = client.patch(f"/api/invoices/{inv['id']}", json={"description": pack("", {"approval_status": "Approved"})}).json()
    assert status_of(ok, "description") == "Approved"


def test_estimate_then_first_invoice_uses_it(fake):
    make_project(fake)
    as_user(OWNER)
    est = client.post("/api/documents", json={"kind": "estimate", "project_id": "p1"}).json()
    assert est["invoice_number"] == "EST-0001" and est["total"] == "80.00"   # 1 open task x $80
    inv = client.post("/api/documents", json={"kind": "invoice", "project_id": "p1"}).json()
    assert inv["estimate_id"] == est["id"] and inv["total"] == "80.00"
    again = client.post("/api/documents", json={"kind": "invoice", "project_id": "p1", "from_estimate": est["id"]})
    assert again.status_code == 400   # already converted


def test_editing_line_items_recalculates_total(fake):
    fake.tables["invoices"]["i1"] = {"id": "i1", "kind": "invoice", "line_items": [], "status": "Unpaid"}
    as_user(OWNER)
    row = client.patch("/api/invoices/i1", json={"line_items": [{"description": "Labor", "qty": 2, "rate": 90}]}).json()
    assert row["total"] == "180.00" and row["line_items"][0]["amount"] == 180.0


def test_marking_paid_stamps_todays_date_and_estimates_have_no_payment(fake):
    fake.tables["invoices"].update({"i1": {"id": "i1", "kind": "invoice", "status": "Unpaid", "paid_date": None},
                                    "e1": {"id": "e1", "kind": "estimate", "status": "Unpaid"}})
    as_user(OWNER)
    assert client.patch("/api/invoices/i1", json={"status": "Paid"}).json()["paid_date"] == "2026-11-16"
    assert client.patch("/api/invoices/i1", json={"status": "Unpaid"}).json()["paid_date"] is None
    assert client.patch("/api/invoices/e1", json={"status": "Paid"}).status_code == 400


def test_canceled_task_cannot_be_invoiced(fake):
    make_project(fake)
    as_user(OWNER)
    r = client.post("/api/documents", json={"kind": "invoice", "project_id": "p1", "visit_id": "v2"})
    assert r.status_code == 400 and "canceled" in r.json()["detail"].lower()


# ---------- receipts & photos ----------
def test_invoiced_receipt_cannot_change_billable(fake):
    fake.tables["receipts"]["r1"] = {"id": "r1", "billable": True, "invoice_id": "i1", "created_by": "m-own"}
    as_user(OWNER)
    assert client.patch("/api/receipts/r1", json={"billable": False}).status_code == 400


def test_removed_photo_file_is_deleted_from_storage(fake):
    fake.tables["visits"]["v1"] = {"id": "v1", "image_urls": ["a.webp", "b.webp"]}
    as_user(OWNER)
    client.patch("/api/visits/v1", json={"image_urls": ["b.webp"]})
    assert fake.deleted_photos == ["a.webp"]


def test_project_creation_returns_its_first_task(fake):
    as_user(OWNER)
    row = client.post("/api/projects", json={"client_id": "c1", "name": "Deck"}).json()
    assert row["first_visit_id"] in fake.tables["visits"]


# ---------- report export & timer ----------
def test_report_export_csv_for_owner_and_refused_for_employee(fake):
    make_project(fake)
    fake.tables["clients"]["c1"] = {"id": "c1", "name": "Avery"}
    fake.tables["invoices"]["i1"] = {"id": "i1", "kind": "invoice", "project_id": "p1", "client_id": "c1",
                                     "invoice_number": "INV-0001", "status": "Paid", "total": 300,
                                     "paid_date": "2026-11-10", "invoice_date": "2026-11-01"}
    as_user(OWNER)
    r = client.get("/api/report/export?format=csv")
    assert r.status_code == 200 and "INV-0001" in r.content.decode("utf-8-sig")
    assert client.get("/api/report/export?format=pdf").content.startswith(b"%PDF")
    as_user(EMPLOYEE)
    assert client.get("/api/report/export?format=csv").status_code == 403


def test_starting_a_timer_does_not_send_task_back_to_approval(fake):
    approved = pack("Fix sink", {"title": "Fix sink", "approval_status": "Approved"})
    fake.tables["visits"]["v1"] = {"id": "v1", "assigned_to": "m-emp", "planned_work": approved}
    as_user(EMPLOYEE)
    running = pack("Fix sink", {"title": "Fix sink", "approval_status": "Approved", "timer_start": 1700000000000, "timer_by": "m-emp"})
    row = client.patch("/api/visits/v1", json={"planned_work": running, "status": "In Progress"}).json()
    assert status_of(row, "planned_work") == "Approved"


# ---------- Reports ----------
def test_reports_cost_only_for_owner_and_refused_for_employee(fake):
    make_project(fake)
    fake.tables["clients"]["c1"] = {"id": "c1", "name": "Avery"}
    fake.tables["team_members"]["m-emp"]["hourly_cost"] = 25
    fake.tables["visits"]["v1"].update({"assigned_to": "m-emp", "visit_date": "2026-11-05"})
    as_user(OWNER)
    owner = client.get("/api/reports/overview?start=2026-11-01&end=2026-11-30").json()
    assert owner["current"]["labor"] == 75.0                     # 3 h x $25
    as_user(MANAGER)
    mgr = client.get("/api/reports/jobs?start=2026-11-01&end=2026-11-30").json()
    assert all(not c["cost"] for c in mgr["columns"]) and "profit" not in mgr["rows"][0]
    assert "hourly_cost" not in client.get("/api/bootstrap").json()["team"][0]
    as_user(EMPLOYEE)
    assert client.get("/api/reports/overview").status_code == 403


def test_report_pdf_from_the_visible_table(fake):
    as_user(OWNER)
    body = {"title": "Income report", "subtitle": "2026-11", "columns": [{"label": "Client"}, {"label": "Amount", "align": "right"}],
            "rows": [{"kind": "group", "cells": ["Avery"]}, {"kind": "row", "cells": ["Avery", "$100.00"]},
                     {"kind": "total", "cells": ["Total (1)", "$100.00"]}]}
    r = client.post("/api/reports/pdf", json=body)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")

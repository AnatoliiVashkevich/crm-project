from decimal import Decimal

import main


def project(estimate=0, items=None, **extra):
    p = {"id": "p1", "estimated_amount": estimate, "invoice_data": {"items": items} if items is not None else {}}
    p.update(extra)
    return p


def pay(*amounts):
    return [{"amount": a} for a in amounts]


def test_estimate_is_total_due_when_no_invoice():
    b = main.compute_balance(project(500), [])
    assert b["total_due"] == Decimal("500.00")
    assert b["is_debt"] is True
    assert b["payment_status"] == "debt"


def test_invoice_total_overrides_estimate():
    b = main.compute_balance(project(500, items=[{"qty": 2, "price": 100}, {"qty": 1, "price": 50}]), [])
    assert b["total_due"] == Decimal("250.00")


def test_payments_add_up_and_clear_debt():
    b = main.compute_balance(project(500), pay(200, 300))
    assert b["total_paid"] == Decimal("500.00")
    assert b["balance_due"] == Decimal("0.00")
    assert b["is_debt"] is False
    assert b["payment_status"] == "paid"


def test_partial_payment_is_still_debt():
    b = main.compute_balance(project(500), pay(200))
    assert b["balance_due"] == Decimal("300.00")
    assert b["is_debt"] is True


def test_overpayment_never_gives_negative_balance():
    b = main.compute_balance(project(100), pay(150))
    assert b["balance_due"] == Decimal("0.00")
    assert b["is_debt"] is False


def test_zero_total_is_not_debt():
    assert main.compute_balance(project(0), [])["is_debt"] is False


def test_no_float_rounding_errors():
    b = main.compute_balance(project(0.3), pay(0.1, 0.2))
    assert b["total_paid"] == Decimal("0.30")
    assert b["is_debt"] is False


def test_fractional_quantity():
    b = main.compute_balance(project(0, items=[{"qty": 1.5, "price": 80}]), [])
    assert b["total_due"] == Decimal("120.00")


def test_list_view_uses_stored_invoice_total_when_invoice_data_missing():
    row = {"id": "p1", "estimated_amount": 500, "invoice_total": 300}  # no invoice_data key
    assert main.compute_balance(row, [])["total_due"] == Decimal("300.00")


def test_project_balance_loads_project_and_payments(monkeypatch):
    monkeypatch.setattr(main, "get_project_or_404", lambda pid: project(500))
    monkeypatch.setattr(main, "get_payments", lambda pid: pay(200, 300))
    b = main.project_balance("p1")
    assert b["total_paid"] == Decimal("500.00")
    assert b["is_debt"] is False


def test_attach_balance_is_json_safe_and_keeps_actual_amount_alias():
    out = main.attach_balance(project(500), pay(200))
    assert out["total_paid"] == 200.0
    assert out["actual_amount"] == 200.0
    assert out["balance_due"] == 300.0
    assert out["payment_status"] == "debt"

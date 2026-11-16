import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_allowed_fields_pass():
    updates = {"name": "Kitchen", "address": "1 Main St", "estimated_amount": 100, "archived": True}
    assert main.validate_updates(updates, main.PROJECT_FIELDS, "project") == updates


@pytest.mark.parametrize("key", [
    "id", "client_id", "payment_status", "actual_amount", "invoice_number", "invoice_total", "created_at",
])
def test_project_rejects_protected_fields(key):
    with pytest.raises(HTTPException) as exc:
        main.validate_updates({"name": "ok", key: "x"}, main.PROJECT_FIELDS, "project")
    assert exc.value.status_code == 400
    assert key in exc.value.detail


@pytest.mark.parametrize("key", ["id", "created_at", "project_id"])
def test_client_rejects_unknown_fields(key):
    with pytest.raises(HTTPException) as exc:
        main.validate_updates({key: "x"}, main.CLIENT_FIELDS, "client")
    assert exc.value.status_code == 400


def test_put_project_with_client_id_returns_400():
    r = client.put("/api/projects/abc", json={"updates": {"client_id": "x"}})
    assert r.status_code == 400


def test_put_project_with_payment_status_returns_400():
    r = client.put("/api/projects/abc", json={"updates": {"payment_status": "paid"}})
    assert r.status_code == 400


def test_put_client_with_id_returns_400():
    r = client.put("/api/clients/abc", json={"updates": {"id": "x"}})
    assert r.status_code == 400

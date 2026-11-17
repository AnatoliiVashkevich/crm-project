"""main.py - the FastAPI web server: every /api/... route lives here.

How the pieces fit together:
    auth.py        -> sign-in, "who is calling?" (current_member), roles, Team endpoints
    database.py    -> talks to Supabase (rows + photo files). No business rules.
    billing.py     -> money math: line items, new estimates/invoices, Income & Expense report. Pure functions.
    meta.py        -> hidden extra fields inside text columns (approval status, task title, ...)
    invoice_pdf.py -> draws the estimate / invoice PDF.
    main.py        -> (this file) checks WHO may do WHAT, validates input, calls the modules above.
    static/        -> the browser app (index.html, styles.css, api.js, app.js).

Who may do what (enforced HERE, not only hidden in the browser):
    Owner     everything, incl. settings, team, approving Manager invoices
    Manager   clients, projects, all tasks, receipts, estimates & invoices (his invoices wait for the Owner)
    Employee  own tasks + own receipts; may create clients/projects/tasks; NEVER receives money data

Run locally:   uvicorn main:app --reload      then open http://localhost:8000
"""
import json
import logging
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import database as db
from auth import current_member, public_member, require
from auth import router as auth_router
from billing import (clean_line_items, compute_report, document_totals, estimate_lines, invoice_lines,
                     latest_estimates, legacy_line_items, money)
from meta import META_COLUMN, pack, unpack
from report_export import period_label, report_rows, table_pdf, to_csv, to_pdf
from reports import COLUMNS as REPORT_COLUMNS
from reports import dataset, make_ctx, overview

log = logging.getLogger("crm")
BASE_DIR = Path(__file__).parent

# Browsers may only call the API from these addresses (set CORS_ORIGINS in .env to change, comma-separated).
CORS_ORIGINS = [
    o.strip() for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
]

app = FastAPI(title="Field Service CRM API")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(auth_router)   # /api/auth/... and /api/team/...


@app.middleware("http")
async def always_fresh_app_files(request, call_next):
    """The page and its files (app.js, api.js, styles.css) must never come from an old browser cache,
    or an updated server meets an outdated app. "no-cache" = the browser re-checks each time
    (a quick "not modified" answer when nothing changed)."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


MONEY_ROLES = ("Owner", "Manager")   # who may see estimates, invoices and reports


# =====================================================================================================
# 1. WHAT THE BROWSER IS ALLOWED TO WRITE
#    Anything not listed here is rejected with a 400, so a bug (or a curious user) can never overwrite
#    totals, ids, creators or parent links.
# =====================================================================================================
FIELDS = {
    "profile":  {"company_name", "phone", "email", "business_address", "payment_details",
                 "default_hourly_rate", "logo_url", "expense_threshold", "approvals_required"},
    "clients":  {"name", "phone", "email", "street", "city", "state", "zip", "notes"},
    "projects": {"name", "street", "city", "state", "zip", "estimate_description"},
    "visits":   {"visit_date", "planned_work", "time_spent", "status", "image_urls", "assigned_to"},
    "receipts": {"amount", "store", "category", "receipt_date", "billable", "image_urls"},
    "invoices": {"status", "paid_date", "invoice_date", "description", "line_items"},
}
# Parent links: accepted when a row is created, never changed afterwards (PATCH).
PARENTS = {"projects": {"client_id"}, "visits": {"project_id"}, "receipts": {"project_id", "visit_id"}}
REQUIRED_PARENT = {"projects": ["client_id"], "visits": ["project_id"], "receipts": ["project_id"]}

CREATABLE = {"clients", "projects", "visits", "receipts"}   # estimates/invoices: POST /api/documents
DELETABLE = {"clients", "projects", "visits", "receipts", "invoices"}

# Fields with a fixed list of allowed values.
CHOICES = {
    ("visits", "status"): {"Scheduled", "In Progress", "Completed", "Canceled"},
    ("invoices", "status"): {"Unpaid", "Paid"},
}

NULL_IF_EMPTY = {"paid_date", "visit_id", "assigned_to"}
ZERO_IF_EMPTY = {"time_spent", "amount", "default_hourly_rate", "expense_threshold"}
KEEP_WHITESPACE = {"planned_work", "notes", "description", "estimate_description"}   # multi-line text


def clean(body: dict, allowed: set[str], entity: str) -> dict:
    """Reject unknown fields, trim text, turn "" into NULL / 0 where the column needs it, check fixed choices."""
    rejected = sorted(set(body) - allowed)
    if rejected:
        raise HTTPException(400, f"Fields not allowed for {entity}: {', '.join(rejected)}")
    out = {}
    for k, v in body.items():
        if isinstance(v, str) and k not in KEEP_WHITESPACE:
            v = v.strip()
        if v == "" and k in NULL_IF_EMPTY:
            v = None
        elif v in ("", None) and k in ZERO_IF_EMPTY:
            v = 0
        choices = CHOICES.get((entity, k))
        if choices is not None and v not in choices:
            raise HTTPException(400, f"{k} must be one of: {', '.join(sorted(choices))}")
        out[k] = v
    return out


def safe(fn, *args, **kwargs):
    """Run a database call and turn any database error into a readable 400 for the browser."""
    try:
        return fn(*args, **kwargs)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Database error")
        raise HTTPException(400, f"Database error: {e}")


def need(table: str, row_id) -> dict:
    """Fetch one row or answer 404 ("Visit not found", "Client not found", ...)."""
    row = safe(db.get_row, table, row_id)
    if not row:
        raise HTTPException(404, f"{table[:-1].capitalize()} not found")
    return row


def rows_in(table: str, project_ids: list[str], order: str) -> list[dict]:
    """All rows of `table` that belong to any of these projects."""
    if not project_ids:
        return []
    return safe(lambda: db.supabase.table(table).select("*").in_("project_id", project_ids)
                .order(order).execute().data or [])


def get_profile_row() -> dict:
    return need("profile", 1)


# =====================================================================================================
# 2. PERMISSIONS & APPROVAL RULES
# =====================================================================================================
def check_row_access(me: dict, entity: str, row: dict) -> None:
    """Employees may only change their own tasks and receipts, and never estimates/invoices."""
    if me["role"] != "Employee":
        return
    if entity == "invoices":
        raise HTTPException(403, "You don't have access to this.")
    if entity == "visits" and row.get("assigned_to") != me["id"]:
        raise HTTPException(403, "This task is assigned to someone else.")
    if entity == "receipts" and row.get("created_by") != me["id"]:
        raise HTTPException(403, "This receipt was entered by someone else.")


def check_assignee(member_id) -> None:
    """A task can only be assigned to an active team member (or nobody)."""
    if member_id is None:
        return
    m = safe(db.get_row, "team_members", member_id)
    if not m or not m.get("active"):
        raise HTTPException(400, "Please choose an active team member.")


# Changing these fields counts as "editing the record" (BR-02 / BR-06) when an Employee does it.
TRACKED = {
    "clients": {"name", "phone", "email", "street", "city", "state", "zip"},
    "projects": {"name", "street", "city", "state", "zip"},
    "visits": {"visit_date", "assigned_to"},
}
# Meta keys an Employee may change without a new approval: field notes, photo tags, time explanation.
QUIET_META = {"comments", "photo_categories", "variance_reason", "approval_status", "rejection_reason",
              "created_by_role", "submitted_by", "sent_to_client", "sent_date", "timer_start", "timer_by"}


def apply_approval_rules(entity: str, data: dict, me: dict, profile: dict, old: dict | None = None) -> None:
    """Set the approval status inside the row's meta, whatever the browser sent (edits `data` in place).

    Approvals switched OFF (Settings): everything is simply Approved.
    Approvals ON:
      - Employee creates or edits a client / project / task  -> Pending Approval (field notes, photos excepted)
      - Employee receipt above the Owner's threshold           -> Pending Approval
      - Manager creates an invoice                             -> Pending Approval (only the Owner approves)
      - Employees can never approve; Managers can't approve invoices.
    """
    col = META_COLUMN.get(entity)
    if not col:
        return
    role = me["role"]
    old_text, old_meta = unpack(old.get(col)) if old else ("", {})
    touched = col in data
    text, meta = unpack(data[col]) if touched else (old_text, dict(old_meta))
    new = dict(meta)
    old_status = old_meta.get("approval_status", "Approved")

    def set_status(status, reason=""):
        new["approval_status"] = status
        new["rejection_reason"] = reason

    if not profile.get("approvals_required", True):
        if new.get("approval_status", "Approved") != "Approved":
            set_status("Approved")
    elif role == "Employee":
        new["created_by_role"] = old_meta.get("created_by_role", "Employee") if old else "Employee"
        if entity == "receipts":
            amount = money(data.get("amount", old.get("amount") if old else 0))
            if amount <= money(profile.get("expense_threshold")):
                set_status("Approved")
            elif not old or "amount" in data and amount != money(old.get("amount")):
                set_status("PendingApproval")
            else:
                set_status(old_status, old_meta.get("rejection_reason", ""))
        elif entity in TRACKED:
            if not old:
                changed = True
            else:
                changed = any(k in data and data[k] != old.get(k) for k in TRACKED[entity])
                if touched:
                    loud = lambda m: {k: v for k, v in m.items() if k not in QUIET_META}
                    changed = changed or text != old_text or loud(meta) != loud(old_meta)
            if changed:
                set_status("PendingApproval")
            else:
                set_status(old_status, old_meta.get("rejection_reason", ""))
    elif role == "Manager" and entity == "invoices":
        if not old:
            new["created_by_role"] = "Manager"
            set_status("PendingApproval")
        else:   # a Manager can't approve or reject invoices
            set_status(old_status, old_meta.get("rejection_reason", ""))

    if new != (meta if touched else old_meta):
        data[col] = pack(text, new)


# =====================================================================================================
# 3. MY PROFILE / SETTINGS (one row, id = 1). Everyone signed in may read the company name; only the Owner edits.
# =====================================================================================================
@app.patch("/api/profile")
def patch_profile(body: dict, me: dict = Depends(current_member)):
    require(me, "Owner")
    data = clean(body, FIELDS["profile"], "profile")
    if "approvals_required" in data:
        data["approvals_required"] = bool(data["approvals_required"])
    return safe(db.update_row, "profile", 1, data)


# =====================================================================================================
# 4. ADDRESS AUTOCOMPLETE (Photon / OpenStreetMap: free, no API key). US street addresses only.
# =====================================================================================================
US_STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO",
    "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}


@lru_cache(maxsize=300)   # only successful lookups are cached (errors raise); keeps us inside Photon's fair use
def photon_search(q: str) -> tuple:
    params = {"q": q, "limit": 12, "lang": "en"}
    bias = os.getenv("ADDRESS_BIAS")   # optional "lat,lon" in .env: ranks addresses near you first
    if bias:
        lat, lon = bias.split(",")
        params.update({"lat": lat.strip(), "lon": lon.strip()})
    req = urllib.request.Request("https://photon.komoot.io/api/?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": "FieldServiceCRM/1.0"})
    with urllib.request.urlopen(req, timeout=6) as r:
        features = json.load(r).get("features", [])
    out = []
    for f in features:
        p = f.get("properties", {})
        if p.get("countrycode") != "US" or not p.get("street"):
            continue
        street = " ".join(x for x in (p.get("housenumber"), p["street"]) if x)
        city = p.get("city") or p.get("locality") or p.get("district") or ""
        state = US_STATES.get(p.get("state", ""), p.get("state", ""))
        zip_ = p.get("postcode", "")
        label = ", ".join(x for x in (street, city, f"{state} {zip_}".strip()) if x)
        out.append((label, street, city, state, zip_))
        if len(out) == 5:
            break
    return tuple(out)


@app.get("/api/address-search")
def address_search(q: str = "", me: dict = Depends(current_member)):
    q = q.strip()
    if len(q) < 4:
        return []
    try:
        rows = photon_search(q.lower())
    except Exception:
        log.warning("Address lookup failed", exc_info=True)
        return []   # the user can always type the address by hand
    return [{"label": l, "street": s, "city": c, "state": st, "zip": z} for l, s, c, st, z in rows]


# =====================================================================================================
# 5. BOOTSTRAP: everything the signed-in person may see, in ONE request.
#    Employees get their own tasks and receipts only, and no money data at all.
# =====================================================================================================
@app.get("/api/bootstrap")
def bootstrap(me: dict = Depends(current_member)):
    profile = get_profile_row()
    clients = safe(db.fetch_all, "clients")
    projects = safe(db.fetch_all, "projects")
    visits = safe(db.fetch_all, "visits")
    receipts = safe(db.fetch_all, "receipts")
    team = safe(db.fetch_all, "team_members")
    is_employee = me["role"] == "Employee"

    if is_employee:
        visits = [v for v in visits if v.get("assigned_to") == me["id"]]
        receipts = [r for r in receipts if r.get("created_by") == me["id"]]
        documents = []
        projects = [{k: v for k, v in p.items() if not k.startswith("estimate_") or k == "estimate_description"}
                    for p in projects]
        profile = {k: profile.get(k) for k in ("id", "company_name", "expense_threshold", "approvals_required")}
    else:
        documents = safe(db.fetch_all, "invoices")
        by_invoice = defaultdict(list)
        for r in receipts:
            if r.get("invoice_id"):
                by_invoice[r["invoice_id"]].append(r)
        for d in documents:   # invoices made before line items existed get their lines rebuilt
            if d.get("line_items") is None:
                d["line_items"] = legacy_line_items(d, by_invoice[d["id"]])

    # Unpaid invoices -> red [ 🔴 $450 ] badges next to the client and the project
    client_debt, project_debt = defaultdict(Decimal), defaultdict(Decimal)
    for d in documents:
        if d.get("kind", "invoice") == "invoice" and d["status"] == "Unpaid":
            client_debt[d["client_id"]] += money(d["total"])
            project_debt[d["project_id"]] += money(d["total"])

    return {
        "me": public_member(me, True, cost=me["role"] == "Owner"),
        "profile": profile,
        "team": [public_member(m, not is_employee, cost=me["role"] == "Owner") for m in sorted(team, key=lambda m: (m.get("name") or "").lower())],
        "clients": sorted(clients, key=lambda c: (c.get("name") or "").lower()),
        "projects": sorted(projects, key=lambda p: p.get("created_at") or "", reverse=True),
        "visits": sorted(visits, key=lambda v: v.get("visit_date") or ""),
        "invoices": sorted(documents, key=lambda i: (i.get("invoice_date") or "", i.get("created_at") or ""), reverse=True),
        "receipts": sorted(receipts, key=lambda r: r.get("receipt_date") or "", reverse=True),
        "client_debt": {k: float(v) for k, v in client_debt.items()},
        "project_debt": {k: float(v) for k, v in project_debt.items()},
    }


# =====================================================================================================
# 6. ESTIMATES & INVOICES ("documents") - created from the one "+ New" button
# =====================================================================================================
def next_number(kind: str) -> str:
    """INV-0001, INV-0002, ... / EST-0001, ... (highest existing number of that kind + 1).
    schema.sql adds a unique index, so two clicks at the same moment can't share a number."""
    prefix = "EST" if kind == "estimate" else "INV"
    nums = []
    for r in db.fetch_all("invoices", "id,invoice_number,kind"):
        if r.get("kind", "invoice") != kind:
            continue
        digits = "".join(ch for ch in (r.get("invoice_number") or "") if ch.isdigit())
        if digits:
            nums.append(int(digits))
    return f"{prefix}-{max(nums, default=0) + 1:04d}"


@app.post("/api/documents")
def create_document(body: dict, me: dict = Depends(current_member)):
    """Create an estimate or an invoice for a project, already filled in:
       estimate -> one line per planned task (Planned Work -> Estimate)
       invoice  -> the project's estimate (first invoice / "Convert to invoice"), otherwise completed tasks
                   nobody billed yet (Estimate skipped -> straight from the tasks), plus unbilled billable receipts.
    body = {kind: "invoice" | "estimate", project_id, visit_id?: task you were looking at, from_estimate?: id}"""
    require(me, *MONEY_ROLES)
    kind = body.get("kind") or "invoice"
    if kind not in ("invoice", "estimate"):
        raise HTTPException(400, "kind must be invoice or estimate")
    project = need("projects", body.get("project_id"))
    profile = get_profile_row()
    rate = money(profile.get("default_hourly_rate"))
    tasks = safe(db.select_where, "visits", "project_id", project["id"], order="visit_date")
    docs = safe(db.select_where, "invoices", "project_id", project["id"])
    invoices = [d for d in docs if d.get("kind", "invoice") == "invoice"]
    receipts, estimate_id, visit_ids = [], None, []

    if kind == "estimate":
        items = estimate_lines(tasks, rate)
    else:
        visit_id = body.get("visit_id") or None
        if visit_id:
            visit = next((t for t in tasks if t["id"] == visit_id), None)
            if not visit:
                raise HTTPException(400, "That task is not part of this project.")
            if visit["status"] == "Canceled":
                raise HTTPException(400, "A canceled task cannot be invoiced.")
        converted = {d.get("estimate_id") for d in invoices}
        estimate = None
        if body.get("from_estimate"):
            estimate = next((d for d in docs if d["id"] == body["from_estimate"] and d.get("kind") == "estimate"), None)
            if not estimate:
                raise HTTPException(404, "Estimate not found")
            if estimate["id"] in converted:
                raise HTTPException(400, "This estimate was already turned into an invoice.")
        elif not invoices:   # the project's first invoice starts from its newest estimate, if any
            newest = latest_estimates(docs).get(project["id"])
            estimate = newest if newest and newest["id"] not in converted else None
        estimate_id = estimate["id"] if estimate else None
        billed = {v for d in invoices for v in (d.get("visit_ids") or [])} | {d["visit_id"] for d in invoices if d.get("visit_id")}
        receipts = [r for r in safe(db.select_where, "receipts", "project_id", project["id"])
                    if r["billable"] and not r["invoice_id"]]
        items, visit_ids = invoice_lines(tasks, billed, rate, receipts, estimate, include_visit=visit_id)

    row = {
        "kind": kind, "project_id": project["id"], "client_id": project["client_id"],
        "visit_id": visit_ids[0] if visit_ids else None, "visit_ids": visit_ids, "estimate_id": estimate_id,
        "invoice_number": next_number(kind), "invoice_date": db.today_local(), "status": "Unpaid",
        "description": "", "line_items": items, "hourly_rate": str(rate), **document_totals(items),
    }
    if kind == "invoice":
        apply_approval_rules("invoices", row, me, profile)
    doc = safe(db.insert_row, "invoices", row)
    receipt_ids = [i["receipt_id"] for i in items if i.get("receipt_id")]
    if kind == "invoice" and receipt_ids:   # mark as Invoiced so they can't be billed twice
        safe(lambda: db.supabase.table("receipts").update({"invoice_id": doc["id"]}).in_("id", receipt_ids).execute())
    return doc


@app.get("/api/invoices/{invoice_id}/pdf")
def invoice_pdf(invoice_id: str, download: int = 0, me: dict = Depends(current_member)):
    """download=0 opens the PDF in the browser (View), download=1 saves it (Download PDF)."""
    require(me, *MONEY_ROLES)
    try:
        from invoice_pdf import build_invoice_pdf
    except ImportError:
        raise HTTPException(503, "PDF support is not installed. Run: pip install reportlab")
    doc = need("invoices", invoice_id)
    items = doc.get("line_items")
    if items is None:
        items = legacy_line_items(doc, safe(db.select_where, "receipts", "invoice_id", invoice_id))
    pdf = build_invoice_pdf(doc, need("clients", doc["client_id"]), need("projects", doc["project_id"]),
                            get_profile_row(), items)
    name = f"{doc.get('invoice_number') or 'document'}.pdf"
    kind = "attachment" if download else "inline"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'{kind}; filename="{name}"'})


# =====================================================================================================
# 7. INCOME & EXPENSE REPORT - the same numbers for the whole business, a client, a project or a visit
# =====================================================================================================
def valid_date(text: str) -> str:
    if text:
        try:
            datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "Dates must look like YYYY-MM-DD.")
    return text


def report_data(scope: str, ref: str) -> tuple[list, list, list]:
    """Projects, documents and receipts of one report scope: all | client | project | visit (ref = its id)."""
    if scope == "all":
        projects = safe(db.fetch_all, "projects")
        documents, receipts = safe(db.fetch_all, "invoices"), safe(db.fetch_all, "receipts")
    elif scope in ("client", "project", "visit"):
        if scope == "client":
            need("clients", ref)
            projects = safe(db.select_where, "projects", "client_id", ref)
        elif scope == "project":
            projects = [need("projects", ref)]
        else:
            projects = [need("projects", need("visits", ref)["project_id"])]
        ids = [p["id"] for p in projects]
        documents, receipts = rows_in("invoices", ids, "invoice_date"), rows_in("receipts", ids, "receipt_date")
        if scope == "visit":
            documents = [d for d in documents if ref in (d.get("visit_ids") or []) or d.get("visit_id") == ref]
            receipts = [r for r in receipts if r.get("visit_id") == ref]
    else:
        raise HTTPException(404, "Unknown report scope")
    return projects, documents, receipts


@app.get("/api/report")
def get_report(scope: str = "all", ref: str = "", start: str = "", end: str = "", me: dict = Depends(current_member)):
    """The numbers of the Income & Expense cards. start/end = optional date range (YYYY-MM-DD)."""
    require(me, *MONEY_ROLES)
    start, end = valid_date(start), valid_date(end)
    projects, documents, receipts = report_data(scope, ref)
    clients = {c["id"]: c["name"] for c in safe(db.fetch_all, "clients", "id,name")}
    labels = {p["id"]: f"{clients.get(p['client_id'], '')} / {p['name']}" for p in projects}
    # the estimate belongs to a whole project, so comparing it with one task's invoices would mislead
    return compute_report(documents, receipts, projects, start, end, labels, with_estimate=scope != "visit")


@app.get("/api/reports/{kind}")
def reports_data(kind: str, start: str = "", end: str = "", prev_start: str = "", prev_end: str = "",
                 me: dict = Depends(current_member)):
    """Money > Reports. kind = overview | income | expenses | debts | jobs | team (see reports.py).
    Labor cost and profit are included only for the Owner."""
    require(me, *MONEY_ROLES)
    start, end, prev_start, prev_end = (valid_date(x) for x in (start, end, prev_start, prev_end))
    ctx = make_ctx(safe(db.fetch_all, "clients"), safe(db.fetch_all, "projects"), safe(db.fetch_all, "visits"),
                   safe(db.fetch_all, "invoices"), safe(db.fetch_all, "receipts"), safe(db.fetch_all, "team_members"))
    with_cost = me["role"] == "Owner"
    if kind == "overview":
        return overview(ctx, start, end, prev_start, prev_end, db.today_local(), with_cost)
    if kind not in REPORT_COLUMNS:
        raise HTTPException(404, "Unknown report")
    return dataset(kind, ctx, start, end, db.today_local(), with_cost)


@app.post("/api/reports/pdf")
def report_table_pdf(body: dict, me: dict = Depends(current_member)):
    """PDF of the report table exactly as the browser shows it (columns, groups, subtotals, total)."""
    require(me, *MONEY_ROLES)
    columns, rows = body.get("columns") or [], body.get("rows") or []
    if not isinstance(columns, list) or not isinstance(rows, list) or not columns:
        raise HTTPException(400, "Nothing to print")
    pdf = table_pdf(str(body.get("title") or "Report")[:200], str(body.get("subtitle") or "")[:500],
                    get_profile_row().get("company_name") or "", columns, rows)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="report.pdf"'})


@app.get("/api/report/export")
def export_report(format: str = "csv", scope: str = "all", ref: str = "", start: str = "", end: str = "",
                  me: dict = Depends(current_member)):
    """The same report as a file: every income and expense line + totals. format = csv | pdf."""
    require(me, *MONEY_ROLES)
    if format not in ("csv", "pdf"):
        raise HTTPException(400, "format must be csv or pdf")
    start, end = valid_date(start), valid_date(end)
    projects, documents, receipts = report_data(scope, ref)
    clients = {c["id"]: c["name"] for c in safe(db.fetch_all, "clients", "id,name")}
    income, expenses, totals = report_rows(documents, receipts, projects, clients, start, end)

    what = {"all": "Whole business", "client": f"Client: {clients.get(ref, '')}",
            "project": f"Project: {projects[0]['name'] if projects and scope == 'project' else ''}",
            "visit": "One task"}.get(scope, "")
    title = f"Income & Expense Report · {what} · {period_label(start, end)}"
    name = f"income-expense_{start or 'all'}_{end or 'time'}.{format}"
    if format == "csv":
        return Response(content=to_csv(income, expenses, totals, title), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    pdf = to_pdf(income, expenses, totals, title, get_profile_row().get("company_name") or "")
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# =====================================================================================================
# 8. PHOTOS for tasks and receipts. The browser compresses first (api.js); files live in Supabase Storage,
#    the table row keeps their public links in image_urls.
# =====================================================================================================
MAX_PHOTO_BYTES = 3 * 1024 * 1024   # safety net only: the browser already sends <= 500 KB
PHOTO_TYPES = {"image/webp": "webp", "image/jpeg": "jpg", "image/png": "png"}


@app.post("/api/photos")
def upload_photo(kind: str = Form(...), row_id: str = Form(...), file: UploadFile = File(...),
                 me: dict = Depends(current_member)):
    # plain `def` (not async): FastAPI runs it in a thread, so the slow Storage upload doesn't block other requests
    if kind not in ("visits", "receipts"):
        raise HTTPException(400, "Photos can only be attached to tasks or receipts.")
    row = need(kind, row_id)
    check_row_access(me, kind, row)
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    ext = PHOTO_TYPES.get(ctype)
    if not ext:
        raise HTTPException(415, "Photos must be WebP, JPEG or PNG.")
    data = file.file.read(MAX_PHOTO_BYTES + 1)
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "Photo is too large (max 3 MB after compression).")
    path = f"{row['project_id']}/{kind}/{row_id}/{uuid4().hex}.{ext}"   # folders: project / visits|receipts / record
    try:
        bucket = db.supabase.storage.from_(db.BUCKET)
        bucket.upload(path, data, {"content-type": ctype})
        url = bucket.get_public_url(path)
    except Exception as e:
        log.exception("Photo upload failed")
        raise HTTPException(400, f"Storage error: {e}")
    urls = list(row.get("image_urls") or []) + [url]
    safe(db.update_row, kind, row_id, {"image_urls": urls})
    return {"image_urls": urls}


# =====================================================================================================
# 9. GENERIC CREATE / AUTO-SAVE (PATCH) / DELETE for every table
# =====================================================================================================
@app.post("/api/{entity}")
def create(entity: str, body: dict, me: dict = Depends(current_member)):
    if entity not in CREATABLE:
        raise HTTPException(404, "Unknown or non-creatable entity")
    data = clean(body, FIELDS[entity] | PARENTS.get(entity, set()), entity)
    missing = [p for p in REQUIRED_PARENT.get(entity, []) if not data.get(p)]
    if missing:
        raise HTTPException(400, f"Missing: {', '.join(missing)}")

    if entity == "visits":
        if me["role"] == "Employee":   # employees create tasks for themselves
            data["assigned_to"] = me["id"]
        check_assignee(data.get("assigned_to"))
        data["visit_date"] = data.get("visit_date") or db.today_local()
    if entity == "receipts":
        data["created_by"] = me["id"]
        data["receipt_date"] = data.get("receipt_date") or db.today_local()
    if entity == "projects" and not any(data.get(k) for k in ("street", "city", "state", "zip")):
        client = safe(db.get_row, "clients", data["client_id"])   # address flows Client Card -> Project
        if client:
            data.update({k: client.get(k) or "" for k in ("street", "city", "state", "zip")})

    profile = get_profile_row()
    apply_approval_rules(entity, data, me, profile)
    row = safe(db.insert_row, entity, data)

    if entity == "projects":   # a project always starts with its first task; the browser reuses it
        first = {"project_id": row["id"], "visit_date": db.today_local(), "status": "Scheduled",
                 "assigned_to": me["id"] if me["role"] == "Employee" else None}
        apply_approval_rules("visits", first, me, profile)
        row["first_visit_id"] = safe(db.insert_row, "visits", first)["id"]
    return row


@app.patch("/api/{entity}/{row_id}")
def patch(entity: str, row_id: str, body: dict, me: dict = Depends(current_member)):
    """Auto-save: the browser sends only the fields that changed."""
    if entity not in FIELDS or entity == "profile":
        raise HTTPException(404, "Unknown entity")
    if entity == "invoices":
        require(me, *MONEY_ROLES)
    data = clean(body, FIELDS[entity], entity)
    old = need(entity, row_id)
    check_row_access(me, entity, old)

    if entity == "visits" and "assigned_to" in data:
        if me["role"] == "Employee" and data["assigned_to"] != old.get("assigned_to"):
            raise HTTPException(403, "Only a Manager or the Owner can reassign a task.")
        check_assignee(data["assigned_to"])
    if entity == "receipts" and "billable" in data and old.get("invoice_id"):
        raise HTTPException(400, "This receipt is already on an invoice. Delete that invoice to release it.")

    if entity == "invoices":
        is_estimate = old.get("kind") == "estimate"
        if "status" in data:   # [ Unpaid ] <-> [ Paid ] in one tap
            if is_estimate:
                raise HTTPException(400, "Estimates have no payment status.")
            data["paid_date"] = (data.get("paid_date") or old.get("paid_date") or db.today_local()) \
                if data["status"] == "Paid" else None
        if "line_items" in data:
            try:
                items = clean_line_items(data["line_items"])
            except ValueError as e:
                raise HTTPException(400, str(e))
            data["line_items"] = items
            data.update(document_totals(items))
            if not is_estimate:   # a material line was removed -> its receipt can be billed again
                kept = {i.get("receipt_id") for i in items}
                gone = [i["receipt_id"] for i in (old.get("line_items") or [])
                        if i.get("receipt_id") and i["receipt_id"] not in kept]
                if gone:
                    safe(lambda: db.supabase.table("receipts").update({"invoice_id": None})
                         .in_("id", gone).eq("invoice_id", row_id).execute())

    apply_approval_rules(entity, data, me, get_profile_row(), old)

    # a photo was removed in the browser -> its file is deleted from Storage too (worked out before saving)
    removed = set(old.get("image_urls") or []) - set(data["image_urls"] or []) if "image_urls" in data else set()
    row = safe(db.update_row, entity, row_id, data)
    db.delete_photos(removed)
    return row


@app.delete("/api/{entity}/{row_id}")
def delete(entity: str, row_id: str, me: dict = Depends(current_member)):
    if entity not in DELETABLE:
        raise HTTPException(404, "Unknown entity")
    if me["role"] == "Employee":
        raise HTTPException(403, "Only a Manager or the Owner can delete records.")
    need(entity, row_id)
    if entity == "invoices":   # its receipts become billable again (works whatever the database FK rule is)
        safe(lambda: db.supabase.table("receipts").update({"invoice_id": None}).eq("invoice_id", row_id).execute())
    urls = db.collect_photo_urls(entity, row_id)   # collect first: rows cascade in the database, files don't
    safe(db.delete_row, entity, row_id)
    db.delete_photos(urls)
    return {"status": "deleted"}


# =====================================================================================================
# 10. THE BROWSER APP (static/index.html + styles.css + api.js + app.js)
# =====================================================================================================
@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

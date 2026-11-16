"""main.py - FastAPI routes only. Data access lives in database.py."""
import os
import json
import logging
import urllib.parse
import urllib.request
from collections import defaultdict
from functools import lru_cache
from decimal import Decimal
from pathlib import Path

from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import database as db
from billing import money, compute_invoice

log = logging.getLogger("crm")
BASE_DIR = Path(__file__).parent

CORS_ORIGINS = [
    o.strip() for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
]

app = FastAPI(title="Field Service CRM API")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])

# ---------- what the client may write (anything else -> 400) ----------
FIELDS = {
    "profile":  {"company_name", "phone", "email", "business_address", "payment_details",
                 "default_hourly_rate", "logo_url"},
    "clients":  {"name", "phone", "email", "street", "city", "state", "zip", "notes"},
    "projects": {"name", "street", "city", "state", "zip", "estimate_mode", "estimate_description",
                 "estimate_fixed", "estimate_rate", "estimate_hours"},
    "visits":   {"visit_date", "planned_work", "time_spent", "status", "image_urls"},
    "receipts": {"amount", "store", "category", "receipt_date", "billable", "image_urls"},
    "invoices": {"status", "paid_date", "invoice_date", "description", "labor_amount", "materials_amount"},
}
# parent keys: accepted on create only, never on PATCH
PARENTS = {"projects": {"client_id"}, "visits": {"project_id"}, "receipts": {"project_id", "visit_id"}}
REQUIRED_PARENT = {"projects": ["client_id"], "visits": ["project_id"], "receipts": ["project_id"]}
CREATABLE = {"clients", "projects", "visits", "receipts"}   # invoices are created from a visit (Step 5)
DELETABLE = {"clients", "projects", "visits", "receipts", "invoices"}

NULL_IF_EMPTY = {"estimate_mode", "estimate_fixed", "estimate_rate", "estimate_hours", "paid_date", "visit_id"}
ZERO_IF_EMPTY = {"time_spent", "amount", "default_hourly_rate", "labor_amount", "materials_amount"}


def clean(body: dict, allowed: set[str], entity: str) -> dict:
    rejected = sorted(set(body) - allowed)
    if rejected:
        raise HTTPException(400, f"Fields not allowed for {entity}: {', '.join(rejected)}")
    out = {}
    for k, v in body.items():
        if isinstance(v, str):
            v = v.strip() if k not in ("planned_work", "notes", "description", "estimate_description") else v
        if v == "" and k in NULL_IF_EMPTY:
            v = None
        elif v in ("", None) and k in ZERO_IF_EMPTY:
            v = 0
        out[k] = v
    return out


def safe(fn, *args, **kwargs):
    """Run a DB call; turn database errors into a readable 400."""
    try:
        return fn(*args, **kwargs)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Database error")
        raise HTTPException(400, f"Database error: {e}")


def need(table: str, row_id: str) -> dict:
    row = safe(db.get_row, table, row_id)
    if not row:
        raise HTTPException(404, f"{table[:-1].capitalize()} not found")
    return row


def unpaid_total(invoices: list[dict]) -> float:
    return float(sum((money(i["total"]) for i in invoices if i["status"] == "Unpaid"), Decimal(0)))


# ---------- My Profile ----------
@app.get("/api/profile")
def get_profile():
    return need("profile", 1)


@app.patch("/api/profile")
def patch_profile(body: dict):
    data = clean(body, FIELDS["profile"], "profile")
    return safe(db.update_row, "profile", 1, data)


# ---------- Address autocomplete (Photon / OpenStreetMap: free, no API key) ----------
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


@lru_cache(maxsize=300)   # only successful lookups are cached; keeps us well inside Photon's fair-use limits
def photon_search(q: str) -> tuple:
    params = {"q": q, "limit": 12, "lang": "en"}
    bias = os.getenv("ADDRESS_BIAS")   # optional "lat,lon" in .env: ranks nearby results first
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
def address_search(q: str = ""):
    q = q.strip()
    if len(q) < 4:
        return []
    try:
        rows = photon_search(q.lower())
    except Exception:
        log.warning("Address lookup failed", exc_info=True)
        return []   # user can always type the address by hand
    return [{"label": l, "street": s, "city": c, "state": st, "zip": z} for l, s, c, st, z in rows]


# ---------- Navigation tree: Client -> Project -> Visits (+ debt badges) ----------
@app.get("/api/tree")
def get_tree():
    clients = sorted(db.fetch_all("clients", "id,name,phone"), key=lambda c: (c["name"] or "").lower())
    projects = db.fetch_all("projects", "id,client_id,name,created_at")
    visits = db.fetch_all("visits", "id,project_id,visit_date,status")
    unpaid = db.fetch_all("invoices", "id,project_id,client_id,total", status="Unpaid")

    debt_project, debt_client = defaultdict(Decimal), defaultdict(Decimal)
    for inv in unpaid:
        debt_project[inv["project_id"]] += money(inv["total"])
        debt_client[inv["client_id"]] += money(inv["total"])

    visits_by_project = defaultdict(list)
    for v in sorted(visits, key=lambda v: v["visit_date"]):
        visits_by_project[v["project_id"]].append(v)

    projects_by_client = defaultdict(list)
    for p in sorted(projects, key=lambda p: p["created_at"], reverse=True):
        projects_by_client[p["client_id"]].append({
            "id": p["id"], "name": p["name"],
            "debt": float(debt_project[p["id"]]),
            "visits": visits_by_project[p["id"]],
        })

    return [{
        "id": c["id"], "name": c["name"],
        "debt": float(debt_client[c["id"]]),
        "projects": projects_by_client[c["id"]],
    } for c in clients]


# ---------- ONE workspace for every level: same shape, different scope ----------
def rows_in(table: str, project_ids: list[str], order: str, desc: bool = False) -> list[dict]:
    if not project_ids:
        return []
    return (db.supabase.table(table).select("*").in_("project_id", project_ids)
            .order(order, desc=desc).execute().data or [])


@app.get("/api/scope/{kind}/{row_id}")
def get_scope(kind: str, row_id: str):
    """kind = client | project | visit. Returns everything connected to that node:
    the client, the projects in scope, and their visits / invoices / receipts.
    client: all projects of the client | project: that project | visit: only that visit's data."""
    visit = None
    if kind == "client":
        client = need("clients", row_id)
        projects = db.select_where("projects", "client_id", row_id, order="created_at", desc=True)
    elif kind == "project":
        project = need("projects", row_id)
        client, projects = need("clients", project["client_id"]), [project]
    elif kind == "visit":
        visit = need("visits", row_id)
        project = need("projects", visit["project_id"])
        client, projects = need("clients", project["client_id"]), [project]
    else:
        raise HTTPException(404, "Unknown scope")

    ids = [p["id"] for p in projects]
    visits = rows_in("visits", ids, "visit_date")
    invoices = rows_in("invoices", ids, "invoice_date", desc=True)
    receipts = rows_in("receipts", ids, "receipt_date", desc=True)
    if visit:   # visit level: only what belongs to this visit
        visits = [visit]
        invoices = [i for i in invoices if i["visit_id"] == row_id]
        receipts = [r for r in receipts if r.get("visit_id") == row_id]
    return {
        "kind": kind, "client": client, "projects": projects,
        "visits": visits, "invoices": invoices, "receipts": receipts,
        # canceled visits are excluded from total hours
        "total_hours": float(sum((money(v["time_spent"]) for v in visits if v["status"] != "Canceled"), Decimal(0))),
        "debt": unpaid_total(invoices),
        "default_rate": float(money(need("profile", 1).get("default_hourly_rate"))),
    }


# ---------- Create Invoice (lives inside a Visit only) ----------
def next_invoice_number() -> str:
    nums = []
    for r in db.fetch_all("invoices", "id,invoice_number"):
        digits = "".join(ch for ch in (r.get("invoice_number") or "") if ch.isdigit())
        if digits:
            nums.append(int(digits))
    return f"INV-{max(nums, default=0) + 1:04d}"


@app.post("/api/visits/{visit_id}/invoice")
def create_invoice(visit_id: str):
    visit = need("visits", visit_id)
    if visit["status"] == "Canceled":
        raise HTTPException(400, "A canceled visit cannot be invoiced.")
    project = need("projects", visit["project_id"])
    profile = need("profile", 1)
    is_first = not db.select_where("invoices", "project_id", project["id"], columns="id")
    # billable receipts of this project that are not invoiced yet (this visit's or not tied to a visit)
    receipts = [r for r in db.select_where("receipts", "project_id", project["id"])
                if r["billable"] and not r["invoice_id"] and r.get("visit_id") in (None, visit_id)]
    visit_invoiced = bool(db.select_where("invoices", "visit_id", visit_id, columns="id"))
    calc = compute_invoice(project, profile, visit, receipts, is_first, visit_already_invoiced=visit_invoiced)
    est = calc["estimate_amount"]   # an empty ($0) invoice is allowed: the user fills it in by hand
    invoice = safe(db.insert_row, "invoices", {
        "visit_id": visit_id, "project_id": project["id"], "client_id": project["client_id"],
        "invoice_number": next_invoice_number(), "invoice_date": db.today_local(), "status": "Unpaid",
        "description": calc["description"], "hours": str(calc["hours"]), "hourly_rate": str(calc["hourly_rate"]),
        "labor_amount": str(calc["labor_amount"]), "materials_amount": str(calc["materials_amount"]),
        "total": str(calc["total"]), "estimate_amount": None if est is None else str(est),
    })
    if receipts:   # mark as Invoiced so they can't be billed twice
        safe(lambda: db.supabase.table("receipts").update({"invoice_id": invoice["id"]})
             .in_("id", [r["id"] for r in receipts]).execute())
    return invoice


@app.get("/api/invoices/{invoice_id}/pdf")
def invoice_pdf(invoice_id: str, download: int = 0):
    try:
        from invoice_pdf import build_invoice_pdf
    except ImportError:
        raise HTTPException(503, "PDF support is not installed. Run: pip install reportlab")
    invoice = need("invoices", invoice_id)
    pdf = build_invoice_pdf(
        invoice, need("clients", invoice["client_id"]), need("projects", invoice["project_id"]),
        need("profile", 1), db.select_where("receipts", "invoice_id", invoice_id, order="receipt_date"))
    name = f"{invoice.get('invoice_number') or 'invoice'}.pdf"
    kind = "attachment" if download else "inline"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'{kind}; filename="{name}"'})


# ---------- Photos for visits and receipts (browser compresses first; files live in Supabase Storage) ----------
MAX_PHOTO_BYTES = 3 * 1024 * 1024
PHOTO_TYPES = {"image/webp": "webp", "image/jpeg": "jpg", "image/png": "png"}


@app.post("/api/photos")
def upload_photo(kind: str = Form(...), row_id: str = Form(...), file: UploadFile = File(...)):
    # plain `def`: FastAPI runs it in a threadpool, so the blocking Storage call doesn't freeze the server
    if kind not in ("visits", "receipts"):
        raise HTTPException(400, "Photos can only be attached to visits or receipts.")
    row = need(kind, row_id)
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


# ---------- Generic CRUD: create / PATCH (auto-save) / delete ----------
@app.post("/api/{entity}")
def create(entity: str, body: dict):
    if entity not in CREATABLE:
        raise HTTPException(404, "Unknown or non-creatable entity")
    data = clean(body, FIELDS[entity] | PARENTS.get(entity, set()), entity)
    missing = [p for p in REQUIRED_PARENT.get(entity, []) if not data.get(p)]
    if missing:
        raise HTTPException(400, f"Missing: {', '.join(missing)}")
    if entity == "projects" and not any(data.get(k) for k in ("street", "city", "state", "zip")):
        client = safe(db.get_row, "clients", data["client_id"])   # address flows Client Card -> Project
        if client:
            data.update({k: client.get(k) or "" for k in ("street", "city", "state", "zip")})
    if entity == "visits" and not data.get("visit_date"):
        data["visit_date"] = db.today_local()
    if entity == "receipts" and not data.get("receipt_date"):
        data["receipt_date"] = db.today_local()
    row = safe(db.insert_row, entity, data)
    if entity == "projects":   # a project always starts with its first visit
        safe(db.insert_row, "visits", {"project_id": row["id"], "visit_date": db.today_local(), "status": "Scheduled"})
    return row


@app.patch("/api/{entity}/{row_id}")
def patch(entity: str, row_id: str, body: dict):
    if entity not in FIELDS or entity == "profile":
        raise HTTPException(404, "Unknown entity")
    data = clean(body, FIELDS[entity], entity)
    old = need(entity, row_id)
    if entity == "receipts" and "billable" in data and old.get("invoice_id"):
        raise HTTPException(400, "This receipt is already on an invoice. Delete that invoice to release it.")

    if entity == "invoices" and "status" in data:       # [ Unpaid ] <-> [ Paid ] in one tap
        if data["status"] == "Paid":
            data["paid_date"] = data.get("paid_date") or old.get("paid_date") or db.today_local()
        else:
            data["paid_date"] = None
    if entity == "invoices" and ("labor_amount" in data or "materials_amount" in data):
        merged = {**old, **data}
        data["total"] = str(money(merged["labor_amount"]) + money(merged["materials_amount"]))

    row = safe(db.update_row, entity, row_id, data)

    if "image_urls" in data:                            # photo removed in UI -> delete file from Storage
        removed = set(old.get("image_urls") or []) - set(data["image_urls"] or [])
        db.delete_photos(removed)
    return row


@app.delete("/api/{entity}/{row_id}")
def delete(entity: str, row_id: str):
    if entity not in DELETABLE:
        raise HTTPException(404, "Unknown entity")
    need(entity, row_id)
    urls = db.collect_photo_urls(entity, row_id)        # collect first: DB rows cascade, files don't
    safe(db.delete_row, entity, row_id)
    db.delete_photos(urls)
    return {"status": "deleted"}


# ---------- Frontend (put index.html, styles.css, api.js, app.js in ./static) ----------
@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

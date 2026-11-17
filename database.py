"""database.py - the only file that talks to Supabase.

Two kinds of storage:
    * PostgreSQL tables (profile, clients, projects, visits, receipts, invoices) - see schema.sql
    * Storage bucket "crm-photos" - the photo files themselves (rows only keep their links in image_urls)

No business rules here: main.py decides WHAT to read or write, this file only knows HOW.
"""
import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()   # reads SUPABASE_URL / SUPABASE_KEY / APP_TIMEZONE from .env

log = logging.getLogger("crm")

# The backend needs the SECRET (service_role) key. Run `python check_storage.py` if uploads fail.
supabase: Client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
BUCKET = "crm-photos"
APP_TZ = ZoneInfo(os.getenv("APP_TIMEZONE", "America/New_York"))   # "today" means today in YOUR time zone


def today_local() -> str:
    """Today's date as YYYY-MM-DD in the business time zone (not the server's, not UTC)."""
    return datetime.now(APP_TZ).strftime("%Y-%m-%d")


# =====================================================================================================
# Generic row helpers
# =====================================================================================================
def fetch_all(table: str, columns: str = "*", page: int = 1000, **eq) -> list[dict]:
    """Every row of a table. Supabase returns at most ~1000 rows per request, so this pages through them.
    eq = optional column filters, e.g. fetch_all("invoices", status="Unpaid")."""
    rows, start = [], 0
    while True:
        q = supabase.table(table).select(columns)
        for k, v in eq.items():
            q = q.eq(k, v)
        chunk = q.order("id").range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def select_where(table: str, column: str, value, columns: str = "*",
                 order: str | None = None, desc: bool = False) -> list[dict]:
    """Rows where column == value, optionally sorted."""
    q = supabase.table(table).select(columns).eq(column, value)
    if order:
        q = q.order(order, desc=desc)
    return q.execute().data or []


def get_row(table: str, row_id) -> dict | None:
    """One row by id, or None."""
    rows = supabase.table(table).select("*").eq("id", row_id).execute().data
    return rows[0] if rows else None


def insert_row(table: str, data: dict) -> dict:
    """Insert and return the new row (with its generated id)."""
    return supabase.table(table).insert(data).execute().data[0]


def update_row(table: str, row_id, data: dict) -> dict | None:
    """Update only the given fields and return the fresh row."""
    if data:
        supabase.table(table).update(data).eq("id", row_id).execute()
    return get_row(table, row_id)


def delete_row(table: str, row_id) -> None:
    """Delete one row. Child rows are removed by the database (ON DELETE CASCADE in schema.sql)."""
    supabase.table(table).delete().eq("id", row_id).execute()


# =====================================================================================================
# Photo files in Supabase Storage
# =====================================================================================================
def photo_path(url: str) -> str | None:
    """Public URL -> path inside the bucket ('<project>/visits/<visit>/<file>.webp'). None if not ours."""
    marker = f"/{BUCKET}/"
    if not url or marker not in url:
        return None
    return url.split(marker, 1)[1].split("?")[0]


def delete_photos(urls) -> None:
    """Delete photo files. Never fails the request: a leftover file is better than a broken delete."""
    paths = [p for p in (photo_path(u) for u in (urls or [])) if p]
    if not paths:
        return
    try:
        supabase.storage.from_(BUCKET).remove(paths)
    except Exception:
        log.warning("Could not remove %d file(s) from storage", len(paths), exc_info=True)


def collect_photo_urls(table: str, row_id) -> list[str]:
    """Every photo link that disappears when this row is deleted. Called BEFORE the delete, because
    the database removes child rows by itself (cascade) but knows nothing about the files."""
    if table in ("visits", "receipts"):
        row = get_row(table, row_id)
        return list(row.get("image_urls") or []) if row else []
    if table == "projects":
        project_ids = [row_id]
    elif table == "clients":
        project_ids = [p["id"] for p in select_where("projects", "client_id", row_id, columns="id")]
    else:
        return []   # invoices have no photos
    urls: list[str] = []
    if project_ids:
        for t in ("visits", "receipts"):
            rows = supabase.table(t).select("image_urls").in_("project_id", project_ids).execute().data or []
            for r in rows:
                urls += r.get("image_urls") or []
    return urls

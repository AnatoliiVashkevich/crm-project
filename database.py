"""database.py - Supabase connection + small generic helpers (no business logic)."""
import os
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

log = logging.getLogger("crm")
supabase: Client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
BUCKET = "crm-photos"
APP_TZ = ZoneInfo(os.getenv("APP_TIMEZONE", "America/New_York"))


def today_local() -> str:
    return datetime.now(APP_TZ).strftime("%Y-%m-%d")


# ---------- generic row helpers ----------
def fetch_all(table: str, columns: str = "*", page: int = 1000, **eq) -> list[dict]:
    """Page through a table (PostgREST caps one select at ~1000 rows). eq = column filters."""
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
    q = supabase.table(table).select(columns).eq(column, value)
    if order:
        q = q.order(order, desc=desc)
    return q.execute().data or []


def get_row(table: str, row_id) -> dict | None:
    rows = supabase.table(table).select("*").eq("id", row_id).execute().data
    return rows[0] if rows else None


def insert_row(table: str, data: dict) -> dict:
    return supabase.table(table).insert(data).execute().data[0]


def update_row(table: str, row_id, data: dict) -> dict | None:
    if data:
        supabase.table(table).update(data).eq("id", row_id).execute()
    return get_row(table, row_id)


def delete_row(table: str, row_id) -> None:
    supabase.table(table).delete().eq("id", row_id).execute()


# ---------- photo storage cleanup ----------
def photo_path(url: str) -> str | None:
    """Public URL -> path inside the bucket."""
    marker = f"/{BUCKET}/"
    if not url or marker not in url:
        return None
    return url.split(marker, 1)[1].split("?")[0]


def delete_photos(urls) -> None:
    paths = [p for p in (photo_path(u) for u in (urls or [])) if p]
    if not paths:
        return
    try:
        supabase.storage.from_(BUCKET).remove(paths)
    except Exception:
        log.warning("Could not remove %d file(s) from storage", len(paths), exc_info=True)


def collect_photo_urls(table: str, row_id) -> list[str]:
    """All photo URLs that will disappear when this row is deleted (DB rows cascade, files don't)."""
    if table in ("visits", "receipts"):
        row = get_row(table, row_id)
        return list(row.get("image_urls") or []) if row else []
    if table == "projects":
        project_ids = [row_id]
    elif table == "clients":
        project_ids = [p["id"] for p in select_where("projects", "client_id", row_id, columns="id")]
    else:
        return []
    urls: list[str] = []
    if project_ids:
        for t in ("visits", "receipts"):
            rows = supabase.table(t).select("image_urls").in_("project_id", project_ids).execute().data or []
            for r in rows:
                urls += r.get("image_urls") or []
    return urls

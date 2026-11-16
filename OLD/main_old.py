import os
import json
import base64
import logging
import tempfile
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from zoneinfo import ZoneInfo
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import OpenAI
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "America/New_York")
CORS_ORIGINS = [
    o.strip() for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
]

log = logging.getLogger("crm")
APP_TZ = ZoneInfo(APP_TIMEZONE)  # fails fast at startup if the timezone name is wrong

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
openai_client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI(title="Agentic CRM API")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# --- DATA MODELS ---
class ClientModel(BaseModel):
    name: str
    phone: str | None = None
    comment: str | None = None

class ProjectModel(BaseModel):
    client_id: str
    name: str
    address: str | None = None

class ManualUpdateModel(BaseModel):
    updates: dict

class PaymentModel(BaseModel):
    amount: float = Field(gt=0)
    method: str | None = None
    paid_at: str | None = None  # optional YYYY-MM-DD or ISO timestamp
    note: str | None = None

class ChatInput(BaseModel):
    text: str
    client_id: str
    project_id: str

# --- RECEIPT OCR MODELS ---
class ReceiptLineItem(BaseModel):
    name: str
    qty: float
    price: float
    total: float

class ParsedReceipt(BaseModel):
    vendor: str
    date_purchased: str # YYYY-MM-DD
    category: str # "Construction", "Groceries", "Fuel", "Other"
    items: list[ReceiptLineItem]
    total_amount: float

# --- AI ASSISTANT MODELS ---
class ProposedChanges(BaseModel):
    client_name: str | None
    client_phone: str | None
    client_comment: str | None
    project_name: str | None
    project_address: str | None
    project_scope: str | None
    new_work_plan_task: str | None
    estimated_amount: float | None
    actual_amount: float | None
    payment_status: str | None # 'paid', 'debt'
    transaction_amount: float | None
    transaction_category: str | None # 'Construction', 'Groceries', 'Fuel', 'Other', 'income'
    transaction_vendor: str | None
    transaction_description: str | None

class AgentResponse(BaseModel):
    internal_status: str # "greeting_or_collecting", "confirming", "confirmed_and_save"
    reply_message: str
    proposed_changes: ProposedChanges | None
    missing_fields_reminder: list[str]

SYSTEM_PROMPT = """
You are a smart AI assistant inside a Field Service CRM.
You always receive the CURRENT DATABASE STATE for the active Client and Project (including Work Plan, Estimate, Invoice, and Expenses). Context is extended, never overwritten!

STATE MACHINE RULES:
1. ON PROJECT OPEN ("__INIT_PROJECT__"):
   Analyze the DB state. Briefly summarize what is filled in, list any missing important fields (phone, address, work plan, estimate), and state how you can help. Set internal_status = "greeting_or_collecting".
2. COLLECTING & CONFIRMING ("confirming"):
   When the user provides new info (phone, address, a new task for the work plan, payment update, or an expense), DO NOT save immediately!
   Fill ONLY the changed fields in `proposed_changes` (leave others null).
   If `estimated_amount > actual_amount` (and `estimated_amount > 0`), set `payment_status = "debt"`. When `actual_amount >= estimated_amount`, set `payment_status = "paid"`.
   Set `internal_status = "confirming"`. In `reply_message`, show a short bulleted summary of the changes and ask: "Would you like me to save these changes?".
3. SAVING ("confirmed_and_save"):
   When the user confirms ("yes", "ok", "save", "да", "ок"):
   Set `internal_status = "confirmed_and_save"` and REPEAT all changes in `proposed_changes` so the backend writes them to the DB.
   In `reply_message`, confirm "Saved to database!" and mention if any key fields are still empty.
Always reply in the same language the user speaks to you (default to English for system init).
"""

# --- TIME, VALIDATION & UPLOAD HELPERS ---
def today_local() -> str:
    """Today's date (YYYY-MM-DD) in the business timezone (APP_TIMEZONE env var)."""
    return datetime.now(APP_TZ).strftime("%Y-%m-%d")

# Fields a client may change through PUT. Anything else is rejected with 400.
# Never allowed: id, client_id, payment_status, actual_amount, invoice_number, created_at.
CLIENT_FIELDS = {"name", "phone", "comment"}
PROJECT_FIELDS = {
    "name", "address", "scope_description", "estimated_amount",
    "work_plan", "estimate_items", "invoice_data", "archived",
}

def validate_updates(updates: dict, allowed: set[str], entity: str) -> dict:
    rejected = sorted(set(updates) - allowed)
    if rejected:
        raise HTTPException(
            status_code=400,
            detail=f"Fields not allowed for {entity}: {', '.join(rejected)}. Allowed: {', '.join(sorted(allowed))}.",
        )
    return updates

MAX_RECEIPT_BYTES = 10 * 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024
AUDIO_EXTENSIONS = {
    "audio/webm": ".webm", "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
}

def base_content_type(upload: UploadFile) -> str:
    return (upload.content_type or "").split(";")[0].strip().lower()

def read_limited(upload: UploadFile, max_bytes: int, label: str) -> bytes:
    data = upload.file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} is too large (max {max_bytes // (1024 * 1024)} MB).")
    return data

# --- MONEY & BALANCE (single source of truth for paid / debt) ---
CENT = Decimal("0.01")
ZERO = Decimal("0.00")

def to_money(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0)).quantize(CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return ZERO

def fetch_all(table: str, columns: str = "*", page: int = 1000) -> list[dict]:
    """Page through a table (PostgREST caps a single select at ~1000 rows)."""
    rows: list[dict] = []
    start = 0
    while True:
        chunk = supabase.table(table).select(columns).order("id").range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page

def invoice_total(project: dict) -> Decimal:
    inv = project.get("invoice_data")
    items = inv.get("items") if isinstance(inv, dict) else None
    if not isinstance(items, list):
        return ZERO
    total = Decimal(0)
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            qty = Decimal(str(it.get("qty") or 1))
            price = Decimal(str(it.get("price") or 0))
        except InvalidOperation:
            continue
        total += qty * price
    return total.quantize(CENT, rounding=ROUND_HALF_UP)

def compute_balance(project: dict, payments: list[dict]) -> dict:
    """Pure calculation. total_due = invoice total if an invoice exists, else the estimate."""
    if "invoice_data" in project:
        inv = invoice_total(project)
    else:  # list views skip the heavy JSON column and carry the stored total instead
        inv = to_money(project.get("invoice_total"))
    total_due = inv if inv > 0 else to_money(project.get("estimated_amount"))
    total_paid = sum((to_money(p.get("amount")) for p in payments), ZERO)
    is_debt = total_due > total_paid
    return {
        "total_due": total_due,
        "total_paid": total_paid,
        "balance_due": max(total_due - total_paid, ZERO),
        "is_debt": is_debt,
        "payment_status": "debt" if is_debt else "paid",
    }

def get_project_or_404(project_id: str) -> dict:
    rows = supabase.table("projects").select("*").eq("id", project_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Project not found")
    return rows[0]

def get_payments(project_id: str) -> list[dict]:
    return supabase.table("payments").select("*").eq("project_id", project_id).order("paid_at", desc=True).execute().data or []

def project_balance(project_id: str) -> dict:
    """THE function for a project's money state: total_due, total_paid, balance_due, is_debt, payment_status."""
    return compute_balance(get_project_or_404(project_id), get_payments(project_id))

def attach_balance(project: dict, payments: list[dict] | None = None) -> dict:
    """Return the project row plus derived balance fields (JSON-safe).
    actual_amount is kept as a read-only alias of total_paid so the current UI keeps working."""
    if payments is None:
        payments = get_payments(project["id"])
    bal = compute_balance(project, payments)
    return {
        **project,
        "total_due": float(bal["total_due"]),
        "total_paid": float(bal["total_paid"]),
        "balance_due": float(bal["balance_due"]),
        "is_debt": bal["is_debt"],
        "payment_status": bal["payment_status"],
        "actual_amount": float(bal["total_paid"]),
    }

def insert_payment(project_id: str, amount: Decimal, method: str | None, note: str | None, paid_at: str | None = None) -> dict:
    row = {"project_id": project_id, "amount": str(to_money(amount)), "method": method, "note": note}
    if paid_at:
        row["paid_at"] = paid_at
    return supabase.table("payments").insert(row).execute().data[0]

def pay_remaining(project_id: str, method: str, note: str | None = None) -> dict | None:
    """Insert one payment for whatever is still owed. Returns None if nothing is owed."""
    remaining = project_balance(project_id)["balance_due"]
    if remaining <= 0:
        return None
    return insert_payment(project_id, remaining, method, note)

# --- HELPER FUNCTIONS ---
def get_full_context(client_id: str, project_id: str):
    c_res = supabase.table("clients").select("*").eq("id", client_id).execute()
    p_res = supabase.table("projects").select("*").eq("id", project_id).execute()
    t_res = supabase.table("transactions").select("*").eq("project_id", project_id).order("created_at", desc=True).execute()
    
    client = c_res.data[0] if c_res.data else {}
    project = attach_balance(p_res.data[0]) if p_res.data else {}
    transactions = t_res.data if t_res.data else []
    return client, project, transactions

def apply_changes_to_db(client_id: str, project_id: str, changes: ProposedChanges):
    if not changes:
        return
    
    client_updates = {}
    if changes.client_name is not None: client_updates["name"] = changes.client_name
    if changes.client_phone is not None: client_updates["phone"] = changes.client_phone
    if changes.client_comment is not None: client_updates["comment"] = changes.client_comment
    if client_updates:
        supabase.table("clients").update(client_updates).eq("id", client_id).execute()

    p_cur = supabase.table("projects").select("*").eq("id", project_id).execute().data[0]
    project_updates = {}
    if changes.project_name is not None: project_updates["name"] = changes.project_name
    if changes.project_address is not None: project_updates["address"] = changes.project_address
    if changes.project_scope is not None: project_updates["scope_description"] = changes.project_scope
    if changes.estimated_amount is not None: project_updates["estimated_amount"] = changes.estimated_amount
    # actual_amount / payment_status are derived from the payments table (see project_balance)
    
    if changes.new_work_plan_task:
        current_plan = p_cur.get("work_plan") if isinstance(p_cur.get("work_plan"), list) else []
        current_plan.append({"task": changes.new_work_plan_task, "details": "", "price": 0, "done": False})
        project_updates["work_plan"] = current_plan

    if project_updates:
        supabase.table("projects").update(project_updates).eq("id", project_id).execute()

    # Bridge until the AI flow is reworked: the model still reports a running "actual paid" total.
    # Record only the increase as a payment; never lower or overwrite anything.
    if changes.actual_amount is not None:
        increase = to_money(changes.actual_amount) - project_balance(project_id)["total_paid"]
        if increase > 0:
            insert_payment(project_id, increase, "AI Assistant", "Recorded via AI assistant")

    if changes.transaction_amount is not None and changes.transaction_description is not None:
        supabase.table("transactions").insert({
            "client_id": client_id,
            "project_id": project_id,
            "amount": changes.transaction_amount,
            "category": changes.transaction_category or "Other",
            "kind": "income" if (changes.transaction_category or "").lower() == "income" else "expense",
            "vendor": changes.transaction_vendor or "AI Assistant",
            "description": changes.transaction_description,
            "date_purchased": today_local(),
            "items": []
        }).execute()

# --- DIRECTORY & CRUD ENDPOINTS ---
@app.get("/api/clients")
def get_clients():
    clients = supabase.table("clients").select("*").order("created_at", desc=False).execute().data
    projects = (
        supabase.table("projects")
        .select("id, client_id, name, address, estimated_amount, invoice_total, invoice_number, archived, created_at")
        .eq("archived", False)
        .order("created_at", desc=True)
        .execute().data
    )
    
    payments_by_project = defaultdict(list)
    for pay in fetch_all("payments", "id, project_id, amount"):
        payments_by_project[pay["project_id"]].append(pay)

    for c in clients:
        c_projects = [attach_balance(p, payments_by_project[p["id"]]) for p in projects if p["client_id"] == c["id"]]
        c["has_debt"] = any(p["is_debt"] for p in c_projects)
        c["projects"] = c_projects
        c["known_addresses"] = list({p["address"] for p in c_projects if p.get("address")})
    return clients

@app.post("/api/clients")
def create_client(client: ClientModel):
    return supabase.table("clients").insert(client.model_dump(exclude_none=True)).execute().data[0]

@app.put("/api/clients/{client_id}")
def update_client_manual(client_id: str, payload: ManualUpdateModel):
    updates = validate_updates(payload.updates, CLIENT_FIELDS, "client")
    if not updates:
        return {"status": "ok"}
    res = supabase.table("clients").update(updates).eq("id", client_id).execute()
    return res.data[0] if res.data else {"status": "ok"}

@app.post("/api/clients/{client_id}/mark-all-paid")
def mark_client_paid(client_id: str):
    projects = supabase.table("projects").select("id").eq("client_id", client_id).execute().data or []
    created = 0
    for p in projects:
        if pay_remaining(p["id"], "Mark all paid", "Marked paid for all client projects"):
            created += 1
    return {"status": "ok", "payments_created": created}

@app.post("/api/projects")
def create_project(project: ProjectModel):
    data = project.model_dump(exclude_none=True)
    data["work_plan"] = []
    data["estimate_items"] = []
    data["invoice_data"] = {}
    try:
        row = supabase.table("projects").insert(data).execute().data[0]
    except Exception as e:
        log.exception("create_project failed")
        raise HTTPException(status_code=500, detail=f"Could not create project (did you run schema.sql?): {e}")
    return attach_balance(row, [])

@app.put("/api/projects/{project_id}")
def update_project_manual(project_id: str, payload: ManualUpdateModel):
    updates = validate_updates(payload.updates, PROJECT_FIELDS, "project")
    if "invoice_data" in updates:
        # keep the stored total in sync so list views can compute debt without loading invoice_data
        updates["invoice_total"] = str(invoice_total({"invoice_data": updates["invoice_data"]}))
    try:
        if updates:
            supabase.table("projects").update(updates).eq("id", project_id).execute()
        return attach_balance(get_project_or_404(project_id))
    except HTTPException:
        raise
    except Exception as e:
        log.exception("update_project_manual failed")
        raise HTTPException(status_code=400, detail=f"Database error (make sure you ran schema.sql in Supabase): {str(e)}")

@app.post("/api/projects/{project_id}/invoice-number")
def assign_invoice_number(project_id: str):
    """Idempotent: returns the project's invoice number, assigning the next INV-#### the first time."""
    get_project_or_404(project_id)
    try:
        res = supabase.rpc("assign_invoice_number", {"p_project_id": project_id}).execute()
    except Exception as e:
        log.exception("assign_invoice_number failed")
        raise HTTPException(status_code=500, detail=f"Could not assign invoice number (re-run schema.sql?): {e}")
    return {"invoice_number": res.data}

# --- PAYMENTS ---
@app.get("/api/projects/{project_id}/payments")
def list_payments(project_id: str):
    return {"payments": get_payments(project_id), "balance": attach_balance(get_project_or_404(project_id))}

@app.post("/api/projects/{project_id}/payments")
def add_payment(project_id: str, payment: PaymentModel):
    get_project_or_404(project_id)
    row = insert_payment(project_id, to_money(payment.amount), payment.method, payment.note, payment.paid_at)
    return {"payment": row, "project": attach_balance(get_project_or_404(project_id))}

@app.post("/api/projects/{project_id}/mark-paid")
def mark_project_paid(project_id: str):
    pay_remaining(project_id, "Mark paid")
    return {"project": attach_balance(get_project_or_404(project_id))}

@app.delete("/api/payments/{payment_id}")
def delete_payment(payment_id: str):
    rows = supabase.table("payments").select("project_id").eq("id", payment_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Payment not found")
    supabase.table("payments").delete().eq("id", payment_id).execute()
    return {"status": "deleted", "project": attach_balance(get_project_or_404(rows[0]["project_id"]))}

# --- RECEIPT OCR SCANNER ---
@app.post("/api/projects/{project_id}/scan-receipt")
def scan_receipt(project_id: str, client_id: str = Form(...), receipt_file: UploadFile = File(...)):
    # plain `def`: FastAPI runs it in a threadpool, so the sync OpenAI/Supabase calls don't block the server
    mime_type = base_content_type(receipt_file)
    if not mime_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Receipts must be image files.")
    file_bytes = read_limited(receipt_file, MAX_RECEIPT_BYTES, "Receipt image")
    base64_image = base64.b64encode(file_bytes).decode("utf-8")

    prompt = """
    Analyze this receipt image and extract:
    1. vendor: Store/Merchant name (e.g., Home Depot, Lowe's, Walmart, Shell).
    2. date_purchased: Transaction date in YYYY-MM-DD format (if missing, use today's date).
    3. category: Choose strictly from this list based on store & items:
       - "Construction" (hardware/building stores: Home Depot, Lowe's, Ace Hardware, Floor & Decor, etc.)
       - "Groceries" (supermarkets: Walmart, Publix, Target, Costco, Aldi)
       - "Fuel" (gas stations: Shell, Chevron, Wawa, Exxon, Mobil, RaceTrac)
       - "Other" (anything else)
    4. items: Line items purchased (name, qty, unit price, line total).
    5. total_amount: Final receipt total including tax.
    """

    completion = openai_client.beta.chat.completions.parse(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{base64_image}"}}
                ]
            }
        ],
        response_format=ParsedReceipt
    )
    parsed = completion.choices[0].message.parsed

    new_tx = {
        "client_id": client_id,
        "project_id": project_id,
        "vendor": parsed.vendor,
        "date_purchased": parsed.date_purchased,
        "category": parsed.category,
        "amount": parsed.total_amount,
        "description": f"{parsed.vendor} ({len(parsed.items)} items)",
        "items": [item.model_dump() for item in parsed.items]
    }
    res = supabase.table("transactions").insert(new_tx).execute()
    return res.data[0]

@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: str):
    supabase.table("transactions").delete().eq("id", tx_id).execute()
    return {"status": "deleted"}

# --- AI ENGINE WITH DB MEMORY ---
def run_ai_turn(user_text: str, client_id: str, project_id: str, is_init: bool = False):
    history_res = supabase.table("chat_messages").select("*").eq("project_id", project_id).order("created_at", desc=False).execute()
    db_history = history_res.data if history_res.data else []

    if not is_init:
        supabase.table("chat_messages").insert({
            "project_id": project_id,
            "role": "user",
            "content": user_text
        }).execute()
        db_history.append({"role": "user", "content": user_text})

    client, project, transactions = get_full_context(client_id, project_id)
    db_snapshot = f"""
=== CURRENT DATABASE CONTEXT ===
CLIENT: Name={client.get('name')}, Phone={client.get('phone') or 'MISSING'}, Note={client.get('comment') or 'MISSING'}
PROJECT: Name={project.get('name')}, Address={project.get('address') or 'MISSING'}, Scope={project.get('scope_description') or 'MISSING'}
WORK PLAN: {json.dumps(project.get('work_plan') or [], ensure_ascii=False)}
FINANCES: Estimate=${project.get('estimated_amount', 0)}, Total due=${project.get('total_due', 0)}, Paid so far=${project.get('total_paid', 0)}, Balance due=${project.get('balance_due', 0)}, Status={project.get('payment_status', 'paid')}
EXPENSES/RECEIPTS ({len(transactions)}): {json.dumps([{'vendor': t.get('vendor'), 'amount': t.get('amount'), 'cat': t.get('category')} for t in transactions], ensure_ascii=False)}
================================
"""

    messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n" + db_snapshot}]
    for m in db_history[-12:]:
        messages.append({"role": m["role"], "content": m["content"]})

    if is_init:
        messages.append({
            "role": "user",
            "content": "__INIT_PROJECT__: I opened this project card. Briefly summarize what is filled in, what important fields are still missing, and how you can help me."
        })

    completion = openai_client.beta.chat.completions.parse(
        model="gpt-4o-mini",
        messages=messages,
        response_format=AgentResponse,
    )
    ai_data = completion.choices[0].message.parsed

    if ai_data.internal_status == "confirmed_and_save" and ai_data.proposed_changes:
        apply_changes_to_db(client_id, project_id, ai_data.proposed_changes)
        client, project, transactions = get_full_context(client_id, project_id)

    result_dict = ai_data.model_dump()
    result_dict["user_text"] = None if is_init else user_text
    result_dict["updated_client"] = client
    result_dict["updated_project"] = project
    result_dict["updated_transactions"] = transactions

    supabase.table("chat_messages").insert({
        "project_id": project_id,
        "role": "assistant",
        "content": ai_data.reply_message,
        "raw_json": json.dumps(result_dict, ensure_ascii=False)
    }).execute()

    return result_dict

@app.get("/api/project-workspace/{client_id}/{project_id}")
def load_project_workspace(client_id: str, project_id: str):
    # Never calls OpenAI, so opening a project cannot fail because of the AI.
    history_res = supabase.table("chat_messages").select("*").eq("project_id", project_id).order("created_at", desc=False).execute()
    messages = history_res.data or []
    client, project, transactions = get_full_context(client_id, project_id)
    return {
        "messages": messages,
        "client": client,
        "project": project,
        "transactions": transactions,
        "needs_greeting": len(messages) == 0,
    }

@app.post("/api/project-greeting/{client_id}/{project_id}")
def project_greeting(client_id: str, project_id: str):
    """Generates the first AI summary for a project. The frontend calls this after the workspace has loaded."""
    existing = supabase.table("chat_messages").select("id").eq("project_id", project_id).limit(1).execute().data
    if existing:
        return {"status": "exists"}
    try:
        return run_ai_turn("__INIT_PROJECT__", client_id, project_id, is_init=True)
    except Exception:
        log.exception("AI greeting failed")
        raise HTTPException(status_code=502, detail="The AI assistant is unavailable right now. Use 'Check Missing Fields' to retry.")

@app.post("/api/project-chat/recheck")
def force_recheck_context(payload: ChatInput):
    return run_ai_turn("__INIT_PROJECT__", payload.client_id, payload.project_id, is_init=True)

@app.post("/api/text-command")
def process_text_command(payload: ChatInput):
    return run_ai_turn(payload.text, payload.client_id, payload.project_id, is_init=False)

@app.post("/api/voice-command")
def process_voice_command(audio_file: UploadFile = File(...), client_id: str = Form(...), project_id: str = Form(...)):
    ext = AUDIO_EXTENSIONS.get(base_content_type(audio_file))
    if ext is None:
        raise HTTPException(status_code=415, detail="Unsupported audio type.")
    data = read_limited(audio_file, MAX_AUDIO_BYTES, "Audio recording")

    # Random temp name + suffix from the content type; the client's filename is never used.
    tmp = tempfile.NamedTemporaryFile(prefix="voice_", suffix=ext, delete=False)
    temp_path = tmp.name
    try:
        with tmp:
            tmp.write(data)
        with open(temp_path, "rb") as audio:
            transcript = openai_client.audio.transcriptions.create(model="whisper-1", file=audio)
        return run_ai_turn(transcript.text, client_id, project_id, is_init=False)
    finally:
        try:
            os.remove(temp_path)
        except FileNotFoundError:
            pass

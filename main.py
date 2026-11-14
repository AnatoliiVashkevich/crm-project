import os
import shutil
import json
import base64
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
openai_client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI(title="Agentic CRM API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

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

# --- HELPER FUNCTIONS ---
def get_full_context(client_id: str, project_id: str):
    c_res = supabase.table("clients").select("*").eq("id", client_id).execute()
    p_res = supabase.table("projects").select("*").eq("id", project_id).execute()
    t_res = supabase.table("transactions").select("*").eq("project_id", project_id).order("created_at", desc=True).execute()
    
    client = c_res.data[0] if c_res.data else {}
    project = p_res.data[0] if p_res.data else {}
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
    if changes.actual_amount is not None: project_updates["actual_amount"] = changes.actual_amount
    if changes.payment_status is not None: project_updates["payment_status"] = changes.payment_status
    
    if changes.new_work_plan_task:
        current_plan = p_cur.get("work_plan") if isinstance(p_cur.get("work_plan"), list) else []
        current_plan.append({"task": changes.new_work_plan_task, "details": "", "price": 0, "done": False})
        project_updates["work_plan"] = current_plan

    if ("estimated_amount" in project_updates or "actual_amount" in project_updates) and "payment_status" not in project_updates:
        est = float(project_updates.get("estimated_amount", p_cur.get("estimated_amount") or 0))
        act = float(project_updates.get("actual_amount", p_cur.get("actual_amount") or 0))
        project_updates["payment_status"] = "debt" if (est > 0 and act < est) else "paid"

    if project_updates:
        supabase.table("projects").update(project_updates).eq("id", project_id).execute()

    if changes.transaction_amount is not None and changes.transaction_description is not None:
        supabase.table("transactions").insert({
            "client_id": client_id,
            "project_id": project_id,
            "amount": changes.transaction_amount,
            "category": changes.transaction_category or "Other",
            "vendor": changes.transaction_vendor or "AI Assistant",
            "description": changes.transaction_description,
            "date_purchased": datetime.utcnow().strftime("%Y-%m-%d"),
            "items": []
        }).execute()

# --- DIRECTORY & CRUD ENDPOINTS ---
@app.get("/api/clients")
def get_clients():
    clients = supabase.table("clients").select("*").order("created_at", desc=False).execute().data
    projects = supabase.table("projects").select("*").order("created_at", desc=True).execute().data
    
    for c in clients:
        c_projects = [p for p in projects if p["client_id"] == c["id"]]
        has_debt = any(
            p.get("payment_status") == "debt" or 
            (float(p.get("estimated_amount") or 0) > float(p.get("actual_amount") or 0) and float(p.get("estimated_amount") or 0) > 0)
            for p in c_projects
        )
        c["has_debt"] = has_debt
        c["projects"] = c_projects
        c["known_addresses"] = list({p["address"] for p in c_projects if p.get("address")})
    return clients

@app.post("/api/clients")
def create_client(client: ClientModel):
    return supabase.table("clients").insert(client.model_dump(exclude_none=True)).execute().data[0]

@app.put("/api/clients/{client_id}")
def update_client_manual(client_id: str, payload: ManualUpdateModel):
    res = supabase.table("clients").update(payload.updates).eq("id", client_id).execute()
    return res.data[0] if res.data else {"status": "ok"}

@app.post("/api/clients/{client_id}/mark-all-paid")
def mark_client_paid(client_id: str):
    supabase.table("projects").update({"payment_status": "paid"}).eq("client_id", client_id).execute()
    return {"status": "ok"}

@app.post("/api/projects")
def create_project(project: ProjectModel):
    data = project.model_dump(exclude_none=True)
    data["payment_status"] = "paid"
    try:
        data["work_plan"] = []
        data["estimate_items"] = []
        data["invoice_data"] = {}
        return supabase.table("projects").insert(data).execute().data[0]
    except Exception:
        # Fallback if SQL columns weren't added yet
        data.pop("work_plan", None)
        data.pop("estimate_items", None)
        data.pop("invoice_data", None)
        return supabase.table("projects").insert(data).execute().data[0]

@app.put("/api/projects/{project_id}")
def update_project_manual(project_id: str, payload: ManualUpdateModel):
    updates = payload.updates
    try:
        if "estimated_amount" in updates or "actual_amount" in updates:
            p_cur = supabase.table("projects").select("estimated_amount, actual_amount").eq("id", project_id).execute().data[0]
            est = float(updates.get("estimated_amount", p_cur.get("estimated_amount") or 0))
            act = float(updates.get("actual_amount", p_cur.get("actual_amount") or 0))
            if "payment_status" not in updates:
                updates["payment_status"] = "debt" if (est > 0 and act < est) else "paid"
                
        res = supabase.table("projects").update(updates).eq("id", project_id).execute()
        return res.data[0] if res.data else {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Database error (make sure you ran the SQL script in Supabase): {str(e)}")

# --- RECEIPT OCR SCANNER ---
@app.post("/api/projects/{project_id}/scan-receipt")
async def scan_receipt(project_id: str, client_id: str = Form(...), receipt_file: UploadFile = File(...)):
    file_bytes = await receipt_file.read()
    base64_image = base64.b64encode(file_bytes).decode("utf-8")
    mime_type = receipt_file.content_type or "image/jpeg"

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
FINANCES: Estimate=${project.get('estimated_amount', 0)}, Actual Paid=${project.get('actual_amount', 0)}, Status={project.get('payment_status', 'paid')}
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
    history_res = supabase.table("chat_messages").select("*").eq("project_id", project_id).order("created_at", desc=False).execute()
    messages = history_res.data or []
    
    if len(messages) == 0:
        run_ai_turn("__INIT_PROJECT__", client_id, project_id, is_init=True)
        history_res = supabase.table("chat_messages").select("*").eq("project_id", project_id).order("created_at", desc=False).execute()
        messages = history_res.data or []

    client, project, transactions = get_full_context(client_id, project_id)
    return {
        "messages": messages,
        "client": client,
        "project": project,
        "transactions": transactions
    }

@app.post("/api/project-chat/recheck")
def force_recheck_context(payload: ChatInput):
    return run_ai_turn("__INIT_PROJECT__", payload.client_id, payload.project_id, is_init=True)

@app.post("/api/text-command")
def process_text_command(payload: ChatInput):
    return run_ai_turn(payload.text, payload.client_id, payload.project_id, is_init=False)

@app.post("/api/voice-command")
async def process_voice_command(audio_file: UploadFile = File(...), client_id: str = Form(...), project_id: str = Form(...)):
    temp_path = f"temp_{audio_file.filename}"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)
    try:
        with open(temp_path, "rb") as audio:
            transcript = openai_client.audio.transcriptions.create(model="whisper-1", file=audio)
        return run_ai_turn(transcript.text, client_id, project_id, is_init=False)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
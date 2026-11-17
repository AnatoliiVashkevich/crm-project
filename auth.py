"""auth.py - signing in, "who is calling?", roles, and the Team (employees) endpoints.

How a login works:
    1. The browser sends email + password to POST /api/auth/login.
    2. We ask Supabase Auth to check them and get back two tokens:
         access_token  (proves who you are, valid ~1 hour)   refresh_token (gets a new access token)
    3. The browser sends the access token with every request:  Authorization: Bearer <token>
    4. current_member() turns that token into the person's row in `team_members` (name, role, active).
       Every protected route asks for it with:   me: dict = Depends(current_member)

Roles:  Owner (everything) · Manager (operations + invoices, no settings) · Employee (own tasks, no money).
The first person ever is created through POST /api/auth/setup and becomes the Owner.
"""
import logging
import os
import secrets
import string
import time

from fastapi import APIRouter, Depends, Header, HTTPException
from supabase import ClientOptions, create_client

import database as db

log = logging.getLogger("crm")
router = APIRouter(prefix="/api")

ROLES = ("Owner", "Manager", "Employee")
MIN_PASSWORD = 8

# token -> (valid until, member row). Saves a Supabase round trip on every click; role changes apply within a minute.
_cache: dict[str, tuple[float, dict]] = {}
CACHE_SECONDS = 60


# =====================================================================================================
# Helpers
# =====================================================================================================
def _login_client():
    """A throw-away Supabase client for sign-in / refresh. The shared client in database.py must never
    'sign in' itself, or it would stop acting with the server's own (secret key) permissions."""
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"),
                         options=ClientOptions(auto_refresh_token=False, persist_session=False))


def _session(session) -> dict:
    """What the browser keeps after signing in."""
    return {"access_token": session.access_token, "refresh_token": session.refresh_token,
            "expires_at": session.expires_at}


def _temp_password() -> str:
    """Readable temporary password, e.g. 'k7Rm-2xQp-9TzL'. The person changes it in Settings."""
    abc = string.ascii_letters + string.digits
    return "-".join("".join(secrets.choice(abc) for _ in range(4)) for _ in range(3))


def _check_password(pw: str) -> str:
    pw = str(pw or "")
    if len(pw) < MIN_PASSWORD:
        raise HTTPException(400, f"The password needs at least {MIN_PASSWORD} characters.")
    return pw


def _clean_email(email: str) -> str:
    email = str(email or "").strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(400, "Please enter a valid email address.")
    return email


def forget_sessions() -> None:
    """Call after changing someone's role or active flag, so it applies immediately."""
    _cache.clear()


def _create_account(email: str, password: str) -> str:
    """Create a Supabase login (already confirmed, no email is sent). Returns its user id."""
    try:
        res = db.supabase.auth.admin.create_user({"email": email, "password": password, "email_confirm": True})
        return res.user.id
    except Exception as e:
        log.warning("Could not create login for %s", email, exc_info=True)
        msg = str(e)
        if "already" in msg.lower():
            raise HTTPException(400, "A login with this email already exists.")
        raise HTTPException(400, f"Could not create the login: {msg}")


# =====================================================================================================
# "Who is calling?" - used by every protected route
# =====================================================================================================
def current_member(authorization: str | None = Header(None)) -> dict:
    """Authorization header -> team member row. 401 = not signed in / expired, 403 = not allowed."""
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Please sign in.")

    hit = _cache.get(token)
    if hit and hit[0] > time.time():
        member = hit[1]
    else:
        try:
            res = db.supabase.auth.get_user(token)
            user_id = res.user.id if res and res.user else None
        except Exception:
            user_id = None
        if not user_id:
            raise HTTPException(401, "Your session has expired. Please sign in again.")
        rows = db.select_where("team_members", "user_id", user_id)
        if not rows:
            raise HTTPException(403, "This login is not part of the team.")
        member = rows[0]
        if len(_cache) > 1000:   # keep memory small: drop expired entries
            now = time.time()
            for k in [k for k, (until, _) in _cache.items() if until < now]:
                _cache.pop(k, None)
        _cache[token] = (time.time() + CACHE_SECONDS, member)

    if not member.get("active"):
        raise HTTPException(403, "Your account is deactivated. Please ask the Owner.")
    return member


def require(me: dict, *roles: str) -> None:
    """Stop the request unless the caller has one of these roles."""
    if me.get("role") not in roles:
        raise HTTPException(403, "You don't have access to this.")


def public_member(m: dict, full: bool, cost: bool = False) -> dict:
    """A team member as other people may see them. Employees only see names and roles;
    the hourly cost (what the person costs the business) only goes to the Owner."""
    keys = ("id", "name", "role", "active", "email", "phone", "specialty") if full else ("id", "name", "role", "active")
    out = {k: m.get(k) for k in keys}
    if cost:
        out["hourly_cost"] = float(m.get("hourly_cost") or 0)
    return out


# =====================================================================================================
# Sign-in routes (open: no token needed)
# =====================================================================================================
@router.get("/auth/status")
def auth_status():
    """needs_setup = nobody exists yet -> the browser shows "Create the Owner account"."""
    try:
        return {"needs_setup": not db.fetch_all("team_members", "id")}
    except Exception:
        log.exception("team_members table missing?")
        raise HTTPException(503, "The database needs an update: run schema.sql in Supabase > SQL Editor, then reload.")


@router.post("/auth/setup")
def auth_setup(body: dict):
    """One time only: create the first person, the Owner."""
    if db.fetch_all("team_members", "id"):
        raise HTTPException(409, "The Owner account already exists. Please sign in.")
    name = str(body.get("name") or "").strip() or "Owner"
    email, password = _clean_email(body.get("email")), _check_password(body.get("password"))
    user_id = _create_account(email, password)
    db.insert_row("team_members", {"user_id": user_id, "name": name, "email": email, "role": "Owner"})
    return auth_login({"email": email, "password": password})


@router.post("/auth/login")
def auth_login(body: dict):
    email, password = str(body.get("email") or "").strip().lower(), str(body.get("password") or "")
    try:
        res = _login_client().auth.sign_in_with_password({"email": email, "password": password})
    except Exception:
        raise HTTPException(401, "Wrong email or password.")
    rows = db.select_where("team_members", "user_id", res.user.id)
    if not rows:
        raise HTTPException(403, "This login is not part of the team.")
    if not rows[0].get("active"):
        raise HTTPException(403, "Your account is deactivated. Please ask the Owner.")
    return _session(res.session)


@router.post("/auth/refresh")
def auth_refresh(body: dict):
    """Swap the refresh token for fresh tokens (the browser does this by itself when 1 hour is up)."""
    try:
        res = _login_client().auth.refresh_session(str(body.get("refresh_token") or ""))
        return _session(res.session)
    except Exception:
        raise HTTPException(401, "Your session has expired. Please sign in again.")


# =====================================================================================================
# My account
# =====================================================================================================
@router.post("/auth/password")
def change_my_password(body: dict, me: dict = Depends(current_member)):
    """Settings > My account > change password (e.g. replace the temporary one)."""
    password = _check_password(body.get("password"))
    db.supabase.auth.admin.update_user_by_id(me["user_id"], {"password": password})
    return {"status": "ok"}


# =====================================================================================================
# Team (Owner manages people; everyone gets the list for showing names)
# =====================================================================================================
TEAM_FIELDS = {"name", "phone", "specialty", "role", "active", "hourly_cost"}


@router.post("/team")
def add_member(body: dict, me: dict = Depends(current_member)):
    """Owner adds a person: creates their login with a temporary password and returns it ONCE."""
    require(me, "Owner")
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Please enter the person's name.")
    role = body.get("role") or "Employee"
    if role not in ROLES:
        raise HTTPException(400, f"Role must be one of: {', '.join(ROLES)}")
    email = _clean_email(body.get("email"))
    password = _temp_password()
    user_id = _create_account(email, password)
    row = db.insert_row("team_members", {
        "user_id": user_id, "name": name, "email": email, "role": role,
        "phone": str(body.get("phone") or "").strip(), "specialty": str(body.get("specialty") or "").strip(),
    })
    return {"member": public_member(row, True, cost=True), "temp_password": password}


@router.patch("/team/{member_id}")
def update_member(member_id: str, body: dict, me: dict = Depends(current_member)):
    """Owner edits a person: name, phone, specialty, role, active (deactivate = can't sign in any more)."""
    require(me, "Owner")
    rejected = sorted(set(body) - TEAM_FIELDS)
    if rejected:
        raise HTTPException(400, f"Fields not allowed: {', '.join(rejected)}")
    if "role" in body and body["role"] not in ROLES:
        raise HTTPException(400, f"Role must be one of: {', '.join(ROLES)}")
    member = db.get_row("team_members", member_id)
    if not member:
        raise HTTPException(404, "Team member not found")
    # never leave the business without an active Owner
    losing_owner = member["role"] == "Owner" and (body.get("role", "Owner") != "Owner" or body.get("active") is False)
    if losing_owner:
        owners = [m for m in db.select_where("team_members", "role", "Owner") if m.get("active")]
        if len(owners) <= 1:
            raise HTTPException(400, "There must always be at least one active Owner.")
    row = db.update_row("team_members", member_id, body)
    forget_sessions()
    return public_member(row, True, cost=True)


@router.post("/team/{member_id}/reset-password")
def reset_member_password(member_id: str, me: dict = Depends(current_member)):
    """Owner gives someone a new temporary password (returned once)."""
    require(me, "Owner")
    member = db.get_row("team_members", member_id)
    if not member or not member.get("user_id"):
        raise HTTPException(404, "Team member not found")
    password = _temp_password()
    db.supabase.auth.admin.update_user_by_id(member["user_id"], {"password": password})
    return {"temp_password": password}

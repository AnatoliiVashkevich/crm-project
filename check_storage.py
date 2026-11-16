"""check_storage.py - run from the project folder with the venv active:  python check_storage.py
Shows which SUPABASE_KEY the backend really uses (never prints the full key) and tests a Storage upload."""
import base64
import json
import os
from importlib.metadata import PackageNotFoundError, version

from dotenv import dotenv_values, load_dotenv


def classify(key):
    if not key:
        return "MISSING"
    if key.startswith("sb_secret_"):
        return "secret key  -> correct for the backend"
    if key.startswith("sb_publishable_"):
        return "PUBLISHABLE key  -> WRONG for the backend, you need the secret key"
    if key.count(".") == 2:
        try:
            part = key.split(".")[1]
            part += "=" * (-len(part) % 4)
            role = json.loads(base64.urlsafe_b64decode(part)).get("role")
            ok = role == "service_role"
            return f"legacy JWT key, role = {role}" + ("  -> correct" if ok else "  -> WRONG, you need service_role")
        except Exception:
            return "unreadable JWT"
    return "unknown format"


def mask(key):
    return (key[:12] + "...") if key else "(not set)"


if __name__ == "__main__":
    shell_key = os.environ.get("SUPABASE_KEY")           # set in this PowerShell window, if at all
    file_key = dotenv_values(".env").get("SUPABASE_KEY")  # what is written in .env

    print("supabase library :", end=" ")
    try:
        print(version("supabase"))
    except PackageNotFoundError:
        print("NOT INSTALLED")
    print(".env file key    :", mask(file_key), "|", classify(file_key))
    print("shell variable   :", mask(shell_key), "|", classify(shell_key) if shell_key else "")
    if shell_key and file_key and shell_key != file_key:
        print("\n!! This window has its OWN SUPABASE_KEY, and it overrides .env (load_dotenv does not replace it).")
        print("   Fix: run   Remove-Item Env:SUPABASE_KEY   then start uvicorn again.")

    load_dotenv()   # same behaviour as database.py
    key, url = os.getenv("SUPABASE_KEY"), os.getenv("SUPABASE_URL")
    print("\nKey the backend will use:", mask(key), "|", classify(key))
    print("Project URL             :", url)

    try:
        from supabase import create_client
        bucket = create_client(url, key).storage.from_("crm-photos")
        bucket.upload("_healthcheck/ping.txt", b"ok", {"content-type": "text/plain", "upsert": "true"})
        bucket.remove(["_healthcheck/ping.txt"])
        print("\nSTORAGE UPLOAD: OK  (photo upload should work now; restart uvicorn if it is running)")
    except Exception as e:
        print("\nSTORAGE UPLOAD: FAILED ->", e)

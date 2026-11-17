"""conftest.py - shared test setup (pytest loads it automatically).

database.py connects to Supabase the moment it is imported. Here we swap the real client for a mock
BEFORE that happens, so the tests run offline with no keys. Run them with:   python -m pytest
"""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_KEY", "test")

import supabase  # noqa: E402

supabase.create_client = lambda *a, **k: MagicMock()

sys.path.insert(0, str(Path(__file__).resolve().parent))   # this file lives in the project root

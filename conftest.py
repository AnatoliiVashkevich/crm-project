import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# main.py creates its Supabase/OpenAI clients at import time. Replace them with mocks
# so the tests never need real credentials or network access.
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_KEY", "test")
os.environ.setdefault("OPENAI_API_KEY", "test")

import openai
import supabase

supabase.create_client = lambda *a, **k: MagicMock()
openai.OpenAI = lambda *a, **k: MagicMock()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

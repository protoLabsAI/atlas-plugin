"""Dev helper for the real-console checks: run Atlas's own tool logic (show_target /
describe_current) against a live host's model, without the agent loop.

stdin: {"op": "show"|"current", "kwargs": {...}, "state": {...atlas.viewing...}}
env:   ATLAS_HOST (default http://127.0.0.1:7953), ATLAS_TOKEN
stdout: {"event": {...}} | {"error": "..."} | {"text": "..."}
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("atlas", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
mod = importlib.util.module_from_spec(spec)
sys.modules["atlas"] = mod
spec.loader.exec_module(mod)

from atlas import nav as N  # noqa: E402
from atlas.tools import describe_show, show_target  # noqa: E402

HOST = os.environ.get("ATLAS_HOST", "http://127.0.0.1:7953")
TOKEN = os.environ.get("ATLAS_TOKEN", "")


def _get(path):
    req = urllib.request.Request(HOST + path, headers={"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


class HttpService:
    def __init__(self):
        self.payload = _get("/api/plugins/atlas/model")

    def current(self):
        return self.payload, self.payload.get("model")

    def current_tours(self):
        return self.payload.get("tours")


req = json.load(sys.stdin)
svc = HttpService()
if req.get("op") == "current":
    st = N.ViewerState()
    st.update(req.get("state") or {})
    print(json.dumps({"text": N.describe_current(svc.current()[1], st)}))
else:
    event, why = show_target(svc, state=req.get("state"), **req.get("kwargs", {}))
    out = {"event": event, "text": describe_show(event, svc.current()[1])} if event else {"error": why}
    print(json.dumps(out))

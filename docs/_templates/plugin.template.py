"""my_plugin — register() is the ONLY place plugin code runs.

Keep host-only imports (graph.*, plugins.*) LAZY — inside functions or try/except
blocks — so the test suite imports your modules with no protoAgent host present.
Wrap each contribution group so one failure doesn't sink the rest.
"""

from __future__ import annotations

import json
import logging

from langchain_core.tools import tool  # the host provides this at runtime

log = logging.getLogger("protoagent.plugins.my_plugin")


def register(registry) -> None:
    cfg = registry.config or {}

    # 1. Console view (public) + data API (gated) — TWO routers, distinct prefixes.
    try:
        from .api import build_data_router, build_view_router

        registry.register_router(build_view_router(cfg), prefix="/plugins/my_plugin")
        registry.register_router(build_data_router(cfg), prefix="/api/plugins/my_plugin")
    except Exception:  # noqa: BLE001 — API is best-effort
        log.exception("[my_plugin] mounting routers failed")

    # 2. A background surface (a loop / listener), off unless configured.
    try:
        from .loop import MyLoop

        loop = MyLoop(cfg)
        registry.register_surface(loop.start, stop=loop.stop, name="my-plugin-loop")
    except Exception:  # noqa: BLE001
        log.exception("[my_plugin] registering surface failed")

    # 3. Tools the agent (or A2A) can drive headlessly.
    for t in _tools(cfg):
        registry.register_tool(t)

    # 4. Optional: subagents + a skill dir + workflows.
    try:
        registry.register_skill_dir("skills")
    except Exception:  # noqa: BLE001
        log.exception("[my_plugin] registering skills failed")

    log.info("[my_plugin] registered")


def _tools(cfg: dict):
    @tool
    def my_action(arg: str) -> str:
        """One-line description the model sees. Do the thing and return a short result."""
        return json.dumps({"ok": True, "arg": arg})

    return [my_action]


# api.py would define:
#
#   def build_view_router(cfg):
#       from fastapi import APIRouter
#       from fastapi.responses import HTMLResponse
#       from .view import PAGE
#       r = APIRouter()
#       @r.get("/view", response_class=HTMLResponse)
#       async def _view():
#           return HTMLResponse(PAGE)
#       return r
#
#   def build_data_router(cfg):           # gated under /api/plugins/my_plugin
#       from fastapi import APIRouter
#       r = APIRouter()
#       @r.get("/data")
#       async def _data() -> dict:
#           return {"items": []}
#       return r

"""Atlas HTTP — the viewer page + its assets (PUBLIC), the model + status (GATED).

| Route | Prefix | Auth |
|---|---|---|
| ``GET /view`` → ``static/index.html`` | ``/plugins/atlas`` | public (an iframe load carries no bearer) |
| ``GET /static/{path}`` → built viewer assets | ``/plugins/atlas`` | public (manifest ``public_paths``) |
| ``GET /model`` | ``/api/plugins/atlas`` | operator bearer |
| ``GET /status`` | ``/api/plugins/atlas`` | operator bearer |

``static/`` is built by the viewer's own toolchain (``web/`` → ``static/``) and committed; it is
served as-is. Until a build exists the view route returns a small placeholder page.
"""

from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path

from fastapi import Request  # module-level so the route's annotation resolves (PEP 563)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

PLACEHOLDER = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas</title>
<style>
  html,body{margin:0;background:var(--pl-color-bg,#fff);color:var(--pl-color-fg,#111);
    font-family:var(--pl-font-sans,system-ui,sans-serif);font-size:13px}
  .wrap{max-width:640px;margin:0 auto;padding:32px 24px}
</style>
<script>
  var BASE = location.pathname.split("/plugins/")[0];
  (function(){ var l=document.createElement("link"); l.rel="stylesheet";
    l.href=BASE+"/_ds/plugin-kit.css"; document.head.appendChild(l); })();
</script>
</head><body><div class="wrap">
  <h1>Atlas</h1>
  <p>The Atlas viewer hasn't been built yet (no <code>static/index.html</code> in the plugin).
  Run <code>npm run build</code> in the plugin's <code>web/</code> folder.</p>
</div>
<script type="module">
  try { const kit = await import(BASE + "/_ds/plugin-kit.js"); kit.initPluginView(); } catch (e) {}
</script>
</body></html>
"""

_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".map": "application/json",
}


def static_file(rel: str, base: Path | None = None) -> Path | None:
    """The file under ``static/`` for a request path, or None — never anything outside it."""
    root = (base or STATIC).resolve()
    if not rel or "\\" in rel or "\0" in rel:
        return None
    target = (root / rel).resolve()
    if root not in target.parents or not target.is_file():
        return None
    return target


def build_view_router(static_dir=None):
    """The PUBLIC router — mount under ``/plugins/atlas``."""
    from fastapi import APIRouter, HTTPException
    from fastapi.responses import FileResponse, HTMLResponse

    router = APIRouter()

    def _dir() -> Path:
        return Path(static_dir() if callable(static_dir) else (static_dir or STATIC))

    @router.get("/view", response_class=HTMLResponse)
    async def _view():
        index = _dir() / "index.html"
        html = index.read_text(encoding="utf-8") if index.is_file() else PLACEHOLDER
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    @router.get("/static/{path:path}")
    async def _static(path: str):
        target = static_file(path, _dir())
        if target is None:
            raise HTTPException(404)
        media = _TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        # Vite's hashed assets/ are immutable; anything else revalidates (FileResponse sends an ETag).
        cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return FileResponse(target, media_type=media, headers={"Cache-Control": cache})

    return router


TRANSITION_SPEEDS = ("slow", "normal", "fast")


def transition_speed(conf: dict | None) -> str:
    """The viewer's ``transition_speed`` setting — ``slow`` | ``normal`` | ``fast`` (default ``normal``)."""
    v = str((conf or {}).get("transition_speed") or "").strip().lower()
    return v if v in TRANSITION_SPEEDS else "normal"


def _etag_matches(header: str | None, h: str) -> bool:
    if not header:
        return False
    for tag in header.split(","):
        tag = tag.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag.strip('"') == h:
            return True
    return False


def build_data_router(service):
    """The GATED router — mount under ``/api/plugins/atlas`` (the host's operator-bearer gate)."""
    from fastapi import APIRouter
    from fastapi.responses import JSONResponse, Response

    router = APIRouter()

    @router.get("/model")
    async def _model(request: Request):
        payload = await asyncio.to_thread(service.get)
        etag = f'"{payload["hash"]}"'
        headers = {"ETag": etag, "Cache-Control": "no-cache"}
        if _etag_matches(request.headers.get("if-none-match"), payload["hash"]):
            return Response(status_code=304, headers=headers)
        return JSONResponse(payload, headers=headers)

    @router.get("/status")
    async def _status():
        status = await asyncio.to_thread(service.status)
        status["transition_speed"] = transition_speed(service.conf())
        return JSONResponse(status, headers={"Cache-Control": "no-store"})

    return router

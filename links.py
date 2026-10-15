"""Element-link normalisation — turn LikeC4 ``link`` urls into something the viewer can act on.

In the model, ``link /src/graph/agent.py#L10`` means a file **relative to the project root**
(not the model dir). ``./x`` / ``../x`` are relative to the ``.c4`` file; the engine already
resolves those into ``relative`` (relative to the model dir). Each link dict keeps its original
fields and gains:

* ``{kind: "code", path: "src/graph/agent.py", line: 10, end_line?: 20}`` — a file in the project;
* ``{kind: "web", url}`` — an ``http(s)`` link;
* ``{kind: "other"}`` — any other scheme (``vscode://``, ``mailto:``…), left for the viewer;
* ``{kind: "invalid", error}`` — a file link escaping the project root (``../../etc/passwd``),
  never offered as a code link.

Fragments: ``#L10``, ``#L10-L20``, ``#L10-20`` (GitHub style) and ``#10``.
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
_WEB = re.compile(r"^https?://", re.I)
_LINES = re.compile(r"^L?(\d+)(?:-L?(\d+))?$", re.I)


def parse_fragment(fragment: str) -> tuple[int | None, int | None]:
    """``"L10"`` → (10, None); ``"L10-L20"`` → (10, 20); anything else → (None, None)."""
    m = _LINES.match((fragment or "").strip())
    if not m:
        return None, None
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else None
    if start < 1:
        return None, None
    if end is not None and end < start:
        end = None
    return start, end


def classify(url: str, *, relative: str | None, project_root: Path, model_dir: Path) -> dict:
    """The extra fields for one link (see module doc)."""
    url = (url or "").strip()
    if _WEB.match(url):
        return {"kind": "web", "url": url}
    if url.startswith("//") or _SCHEME.match(url):
        return {"kind": "other"}
    raw, _, fragment = url.partition("#")
    line, end_line = parse_fragment(fragment)
    raw = unquote(raw)
    if not raw or raw.startswith("~"):
        return {"kind": "invalid", "error": "not a project file"}
    root = project_root.resolve()
    if raw.startswith("/"):
        target = root / raw.lstrip("/")
    else:
        rel = (relative or "").partition("#")[0]
        if rel.lower().startswith("file:"):
            # LikeC4 hands back an absolute file:// URL once a link leaves the model dir
            # (`link ../../src/a.py` from architecture/) — resolve it, then fence it below.
            parsed = urlparse(rel)
            if parsed.netloc not in ("", "localhost"):
                return {"kind": "invalid", "error": "not a project file"}
            target = Path(url2pathname(parsed.path))
        elif _SCHEME.match(rel) or rel.startswith("//"):
            return {"kind": "invalid", "error": "not a project file"}
        else:
            target = model_dir / (unquote(rel) if rel else raw)
    # Normalise lexically (".." collapses) and then follow symlinks — either escaping is refused.
    lexical = Path(posixpath.normpath(target.as_posix()))
    resolved = lexical.resolve()
    if not (_inside(lexical, root) and _inside(resolved, root)):
        return {"kind": "invalid", "error": "outside the project"}
    path = lexical.relative_to(root).as_posix()
    if path in ("", "."):
        return {"kind": "invalid", "error": "not a project file"}
    out: dict = {"kind": "code", "path": path}
    if line is not None:
        out["line"] = line
    if end_line is not None:
        out["end_line"] = end_line
    return out


def _inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def normalize_links(links, *, project_root: Path, model_dir: Path) -> list:
    if not isinstance(links, list):
        return links
    out = []
    for link in links:
        if isinstance(link, dict) and isinstance(link.get("url"), str):
            extra = classify(link["url"], relative=link.get("relative"), project_root=project_root, model_dir=model_dir)
            out.append({**link, **extra})
        else:
            out.append(link)
    return out


def normalize_model(model: dict, *, project_root: Path, model_dir: Path) -> dict:
    """Normalise every element link in an exported model, in place (elements + view nodes)."""
    if not isinstance(model, dict):
        return model
    kw = {"project_root": project_root, "model_dir": model_dir}
    for el in (model.get("elements") or {}).values():
        if isinstance(el, dict) and el.get("links"):
            el["links"] = normalize_links(el["links"], **kw)
    for view in (model.get("views") or {}).values():
        if not isinstance(view, dict):
            continue
        for node in view.get("nodes") or []:
            if isinstance(node, dict) and node.get("links"):
                node["links"] = normalize_links(node["links"], **kw)
    return model

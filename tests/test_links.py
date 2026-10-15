"""Link normalisation — code vs web, line fragments, and the project fence."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from atlas.links import classify, normalize_model, parse_fragment
from conftest import needs_node


@pytest.mark.parametrize(
    "frag,want",
    [
        ("L10", (10, None)),
        ("L10-L20", (10, 20)),
        ("L10-20", (10, 20)),
        ("10", (10, None)),
        ("l7", (7, None)),
        ("L20-L10", (20, None)),  # a backwards range keeps the start
        ("L0", (None, None)),
        ("section-2", (None, None)),
        ("", (None, None)),
    ],
)
def test_parse_fragment(frag, want):
    assert parse_fragment(frag) == want


@pytest.fixture
def roots(tmp_path):
    root = tmp_path / "proj"
    (root / "architecture" / "sub").mkdir(parents=True)
    return root.resolve(), (root / "architecture").resolve()


def test_root_relative_code_link(roots):
    root, md = roots
    out = classify("/src/graph/agent.py#L10", relative="src/graph/agent.py#L10", project_root=root, model_dir=md)
    assert out == {"kind": "code", "path": "src/graph/agent.py", "line": 10}


def test_code_link_range(roots):
    root, md = roots
    out = classify("/src/a.py#L3-L7", relative=None, project_root=root, model_dir=md)
    assert out == {"kind": "code", "path": "src/a.py", "line": 3, "end_line": 7}


def test_file_relative_link_uses_the_engines_relative(roots):
    root, md = roots
    # `./rel/x.py` written in architecture/sub/a.c4 → engine relative "sub/rel/x.py"
    out = classify("./rel/x.py#L2", relative="sub/rel/x.py#L2", project_root=root, model_dir=md)
    assert out == {"kind": "code", "path": "architecture/sub/rel/x.py", "line": 2}
    # one level up stays inside the model dir's parent → the engine still gives a plain relative…
    assert classify("../x.py", relative="x.py", project_root=root, model_dir=md)["path"] == "architecture/x.py"
    # …but leaving the model dir, LikeC4 1.60 hands back an absolute file:// URL
    up = classify("../../src/x.py", relative=(root / "src" / "x.py").as_uri(), project_root=root, model_dir=md)
    assert up == {"kind": "code", "path": "src/x.py"}


def test_file_url_relative_outside_the_project_is_rejected(roots):
    root, md = roots
    evil = classify("../../../../etc/passwd", relative="file:///etc/passwd", project_root=root, model_dir=md)
    assert evil["kind"] == "invalid" and "path" not in evil
    remote = classify("../x.py", relative="file://evil-host/share/x.py", project_root=root, model_dir=md)
    assert remote["kind"] == "invalid"


@pytest.mark.parametrize("url", ["https://likec4.dev/docs#L4", "http://example.com/x"])
def test_web_links(url, roots):
    root, md = roots
    assert classify(url, relative=None, project_root=root, model_dir=md) == {"kind": "web", "url": url}


def test_other_schemes(roots):
    root, md = roots
    assert classify("vscode://file/x", relative=None, project_root=root, model_dir=md) == {"kind": "other"}
    assert classify("//cdn/x.js", relative=None, project_root=root, model_dir=md) == {"kind": "other"}


@pytest.mark.parametrize(
    "url,relative",
    [
        ("/../../etc/passwd", None),
        ("/src/../../secret", None),
        ("../../../etc/passwd", "../../etc/passwd"),
        ("/%2e%2e/%2e%2e/etc/passwd", None),
        ("~/secrets", None),
        ("/", None),
    ],
)
def test_traversal_outside_the_project_is_rejected(url, relative, roots):
    root, md = roots
    out = classify(url, relative=relative, project_root=root, model_dir=md)
    assert out["kind"] == "invalid", out
    assert "path" not in out


def test_symlink_escape_is_rejected(roots, tmp_path):
    root, md = roots
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.py").write_text("x")
    (root / "link").symlink_to(outside)
    out = classify("/link/x.py", relative=None, project_root=root, model_dir=md)
    assert out["kind"] == "invalid"


@needs_node
def test_parent_links_through_the_real_engine(tmp_path):
    """The shape the REAL engine produces for `../` links (absolute file:// once they leave the
    model dir) — up-links into the project become code links, escapes are refused."""
    from atlas.engine import run_engine

    root = (tmp_path / "proj").resolve()
    md = root / "architecture"
    (md / "sub").mkdir(parents=True)
    (md / "likec4.config.json").write_text('{"name": "t"}')
    (md / "sub" / "a.c4").write_text(
        "specification { element system }\n"
        "model {\n  a = system 'A' {\n"
        "    link ../../src/a.py#L3 'up2'\n    link ../x.py 'up1'\n"
        "    link ../../../../../../../../etc/passwd 'evil'\n    link ./y.py 'here'\n  }\n}\n"
        "views { view index { include * } }\n"
    )
    out = run_engine(shutil.which("node"), "export", md)
    model = normalize_model(out["model"], project_root=root, model_dir=md)
    links = {lk["title"]: lk for lk in model["elements"]["a"]["links"]}
    assert (links["up2"]["kind"], links["up2"]["path"], links["up2"]["line"]) == ("code", "src/a.py", 3)
    assert links["up1"]["path"] == "architecture/x.py"
    assert links["here"]["path"] == "architecture/sub/y.py"
    assert links["evil"]["kind"] == "invalid" and "path" not in links["evil"]


def test_normalize_model_covers_elements_and_view_nodes(roots):
    root, md = roots
    link = {"url": "/src/a.py#L5", "title": "Source", "relative": "src/a.py#L5"}
    model = {
        "elements": {"a": {"id": "a", "links": [dict(link), {"url": "https://x.dev"}]}},
        "views": {"index": {"nodes": [{"id": "a", "links": [dict(link)]}, {"id": "b"}]}},
    }
    normalize_model(model, project_root=root, model_dir=md)
    el = model["elements"]["a"]["links"]
    assert el[0] == {**link, "kind": "code", "path": "src/a.py", "line": 5}  # original fields kept
    assert el[1] == {"url": "https://x.dev", "kind": "web"}
    assert model["views"]["index"]["nodes"][0]["links"][0]["kind"] == "code"
    assert "links" not in model["views"]["index"]["nodes"][1]


def test_paths_are_posix(roots):
    root, md = roots
    out = classify("/a/b/c.py", relative=None, project_root=root, model_dir=md)
    assert out["path"] == Path("a/b/c.py").as_posix()

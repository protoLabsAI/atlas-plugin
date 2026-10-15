"""atlas — drill-down architecture diagrams you can explore and present (LikeC4).

``register()`` mounts two routers: the PUBLIC ``/plugins/atlas`` one (the viewer page + its built
assets — an iframe load carries no bearer) and the GATED ``/api/plugins/atlas`` one (the exported
model + status). It registers three agent tools (``atlas_validate`` / ``atlas_describe`` /
``atlas_show``), the ``install-node`` setup step behind the "Install Node runtime" banner button,
and the ``skills/atlas`` authoring skill; then probes for a usable Node so a missing one shows as
a setup banner at load, not as a failed tool call.

Host-only imports stay lazy (inside the modules' functions, guarded) so the test suite runs with
no protoAgent host.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("protoagent.plugins.atlas")

PLUGIN_ID = "atlas"


def _store_dir(registry) -> Path | None:
    """This plugin's instance-scoped store dir (``sdk.plugin_store``), or None (memory only)."""
    pid = getattr(registry, "plugin_id", None) or PLUGIN_ID
    try:
        from graph import sdk

        return sdk.plugin_store(plugin_id=pid)
    except Exception:  # noqa: BLE001 — no host / an older host
        pass
    try:
        from infra.paths import instance_paths

        d = instance_paths().store(pid)
        d.mkdir(parents=True, exist_ok=True)
        return d
    except Exception:  # noqa: BLE001
        log.info("[atlas] no plugin store available — the last good model is kept in memory only")
        return None


def register(registry) -> None:
    from .engine import AtlasService
    from .nodes import STEP_INSTALL_NODE, NodeGap

    live = getattr(registry, "live_config", None) or (lambda: registry.config or {})
    gap = NodeGap(registry)
    service = AtlasService(live, store_dir=_store_dir(registry), gap=gap)

    try:
        from .api import build_data_router, build_view_router

        registry.register_router(build_view_router(), prefix="/plugins/atlas")
        registry.register_router(build_data_router(service), prefix="/api/plugins/atlas")
    except Exception:  # noqa: BLE001 — the routers are best-effort
        log.exception("[atlas] mounting the routers failed")

    try:
        from .tools import build_tools

        registry.register_tools(build_tools(service, registry))
    except Exception:  # noqa: BLE001
        log.exception("[atlas] registering the agent tools failed")

    # The step behind the banner's "Install Node runtime" button — registered BEFORE the probe
    # reports, so the first banner's button already works. Older hosts lack it (the banner then
    # degrades to its message + the node_path shortcut).
    add_step = getattr(registry, "register_setup_step", None)
    if callable(add_step):
        try:
            add_step(STEP_INSTALL_NODE, lambda: gap.start_install(service.node))
        except Exception:  # noqa: BLE001
            log.exception("[atlas] registering the install-node setup step failed")

    try:
        registry.register_skill_dir("skills")
    except Exception:  # noqa: BLE001
        log.exception("[atlas] registering the skill failed")

    try:
        info = service.node()
        log.info("[atlas] registered (node=%s %s via %s)", info.path or "MISSING", info.version, info.source or "-")
    except Exception:  # noqa: BLE001 — a preflight must never break loading
        log.exception("[atlas] node preflight failed")

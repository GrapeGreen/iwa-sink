# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""App Shell, Repo Hygiene, Overview, Routing, Theme, Headers & WCAG 2.2 AA E2E Suite (`12` tests)."""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from playwright.sync_api import expect

import tests.pw_harness as h

TESTS: list[h.TestSpec] = []
_SD1 = (".git", "node_modules", "dist", "certs", ".agents")
_SKIP_DIRS = {*_SD1, "__pycache__", ".venv", ".pytest_cache", ".ruff_cache"}
_EXT_ID = "gopkidjpdjfamphfffkhpmmmbmknflmk"


def _t(tid: str, tr: int, feat: str, ttl: str) -> Any:
    return h.e2e_test(TESTS, tid, tr, feat, ttl)


def _iter_project_files(repo_root: str) -> list[str]:
    out: list[str] = []
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        out.extend(os.path.join(root, fn) for fn in sorted(files))
    return out


@_t("SH-01", 1, "Hygiene", "Public npm registry, empty runtime deps & zero secrets")
def test_sh01_repo_and_registry_hygiene(ctx: h.E2EContext) -> None:
    root = Path(ctx.repo_root)
    gitignore = (root / ".gitignore").read_text("utf-8")
    for tok in ("node_modules", "dist", ".env", "certs", ".agents"):
        assert tok in gitignore, f"Expected {tok!r} in .gitignore"
    assert "https://registry.npmjs.org/" in (root / ".npmrc").read_text("utf-8")
    pkg = json.loads((root / "package.json").read_text("utf-8"))
    assert pkg.get("dependencies") == {} and (root / "pnpm-lock.yaml").is_file()
    rkw: dict[str, Any] = {"cwd": ctx.repo_root, "capture_output": True, "text": True}
    tracked = subprocess.run(["git", "ls-files"], check=True, **rkw).stdout.splitlines()
    bad_dir = [p for p in tracked if p.startswith(("certs/", "dist/", ".env"))]
    assert not bad_dir and not [p for p in tracked if p.endswith((".pem", ".swbn"))]
    banned = ("grain" + ".corp", "npm.corp.", "GOCSPX-", "BEGIN " + "PRIVATE KEY")
    scan_exts = (".ts", ".js", ".json", ".yaml", ".yml", ".md", ".npmrc", ".html")
    for fp in (p for p in _iter_project_files(ctx.repo_root) if p.endswith(scan_exts)):
        txt, rel = (
            Path(fp).read_text("utf-8", errors="ignore"),
            os.path.relpath(fp, ctx.repo_root),
        )
        for bad in banned:
            assert bad not in txt, f"Leaked {bad!r} in {rel}"


@_t("SH-02", 1, "License", "100% Apache-2.0 Google LLC headers & zero raw HTML sinks")
def test_sh02_apache_headers_and_trusted_types_hygiene(ctx: h.E2EContext) -> None:
    lic = (Path(ctx.repo_root) / "LICENSE").read_text("utf-8")
    assert "Apache License" in lic and "Version 2.0" in lic
    exts = {".ts", ".js", ".cjs", ".css", ".html", ".xml", ".yml", ".yaml", ".py"}
    c_re, missing = re.compile(r"Copyright\s+20\d{2}\s+Google\s+LLC"), []
    for fp in _iter_project_files(ctx.repo_root):
        bn, ext = os.path.basename(fp), os.path.splitext(fp)[1].lower()
        if bn != "pnpm-lock.yaml" and ext in exts:
            with open(fp, encoding="utf-8") as f:
                head = "".join(f.readline() for _ in range(25))
            if not (c_re.search(head) and "Apache License, Version 2.0" in head):
                missing.append(os.path.relpath(fp, ctx.repo_root))
    assert not missing, f"Files missing Apache-2.0 header: {missing}"
    sink_re = re.compile(r"\.\s*(?:inner|outer)HTML\s*=|\.\s*insertAdjacentHTML\s*\(")
    strip_re = re.compile(r"//.*?$|/\*[\s\S]*?\*/", re.MULTILINE)
    sinks = [
        os.path.relpath(fp, ctx.repo_root)
        for fp in _iter_project_files(os.path.join(ctx.repo_root, "src"))
        if fp.endswith((".ts", ".js"))
        and sink_re.search(strip_re.sub("", Path(fp).read_text("utf-8")))
    ]
    assert not sinks, f"Forbidden raw HTML sinks in src/: {sinks}"


@_t("SH-03", 1, "ExtensionFiles", "Companion extension .crx & zero retired paths")
def test_sh03_extension_artifacts_and_zero_retired_files(ctx: h.E2EContext) -> None:
    root = Path(ctx.repo_root)
    for rel in (
        "extension/IwaKitchenSinkExtension/manifest.json",
        "extension/IwaKitchenSinkExtension/scripts/background.js",
        "extension/IwaKitchenSinkExtension.crx",
        "extension/extension_manifest.xml",
    ):
        assert (root / rel).is_file(), f"Missing required extension artifact: {rel}"
    ext_man = json.loads(
        (root / "extension/IwaKitchenSinkExtension/manifest.json").read_text("utf-8")
    )
    assert ext_man["manifest_version"] == 3
    assert "isolated-app://*/*" in ext_man["externally_connectable"]["matches"]
    assert _EXT_ID in (root / "extension/extension_manifest.xml").read_text("utf-8")
    for retired in ("src/workspaces/mdns-radar", "tests/cdp_harness.py", "tests/tiers"):
        assert not (root / retired).exists(), f"Retired path still exists: {retired}"


@_t("SH-04", 1, "TypesDocs", "Zero tsc --noEmit errors & updated E2E docs")
def test_sh04_tsc_and_documentation(ctx: h.E2EContext) -> None:
    rc, out = h.run_tsc_no_emit(ctx.repo_root)
    assert rc == 0, f"tsc --noEmit failed ({rc}):\n{out}"
    readme = (Path(ctx.repo_root) / "README.md").read_text("utf-8")
    reqs = ("Windows", "macOS", "Linux", "ChromeOS", "pnpm build", "iwa-sink.swbn")
    for req in (*reqs, _EXT_ID, "tests/run_e2e.py"):
        assert req in readme, f"README.md missing {req!r}"
    assert not any(s in readme for s in ("242 end-to-end", "242 tests", "tests/tiers"))
    contrib = (Path(ctx.repo_root) / "CONTRIBUTING.md").read_text("utf-8")
    for s in ("pnpm typecheck", "pnpm build", "tests/run_e2e.py"):
        assert s in contrib
    assert "5-tier CDP" not in contrib


@_t("SH-05", 1, "Manifest", "IWA manifest permissions_policy, /hud.html & PNGs")
def test_sh05_manifest_and_icons(ctx: h.E2EContext) -> None:
    st, hdrs, raw = h.fetch_iwa_asset(
        ctx.session.page, "/.well-known/manifest.webmanifest"
    )
    assert st == 200 and "manifest+json" in hdrs.get("content-type", "")
    man: dict[str, Any] = json.loads(raw.decode("utf-8"))
    pp = man["permissions_policy"]
    p1 = ("direct-sockets", "direct-sockets-private", "controlled-frame", "sub-apps")
    p2 = ("window-management", "display-capture", "cross-origin-isolated")
    for req in (*p1, *p2, "local-network-access", "local-network", "loopback-network"):
        assert req in pp, f"Missing permissions_policy {req!r}"
    assert "camera" not in pp and "direct-sockets-multicast" not in pp
    unf = [
        d
        for d in man.get("display_override", [])
        if isinstance(d, dict) and d.get("display") == "unframed"
    ]
    assert unf and any(
        "/hud.html" in str(p.get("pathname", ""))
        for p in unf[0].get("url_patterns", [])
    )
    protos = {p["protocol"]: p["url"] for p in man.get("protocol_handlers", [])}
    assert set(protos) == {"cf", "web+cf"}
    assert all("%s" in u and "?" in u for u in protos.values())
    assert "focus-existing" in str(man.get("launch_handler", {}).get("client_mode", ""))
    purposes: set[str] = set()
    for ic in man.get("icons", []):
        purposes.update(str(ic.get("purpose", "any")).split())
        ist, _, iraw = h.fetch_iwa_asset(ctx.session.page, ic["src"])
        assert ist == 200 and h.verify_png_bytes(iraw, (512, 512))["valid"]
    assert {"any", "maskable"}.issubset(purposes)


@_t("SH-06", 1, "ShellBoot", "Overview boot, COI, Trusted Types & zero zombies")
def test_sh06_shell_boot_and_isolation(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    expect(pg.get_by_test_id("panel-overview")).to_be_visible()
    expect(pg.get_by_test_id("nav-overview")).to_have_attribute("aria-current", "page")
    boot = pg.evaluate(
        """() => ({ origin: location.origin, coi: window.crossOriginIsolated, hasTT: typeof window.trustedTypes?.createPolicy === 'function', inlineScripts: document.querySelectorAll('script:not([src])').length, metaCsp: document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length })"""
    )
    assert boot["origin"].startswith("isolated-app://") and boot["coi"] is True
    assert boot["hasTT"] is True and boot["inlineScripts"] == 0 and boot["metaCsp"] == 0
    assert ctx.session.companion_extension_id == _EXT_ID
    h.assert_no_deleted_zombie_dom(pg)


@_t("SH-07", 1, "Sidebar", "184px <-> 60px Icon Rail with Ctrl+B & 0.0px nav shift")
def test_sh07_collapsible_icon_rail(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    sidebar = pg.get_by_test_id("app-sidebar")
    btn = pg.get_by_test_id("sidebar-collapse-btn")
    expect(btn).to_have_attribute("aria-expanded", "true")
    pre = pg.evaluate(
        """() => ({ sw: Math.round(document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect().width), navTop: document.querySelector('[data-testid="nav-overview"]').getBoundingClientRect().top, btnW: document.querySelector('[data-testid="sidebar-collapse-btn"]').getBoundingClientRect().width, btnH: document.querySelector('[data-testid="sidebar-collapse-btn"]').getBoundingClientRect().height })"""
    )
    assert pre["sw"] == 184 and pre["btnW"] >= 32 and pre["btnH"] >= 32
    btn.click()
    expect(btn).to_have_attribute("aria-expanded", "false")
    expect(sidebar).to_have_attribute("data-sidebar-collapsed", "true")
    pg.wait_for_function(
        "() => Math.round(document.querySelector('[data-testid=\"app-sidebar\"]').getBoundingClientRect().width) === 60"
    )
    post = pg.evaluate(
        """() => { const bm = document.querySelector('.brand-mark'), cs = getComputedStyle(bm); return { sw: Math.round(document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect().width), navTop: document.querySelector('[data-testid="nav-overview"]').getBoundingClientRect().top, brandHidden: parseFloat(cs.opacity) === 0 || cs.display === 'none' || bm.getBoundingClientRect().width === 0, stored: localStorage.getItem('iwa-sink.sidebar-collapsed') }; }"""
    )
    assert post["sw"] == 60 and abs(post["navTop"] - pre["navTop"]) == 0.0
    assert post["brandHidden"] is True and post["stored"] == "1"
    pg.keyboard.press("Control+b")
    expect(btn).to_have_attribute("aria-expanded", "true")
    pg.wait_for_function(
        "() => Math.round(document.querySelector('[data-testid=\"app-sidebar\"]').getBoundingClientRect().width) === 184"
    )


@_t("SH-08", 1, "Overview", "Overview copy, full-width rows, focus & panels")
def test_sh08_overview_directory_and_persistent_panels(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    n_rows = len(h.get_workspace_ids(ctx)) - 1
    expect(pg.locator('[data-testid^="overview-row-"]')).to_have_count(n_rows)
    chk = pg.evaluate(
        """() => { const txt = (document.querySelector('[data-testid="overview-directory-card"]')?.textContent || '') + ' ' + (document.querySelector('.overview-lead')?.textContent || ''); return { txt, maxWidths: Array.from(document.querySelectorAll('.overview-row-desc')).map((d) => getComputedStyle(d).maxWidth), unspacedDash: /\\S—|—\\S/.test(txt) }; }"""
    )
    assert not chk["unspacedDash"]
    assert all(mw in ("none", "100%") for mw in chk["maxWidths"])
    for banned in ("mDNS", "UDP", "embedded SSO"):
        assert banned.lower() not in chk["txt"].lower()
    pg.evaluate("() => { window.__PW_BOOT_SENTINEL__ = 'alive'; }")
    open_tcp = pg.get_by_test_id("overview-open-tcp-terminal")
    open_tcp.focus()
    open_tcp.click()
    expect(pg.get_by_test_id("panel-tcp-terminal")).to_be_visible()
    st = pg.evaluate(
        """() => { const ov = document.querySelector('[data-testid="panel-overview"]'); return { sentinel: window.__PW_BOOT_SENTINEL__, ovAria: ov.getAttribute('aria-hidden'), ovDisp: getComputedStyle(ov).display, focusInHidden: ov.contains(document.activeElement) }; }"""
    )
    assert st["sentinel"] == "alive" and st["ovAria"] == "true"
    assert st["ovDisp"] != "none" and st["focusInHidden"] is False


@_t("SH-09", 2, "Routing", "?workspace=<id> normalization, fallback & CrOS gating")
def test_sh09_workspace_query_routing_and_cros_gating(ctx: h.E2EContext) -> None:
    pg, orig = ctx.session.page, ctx.session.origin
    ctx.session.launch_app_url(f"{orig}/index.html?workspace=%20TCP-TERMINAL%20")
    expect(pg.get_by_test_id("panel-tcp-terminal")).to_be_visible()
    ctx.session.launch_app_url(f"{orig}/index.html?workspace=mdns-radar")
    expect(pg.get_by_test_id("panel-overview")).to_be_visible()
    if (nc := ctx.non_cros_session) is not None:
        cnts = [
            nc.page.locator(f'[data-testid="nav-{w}"]').count()
            for w in h.LINUX_WORKSPACE_IDS
        ]
        assert cnts == [1] * 7
        expect(nc.page.get_by_test_id("nav-screen-capture")).to_have_count(0)
        nc.launch_app_url(f"{nc.origin}/index.html?workspace=screen-capture")
        expect(nc.page.get_by_test_id("panel-overview")).to_be_visible()
    if (cros := ctx.cros_session) is not None:
        cnts = [
            cros.page.locator(f'[data-testid="nav-{w}"]').count()
            for w in h.CROS_WORKSPACE_IDS
        ]
        assert cnts == [1] * 8
        cros.launch_app_url(f"{cros.origin}/index.html?workspace=screen-capture")
        expect(cros.page.get_by_test_id("panel-screen-capture")).to_be_visible()
        uv = cros.cros_unframed_verified or {}
        assert uv.get("unframed") is True and uv.get("standalone") is False
        assert "?compact=1#live" in str(uv.get("url", ""))


@_t("SH-10", 1, "Theme", "Warm Dark/Light toggle, SC 2.5.3 label & BroadcastChannel")
def test_sh10_warm_dark_light_theme_sync(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    toggle = pg.get_by_test_id("theme-toggle-btn")
    expect(pg.locator("html")).to_have_attribute("data-theme", "dark")
    expect(toggle).to_contain_text("Light theme")
    assert "light theme" in (toggle.get_attribute("aria-label") or "").lower()
    pg.evaluate(
        "() => { window.__pwThemeBc = null; const ch = new BroadcastChannel('iwa-sink-theme'); ch.onmessage = (e) => { window.__pwThemeBc = e.data; ch.close(); }; }"
    )
    toggle.click()
    expect(pg.locator("html")).to_have_attribute("data-theme", "light")
    expect(toggle).to_contain_text("Dark theme")
    assert "dark theme" in (toggle.get_attribute("aria-label") or "").lower()
    pg.wait_for_function("() => window.__pwThemeBc !== null")
    bc_msg = pg.evaluate(
        "() => { const m = window.__pwThemeBc; delete window.__pwThemeBc; return m; }"
    )
    assert isinstance(bc_msg, dict) and bc_msg.get("theme") == "light"
    meta = pg.evaluate(
        """() => ({ scheme: document.documentElement.style.colorScheme, metaScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'), metaColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'), stored: localStorage.getItem('iwa-sink.theme') })"""
    )
    assert (
        len(meta) == 4 and meta["scheme"] == "light" and meta["metaScheme"] == "light"
    )
    assert meta["metaColor"] == "#faf7f2" and meta["stored"] == "light"
    pg.evaluate(
        "() => { const ch = new BroadcastChannel('iwa-sink-theme'); ch.postMessage({ type: 'THEME_CHANGE', theme: 'dark' }); ch.close(); }"
    )
    expect(pg.locator("html")).to_have_attribute("data-theme", "dark")


@_t("SH-11", 5, "Headers", "Single CSP, COOP, COEP, CORP & nosniff headers")
def test_sh11_security_and_isolation_headers(ctx: h.E2EContext) -> None:
    pg, vbase = ctx.session.page, ctx.vite_url.rstrip("/")

    def _chk_coi(hdrs: dict[str, str]) -> None:
        assert hdrs.get("cross-origin-opener-policy") == "same-origin"
        assert hdrs.get("cross-origin-embedder-policy") == "require-corp"
        assert hdrs.get("cross-origin-resource-policy") == "same-origin"

    r1 = ("/", "/hud.html", "/sub/telnet/index.html")
    r2 = ("/sub/telnet/manifest.webmanifest", "/.well-known/manifest.webmanifest")
    for route in (*r1, *r2):
        vst, vhdrs, _ = h.http_get(f"{vbase}{route}")
        assert vst == 200 and vhdrs.get("content-security-policy", "") == ""
        ist, ihdrs, _ = h.fetch_iwa_asset(pg, route)
        icsp = ihdrs.get("content-security-policy", "")
        assert ist == 200 and icsp.count("default-src") == 1
        assert "base-uri 'none'" in icsp and "object-src 'none'" in icsp
        assert "require-trusted-types-for 'script'" in icsp
        _chk_coi(ihdrs)
    dp = "/dynamic/header-probe"
    d_routes = ("/__dev_dynamic_subapps", f"{dp}/index.html", f"{dp}/icon-512.png")
    for dyn_route in (*d_routes, f"{dp}/manifest.webmanifest"):
        dst, dhdrs, _ = h.http_get(f"{vbase}{dyn_route}")
        assert dst == 200 and dhdrs.get("content-security-policy", "") == ""
        assert dhdrs.get("x-content-type-options") == "nosniff"
        _chk_coi(dhdrs)
        ist2, ihdrs2, _ = h.fetch_iwa_asset(pg, dyn_route)
        c2 = ihdrs2.get("content-security-policy", "")
        assert ist2 == 200 and c2.count("default-src") == 1
    assert pg.evaluate(
        "() => window.crossOriginIsolated === true && window.trustedTypes?.defaultPolicy === null"
    )


def _assert_viewport_resize_geometry(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    cdp = pg.context.new_cdp_session(pg)
    raf2 = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"

    def _vp(target_pg: Any, target_cdp: Any, w: int, ht: int) -> None:
        ov = {"width": w, "height": ht, "deviceScaleFactor": 1, "mobile": False}
        target_cdp.send("Emulation.setDeviceMetricsOverride", ov)
        target_pg.wait_for_function(
            "([tw, th]) => window.innerWidth === tw && window.innerHeight === th",
            arg=[w, ht],
        )
        target_pg.evaluate(raf2)

    try:
        ctx.session.activate_workspace("overview")
        _vp(pg, cdp, 700, 850)
        for toggle in (False, True):
            if toggle:
                pg.keyboard.press("Control+b")
                pg.evaluate(raf2)
            d1 = pg.evaluate(
                """() => {
                  const sb = document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect();
                  const cw = document.documentElement.clientWidth;
                  const items = [...document.querySelectorAll('[data-testid="app-sidebar"] .nav-item')].map((n) => n.getBoundingClientRect());
                  return {
                    sw: Math.round(sb.width),
                    cw,
                    sh: Math.round(sb.height),
                    overflow: document.documentElement.scrollWidth - cw,
                    clipped: items.some((r) => r.right > sb.right + 1 || r.width < 32 || r.height < 32),
                  };
                }"""
            )
            assert d1["sw"] == d1["cw"] and d1["sh"] <= 200, d1
            assert d1["overflow"] <= 0 and not d1["clipped"], d1
        pg.keyboard.press("Control+b")
        _vp(pg, cdp, 1280, 380)
        pg.wait_for_function(
            "() => Math.round(document.querySelector('[data-testid=\"app-sidebar\"]').getBoundingClientRect().width) === 184"
        )
        d1_short = pg.evaluate(
            """() => {
              const sb = document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect();
              const br = document.querySelector('[data-testid="app-sidebar"] .brand').getBoundingClientRect();
              const th = document.querySelector('[data-testid="theme-toggle-btn"]').getBoundingClientRect();
              return { sw: Math.round(sb.width), brandH: br.height, themeH: th.height };
            }"""
        )
        assert (
            d1_short["sw"] == 184
            and d1_short["brandH"] >= 30
            and d1_short["themeH"] >= 32
        )

        ctx.session.activate_workspace("sub-apps")
        pg.get_by_test_id("subapps-tab-builder").click()
        pg.get_by_test_id("dyn-subapp-add-field-btn").click()
        for vw, vh in (
            (1121, 560),
            (980, 680),
            (922, 720),
            (720, 800),
            (480, 900),
            (360, 700),
        ):
            _vp(pg, cdp, vw, vh)
            d2 = pg.evaluate(
                """() => {
                  const key = document.querySelector('.subapp-manifest-key-col').getBoundingClientRect();
                  const rm = document.querySelector('[data-testid="dyn-subapp-field-remove-btn"]').getBoundingClientRect();
                  const val = document.querySelector('[data-testid="dyn-subapp-field-json-value"]').getBoundingClientRect();
                  const nm = document.querySelector('[data-testid="dyn-subapp-name"]').getBoundingClientRect();
                  const sl = document.querySelector('[data-testid="dyn-subapp-slug"]').getBoundingClientRect();
                  const cw = document.documentElement.clientWidth;
                  return {
                    valW: val.width,
                    nmW: nm.width,
                    slW: sl.width,
                    rmRowDelta: Math.abs(rm.top - key.top),
                    rmAboveVal: rm.bottom <= val.top + 1,
                    stacked: val.top >= key.bottom - 1,
                    overflow: document.documentElement.scrollWidth - cw,
                  };
                }"""
            )
            assert d2["valW"] >= 220 and d2["nmW"] >= 220 and d2["slW"] >= 220, (vw, d2)
            assert d2["overflow"] <= 0 and d2["rmRowDelta"] <= 6, (vw, d2)
            if vw in (720, 480, 360):
                assert d2["stacked"] and d2["rmAboveVal"], (vw, d2)
        _vp(pg, cdp, 1440, 900)
        cq_ok = pg.evaluate(
            """() => {
              const rc = document.querySelector('.subapps-builder-right-col');
              rc.style.maxWidth = '500px';
              try {
                const key = document.querySelector('.subapp-manifest-key-col').getBoundingClientRect();
                const rm = document.querySelector('[data-testid="dyn-subapp-field-remove-btn"]').getBoundingClientRect();
                const val = document.querySelector('[data-testid="dyn-subapp-field-json-value"]').getBoundingClientRect();
                return val.top >= key.bottom - 1 && Math.abs(rm.top - key.top) <= 6 && rm.bottom <= val.top + 1;
              } finally {
                rc.style.removeProperty('max-width');
              }
            }"""
        )
        assert cq_ok
        pg.get_by_test_id("dyn-subapp-field-remove-btn").click()
        pg.get_by_test_id("subapps-tab-bundled").click()
        pg.evaluate(
            """() => {
              const ch = new BroadcastChannel('iwa-sink-subapps');
              ch.postMessage({
                type: 'SUBAPP_HEARTBEAT',
                appId: '/dynamic/longslug/index.html',
                scope: '/dynamic/longslug/',
                title: 'SupercalifragilisticexpialidociousWindowTitleWithoutSpacesOrHyphens99',
                instanceId: 'pw-defect01',
                ts: Date.now(),
              });
              ch.close();
            }"""
        )
        expect(pg.get_by_test_id("subapps-window-tracker")).to_be_visible()
        for vw, vh in ((359, 500), (380, 640)):
            _vp(pg, cdp, vw, vh)
            d01 = pg.evaluate(
                """() => {
                  const cw = document.documentElement.clientWidth;
                  const it = document.querySelector('[data-testid="subapps-tracker-item"]').getBoundingClientRect();
                  const nm = document.querySelector('.subapps-tracker-name').getBoundingClientRect();
                  return {
                    overflow: document.documentElement.scrollWidth - cw,
                    nmInItem: nm.right <= it.right + 1,
                  };
                }"""
            )
            assert d01["overflow"] <= 0 and d01["nmInItem"], (vw, d01)
        pg.get_by_test_id("subapp-tracker-close-btn").click()
        expect(pg.get_by_test_id("subapps-window-tracker")).to_be_hidden()
        _vp(pg, cdp, 480, 900)
        d4 = pg.evaluate(
            """() => {
              const hm = document.querySelector('[data-testid="panel-sub-apps"] .ws-header-main').getBoundingClientRect();
              const rl = document.querySelector('[data-testid="panel-sub-apps"] .subapp-row-left').getBoundingClientRect();
              const tt = document.querySelector('[data-testid="panel-sub-apps"] .subapp-row-title');
              return { hdrMainW: hm.width, rowLeftW: rl.width, titleTrunc: tt.scrollWidth > Math.ceil(tt.clientWidth) };
            }"""
        )
        assert (
            d4["hdrMainW"] >= 400 and d4["rowLeftW"] >= 240 and not d4["titleTrunc"]
        ), d4

        ctx.session.activate_workspace("controlled-frame-tls")
        _vp(pg, cdp, 1280, 850)
        cf_handle = pg.get_by_test_id("cf-resize-handle")
        cf_handle.focus()
        pg.keyboard.press("PageDown")
        pg.keyboard.press("PageDown")
        assert (
            pg.evaluate(
                "() => Math.round(document.querySelector('[data-testid=\"cf-viewport-container\"]').getBoundingClientRect().height)"
            )
            == 720
        )
        _vp(pg, cdp, 1280, 340)
        assert (
            pg.evaluate(
                "() => Math.round(document.querySelector('[data-testid=\"cf-viewport-container\"]').getBoundingClientRect().height)"
            )
            == 220
        )
        _vp(pg, cdp, 1280, 850)
        assert (
            pg.evaluate(
                "() => Math.round(document.querySelector('[data-testid=\"cf-viewport-container\"]').getBoundingClientRect().height)"
            )
            == 720
        )
        cf_handle.dblclick()
        assert (
            pg.evaluate(
                "() => document.querySelector('[data-testid=\"cf-viewport-container\"]').style.height"
            )
            == ""
        )
        _vp(pg, cdp, 1280, 380)
        cf_short_h = pg.evaluate(
            "() => Math.round(document.querySelector('[data-testid=\"cf-viewport-container\"]').getBoundingClientRect().height)"
        )
        assert 220 <= cf_short_h <= 260, cf_short_h
        _vp(pg, cdp, 1440, 900)
        cf_tall_h = pg.evaluate(
            "() => Math.round(document.querySelector('[data-testid=\"cf-viewport-container\"]').getBoundingClientRect().height)"
        )
        assert cf_tall_h == 480, cf_tall_h

        cf_console_toggle = pg.get_by_test_id("cf-toggle-console-btn")
        cf_console_toggle.click()
        prev_prov = pg.evaluate(
            """() => {
              const el = document.querySelector('[data-testid="tls-provenance-url"]');
              const old = el.textContent;
              el.textContent = 'https://127.0.0.1:41235';
              return old;
            }"""
        )
        try:
            _vp(pg, cdp, 359, 500)
            d04 = pg.evaluate(
                """() => {
                  const cw = document.documentElement.clientWidth;
                  const cbEl = document.querySelector('[data-testid="cf-clear-log-btn"]');
                  const cb = cbEl.getBoundingClientRect();
                  const card = cbEl.closest('.card').getBoundingClientRect();
                  const prov = document.querySelector('[data-testid="tls-provenance-url"]').getBoundingClientRect();
                  return {
                    overflow: document.documentElement.scrollWidth - cw,
                    clearPadR: card.right - cb.right,
                    provW: prov.width,
                  };
                }"""
            )
            assert (
                d04["overflow"] <= 0 and d04["clearPadR"] >= 12 and d04["provW"] >= 200
            ), d04
        finally:
            pg.evaluate(
                "(old) => { document.querySelector('[data-testid=\"tls-provenance-url\"]').textContent = old; }",
                prev_prov,
            )
            cf_console_toggle.click()

        ctx.session.activate_workspace("windowing-hud")
        for (vw, vh), exp_cols in (
            ((1440, 900), 4),
            ((960, 400), 2),
            ((760, 720), 2),
            ((480, 900), 1),
        ):
            _vp(pg, cdp, vw, vh)
            d6 = pg.evaluate(
                """() => {
                  const cards = [...document.querySelectorAll('[data-testid="panel-windowing-hud"] .win-awc-card-btn')];
                  const xs = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left)));
                  const padClip = cards.some((c) => {
                    const cr = c.getBoundingClientRect();
                    const ar = c.querySelector('.win-awc-btn-api').getBoundingClientRect();
                    return ar.right > cr.right - 8 || ar.left < cr.left + 8;
                  });
                  return {
                    cols: xs.size,
                    padClip,
                    overflow: document.documentElement.scrollWidth - window.innerWidth,
                  };
                }"""
            )
            assert (
                d6["cols"] == exp_cols and not d6["padClip"] and d6["overflow"] <= 0
            ), (vw, d6)
    finally:
        with contextlib.suppress(Exception):
            cdp.send("Emulation.clearDeviceMetricsOverride")
            pg.evaluate(raf2)
        with contextlib.suppress(Exception):
            cdp.detach()

    dyn_url = (
        "/dynamic/unbreakableslugxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/index.html"
        "?name=SupercalifragilisticexpialidociousAppTitle99"
    )
    with pg.context.expect_page(timeout=8000) as dyn_info:
        pg.evaluate("(u) => window.open(u, '_blank')", dyn_url)
    dyn_pg = dyn_info.value
    dyn_cdp = dyn_pg.context.new_cdp_session(dyn_pg)
    try:
        dyn_pg.wait_for_load_state("domcontentloaded")
        expect(dyn_pg.get_by_test_id("dynamic-subapp-log")).to_be_visible()
        dyn_pg.evaluate(
            "() => { document.getElementById('dynamic-subapp-log').textContent += '\\n' + 'x'.repeat(180); }"
        )
        for dw, dh in ((320, 260), (520, 600)):
            _vp(dyn_pg, dyn_cdp, dw, dh)
            d02 = dyn_pg.evaluate(
                """() => {
                  const cw = document.documentElement.clientWidth;
                  const card = document.querySelector('.card').getBoundingClientRect();
                  const td = document.querySelector('.bar .row > div').getBoundingClientRect();
                  const lg = document.getElementById('dynamic-subapp-log');
                  return {
                    overflow: document.documentElement.scrollWidth - cw,
                    titleClip: td.right - card.right,
                    logOverflow: lg.scrollWidth - lg.clientWidth,
                  };
                }"""
            )
            assert (
                d02["overflow"] <= 0
                and d02["titleClip"] <= 1
                and d02["logOverflow"] <= 1
            ), (dw, d02)
    finally:
        with contextlib.suppress(Exception):
            dyn_cdp.detach()
        with contextlib.suppress(Exception):
            dyn_pg.close()
        pg.evaluate(
            """() => {
              document.querySelectorAll('[data-testid="subapp-tracker-close-btn"]').forEach((b) => b.click());
            }"""
        )

    if (cros := ctx.cros_session) is not None:
        with cros.context.expect_page(timeout=8000) as pinfo:
            cros.page.evaluate(
                "() => window.open('/hud.html?compact=1#live', '_blank')"
            )
        hud_pg = pinfo.value
        hud_cdp = hud_pg.context.new_cdp_session(hud_pg)
        try:
            hud_pg.wait_for_load_state("domcontentloaded")
            expect(hud_pg.get_by_test_id("hud-close-btn")).to_be_visible()
            hud_pg.evaluate(
                """() => {
                  const ch = new BroadcastChannel('iwa-sink-subapps');
                  ch.postMessage({
                    type: 'SHELL_TELEMETRY',
                    activeWorkspace: 'tcp-terminal',
                    tcpEchoRunning: true,
                    tcpEchoHost: '::1',
                    tcpEchoPort: 43821,
                    tcpBytesEchoed: 1228,
                    theme: 'dark',
                    ts: Date.now(),
                  });
                  ch.close();
                }"""
            )
            expect(hud_pg.get_by_test_id("hud-telemetry-summary")).to_contain_text(
                "[::1]:43821"
            )
            for hw, hh in ((362, 260), (280, 220)):
                _vp(hud_pg, hud_cdp, hw, hh)
                d3 = hud_pg.evaluate(
                    """() => {
                      const cb = document.querySelector('[data-testid="hud-close-btn"]').getBoundingClientRect();
                      const gaps = [...document.querySelectorAll('.kv-row')].map((r) => {
                        const k = r.querySelector('.kv-key').getBoundingClientRect();
                        const v = r.querySelector('.kv-val').getBoundingClientRect();
                        return v.left - k.right;
                      });
                      return {
                        overflow: document.documentElement.scrollWidth - window.innerWidth,
                        closeRight: cb.right,
                        closeLeft: cb.left,
                        minGap: Math.min(...gaps),
                      };
                    }"""
                )
                assert (
                    d3["overflow"] <= 0
                    and 0 <= d3["closeLeft"]
                    and d3["closeRight"] <= hw
                ), (
                    hw,
                    d3,
                )
                assert d3["minGap"] >= 8, (hw, d3)
        finally:
            with contextlib.suppress(Exception):
                hud_cdp.detach()
            with contextlib.suppress(Exception):
                hud_pg.close()


@_t("SH-12", 5, "WCAG", "WCAG 2.2 AA contrast, hit targets, >=12px font & 0px overflow")
def test_sh12_wcag_aa_and_responsive_viewports(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    for ws_id in h.get_workspace_ids(ctx):
        ctx.session.activate_workspace(ws_id)
        h.audit_wcag_and_overflow(pg, viewports=((1440, 900), (768, 1024), (390, 844)))
    ctx.session.activate_workspace("overview")
    pg.get_by_test_id("theme-toggle-btn").click()
    expect(pg.locator("html")).to_have_attribute("data-theme", "light")
    for ws_id in ("overview", "tcp-terminal", "controlled-frame-tls", "sso-offloading"):
        ctx.session.activate_workspace(ws_id)
        h.audit_wcag_and_overflow(pg, viewports=((1440, 900), (390, 844)))
    pg.get_by_test_id("theme-toggle-btn").click()
    expect(pg.locator("html")).to_have_attribute("data-theme", "dark")
    _assert_viewport_resize_geometry(ctx)
    ctx.session.activate_workspace("tcp-terminal")
    assert "tabular-nums" in pg.evaluate(
        "() => getComputedStyle(document.querySelector('.mono')).fontVariantNumeric"
    )


def build_tests() -> list[h.TestSpec]:
    return list(TESTS)

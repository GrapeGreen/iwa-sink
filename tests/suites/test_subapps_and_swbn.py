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

"""Sub-Apps, Dynamic SW Builder, Telnet Child & `.swbn` Suite (`14` tests)."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from playwright.sync_api import Locator, Page, expect

import tests.pw_harness as h

TESTS: list[h.TestSpec] = []
_TELNET_ID = "/sub/telnet/index.html"


def _t(tid: str, tr: int, feat: str, ttl: str, swbn: bool = False) -> Any:
    return h.e2e_test(TESTS, tid, tr, feat, ttl, requires_swbn=swbn)


def _el(pg: Page, test_id: str) -> Locator:
    return pg.get_by_test_id(test_id)


def _ws(ctx: h.E2EContext) -> Page:
    ctx.session.activate_workspace("sub-apps")
    return ctx.session.page


def _row(pg: Page, app_id: str) -> Locator:
    return pg.locator(f'[data-testid="subapp-item"][data-subapp-id="{app_id}"]')


def _ok_png(raw: bytes) -> bool:
    return bool(h.verify_png_bytes(raw, (512, 512))["valid"])


def _ok_data_png(src: str) -> bool:
    return _ok_png(base64.b64decode(src.split(",", 1)[1]))


def _build_swbn(ctx: h.E2EContext) -> str:
    rc, out, swbn_path = h.run_clean_pnpm_build(ctx.repo_root)
    assert rc == 0 and os.path.isfile(swbn_path), out
    return swbn_path


def _start_echo_ws(sess: h.PlaywrightIwaSession) -> int:
    sess.activate_workspace("tcp-terminal")
    _el(sess.page, "echo-port-input").fill("0")
    _el(sess.page, "echo-start-btn").click()
    expect(_el(sess.page, "echo-bound-port")).to_be_visible()
    p = h.extract_port(_el(sess.page, "echo-bound-port").text_content() or "")
    assert p is not None
    return p


def _sync_clean_subapps(ctx: h.E2EContext) -> Page:
    pg = _ws(ctx)
    pg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    expect(_el(pg, "subapp-catalog-card")).to_be_visible(timeout=6000)
    expect(_el(pg, "subapp-item")).to_have_count(0, timeout=6000)
    return pg


def _install_telnet(pg: Page) -> None:
    item = _row(pg, _TELNET_ID)
    if item.count() == 0:
        _el(pg, "subapp-install-btn").click()
        expect(item).to_be_visible(timeout=8000)


def _launch_subapp(sess: h.PlaywrightIwaSession, app_id: str) -> Page:
    with sess.context.expect_page(timeout=8000) as info:
        _row(sess.page, app_id).get_by_test_id("subapp-launch-btn").click()
    child = info.value
    child.wait_for_load_state("domcontentloaded")
    return child


def _create_dyn(pg: Page, name: str, slug: str, fields: Any = None) -> str:
    _el(pg, "subapps-tab-builder").click()
    _el(pg, "dyn-subapp-name").fill(name)
    _el(pg, "dyn-subapp-slug").fill(slug)
    for idx, (key, val) in enumerate(fields or []):
        _el(pg, "dyn-subapp-add-field-btn").click()
        _el(pg, "dyn-subapp-field-key-select").nth(idx).select_option(key)
        if val is not None:
            _el(pg, "dyn-subapp-field-json-value").nth(idx).fill(val)
    _el(pg, "dyn-subapp-create-install-btn").click()
    app_id = f"/dynamic/{slug}/index.html"
    expect(_row(pg, app_id)).to_be_visible(timeout=8000)
    return app_id


@_t("SA-01", 1, "SubAppsTabsAria", "Segmented ARIA tabs, roving focus & 0 zombies")
def test_sa01(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    h.assert_no_deleted_zombie_dom(pg)
    for z in ("subapps-install-bundled-btn", "subapps-refresh-list-btn"):
        expect(_el(pg, z)).to_have_count(0)
    t_bun, t_bld = _el(pg, "subapps-tab-bundled"), _el(pg, "subapps-tab-builder")
    expect(t_bun).to_have_attribute("aria-selected", "true")
    expect(t_bld).to_have_attribute("aria-selected", "false")
    t_bun.focus()
    pg.keyboard.press("ArrowRight")
    expect(t_bld).to_have_attribute("aria-selected", "true")
    expect(t_bld).to_be_focused()
    expect(_el(pg, "subapps-panel-builder")).to_be_visible()
    expect(_el(pg, "subapps-panel-bundled")).to_have_attribute("aria-hidden", "true")
    pg.keyboard.press("Home")
    expect(t_bun).to_have_attribute("aria-selected", "true")


@_t("SA-02", 1, "BundledCatalogInstall", "Bundled /sub/telnet/ & <2 Remove All gate")
def test_sa02(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    expect(_el(pg, "subapps-remove-all-btn")).to_be_hidden()
    expect(_el(pg, "subapps-window-tracker")).to_be_hidden()
    _install_telnet(pg)
    pg.wait_for_timeout(300)
    expect(_el(pg, "subapps-window-tracker")).to_be_hidden()
    expect(_el(pg, "subapps-remove-all-btn")).to_be_hidden()


@_t("SA-03", 1, "TelnetLaunchAndEcho", "Launch /sub/telnet/, theme sync & TCP Echo")
def test_sa03(ctx: h.E2EContext) -> None:
    port = _start_echo_ws(ctx.session)
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    child = _launch_subapp(ctx.session, _TELNET_ID)
    expect(child.locator(".meta-tag.mono")).to_have_text("Sub-App · /sub/telnet/")
    expect(_el(child, "telnet-parent-echo-status")).to_have_count(0)
    expect(child.locator(".subapp-shell > .is-hidden")).to_have_count(0)
    for expected in ["light", "dark"]:
        _el(pg, "theme-toggle-btn").click()
        expect(child.locator("html")).to_have_attribute("data-theme", expected)
    _el(child, "tcp-host-input").fill("127.0.0.1")
    _el(child, "tcp-port-input").fill(str(port))
    _el(child, "tcp-connect-btn").click()
    expect(_el(child, "tcp-disconnect-btn")).to_be_enabled()
    expect(_el(child, "tcp-client-status")).to_contain_text("Connected")
    _el(child, "tcp-payload-input").fill("TELNET_ECHO_PING")
    _el(child, "tcp-send-btn").click()
    expect(_el(child, "tcp-terminal-screen")).to_contain_text("TELNET_ECHO_PING")
    child.close()


@_t("SA-04", 3, "TelnetFileLaunch", "PWA.launchFilesInApp .telnet profile launch")
def test_sa04(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    greet = b"TELNET_PROFILE_READY\r\n"
    with (
        h.EphemeralTcpPeerServer(greeting=greet) as peer,
        tempfile.TemporaryDirectory() as td,
    ):
        prof = Path(td) / "local-peer.telnet"
        prof.write_text(f"# profile\n127.0.0.1:{peer.port}\n", encoding="utf-8")
        child = ctx.session.launch_files_in_app(_TELNET_ID, [str(prof)])
        expect(_el(child, "tcp-host-input")).to_have_value("127.0.0.1")
        expect(_el(child, "tcp-port-input")).to_have_value(str(peer.port))
        _el(child, "tcp-connect-btn").click()
        scr = _el(child, "tcp-terminal-screen")
        expect(scr).to_contain_text("TELNET_PROFILE_READY")
        child.close()


@_t("SA-05", 1, "WindowTrackerPingClose", "Window tracker, PARENT_PING RTT & Close")
def test_sa05(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    child = _launch_subapp(ctx.session, _TELNET_ID)
    tracker = _el(pg, "subapps-window-tracker")
    expect(tracker).to_be_visible()
    expect(_el(pg, "subapps-open-windows-count")).to_have_text("1 Window Open")
    _el(pg, "subapps-tab-builder").click()
    expect(tracker).to_be_visible()
    _el(pg, "subapps-tab-bundled").click()
    _el(pg, "subapps-toggle-console-btn").click()
    ping_js = "() => { const c = new BroadcastChannel('iwa-sink-subapps'); c.postMessage({ type: 'PARENT_PING', nonce: 'rtt-42', payload: 'echo-probe', ts: Date.now() }); c.close(); }"
    pg.evaluate(ping_js)
    bus = _el(pg, "subapps-bus-log")
    for tok in ["SUBAPP_PONG", "rtt-42", "echo-probe"]:
        expect(bus).to_contain_text(tok)
    _el(pg, "subapp-tracker-close-btn").click()
    expect(tracker).to_be_hidden(timeout=6000)
    assert child.is_closed()


@_t("SA-06", 2, "HeartbeatFocusPreserve", "Focus kept across heartbeats & auto-sync")
def test_sa06(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    child = _launch_subapp(ctx.session, _TELNET_ID)
    expect(_el(pg, "subapps-window-tracker")).to_be_visible()
    cbtn = _el(pg, "subapp-tracker-close-btn")
    cbtn.focus()
    expect(cbtn).to_be_focused()
    iid = _el(pg, "subapps-tracker-item").get_attribute("data-instance-id")
    hb_js = "(id) => { const c = new BroadcastChannel('iwa-sink-subapps'); for (let i = 0; i < 3; i++) c.postMessage({ type: 'SUBAPP_HEARTBEAT', appId: '/sub/telnet/index.html', scope: '/sub/telnet/', title: 'IWA Telnet Terminal', instanceId: id, ts: Date.now() + i }); c.close(); }"
    pg.evaluate(hb_js, iid)
    pg.wait_for_timeout(150)
    expect(cbtn).to_be_focused()
    child.close()
    rem_js = "async () => { await (window.subApps || navigator.subApps).remove(['/sub/telnet/index.html']); window.dispatchEvent(new Event('focus')); }"
    pg.evaluate(rem_js)
    expect(_el(pg, "subapp-catalog-card")).to_be_visible(timeout=6000)


@_t("SA-07", 1, "BuilderPngMonogram", "Builder 512x512 PNG monogram, swatches & emoji")
def test_sa07(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    _el(pg, "subapps-tab-builder").click()
    i0_js = "() => { const m = document.querySelector('[data-testid=\"dyn-subapp-icon-preview\"]'); return [m.complete, m.naturalWidth, m.naturalHeight, m.src]; }"
    i0 = pg.evaluate(i0_js)
    assert i0[:3] == [True, 512, 512] and _ok_data_png(i0[3])
    indigo = _el(pg, "subapps-swatch-indigo")
    indigo.click()
    expect(indigo).to_have_attribute("aria-pressed", "true")
    _el(pg, "dyn-subapp-name").fill("🚀 My App")
    expect(_el(pg, "dyn-subapp-slug")).to_have_value("my-app")
    s1 = _el(pg, "dyn-subapp-icon-preview").get_attribute("src") or ""
    assert s1 != i0[3] and _ok_data_png(s1)


@_t("SA-08", 2, "BuilderManifestValidation", "Manifest JSON guard & omitted fields")
def test_sa08(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    _el(pg, "subapps-tab-builder").click()
    for _ in range(3):
        _el(pg, "dyn-subapp-add-field-btn").click()
    expect(_el(pg, "dyn-subapp-manifest-field-row")).to_have_count(3)
    geom = pg.evaluate(
        """() => {
          const hdr = document.querySelector('.subapps-manifest-overrides-header').getBoundingClientRect();
          const listEl = document.querySelector('.subapp-manifest-fields-list');
          const listRect = listEl.getBoundingClientRect();
          const rows = [...document.querySelectorAll('.subapp-manifest-field-row')].map((r) => r.getBoundingClientRect());
          const vals = [...document.querySelectorAll('.subapp-manifest-val-input')];
          const valRect = vals[0].getBoundingClientRect();
          const rm = document.querySelector('.subapp-manifest-remove-btn');
          const rmRect = rm.getBoundingClientRect();
          const svgRect = rm.querySelector('svg').getBoundingClientRect();
          return {
            hdrGap: rows[0].top - hdr.bottom,
            rowGap01: rows[1].top - rows[0].bottom,
            rowGap12: rows[2].top - rows[1].bottom,
            listScrollOk: listEl.scrollHeight <= listEl.clientHeight,
            row2InsideList: rows[2].bottom <= listRect.bottom + 1,
            valsNoClip: vals.every((v) => v.scrollHeight <= v.clientHeight),
            valH: valRect.height,
            rmW: rmRect.width,
            rmH: rmRect.height,
            svgW: svgRect.width,
          };
        }"""
    )
    assert geom["hdrGap"] >= 8, geom
    assert geom["rowGap01"] >= 8 and geom["rowGap12"] >= 8, geom
    assert geom["listScrollOk"] and geom["row2InsideList"], geom
    assert geom["valH"] >= 64 and geom["valsNoClip"], geom
    assert geom["rmW"] >= 32 and geom["rmH"] >= 32 and geom["svgW"] >= 12, geom
    for _ in range(2):
        _el(pg, "dyn-subapp-field-remove-btn").last.click()
    _el(pg, "dyn-subapp-field-json-value").fill("{invalid_json")
    _el(pg, "dyn-subapp-create-install-btn").click()
    expect(_el(pg, "dyn-subapp-builder-error")).to_be_visible()
    _el(pg, "dyn-subapp-field-remove-btn").click()
    _create_dyn(pg, "Clean Notes", "clean-notes")
    st, _, raw = h.fetch_iwa_asset(pg, "/dynamic/clean-notes/manifest.webmanifest")
    man = json.loads(raw.decode("utf-8"))
    assert st == 200 and man["name"] == "Clean Notes" and "file_handlers" not in man
    ist, _, iraw = h.fetch_iwa_asset(pg, "/dynamic/clean-notes/icon-512.png")
    assert ist == 200 and _ok_png(iraw)


@_t("SA-09", 3, "DynamicFileProtoLaunch", "Dynamic sub-app protocol & file banners")
def test_sa09(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    fields = [("protocol_handlers", None), ("file_handlers", None)]
    app_id = _create_dyn(pg, "Trace Studio", "trace-studio", fields)
    p_url = f"{app_id}?protocol=logviewer%3A%2F%2Fopen%2Ftrace-77"
    with ctx.session.context.expect_page(timeout=8000) as pinfo:
        pg.evaluate("(u) => window.open(u, '_blank')", p_url)
    pc = pinfo.value
    pc.wait_for_load_state("domcontentloaded")
    expect(_el(pc, "dynamic-subapp-capabilities")).to_be_visible()
    expect(_el(pc, "protocol-launch-banner")).to_be_visible()
    expect(_el(pc, "protocol-restored-url")).to_have_text("logviewer://open/trace-77")
    pc.close()
    with tempfile.TemporaryDirectory() as td:
        sample = Path(td) / "session.log"
        sample.write_text("TRACE_EVENT_OK_99\n", encoding="utf-8")
        fc = ctx.session.launch_files_in_app(app_id, [str(sample)])
        expect(_el(fc, "file-launch-banner")).to_be_visible()
        expect(_el(fc, "file-launch-names")).to_contain_text("session.log")
        expect(_el(fc, "file-launch-preview")).to_contain_text("TRACE_EVENT_OK_99")
        fc.close()


@_t("SA-10", 3, "ClientModeFocusVsMulti", "FOCUS_SUBAPP reuse vs navigate-new #1/#2")
def test_sa10(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    c1 = _launch_subapp(ctx.session, _TELNET_ID)
    expect(_el(pg, "subapps-open-windows-count")).to_have_text("1 Window Open")
    _row(pg, _TELNET_ID).get_by_test_id("subapp-launch-btn").click()
    pg.wait_for_timeout(200)
    expect(_el(pg, "subapps-open-windows-count")).to_have_text("1 Window Open")
    c1.close()
    expect(_el(pg, "subapps-window-tracker")).to_be_hidden(timeout=6000)
    lh = [("launch_handler", '{"client_mode":"navigate-new"}')]
    mid = _create_dyn(pg, "Multi Runner", "multi-runner", lh)
    m1, m2 = _launch_subapp(ctx.session, mid), _launch_subapp(ctx.session, mid)
    expect(_el(pg, "subapps-open-windows-count")).to_have_text("2 Windows Open")
    for n in ("#1", "#2"):
        expect(_el(pg, "subapps-open-windows-list")).to_contain_text(n)
    m1.close()
    m2.close()


@_t("SA-11", 1, "RemoveAllGate", "Remove All >= 2 gating, bulk remove & teardown")
def test_sa11(ctx: h.E2EContext) -> None:
    pg = _sync_clean_subapps(ctx)
    _install_telnet(pg)
    expect(_el(pg, "subapps-remove-all-btn")).to_be_hidden()
    _create_dyn(pg, "Second App", "second-app")
    rem = _el(pg, "subapps-remove-all-btn")
    expect(rem).to_be_visible()
    expect(rem).to_be_enabled()
    child = _launch_subapp(ctx.session, _TELNET_ID)
    expect(_el(pg, "subapps-window-tracker")).to_be_visible()
    rem.click()
    expect(_el(pg, "subapp-item")).to_have_count(0, timeout=8000)
    expect(_el(pg, "subapp-catalog-card")).to_be_visible()
    expect(rem).to_be_hidden()
    expect(_el(pg, "subapps-window-tracker")).to_be_hidden()
    assert child.is_closed()


@_t("SWBN-01", 4, "SwbnBuildIntegrity", "Clean pnpm build & .swbn Integrity v2", True)
def test_swbn01(ctx: h.E2EContext) -> None:
    info = h.verify_swbn_integrity_v2(_build_swbn(ctx))
    assert info["valid"] is True and info["bundleId"].endswith("aaic")


@_t("SWBN-02", 4, "SwbnInstallAndSwParity", "Signed .swbn, /sw.js COI/CSP & 404s", True)
def test_swbn02(ctx: h.E2EContext) -> None:
    with ctx.launch_swbn_session(_build_swbn(ctx)) as swbn:
        assert swbn.bundle_id.endswith("aaic")
        pg = swbn.page
        sw_js = "async () => { const r = await navigator.serviceWorker.ready; return [window.crossOriginIsolated, r.active?.scriptURL || '']; }"
        sw = pg.evaluate(sw_js)
        assert sw[0] is True and sw[1].endswith("/sw.js")
        for route in ["/", "/hud.html", "/sub/telnet/index.html"]:
            st, hdrs, _ = h.fetch_iwa_asset(pg, route)
            csp = hdrs.get("content-security-policy", "")
            assert st == 200 and csp.count("default-src") == 1
            assert hdrs.get("cross-origin-opener-policy") == "same-origin"
            assert hdrs.get("cross-origin-embedder-policy") == "require-corp"
        swbn.assert_clean_diagnostics()
        assert h.fetch_iwa_asset(pg, "/sub/mdns/index.html")[0] == 404
        swbn.assert_clean_diagnostics(allow_console_errors=True)


@_t("SWBN-03", 4, "SwbnOfflineDynamicSubApp", ".swbn offline sub-app & TCP smoke", True)
def test_swbn03(ctx: h.E2EContext) -> None:
    with ctx.launch_swbn_session(_build_swbn(ctx)) as swbn:
        pg = swbn.page
        swbn.activate_workspace("sub-apps")
        app_id = _create_dyn(pg, "Offline Bundle App", "offline-bundle-app")
        ist, _, iraw = h.fetch_iwa_asset(pg, "/dynamic/offline-bundle-app/icon-512.png")
        assert ist == 200 and _ok_png(iraw)
        child = _launch_subapp(swbn, app_id)
        assert child.evaluate("() => window.crossOriginIsolated === true")
        child.close()
        _start_echo_ws(swbn)
        _el(pg, "tcp-connect-btn").click()
        expect(_el(pg, "tcp-client-status")).to_contain_text("Connected")
        _el(pg, "tcp-payload-input").fill("SWBN_TCP_OK")
        _el(pg, "tcp-send-btn").click()
        expect(_el(pg, "tcp-terminal-screen")).to_contain_text("SWBN_TCP_OK")
        swbn.assert_clean_diagnostics()


def build_tests() -> list[h.TestSpec]:
    return list(TESTS)

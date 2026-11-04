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

"""TCP Echo, Windowing, ChromeOS `/hud.html` & Screen Capture Suite (`16` tests)."""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

from playwright.sync_api import Locator, Page, expect

import tests.pw_harness as h

TESTS: list[h.TestSpec] = []


def _t(tid: str, tr: int, feat: str, ttl: str) -> Any:
    return h.e2e_test(TESTS, tid, tr, feat, ttl)


def _el(pg: Page, test_id: str) -> Locator:
    return pg.get_by_test_id(test_id)


def _tcp_ws(ctx: h.E2EContext) -> Page:
    ctx.session.activate_workspace("tcp-terminal")
    return ctx.session.page


def _win_ws(ctx: h.E2EContext) -> Page:
    ctx.session.activate_workspace("windowing-hud")
    return ctx.session.page


def _cap_ws(ctx: h.E2EContext) -> Page:
    cs = ctx.require_cros_session()
    cs.activate_workspace("screen-capture")
    return cs.page


@contextlib.contextmanager
def _mock_js(pg: Page, target: str, prop: str, expr: str) -> Iterator[None]:
    s_js = f"() => {{ const o = {target}; window.__origM = o['{prop}']; o['{prop}'] = {expr}; }}"
    r_js = f"() => {{ const o = {target}; if (window.__origM !== undefined) o['{prop}'] = window.__origM; else delete o['{prop}']; delete window.__origM; }}"
    pg.evaluate(s_js)
    try:
        yield
    finally:
        pg.evaluate(r_js)


def _start_echo(pg: Page, port: str = "0") -> int:
    _el(pg, "echo-port-input").fill(port)
    _el(pg, "echo-start-btn").click()
    bound = _el(pg, "echo-bound-port")
    expect(bound).to_be_visible()
    p = h.extract_port(bound.text_content() or "")
    assert p is not None
    return p


def _connect_tcp(pg: Page) -> None:
    _el(pg, "tcp-connect-btn").click()
    expect(_el(pg, "tcp-disconnect-btn")).to_be_enabled()
    expect(_el(pg, "tcp-client-status")).to_contain_text("Connected")


def _send_tcp(pg: Page, payload: str) -> None:
    _el(pg, "tcp-payload-input").fill(payload)
    _el(pg, "tcp-send-btn").click()


def _spawn_hud(cs: h.PlaywrightIwaSession) -> Page:
    cs.activate_workspace("windowing-hud")
    _el(cs.page, "win-tab-unframed").click()
    with cs.context.expect_page(timeout=8000) as info:
        _el(cs.page, "win-spawn-hud-btn").click()
    hud = info.value
    hud.wait_for_load_state("domcontentloaded")
    return hud


@_t("TCP-01", 1, "TcpEchoRoundtrip", "TCP Echo bind, client echo & broadcast")
def test_tcp01(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    port = _start_echo(pg)
    assert h.is_loopback_tcp_listening(port)
    expect(_el(pg, "tcp-port-input")).to_have_value(str(port))
    _connect_tcp(pg)
    expect(_el(pg, "echo-active-clients")).to_contain_text("1")
    _send_tcp(pg, "HELLO_DIRECT_SOCKETS")
    for tid in ("tcp-terminal-screen", "tcp-server-log"):
        expect(_el(pg, tid)).to_contain_text("HELLO_DIRECT_SOCKETS")
    cnt_txt = _el(pg, "echo-bytes-counter").text_content() or "0"
    assert max(h.extract_ints(cnt_txt)) >= 20
    _el(pg, "tcp-server-send-btn").click()
    expect(_el(pg, "tcp-terminal-screen")).to_contain_text("SERVER_BROADCAST_HELLO")
    _el(pg, "tcp-disconnect-btn").click()
    _el(pg, "echo-stop-btn").click()
    expect(_el(pg, "echo-start-btn")).to_be_enabled()
    cp = h.get_free_tcp_port()
    assert _start_echo(pg, str(cp)) == cp


@_t("TCP-02", 2, "TcpFamilyAddrInUse", "127.0.0.1 vs ::1 bind, ADDRINUSE & non-clobber")
def test_tcp02(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    with h.EphemeralTcpPeerServer() as peer:
        _el(pg, "echo-port-input").fill(str(peer.port))
        _el(pg, "echo-start-btn").click()
        expect(_el(pg, "tcp-server-error")).to_be_visible()
        expect(_el(pg, "echo-stop-btn")).to_be_disabled()
    _el(pg, "tcp-host-input").fill("towel.blinkenlights.nl")
    _el(pg, "tcp-port-input").fill("23")
    _el(pg, "tcp-server-family-ipv6").click()
    expect(_el(pg, "tcp-server-family-ipv6")).to_have_attribute("aria-checked", "true")
    _start_echo(pg)
    expect(_el(pg, "echo-status-badge")).to_contain_text("[::1]")
    expect(_el(pg, "tcp-host-input")).to_have_value("towel.blinkenlights.nl")
    expect(_el(pg, "tcp-port-input")).to_have_value("23")


@_t("TCP-03", 2, "TcpBracketAndValidation", "[::1]:port & host/port validation")
def test_tcp03(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    _el(pg, "tcp-server-family-ipv6").click()
    v6_port = _start_echo(pg)
    host_in, port_in = _el(pg, "tcp-host-input"), _el(pg, "tcp-port-input")
    host_in.fill(f"[::1]:{v6_port}")
    port_in.fill("1")
    _connect_tcp(pg)
    expect(host_in).to_have_value("::1")
    expect(port_in).to_have_value(str(v6_port))
    _send_tcp(pg, "IPV6_BRACKET_OK")
    expect(_el(pg, "tcp-terminal-screen")).to_contain_text("IPV6_BRACKET_OK")
    _el(pg, "tcp-disconnect-btn").click()
    expect(_el(pg, "tcp-connect-btn")).to_be_enabled()
    for bad_host in ["010.0.0.1", "127.0.0.999", "bad.999", "[::1"]:
        host_in.fill(bad_host)
        port_in.fill(str(v6_port))
        _el(pg, "tcp-connect-btn").click()
        expect(host_in).to_have_attribute("aria-invalid", "true")
    host_in.fill("127.0.0.1")
    for bad_port in ["0", "70000", "abc"]:
        port_in.fill(bad_port)
        _el(pg, "tcp-connect-btn").click()
        expect(port_in).to_have_attribute("aria-invalid", "true")


@_t("TCP-04", 3, "TcpSerializeAndAbort", "Start->Stop->Start, Enter guard & SYN abort")
def test_tcp04(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    _start_echo(pg)
    _el(pg, "echo-stop-btn").click()
    expect(_el(pg, "echo-start-btn")).to_be_enabled()
    _start_echo(pg)
    _connect_tcp(pg)
    _el(pg, "tcp-host-input").press("Enter")
    expect(_el(pg, "tcp-disconnect-btn")).to_be_enabled()
    _el(pg, "tcp-disconnect-btn").click()
    expect(_el(pg, "tcp-connect-btn")).to_be_enabled()
    mock_cls = "class { constructor() { this.opened = new Promise(() => {}); this.closed = new Promise(() => {}); } close() { return Promise.resolve(); } }"
    with _mock_js(pg, "window", "TCPSocket", mock_cls):
        _el(pg, "tcp-connect-btn").click()
        expect(_el(pg, "tcp-disconnect-btn")).to_be_enabled()
        t0 = time.monotonic()
        _el(pg, "tcp-disconnect-btn").click()
        expect(_el(pg, "tcp-connect-btn")).to_be_enabled()
        assert (time.monotonic() - t0) < 1.0


@_t("TCP-05", 3, "TcpUtf8AndAnsi", "Split UTF-8 ('電🚀'), ANSI SGR & 64 KiB stream")
def test_tcp05(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    srv = socket.create_server(("127.0.0.1", 0))
    sp = int(srv.getsockname()[1])
    ev1, ev2 = threading.Event(), threading.Event()
    e1, e2 = "電".encode(), "🚀".encode()
    c1 = b"\x1b[1;32mSPLIT_" + e1[:2]
    c2, c3 = e1[2:] + e2[:2], e2[2:] + b"_OK\x1b[0m\r\n"

    def _feed() -> None:
        try:
            conn, _ = srv.accept()
            with conn:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                for chunk, ev in ((c1, ev1), (c2, ev2), (c3, None)):
                    conn.sendall(chunk)
                    if ev:
                        ev.wait(5.0)
        finally:
            with contextlib.suppress(OSError):
                srv.close()

    threading.Thread(target=_feed, daemon=True).start()
    _el(pg, "tcp-host-input").fill("127.0.0.1")
    _el(pg, "tcp-port-input").fill(str(sp))
    _el(pg, "tcp-connect-btn").click()
    scr = _el(pg, "tcp-terminal-screen")
    for part, ev in [("SPLIT_", ev1), ("SPLIT_電", ev2), ("SPLIT_電🚀_OK", None)]:
        expect(scr).to_contain_text(part)
        assert "\ufffd" not in (scr.text_content() or "")
        if ev:
            ev.set()
    assert scr.locator("span[class*='ansi-']").count() >= 1
    expect(_el(pg, "tcp-connect-btn")).to_be_enabled()
    _start_echo(pg)
    _connect_tcp(pg)
    _send_tcp(pg, "K" * 65536)
    cnt_js = "() => parseInt((document.querySelector('[data-testid=\"echo-bytes-counter\"]')?.textContent || '0').replace(/\\D+/g, ''), 10) >= 65536"
    pg.wait_for_function(cnt_js, timeout=8000)


@_t("TCP-06", 2, "TcpKeyboardClear", "SC 2.1.2 Tab freedom & Clear keystroke reset")
def test_tcp06(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    scr = _el(pg, "tcp-terminal-screen")
    focus_js = "() => document.activeElement === document.querySelector('[data-testid=\"tcp-terminal-screen\"]')"
    for key in ["Tab", "Shift+Tab"]:
        scr.focus()
        expect(scr).to_be_focused()
        pg.keyboard.press(key)
        assert not pg.evaluate(focus_js)
    _start_echo(pg)
    _connect_tcp(pg)
    scr.focus()
    pg.keyboard.type("STALE_PREFIX")
    _el(pg, "tcp-clear-btn").click()
    scr.focus()
    pg.keyboard.type("CLEAN_LINE")
    pg.keyboard.press("Enter")
    srv_log = _el(pg, "tcp-server-log")
    expect(srv_log).to_contain_text("CLEAN_LINE")
    assert "STALE_PREFIX" not in (srv_log.text_content() or "")
    _el(pg, "tcp-server-clear-btn").click()
    assert (srv_log.text_content() or "").strip() == ""


@_t("TCP-07", 5, "TcpZeroClsStickBottom", "0.000 live CLS & stick-to-bottom log")
def test_tcp07(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    _start_echo(pg)
    _connect_tcp(pg)
    obs_js = "() => { window.__pwCls = 0; window.__pwObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__pwCls += e.value; }); window.__pwObs.observe({ type: 'layout-shift', buffered: false }); }"
    pg.evaluate(obs_js)
    for i in range(30):
        _send_tcp(pg, f"BURST_LINE_{i:02d}_" + ("Z" * 48))
    expect(_el(pg, "tcp-server-log")).to_contain_text("BURST_LINE_29_")
    end_js = "() => { window.__pwObs?.disconnect(); const el = document.querySelector('[data-testid=\"tcp-server-log\"]'), stuck = el.scrollHeight - el.scrollTop - el.clientHeight <= 24; el.scrollTop = 0; return [window.__pwCls, el.scrollHeight > el.clientHeight, stuck]; }"
    assert pg.evaluate(end_js) == [0, True, True]
    _send_tcp(pg, "AFTER_SCROLL_TOP")
    expect(_el(pg, "tcp-server-log")).to_contain_text("AFTER_SCROLL_TOP")
    assert _el(pg, "tcp-server-log").evaluate("(e) => e.scrollTop") == 0


@_t("WIN-01", 1, "WinAwcControls", "AWC controls, Resizable switch & fallback banner")
def test_win01(ctx: h.E2EContext) -> None:
    pg = _win_ws(ctx)
    expect(_el(pg, "win-display-mode")).to_be_visible()
    sw = _el(pg, "win-resizable-toggle")
    expect(sw).to_have_attribute("role", "switch")
    if _el(pg, "win-awc-unavailable-banner").is_hidden():
        expect(sw).to_have_attribute("aria-checked", "true")
        for exp_val in ("false", "true"):
            sw.click()
            expect(sw).to_have_attribute("aria-checked", exp_val)
        max_b, rest_b = _el(pg, "win-maximize-btn"), _el(pg, "win-restore-btn")
        first, second = (max_b, rest_b) if max_b.is_enabled() else (rest_b, max_b)
        first.click()
        expect(second).to_be_enabled()
        second.click()
        expect(_el(pg, "win-awc-status")).to_be_visible()
    init_js = "for (const k of ['minimize','maximize','restore','setResizable']) { try { delete Window.prototype[k]; } catch {} try { delete window[k]; } catch {} try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch {} }"
    u_no_awc = "/index.html?workspace=windowing-hud&pw_no_awc=1"
    with ctx.session.context.expect_page(timeout=8000) as pinfo:
        pg.evaluate("(u) => window.open(u, '_blank')", u_no_awc)
    np = pinfo.value
    try:
        np.wait_for_load_state("domcontentloaded")
        cdp = np.context.new_cdp_session(np)
        cdp.send("Page.enable")
        cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": init_js})
        np.add_init_script(init_js)
        np.reload(wait_until="domcontentloaded")
        nb = _el(np, "win-awc-unavailable-banner")
        expect(nb).to_be_visible()
        expect(nb).to_contain_text("chrome://flags")
        expect(nb).to_contain_text("#enable-desktop-pwas-additional-windowing-controls")
        expect(_el(np, "win-resizable-toggle")).to_be_disabled()
    finally:
        np.close()


@_t("WIN-02", 1, "WinScreenDetails", "getScreenDetails() multi-display & console log")
def test_win02(ctx: h.E2EContext) -> None:
    pg = _win_ws(ctx)
    _el(pg, "win-screen-details-btn").click()
    scr = _el(pg, "win-screens-list")
    expect(scr).to_be_visible()
    assert scr.locator(".win-screen-dot").count() >= 1
    tbtn = _el(pg, "win-toggle-console-btn")
    tbtn.click()
    expect(tbtn).to_have_attribute("aria-expanded", "true")
    expect(_el(pg, "win-console-log")).to_be_visible()


@_t("WIN-03", 2, "WinNonCrosGuard", "Non-CrOS gating on win-tab-unframed & /hud.html")
def test_win03(ctx: h.E2EContext) -> None:
    ncs = ctx.require_non_cros_session()
    ncs.activate_workspace("windowing-hud")
    expect(_el(ncs.page, "win-tab-unframed")).to_have_count(0)
    with ncs.context.expect_page(timeout=8000) as hinfo:
        ncs.page.evaluate("() => window.open('/hud.html', '_blank')")
    hp = hinfo.value
    hp.wait_for_load_state("domcontentloaded")
    expect(_el(hp, "hud-cros-only-notice")).to_be_visible()
    expect(_el(hp, "hud-drag-region")).to_have_count(0)
    _el(hp, "hud-close-btn").click()
    assert hp.is_closed()


@_t("WIN-04", 1, "CrosHudUnframedTelemetry", "CrOS unframed /hud.html & Focus")
def test_win04(ctx: h.E2EContext) -> None:
    cs = ctx.require_cros_session()
    uv = cs.cros_unframed_verified or {}
    assert uv.get("unframed") is True and uv.get("appRegion") == "drag"
    cs.activate_workspace("tcp-terminal")
    _el(cs.page, "tcp-server-family-ipv6").click()
    v6_port = _start_echo(cs.page)
    hp = _spawn_hud(cs)
    expect(_el(hp, "hud-drag-region")).to_be_visible()
    expect(_el(hp, "hud-telemetry-summary")).to_contain_text(f"[::1]:{v6_port}")
    reg_js = "() => { const r = (e) => (getComputedStyle(e).getPropertyValue('app-region') || getComputedStyle(e).getPropertyValue('-webkit-app-region')).trim(); return [r(document.querySelector('[data-testid=\"hud-drag-region\"]')), r(document.querySelector('[data-testid=\"hud-close-btn\"]').closest('.no-drag') || document.querySelector('[data-testid=\"hud-close-btn\"]'))]; }"
    assert hp.evaluate(reg_js) == ["drag", "no-drag"]
    _el(cs.page, "win-spawn-hud-btn").click()
    cs.page.wait_for_timeout(150)
    assert sum(1 for p in cs.context.pages if "/hud.html" in p.url) == 1
    _el(hp, "hud-focus-shell-btn").click()
    _el(hp, "hud-close-btn").click()


@_t("WIN-05", 4, "CrosHudReloadAndClose", "CrOS /hud.html reload & Close sync")
def test_win05(ctx: h.E2EContext) -> None:
    cs = ctx.require_cros_session()
    hp = _spawn_hud(cs)
    expect(_el(cs.page, "win-close-hud-btn")).to_be_enabled()
    hp.reload(wait_until="domcontentloaded")
    expect(_el(hp, "hud-telemetry-summary")).to_be_visible()
    cs.page.reload(wait_until="domcontentloaded")
    _el(cs.page, "shell-status-bar").wait_for(state="visible")
    assert not hp.is_closed()
    cs.activate_workspace("windowing-hud")
    _el(cs.page, "win-tab-unframed").click()
    expect(_el(cs.page, "win-close-hud-btn")).to_be_enabled()
    _el(hp, "hud-close-btn").click()
    expect(_el(cs.page, "win-close-hud-btn")).to_be_disabled(timeout=6000)


@_t("CAP-01", 1, "CrosCaptureSingle", "CrOS getDisplayMedia tile & Stop All teardown")
def test_cap01(ctx: h.E2EContext) -> None:
    pg = _cap_ws(ctx)
    expect(_el(pg, "screen-stop-all-btn")).to_be_disabled()
    _el(pg, "screen-capture-single-btn").click()
    t0 = _el(pg, "screen-tile-0")
    expect(t0).to_be_visible(timeout=8000)
    vid_js = "() => Boolean(document.querySelector('[data-testid=\"screen-tile-0\"] video')?.srcObject)"
    assert pg.evaluate(vid_js)
    expect(_el(pg, "screen-stop-all-btn")).to_be_enabled()
    _el(pg, "screen-stop-all-btn").click()
    expect(t0).to_have_count(0)
    expect(_el(pg, "screen-stop-all-btn")).to_be_disabled()


@_t("CAP-02", 3, "CrosCaptureMultiDisambig", "CrOS getAllScreensMedia & tile reindex")
def test_cap02(ctx: h.E2EContext) -> None:
    pg = _cap_ws(ctx)
    _el(pg, "screen-capture-all-btn").click()
    done_js = "() => !document.querySelector('[data-testid=\"cap-error-banner\"]')?.hidden || Boolean(document.querySelector('[data-testid=\"screen-tile-0\"]'))"
    pg.wait_for_function(done_js, timeout=8000)
    err = _el(pg, "cap-error-banner")
    if err.is_visible():
        expect(err).to_contain_text("MultiScreenCaptureAllowedForUrls")
    else:
        _el(pg, "screen-stop-all-btn").click()
    all_fn = "async () => [0, 1].map(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; c.getContext('2d').fillRect(0, 0, 320, 180); const s = c.captureStream(15); Object.defineProperty(s.getVideoTracks()[0], 'label', { value: 'Display' }); return s; })"
    with _mock_js(pg, "navigator.mediaDevices", "getAllScreensMedia", all_fn):
        _el(pg, "screen-capture-all-btn").click()
        t0, t1 = _el(pg, "screen-tile-0"), _el(pg, "screen-tile-1")
        expect(t0).to_contain_text("Screen 1 — Display")
        expect(t1).to_contain_text("Screen 2 — Display")
        t0.get_by_test_id("screen-tile-stop-btn").click()
        expect(t1).to_have_count(0)
        expect(t0).to_contain_text("Screen 2 — Display")
        _el(pg, "screen-stop-all-btn").click()


@_t("CAP-03", 2, "CrosCaptureEndedAndConsole", "Ended track guard & console ARIA")
def test_cap03(ctx: h.E2EContext) -> None:
    pg = _cap_ws(ctx)
    tbtn = _el(pg, "screen-toggle-console-btn")
    tbtn.click()
    expect(tbtn).to_have_attribute("aria-expanded", "true")
    dead_fn = "async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64); const s = c.captureStream(5); s.getTracks().forEach((t) => t.stop()); return s; }"
    with _mock_js(pg, "navigator.mediaDevices", "getDisplayMedia", dead_fn):
        _el(pg, "screen-capture-single-btn").click()
        expect(_el(pg, "cap-error-banner")).to_be_visible()
        expect(_el(pg, "screen-tile-0")).to_have_count(0)
        expect(_el(pg, "screen-console-log")).to_contain_text("Skipped stream")


@_t("TOUR-01", 4, "ConcurrentWorkspaceTour", "Workspace tour keeps TCP & guest live")
def test_tour01(ctx: h.E2EContext) -> None:
    pg = _tcp_ws(ctx)
    _start_echo(pg)
    _connect_tcp(pg)
    ctx.session.activate_workspace("controlled-frame-tls")
    _el(pg, "cf-url-input").fill(f"{ctx.tls.base_url}/page-a")
    _el(pg, "cf-navigate-btn").click()
    ctx.session.wait_for_cf_ready("/page-a")
    ctx.session.eval_in_cf("window.__PW_TOUR_SENTINEL__ = 'intact'")
    for ws_id in h.get_workspace_ids(ctx):
        ctx.session.activate_workspace(ws_id)
    ctx.session.activate_workspace("controlled-frame-tls")
    assert ctx.session.eval_in_cf("window.__PW_TOUR_SENTINEL__") == "intact"
    _tcp_ws(ctx)
    _send_tcp(pg, "SURVIVED_TOUR_OK")
    expect(_el(pg, "tcp-terminal-screen")).to_contain_text("SURVIVED_TOUR_OK")


def build_tests() -> list[h.TestSpec]:
    return list(TESTS)

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
    echo_port = _start_echo(pg)
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
    _assert_tcp_viewport_parity(pg, echo_port)


def _assert_tcp_viewport_parity(pg: Page, echo_port: int) -> None:
    sbtn = _el(pg, "sidebar-collapse-btn")
    if sbtn.get_attribute("aria-expanded") == "false":
        sbtn.click()
    expect(sbtn).to_have_attribute("aria-expanded", "true")
    expect(_el(pg, "app-sidebar")).to_have_attribute("data-sidebar-collapsed", "false")
    _el(pg, "tcp-disconnect-btn").click()
    expect(_el(pg, "tcp-connect-btn")).to_be_enabled()
    telnet_host = "towel.blinkenlights.nl"
    telnet_status = f"Connected · {telnet_host}:23"
    redir_cls = (
        "class extends window.__origM {"
        " constructor(h, p, o) {"
        f" super(h === '{telnet_host}' ? '127.0.0.1' : h,"
        f" h === '{telnet_host}' ? {echo_port} : p, o);"
        " } }"
    )
    geom_js = """() => {
      window.scrollTo(0, 0);
      const cli = document.querySelector('[data-testid="tcp-client-panel"]');
      const srv = document.querySelector('[data-testid="tcp-echo-server-panel"]');
      const hdr = cli.querySelector('.tcp-side-card-header');
      const hR = hdr.querySelector('.workspace-bar-right');
      const hcs = getComputedStyle(hdr);
      const padR = parseFloat(hcs.borderRightWidth) + parseFloat(hcs.paddingRight);
      const st = document.querySelector('[data-testid="tcp-client-status"]');
      const bg = document.querySelector('[data-testid="echo-status-badge"]');
      const cap = cli.querySelector('.workspace-caption');
      const cs = getComputedStyle(st);
      const r = (e) => e.getBoundingClientRect();
      const cT = r(cli.querySelector('.terminal-surface'));
      const sT = r(srv.querySelector('.terminal-surface'));
      const cCard = r(cli), sCard = r(srv);
      const cCfg = r(cli.querySelector('.tcp-side-config-bar'));
      const sCfg = r(srv.querySelector('.tcp-side-config-bar'));
      const cHdr = r(cli.querySelector('.tcp-side-log-header'));
      const sHdr = r(srv.querySelector('.tcp-side-log-header'));
      const pay = r(document.querySelector('#tcp-payload-input'));
      const send = r(document.querySelector('[data-testid="tcp-send-btn"]'));
      return {
        cTop: cT.top, sTop: sT.top, cH: cCard.height, sH: sCard.height,
        cCfgH: cCfg.height, sCfgH: sCfg.height, cHdrH: cHdr.height, sHdrH: sHdr.height,
        payTop: pay.top, payBot: pay.bottom, payH: pay.height,
        sendTop: send.top, sendBot: send.bottom, sendH: send.height,
        stTxt: st.textContent, stSw: st.scrollWidth, stCw: st.clientWidth,
        stDisp: cs.display, stEll: cs.textOverflow,
        rightGap: Math.abs((r(hdr).right - padR) - r(hR).right),
        bgH: Math.round(r(bg).height), bgSw: bg.scrollWidth, bgCw: bg.clientWidth,
        capSw: cap.scrollWidth, capCw: cap.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }"""
    raf2_js = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"

    def _set_vp(target_pg: Page, target_cdp: Any, vw: int, vh: int) -> None:
        ov = {"width": vw, "height": vh, "deviceScaleFactor": 1, "mobile": False}
        target_cdp.send("Emulation.setDeviceMetricsOverride", ov)
        target_pg.wait_for_function(
            "([w, h]) => window.innerWidth === w && window.innerHeight === h",
            arg=[vw, vh],
        )
        target_pg.evaluate(raf2_js)

    with _mock_js(pg, "window", "TCPSocket", redir_cls):
        _el(pg, "tcp-host-input").fill(telnet_host)
        _el(pg, "tcp-port-input").fill("23")
        _el(pg, "tcp-connect-btn").click()
        expect(_el(pg, "tcp-client-status")).to_have_text(telnet_status)
        cdp = pg.context.new_cdp_session(pg)
        try:
            for vw, vh in ((1163, 791), (1179, 616), (1082, 768)):
                _set_vp(pg, cdp, vw, vh)
                g = pg.evaluate(geom_js)
                assert abs(g["cTop"] - g["sTop"]) <= 2, f"{vw}x{vh} terminal top: {g}"
                assert abs(g["cH"] - g["sH"]) <= 2, f"{vw}x{vh} card height: {g}"
                assert abs(g["cCfgH"] - g["sCfgH"]) <= 2, f"{vw}x{vh} config bar: {g}"
                assert abs(g["cHdrH"] - g["sHdrH"]) <= 2, f"{vw}x{vh} log header: {g}"
                assert 0 <= g["payTop"] and g["payH"] > 0 and g["payBot"] <= vh, (
                    f"{vw}x{vh} payload: {g}"
                )
                assert 0 <= g["sendTop"] and g["sendH"] > 0 and g["sendBot"] <= vh, (
                    f"{vw}x{vh} send: {g}"
                )
                assert g["stTxt"] == telnet_status and g["stSw"] <= g["stCw"], (
                    f"{vw}x{vh} telnet status clipped: {g}"
                )
                assert (
                    g["stDisp"] in ("block", "inline-block")
                    and g["stEll"] == "ellipsis"
                ), g
                assert g["bgH"] == 26 and g["bgSw"] <= g["bgCw"], (
                    f"{vw}x{vh} echo badge: {g}"
                )
                assert g["rightGap"] <= 2 and g["docOverflow"] <= 0, (
                    f"{vw}x{vh} header: {g}"
                )

            for vw, vh in ((1040, 768), (1024, 768), (768, 700)):
                _set_vp(pg, cdp, vw, vh)
                g = pg.evaluate(geom_js)
                assert (
                    g["stSw"] <= g["stCw"]
                    and g["rightGap"] <= 2
                    and g["docOverflow"] <= 0
                ), f"{vw}x{vh} stacked telnet status: {g}"

            _set_vp(pg, cdp, 360, 700)
            g360 = pg.evaluate(geom_js)
            assert g360["stDisp"] in ("block", "inline-block"), g360
            assert g360["stEll"] == "ellipsis" and g360["stSw"] > g360["stCw"], g360
            assert (
                g360["capSw"] <= g360["capCw"]
                and g360["rightGap"] <= 2
                and g360["docOverflow"] <= 0
            ), g360

            _set_vp(pg, cdp, 280, 500)
            g280 = pg.evaluate(geom_js)
            assert g280["rightGap"] <= 2 and g280["docOverflow"] <= 0, g280
        finally:
            with contextlib.suppress(Exception):
                cdp.send("Emulation.clearDeviceMetricsOverride")
                pg.evaluate(raf2_js)
                cdp.detach()
        _el(pg, "tcp-disconnect-btn").click()
        expect(_el(pg, "tcp-connect-btn")).to_be_enabled()

    sub_js = """() => {
      const hdr = document.querySelector('.tcp-side-card-header');
      const hR = hdr.querySelector('.workspace-bar-right');
      const hcs = getComputedStyle(hdr);
      const padR = parseFloat(hcs.borderRightWidth) + parseFloat(hcs.paddingRight);
      const st = document.querySelector('[data-testid="tcp-client-status"]');
      const cs = getComputedStyle(st);
      return {
        txt: st.textContent, sw: st.scrollWidth, cw: st.clientWidth,
        disp: cs.display, ell: cs.textOverflow,
        rightGap: Math.abs((hdr.getBoundingClientRect().right - padR) - hR.getBoundingClientRect().right),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }"""
    with pg.context.expect_page(timeout=8000) as pinfo:
        pg.evaluate("() => window.open('/sub/telnet/index.html', '_blank')")
    sub = pinfo.value
    sub_cdp = sub.context.new_cdp_session(sub)
    try:
        sub.wait_for_load_state("domcontentloaded")
        expect(_el(sub, "tcp-connect-btn")).to_be_visible()
        with _mock_js(sub, "window", "TCPSocket", redir_cls):
            _el(sub, "tcp-connect-btn").click()
            expect(_el(sub, "tcp-client-status")).to_have_text(telnet_status)
            for sw, sh in ((1280, 800), (800, 600), (760, 560), (600, 500), (500, 500)):
                _set_vp(sub, sub_cdp, sw, sh)
                sg = sub.evaluate(sub_js)
                assert sg["txt"] == telnet_status and sg["sw"] <= sg["cw"], (sw, sh, sg)
                assert sg["rightGap"] <= 2 and sg["docOverflow"] <= 0, (sw, sh, sg)
            for sw, sh in ((360, 500), (320, 260)):
                _set_vp(sub, sub_cdp, sw, sh)
                sg = sub.evaluate(sub_js)
                assert (
                    sg["disp"] in ("block", "inline-block") and sg["ell"] == "ellipsis"
                ), (
                    sw,
                    sh,
                    sg,
                )
                assert (
                    sg["sw"] > sg["cw"]
                    and sg["rightGap"] <= 2
                    and sg["docOverflow"] <= 0
                ), (
                    sw,
                    sh,
                    sg,
                )
            _el(sub, "tcp-disconnect-btn").click()
            expect(_el(sub, "tcp-connect-btn")).to_be_enabled()
    finally:
        with contextlib.suppress(Exception):
            sub_cdp.detach()
        with contextlib.suppress(Exception):
            sub.close()


@_t("WIN-01", 1, "WinAwcControls", "AWC controls, Resizable switch & fallback banner")
def test_win01(ctx: h.E2EContext) -> None:
    pg = _win_ws(ctx)
    boot_log = _el(pg, "win-console-log").text_content() or ""
    assert "Transient activation is required" not in boot_log
    assert "getScreenDetails() failed" not in boot_log
    expect(_el(pg, "win-display-mode")).to_be_visible()
    sw = _el(pg, "win-resizable-toggle")
    expect(sw).to_have_attribute("role", "switch")
    if _el(pg, "win-awc-unavailable-banner").is_hidden():
        expect(sw).to_have_attribute("aria-checked", "true")
        for exp_val in ("false", "true"):
            sw.click()
            expect(sw).to_have_attribute("aria-checked", exp_val)
            expect(sw).to_be_enabled()
        max_b, rest_b = _el(pg, "win-maximize-btn"), _el(pg, "win-restore-btn")
        first, second = (max_b, rest_b) if max_b.is_enabled() else (rest_b, max_b)
        first.click()
        expect(second).to_be_enabled()
        second.click()
        expect(first).to_be_enabled()
        expect(_el(pg, "win-awc-status")).to_be_visible()
        assert (_el(pg, "win-awc-status").text_content() or "").strip() in {
            "Normal",
            "Maximized",
            "Minimized",
            "Fullscreen",
        }
        mode_txt = (_el(pg, "win-display-mode").text_content() or "").strip()
        assert mode_txt in {
            "Standalone",
            "Window Controls Overlay",
            "Minimal UI",
            "Fullscreen",
            "Unframed",
            "Browser tab",
        }
    init_js = """
      window.__pwPermQueried = false;
      for (const k of ['minimize','maximize','restore','setResizable']) {
        try { delete Window.prototype[k]; } catch {}
        try { delete window[k]; } catch {}
        try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch {}
      }
      const origQ = navigator.permissions?.query?.bind(navigator.permissions);
      if (origQ) {
        navigator.permissions.query = async (d) => {
          if (d?.name === 'window-management') {
            window.__pwPermQueried = true;
            return Object.assign(new EventTarget(), { state: 'prompt', onchange: null });
          }
          return origQ(d);
        };
      }
      window.getScreenDetails = () =>
        Promise.reject(new DOMException('Transient activation is required to request permission.', 'NotAllowedError'));
    """
    flag_url = "chrome://flags/#enable-desktop-pwas-additional-windowing-controls"
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
        expect(_el(np, "win-console-log")).to_contain_text("[init] Windowing ready")
        np.wait_for_function("() => window.__pwPermQueried === true")
        np.evaluate(
            "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
        )
        expect(nb).to_contain_text(flag_url)
        expect(nb).to_contain_text("and enable the feature")
        copy_btn = nb.locator(".copy-icon-btn")
        expect(copy_btn).to_be_visible()
        expect(copy_btn).to_be_enabled()
        copy_btn.click()
        expect(copy_btn).to_have_attribute("aria-label", "Copied to clipboard")
        assert h.read_clipboard_text(np) == flag_url
        np_log = _el(np, "win-console-log").text_content() or ""
        assert "Transient activation is required" not in np_log
        assert "getScreenDetails() failed" not in np_log
        expect(_el(np, "win-resizable-toggle")).to_be_disabled()
        expect(_el(np, "win-displays-subtitle")).to_have_text(
            "Current display · query to detect all monitors"
        )
        expect(_el(np, "win-screens-list")).to_contain_text("Current Display")
    finally:
        np.close()


def _assert_win_resize_and_macos_minimize(pg: Page) -> None:
    _el(pg, "win-clear-log-btn").click()
    expect(_el(pg, "win-console-log")).to_have_text("")
    w0 = int(
        pg.evaluate(
            """() => {
      window.__pwOrigIw = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      const base = window.innerWidth;
      let curW = base;
      Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => curW });
      for (let i = 0; i < 10; i++) {
        curW = i % 2 === 0 ? base : base + 24;
        window.dispatchEvent(new Event('resize'));
      }
      return base;
    }"""
        )
    )
    try:
        pg.wait_for_function(
            "(tw) => (document.querySelector('[data-testid=\"win-console-log\"]')?.textContent || '').includes(`-> ${tw} ×`)",
            arg=w0 + 24,
        )
        osc_log = _el(pg, "win-console-log").text_content() or ""
        res_lines = [ln for ln in osc_log.splitlines() if "[resize]" in ln]
        assert len(res_lines) == 1, (
            f"Expected 1 settled [resize] line, got {len(res_lines)}: {osc_log}"
        )
    finally:
        pg.evaluate(
            """() => {
      if (window.__pwOrigIw) Object.defineProperty(window, 'innerWidth', window.__pwOrigIw);
      delete window.__pwOrigIw;
      window.dispatchEvent(new Event('resize'));
    }"""
        )
    pg.wait_for_function(
        "(bw) => (document.querySelector('[data-testid=\"win-console-log\"]')?.textContent || '').includes(`-> ${bw} ×`)",
        arg=w0,
    )
    sim_js = """async () => {
      const origMin = window.minimize, origMax = window.maximize, origRest = window.restore;
      const origIw = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      const waitUntil = (pred, label, timeoutMs = 4000) => new Promise((resolve, reject) => {
        const t0 = performance.now();
        const tick = () => {
          if (pred()) return resolve();
          if (performance.now() - t0 > timeoutMs) {
            return reject(new Error(`Timed out waiting for ${label}`));
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
      const twoFrames = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const logText = () =>
        document.querySelector('[data-testid="win-console-log"]')?.textContent || '';
      const statText = () =>
        document.querySelector('[data-testid="win-awc-status"]')?.textContent || '';

      let blinkSlotBusy = false;
      let resolveMaximize = null;
      let rejectMinimize = null;
      let maximizeCallCount = 0;
      let minimizeCallCount = 0;
      let restoreCallCount = 0;
      let restoreCalledWhileBusy = false;

      window.maximize = () => {
        maximizeCallCount += 1;
        if (blinkSlotBusy) {
          return Promise.reject(new DOMException('Could not maximize the window.', 'InvalidStateError'));
        }
        blinkSlotBusy = true;
        return new Promise((res) => {
          resolveMaximize = () => {
            blinkSlotBusy = false;
            res();
          };
        });
      };
      window.minimize = () => {
        minimizeCallCount += 1;
        if (blinkSlotBusy) {
          return Promise.reject(new DOMException('Could not minimize the window.', 'InvalidStateError'));
        }
        blinkSlotBusy = true;
        return new Promise((_, rej) => {
          rejectMinimize = () => {
            blinkSlotBusy = false;
            rej(new DOMException('Could not minimize the window.', 'InvalidStateError'));
          };
        });
      };
      window.restore = () => {
        restoreCallCount += 1;
        if (blinkSlotBusy) {
          restoreCalledWhileBusy = true;
          return Promise.reject(new DOMException('Could not restore the window.', 'InvalidStateError'));
        }
        return Promise.resolve();
      };

      try {
        const maxBtn = document.querySelector('[data-testid="win-maximize-btn"]');
        const minBtn = document.querySelector('[data-testid="win-minimize-btn"]');
        const restBtn = document.querySelector('[data-testid="win-restore-btn"]');
        const reszBtn = document.querySelector('[data-testid="win-resizable-toggle"]');
        const clearBtn = document.querySelector('[data-testid="win-clear-log-btn"]');
        const allBtns = [minBtn, maxBtn, restBtn, reszBtn];

        if (statText() === 'Maximized') {
          restBtn.click();
          await waitUntil(() => statText() === 'Normal' && !maxBtn.disabled, 'reset Normal');
          restoreCallCount = 0;
        }

        maxBtn.click();
        await waitUntil(() => Boolean(resolveMaximize), 'maximize in-flight');
        const allDisabledDuringMax = allBtns.every((b) => Boolean(b?.disabled));
        maxBtn.click();
        restBtn.click();
        minBtn.click();
        reszBtn.click();
        const noStackDuringMax =
          maximizeCallCount === 1 && restoreCallCount === 0 && minimizeCallCount === 0;
        resolveMaximize();
        await waitUntil(
          () => statText() === 'Maximized' && !restBtn.disabled,
          'State: Maximized',
        );

        clearBtn.click();
        await waitUntil(() => logText() === '', 'log cleared');

        minBtn.click();
        const disabledDuringGenie = allBtns.every((b) => Boolean(b?.disabled));
        minBtn.click();
        await waitUntil(
          () => logText().includes('[awc] Invoking window.minimize() (prev state: Maximized)'),
          'minimize invoked',
        );

        const baseIw = window.innerWidth;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        await waitUntil(
          () => statText() === 'Minimized' && logText().includes('Maximized -> Minimized'),
          'OS minimize committed',
        );
        Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => baseIw - 40 });
        window.dispatchEvent(new Event('resize'));
        const hidAt = performance.now();
        await waitUntil(() => performance.now() - hidAt >= 420, 'pollTimer window while hidden');
        if (origIw) Object.defineProperty(window, 'innerWidth', origIw);

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        await waitUntil(
          () => statText() === 'Maximized' && logText().includes('Minimized -> Maximized'),
          'Dock restore to Maximized',
        );

        restBtn.click();
        const allDisabledDuringRestore = allBtns.every((b) => Boolean(b?.disabled));
        restBtn.click();
        minBtn.click();
        await waitUntil(
          () => logText().includes('[awc] Invoking window.restore() (prev state: Maximized)'),
          'restore invoked while minimize raw pending',
        );
        await twoFrames();
        const queuedBeforeSettle = blinkSlotBusy && restoreCallCount === 0;

        rejectMinimize();
        await waitUntil(
          () => statText() === 'Normal' && logText().includes('Maximized -> Normal') && !maxBtn.disabled,
          'queued restore settled to Normal',
        );
        const preRaceLog = logText();
        const preRaceMinCalls = minimizeCallCount;
        const preRaceRestCalls = restoreCallCount;

        // Verify invoking maximize() from Minimized when visibilitychange + focus
        // fire mid-maximize() is guarded by awcShowInFlight and settles to Maximized.
        clearBtn.click();
        await waitUntil(() => logText() === '', 'clear log before min->max wake race');
        resolveMaximize = null;
        minBtn.click();
        await waitUntil(
          () => logText().includes('[awc] Invoking window.minimize() (prev state: Normal)'),
          'minimize from Normal for awcShowInFlight check',
        );
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        await waitUntil(
          () => statText() === 'Minimized' && logText().includes('Normal -> Minimized'),
          'Normal -> Minimized before mid-maximize wake',
        );
        rejectMinimize();
        await waitUntil(() => !blinkSlotBusy && !maxBtn.disabled, 'maxBtn ready while Minimized');
        maxBtn.click();
        await waitUntil(() => Boolean(resolveMaximize), 'maximize in-flight from Minimized');
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        await twoFrames();
        const stillMinimizedMidMaximize = statText() === 'Minimized';
        resolveMaximize();
        await waitUntil(
          () =>
            statText() === 'Maximized' &&
            logText().includes('Minimized -> Maximized') &&
            !restBtn.disabled,
          'Minimized -> Maximized settled despite mid-flight wake',
        );
        const minToMaxRaceLog = logText();
        restBtn.click();
        await waitUntil(
          () => statText() === 'Normal' && !maxBtn.disabled,
          'reset Normal after min->max wake race',
        );

        return {
          log: preRaceLog,
          allDisabledDuringMax,
          noStackDuringMax,
          disabledDuringGenie,
          allDisabledDuringRestore,
          minimizeCallCount: preRaceMinCalls,
          queuedBeforeSettle,
          restoreCallCount: preRaceRestCalls,
          restoreCalledWhileBusy,
          stillMinimizedMidMaximize,
          minToMaxRaceLog,
        };
      } finally {
        if (origIw) Object.defineProperty(window, 'innerWidth', origIw);
        try { delete document.hidden; } catch {}
        if (origMin !== undefined) window.minimize = origMin; else delete window.minimize;
        if (origMax !== undefined) window.maximize = origMax; else delete window.maximize;
        if (origRest !== undefined) window.restore = origRest; else delete window.restore;
      }
    }"""
    res = pg.evaluate(sim_js)
    log_txt = str(res["log"])
    assert res["allDisabledDuringMax"] is True, (
        f"Buttons enabled during maximize: {res}"
    )
    assert res["noStackDuringMax"] is True, f"Stacked calls during maximize: {res}"
    assert res["disabledDuringGenie"] is True, (
        f"Buttons not disabled during Genie: {res}"
    )
    assert res["allDisabledDuringRestore"] is True, (
        f"Buttons enabled during queued restore: {res}"
    )
    assert res["minimizeCallCount"] == 1, f"Double-click invoked minimize twice: {res}"
    assert res["queuedBeforeSettle"] is True, (
        f"Restore was not queued behind showStateQ: {res}"
    )
    assert res["restoreCallCount"] == 1, f"Expected 1 restore call: {res}"
    assert res["restoreCalledWhileBusy"] is False, (
        f"Restore called while Blink slot busy: {res}"
    )
    lines = log_txt.splitlines()
    min_i = next(
        (
            i
            for i, ln in enumerate(lines)
            if "Maximized -> Minimized" in ln and "via window.minimize()" in ln
        ),
        -1,
    )
    dock_i = next(
        (
            i
            for i, ln in enumerate(lines)
            if "Minimized -> Maximized" in ln and "via restore" in ln
        ),
        -1,
    )
    norm_i = next(
        (
            i
            for i, ln in enumerate(lines)
            if "Maximized -> Normal" in ln and "via window.restore()" in ln
        ),
        -1,
    )
    assert min_i >= 0, f"Missing Maximized -> Minimized transition in:\n{log_txt}"
    assert dock_i > min_i, f"Missing Minimized -> Maximized Dock restore in:\n{log_txt}"
    assert norm_i > dock_i, f"Missing queued Maximized -> Normal restore in:\n{log_txt}"
    assert "[resize]" not in log_txt, (
        f"Ghost [resize] logged while minimized:\n{log_txt}"
    )
    assert "State: Minimized)" not in log_txt, (
        f"Ghost Minimized resize state in:\n{log_txt}"
    )
    assert "via poll" not in log_txt, f"Unexpected poll transition in:\n{log_txt}"
    assert "Could not minimize the window." not in log_txt, (
        f"False minimize error in:\n{log_txt}"
    )
    assert "Could not restore the window." not in log_txt, (
        f"Blink slot collision on restore in:\n{log_txt}"
    )
    assert res["stillMinimizedMidMaximize"] is True, (
        f"Mid-maximize wake prematurely cleared Minimized: {res}"
    )
    race_log = str(res["minToMaxRaceLog"])
    assert (
        "Minimized -> Maximized" in race_log and "via window.maximize()" in race_log
    ), f"Expected Minimized -> Maximized via window.maximize() in:\n{race_log}"
    assert "Minimized -> Normal" not in race_log, (
        f"Unexpected mid-flight restoreFromMinimized to Normal in:\n{race_log}"
    )


def _assert_win_macos_sticky_zoom_and_stalled_restore(pg: Page) -> None:
    mac_js = """async () => {
      const saveProp = (obj, key) => ({
        hasOwn: Object.prototype.hasOwnProperty.call(obj, key),
        desc: Object.getOwnPropertyDescriptor(obj, key),
      });
      const restoreProp = (obj, key, saved) => {
        if (saved.hasOwn && saved.desc) {
          Object.defineProperty(obj, key, saved.desc);
        } else {
          try { delete obj[key]; } catch {}
        }
      };
      const waitUntil = (pred, label, timeoutMs = 4000) => new Promise((resolve, reject) => {
        const t0 = performance.now();
        const tick = () => {
          if (pred()) return resolve();
          if (performance.now() - t0 > timeoutMs) {
            return reject(new Error(`Timed out waiting for ${label} (stat=${statText()}, log=${logText()})`));
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
      const logText = () =>
        document.querySelector('[data-testid="win-console-log"]')?.textContent || '';
      const statText = () =>
        document.querySelector('[data-testid="win-awc-status"]')?.textContent || '';

      const savedPlat = saveProp(navigator, 'platform');
      const savedMm = saveProp(window, 'matchMedia');
      const winProps = [
        'outerWidth', 'outerHeight', 'innerWidth', 'innerHeight',
        'screenX', 'screenY', 'resizeTo', 'moveTo',
        'maximize', 'restore', 'minimize',
      ];
      const savedWin = Object.fromEntries(winProps.map((k) => [k, saveProp(window, k)]));
      const scrProps = ['availWidth', 'availHeight', 'availLeft', 'availTop'];
      const savedScr = Object.fromEntries(scrProps.map((k) => [k, saveProp(window.screen, k)]));

      const origMm = window.matchMedia.bind(window);
      const origNativeMax = typeof window.maximize === 'function' ? window.maximize.bind(window) : null;
      const origNativeRest = typeof window.restore === 'function' ? window.restore.bind(window) : null;
      let nativeMaximized = false;

      let [aw, ah, al, at] = [1000, 700, 0, 38];
      let [curOw, curOh, curIw, curIh, curX, curY] = [1000, 700, 1000, 660, 0, 38];
      let [frameDipW, frameDipH] = [1000, 700];
      const chromeOverhead = 40;
      let stickyMax = true;
      let pendingShimResize = 0;
      let clobberedByMoveTo = false;
      let resolveStalled = null;
      let resizeLog = [];
      let moveLog = [];

      const setGeom = (ow, oh, iw, ih, x, y) => {
        [curOw, curOh, curIw, curIh, curX, curY] = [ow, oh, iw, ih, x, y];
        [frameDipW, frameDipH] = [ow, oh];
      };

      try {
        Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
        for (const [k, fn] of [
          ['availWidth', () => aw],
          ['availHeight', () => ah],
          ['availLeft', () => al],
          ['availTop', () => at],
        ]) {
          Object.defineProperty(window.screen, k, { configurable: true, get: fn });
        }
        for (const [k, fn] of [
          ['outerWidth', () => curOw],
          ['outerHeight', () => curOh],
          ['innerWidth', () => curIw],
          ['innerHeight', () => curIh],
          ['screenX', () => curX],
          ['screenY', () => curY],
        ]) {
          Object.defineProperty(window, k, { configurable: true, get: fn });
        }
        window.matchMedia = (q) => {
          if (q === '(display-mode: standalone)') {
            return {
              matches: true,
              media: q,
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
              dispatchEvent: () => false,
            };
          }
          if (q === '(display-state: maximized)') {
            return {
              get matches() { return stickyMax; },
              media: q,
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
              dispatchEvent: () => false,
            };
          }
          return origMm(q);
        };

        // Async remote_cocoa App Shim model:
        // - resizeTo updates window_frame_in_screen_dip_ asynchronously on rAF and only
        //   fires AppKit windowDidResize: (clearing stickyMax) when NSWindow frame changes.
        // - moveTo reads window_frame_in_screen_dip_ synchronously (WebContentsImpl::MoveWindowTo),
        //   so calling moveTo before resizeTo's async rAF clobbers window size back to frameDipW/H.
        window.resizeTo = (w, h) => {
          resizeLog.push([w, h]);
          pendingShimResize += 1;
          requestAnimationFrame(() => {
            pendingShimResize -= 1;
            const [prevOw, prevOh] = [curOw, curOh];
            [curOw, curOh, curIw, curIh] = [w, h, w, Math.max(200, h - chromeOverhead)];
            [frameDipW, frameDipH] = [w, h];
            if (w !== prevOw || h !== prevOh) {
              stickyMax = w >= aw && h >= ah;
              window.dispatchEvent(new Event('resize'));
              if (!stickyMax && resolveStalled) {
                const r = resolveStalled;
                resolveStalled = null;
                r();
              }
            }
          });
        };
        window.moveTo = (x, y) => {
          moveLog.push([x, y]);
          if (pendingShimResize > 0) clobberedByMoveTo = true;
          const [dipW, dipH] = [frameDipW, frameDipH];
          requestAnimationFrame(() => {
            const [prevOw, prevOh] = [curOw, curOh];
            [curX, curY, curOw, curOh, curIw, curIh] = [
              x, y, dipW, dipH, dipW, Math.max(200, dipH - chromeOverhead),
            ];
            [frameDipW, frameDipH] = [dipW, dipH];
            if (dipW !== prevOw || dipH !== prevOh) {
              stickyMax = dipW >= aw && dipH >= ah;
              window.dispatchEvent(new Event('resize'));
            }
          });
        };

        const maxBtn = document.querySelector('[data-testid="win-maximize-btn"]');
        const minBtn = document.querySelector('[data-testid="win-minimize-btn"]');
        const restBtn = document.querySelector('[data-testid="win-restore-btn"]');
        const reszBtn = document.querySelector('[data-testid="win-resizable-toggle"]');
        const clearBtn = document.querySelector('[data-testid="win-clear-log-btn"]');
        const allBtns = [minBtn, maxBtn, restBtn, reszBtn];

        // 1) Boot-maximized macOS stalled window.restore() -> ~450ms async resizeTo then moveTo.
        window.maximize = () => Promise.resolve();
        if (statText() !== 'Maximized') {
          maxBtn.click();
          await waitUntil(
            () => statText() === 'Maximized' && !restBtn.disabled,
            'Mac 1000x700 Maximized',
          );
        }
        clearBtn.click();
        await waitUntil(() => logText() === '', 'clear log before stalled restore');
        resizeLog = [];
        moveLog = [];
        clobberedByMoveTo = false;
        window.restore = () => new Promise((r) => {
          resolveStalled = r;
        });

        const t0 = performance.now();
        restBtn.click();
        const disabledDuringStalledRestore = allBtns.every((b) => Boolean(b?.disabled));
        await waitUntil(
          () =>
            statText() === 'Normal' &&
            logText().includes('Maximized -> Normal') &&
            !maxBtn.disabled &&
            moveLog.length === 1 &&
            curX === 100 &&
            curY === 101 &&
            curOw === 800 &&
            curOh === 574,
          'stalled restore fallback to Normal',
        );
        const stalledElapsedMs = performance.now() - t0;
        const stalledResizeCalls = [...resizeLog];
        const stalledMoveCalls = [...moveLog];
        const stalledClobbered = clobberedByMoveTo;
        const stalledLog = logText();

        // 2) Sticky (display-state: maximized) manual shrink (1470x792 -> 799x487) + -1px/+1px nudge.
        [aw, ah, al, at] = [1470, 792, 0, 38];
        setGeom(1470, 792, 1470, 792, 0, 38);
        stickyMax = true;
        window.maximize = () => Promise.resolve();
        maxBtn.click();
        await waitUntil(
          () => statText() === 'Maximized' && !restBtn.disabled,
          'Mac 1470x792 Maximized',
        );
        const maxSettledAt = performance.now();
        await waitUntil(() => performance.now() - maxSettledAt >= 270, 'post-AWC cooldown');

        clearBtn.click();
        await waitUntil(() => logText() === '', 'clear log before sticky shrink');
        resizeLog = [];
        moveLog = [];

        setGeom(799, 487, 799, 447, 180, 120);
        stickyMax = true;
        window.dispatchEvent(new Event('resize'));
        await waitUntil(
          () =>
            statText() === 'Normal' &&
            logText().includes('Maximized -> Normal') &&
            resizeLog.length === 2 &&
            pendingShimResize === 0 &&
            !stickyMax &&
            curOw === 799 &&
            curOh === 487,
          'sticky zoom shrink + -1px/+1px nudge',
        );
        const nudgeDoneAt = performance.now();
        await waitUntil(() => performance.now() - nudgeDoneAt >= 220, 'quiet window after nudge');
        const staleZoomSyncCalls = [...resizeLog];
        const stickyClearedByNudge = !stickyMax && curOw === 799 && curOh === 487;
        const shrinkLog = logText();
        const shrinkResizeLines = shrinkLog.split('\\n').filter((l) => l.includes('[resize]'));

        // 3) 0ms IsMaximized(window) short-circuit on window.maximize() from 799x487 @ (180, 120).
        clearBtn.click();
        await waitUntil(() => logText() === '', 'clear log before 0ms maximize');
        resizeLog = [];
        moveLog = [];
        clobberedByMoveTo = false;
        stickyMax = true;
        window.maximize = () => Promise.resolve();
        maxBtn.click();
        await waitUntil(
          () =>
            statText() === 'Maximized' &&
            !restBtn.disabled &&
            moveLog.length === 1 &&
            curOw === 1470 &&
            curOh === 792 &&
            curX === 0 &&
            curY === 38,
          '0ms maximize short-circuit rescued via applyMacBounds',
        );
        const shortMaxResizeCalls = [...resizeLog];
        const shortMaxMoveCalls = [...moveLog];
        const shortMaxClobbered = clobberedByMoveTo;
        const shortMaxLog = logText();

        // 4) 0ms IsNormal(window) short-circuit on window.restore() -> restores saved 799x487 @ (180, 120).
        clearBtn.click();
        await waitUntil(() => logText() === '', 'clear log before 0ms restore');
        resizeLog = [];
        moveLog = [];
        clobberedByMoveTo = false;
        window.restore = () => Promise.resolve();
        restBtn.click();
        await waitUntil(
          () =>
            statText() === 'Normal' &&
            !maxBtn.disabled &&
            moveLog.length === 1 &&
            curOw === 799 &&
            curOh === 487 &&
            curX === 180 &&
            curY === 120,
          '0ms restore short-circuit rescued via saved lastNormalRect',
        );
        const shortRestResizeCalls = [...resizeLog];
        const shortRestMoveCalls = [...moveLog];
        const shortRestClobbered = clobberedByMoveTo;
        const shortRestLog = logText();

        // 5) Sticky (display-state: maximized) change event on Dock restore while !isMax() (799x487).
        let dockStickyRestoredNormal = false;
        if (origNativeMax && origNativeRest && origMm('(display-state: maximized)').media !== 'not all') {
          clearBtn.click();
          await waitUntil(() => logText() === '', 'clear log before sticky Dock restore');
          let releaseMin = null;
          window.minimize = () => new Promise((r) => { releaseMin = r; });
          minBtn.click();
          await waitUntil(
            () => logText().includes('[awc] Invoking window.minimize() (prev state: Normal)'),
            'minimize from Normal invoked',
          );
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
          await waitUntil(
            () => statText() === 'Minimized' && logText().includes('Normal -> Minimized'),
            'Normal -> Minimized committed',
          );
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          nativeMaximized = true;
          await origNativeMax();
          await waitUntil(
            () => statText() === 'Normal' && logText().includes('Minimized -> Normal'),
            'Dock restore with sticky (display-state: maximized) stays Normal when !isMax()',
          );
          dockStickyRestoredNormal =
            statText() === 'Normal' && !logText().includes('Minimized -> Maximized');
          if (releaseMin) releaseMin();
          await origNativeRest();
          nativeMaximized = false;
          try { delete document.hidden; } catch {}
        }

        return {
          disabledDuringStalledRestore,
          stalledResizeCalls,
          stalledMoveCalls,
          stalledClobbered,
          stalledElapsedMs,
          stalledLog,
          staleZoomSyncCalls,
          stickyClearedByNudge,
          shrinkLog,
          shrinkResizeLines,
          shortMaxResizeCalls,
          shortMaxMoveCalls,
          shortMaxClobbered,
          shortMaxLog,
          shortRestResizeCalls,
          shortRestMoveCalls,
          shortRestClobbered,
          shortRestLog,
          dockStickyRestoredNormal,
        };
      } finally {
        try { delete document.hidden; } catch {}
        if (nativeMaximized && origNativeRest) {
          try { await origNativeRest(); } catch {}
        }
        restoreProp(navigator, 'platform', savedPlat);
        restoreProp(window, 'matchMedia', savedMm);
        for (const k of winProps) restoreProp(window, k, savedWin[k]);
        for (const k of scrProps) restoreProp(window.screen, k, savedScr[k]);
        window.dispatchEvent(new Event('resize'));
        const cleanAt = performance.now();
        await waitUntil(() => performance.now() - cleanAt >= 210, 'cleanup debounce');
      }
    }"""
    res = pg.evaluate(mac_js)
    assert res["disabledDuringStalledRestore"] is True, res
    assert res["stalledResizeCalls"] == [[800, 574]], res
    assert res["stalledMoveCalls"] == [[100, 101]], res
    assert res["stalledClobbered"] is False, res
    assert res["stalledElapsedMs"] >= 400, res
    assert "Maximized -> Normal" in res["stalledLog"], res
    assert "via window.restore()" in res["stalledLog"], res
    assert res["staleZoomSyncCalls"] == [[798, 487], [799, 487]], res
    assert res["stickyClearedByNudge"] is True, res
    assert "Maximized -> Normal" in res["shrinkLog"], res
    assert "via resize" in res["shrinkLog"], res
    assert len(res["shrinkResizeLines"]) == 1, res
    assert (
        "1470 × 792 px -> 799 × 447 px (State: Normal)" in res["shrinkResizeLines"][0]
    ), res
    assert res["shortMaxResizeCalls"] == [[1470, 792]], res
    assert res["shortMaxMoveCalls"] == [[0, 38]], res
    assert res["shortMaxClobbered"] is False, res
    assert "Normal -> Maximized" in res["shortMaxLog"], res
    assert "via window.maximize()" in res["shortMaxLog"], res
    assert "[resize]" not in res["shortMaxLog"], res
    assert res["shortRestResizeCalls"] == [[799, 487]], res
    assert res["shortRestMoveCalls"] == [[180, 120]], res
    assert res["shortRestClobbered"] is False, res
    assert "Maximized -> Normal" in res["shortRestLog"], res
    assert "via window.restore()" in res["shortRestLog"], res
    assert "[resize]" not in res["shortRestLog"], res
    assert res["dockStickyRestoredNormal"] is True, res


def _assert_win_displays_ux(pg: Page) -> None:
    row_align_js = """() => {
      const ttl = document.querySelector('#win-panel-controls .win-displays-title');
      const btn = document.querySelector('[data-testid="win-screen-details-btn"]');
      if (!ttl || !btn) return null;
      const tr = ttl.getBoundingClientRect(), br = btn.getBoundingClientRect();
      return {
        dy: Math.abs((tr.top + tr.bottom) / 2 - (br.top + br.bottom) / 2),
        btnRightOfTitle: br.left >= tr.right,
        sameRow: br.top < tr.bottom && tr.top < br.bottom,
      };
    }"""
    panel = pg.locator("#panel-windowing-hud")
    assert panel.locator(".meta-tag, .status-pill").count() == 0
    assert panel.locator(".win-screen-dot").count() == 0
    expect(_el(pg, "win-panel-controls").locator(".ws-card-title")).to_have_text(
        "Desktop Window Controls"
    )
    expect(_el(pg, "win-awc-notice")).to_be_hidden()

    # 1) Fallback mode (permission declined)
    deny_fn = "() => Promise.reject(new DOMException('Permission denied.', 'NotAllowedError'))"
    with _mock_js(pg, "window", "getScreenDetails", deny_fn):
        _el(pg, "win-screen-details-btn").click()
        expect(_el(pg, "win-displays-subtitle")).to_have_text(
            "Permission declined · showing current display"
        )
        rows = _el(pg, "win-screens-list").locator(".win-screen-row")
        expect(rows).to_have_count(1)
        expect(rows.nth(0)).to_contain_text("Current Display")
        expect(rows.nth(0).locator(".win-screen-badge")).to_have_text("Active")
        expect(rows.nth(0).locator(".win-screen-specs")).to_contain_text("× scale")
        assert "DPR" not in (_el(pg, "win-panel-controls").text_content() or "")
        align_fb = pg.evaluate(row_align_js)
        assert (
            align_fb
            and align_fb["sameRow"]
            and align_fb["btnRightOfTitle"]
            and align_fb["dy"] <= 6
        ), align_fb

    # 2) Mocked 2-display ScreenDetails (Mac Retina 2x current + DELL U2722DE 1x)
    mock_two_fn = """async () => {
      const s1 = {
        label: 'Built-in Retina Display',
        width: 1470,
        height: 956,
        left: 0,
        top: 0,
        isInternal: true,
        isPrimary: true,
        devicePixelRatio: 2,
      };
      const s2 = {
        label: 'DELL U2722DE',
        width: 2560,
        height: 1440,
        left: 1470,
        top: 0,
        isInternal: false,
        isPrimary: false,
        devicePixelRatio: 1,
      };
      return Object.assign(new EventTarget(), { screens: [s1, s2], currentScreen: s1 });
    }"""
    with _mock_js(pg, "window", "getScreenDetails", mock_two_fn):
        _el(pg, "win-screen-details-btn").click()
        expect(_el(pg, "win-displays-subtitle")).to_have_text("2 displays")
        rows = _el(pg, "win-screens-list").locator(".win-screen-row")
        expect(rows).to_have_count(2)
        expect(rows.nth(0).locator(".win-screen-name")).to_have_text(
            "Built-in Retina Display"
        )
        expect(rows.nth(0).locator(".win-screen-badge")).to_have_text("Active")
        expect(rows.nth(0).locator(".win-screen-specs")).to_have_text(
            "1470 × 956 px · 2× scale"
        )
        expect(rows.nth(1).locator(".win-screen-name")).to_have_text("DELL U2722DE")
        expect(rows.nth(1).locator(".win-screen-badge")).to_have_count(0)
        expect(rows.nth(1).locator(".win-screen-specs")).to_have_text(
            "2560 × 1440 px · 1× scale"
        )
        assert panel.locator(".meta-tag, .status-pill, .win-screen-dot").count() == 0
        ctrl_txt = _el(pg, "win-panel-controls").text_content() or ""
        assert "DPR" not in ctrl_txt and "Last AWC action:" not in ctrl_txt
        if _el(pg, "win-unframed-screens-summary").count() > 0:
            unf_txt = _el(pg, "win-unframed-screens-summary").text_content() or ""
            assert "1470 × 956 px · 2× scale" in unf_txt and "DPR" not in unf_txt
        align_two = pg.evaluate(row_align_js)
        assert (
            align_two
            and align_two["sameRow"]
            and align_two["btnRightOfTitle"]
            and align_two["dy"] <= 6
        ), align_two

    # 3) Live getScreenDetails() round-trip
    prev_scr_cnt = (_el(pg, "win-console-log").text_content() or "").count("[screens]")
    _el(pg, "win-screen-details-btn").click()
    scr = _el(pg, "win-screens-list")
    expect(scr).not_to_contain_text("DELL U2722DE")
    pg.wait_for_function(
        "(n) => (document.querySelector('[data-testid=\"win-console-log\"]')?.textContent || '').split('[screens]').length - 1 > n",
        arg=prev_scr_cnt,
    )
    expect(scr).to_be_visible()
    assert scr.locator(".win-screen-row").count() >= 1
    assert panel.locator(".meta-tag, .status-pill, .win-screen-dot").count() == 0

    # 4) Fullscreen preserves container mode ('Fullscreen' + 'Standalone', never 'Fullscreen · Fullscreen')
    fs_res = pg.evaluate(
        """async () => {
      const savedMm = {
        hasOwn: Object.prototype.hasOwnProperty.call(window, 'matchMedia'),
        desc: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
      };
      const origMm = window.matchMedia.bind(window);
      const twoFrames = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let activeMode = 'standalone';
      const mkMql = (q, matches) => ({
        matches,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
      try {
        window.matchMedia = (query) => {
          const q = String(query).trim();
          if (q.startsWith('(display-mode:')) {
            return mkMql(q, q === `(display-mode: ${activeMode})`);
          }
          return origMm(q);
        };
        window.dispatchEvent(new Event('resize'));
        await twoFrames();
        activeMode = 'fullscreen';
        window.dispatchEvent(new Event('resize'));
        await twoFrames();
        return {
          state: document.querySelector('[data-testid="win-awc-status"]')?.textContent || '',
          mode: document.querySelector('[data-testid="win-display-mode"]')?.textContent || '',
        };
      } finally {
        if (savedMm.hasOwn && savedMm.desc) {
          Object.defineProperty(window, 'matchMedia', savedMm.desc);
        } else {
          try { delete window.matchMedia; } catch {}
        }
        window.dispatchEvent(new Event('resize'));
        await twoFrames();
      }
    }"""
    )
    assert fs_res == {"state": "Fullscreen", "mode": "Standalone"}, fs_res

    # 5) Interactive Query Displays suppresses perm 'change' race ('prompt' -> 'denied' & 'granted')
    pg.evaluate(
        """() => {
      const f = document.createElement('iframe');
      f.dataset.testid = 'win-perm-probe-iframe';
      f.hidden = true;
      document.body.appendChild(f);
    }"""
    )
    try:
        ifr_el = _el(pg, "win-perm-probe-iframe").element_handle()
        assert ifr_el is not None
        probe_frame = ifr_el.content_frame()
        assert probe_frame is not None
        perm_res = probe_frame.evaluate(
            """async () => {
          const waitUntil = (pred, label, timeoutMs = 3000) =>
            new Promise((resolve, reject) => {
              const t0 = performance.now();
              const tick = () => {
                if (pred()) return resolve();
                if (performance.now() - t0 > timeoutMs) {
                  return reject(new Error(`Timed out waiting for ${label}`));
                }
                requestAnimationFrame(tick);
              };
              tick();
            });
          const twoFrames = () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          let permState = 'prompt';
          let changeListenerAttached = false;
          const mockPerm = new EventTarget();
          Object.defineProperty(mockPerm, 'state', {
            configurable: true,
            get: () => permState,
          });
          const origAdd = mockPerm.addEventListener.bind(mockPerm);
          mockPerm.addEventListener = (type, listener, opts) => {
            if (type === 'change') changeListenerAttached = true;
            return origAdd(type, listener, opts);
          };
          Object.defineProperty(navigator, 'permissions', {
            configurable: true,
            value: {
              query: async (desc) => {
                if (desc && desc.name === 'window-management') return mockPerm;
                throw new TypeError('Unsupported permission');
              },
            },
          });

          let screenDetailsCalls = 0;
          let mode = 'deny';
          window.getScreenDetails = () => {
            screenDetailsCalls += 1;
            if (mode === 'deny') {
              permState = 'denied';
              mockPerm.dispatchEvent(new Event('change'));
              return new Promise((_, rej) => {
                requestAnimationFrame(() => {
                  rej(new DOMException('Permission denied.', 'NotAllowedError'));
                });
              });
            }
            if (permState !== 'granted') {
              permState = 'granted';
              mockPerm.dispatchEvent(new Event('change'));
            }
            return new Promise((res) => {
              requestAnimationFrame(() => {
                const s1 = {
                  label: 'Built-in Retina Display',
                  width: 1470,
                  height: 956,
                  left: 0,
                  top: 0,
                  isInternal: true,
                  isPrimary: true,
                  devicePixelRatio: 2,
                };
                res(Object.assign(new EventTarget(), { screens: [s1], currentScreen: s1 }));
              });
            });
          };

          const host = document.createElement('div');
          document.body.appendChild(host);
          const mod = await import('/src/workspaces/windowing-hud/index.ts');
          mod.windowingHudWorkspace.mount(host, { setWorkspaceStatus() {} });

          await waitUntil(() => changeListenerAttached, 'cold-boot perm change listener');
          const qBtn = host.querySelector('[data-testid="win-screen-details-btn"]');
          const clearBtn = host.querySelector('[data-testid="win-clear-log-btn"]');
          const logEl = host.querySelector('[data-testid="win-console-log"]');
          const subEl = host.querySelector('[data-testid="win-displays-subtitle"]');
          const logText = () => logEl?.textContent || '';

          clearBtn.click();
          await waitUntil(() => logText() === '', 'clear log before deny');
          screenDetailsCalls = 0;
          mode = 'deny';
          qBtn.click();
          await waitUntil(
            () => logText().includes('[screens] getScreenDetails() failed (Permission denied.)'),
            'denied failure logged despite perm change event',
          );
          await twoFrames();
          const denySubtitle = subEl?.textContent || '';
          const denyCalls = screenDetailsCalls;
          const denyLog = logText();

          permState = 'prompt';
          clearBtn.click();
          await waitUntil(() => logText() === '', 'clear log before grant');
          screenDetailsCalls = 0;
          mode = 'grant';
          qBtn.click();
          await waitUntil(
            () => logText().includes('[screens] window.getScreenDetails()'),
            'granted screens logged',
          );
          await twoFrames();
          await twoFrames();
          const grantSubtitle = subEl?.textContent || '';
          const grantCalls = screenDetailsCalls;
          const grantScreensLogCount = logText()
            .split('\\n')
            .filter((l) => l.includes('[screens]')).length;

          window.dispatchEvent(new PageTransitionEvent('pagehide'));
          return {
            denySubtitle,
            denyCalls,
            denyLog,
            grantSubtitle,
            grantCalls,
            grantScreensLogCount,
          };
        }"""
        )
        assert perm_res["denyCalls"] == 1, perm_res
        assert (
            perm_res["denySubtitle"] == "Permission declined · showing current display"
        ), perm_res
        assert (
            "[screens] getScreenDetails() failed (Permission denied.)"
            in perm_res["denyLog"]
        ), perm_res
        assert perm_res["grantCalls"] == 1, perm_res
        assert perm_res["grantScreensLogCount"] == 1, perm_res
        assert perm_res["grantSubtitle"] == "1 display", perm_res
    finally:
        pg.evaluate(
            "() => document.querySelector('[data-testid=\"win-perm-probe-iframe\"]')?.remove()"
        )


@_t("WIN-02", 1, "WinScreenDetails", "getScreenDetails() multi-display & console log")
def test_win02(ctx: h.E2EContext) -> None:
    pg = _win_ws(ctx)
    boot_log = _el(pg, "win-console-log").text_content() or ""
    assert "Transient activation is required" not in boot_log
    assert "getScreenDetails() failed" not in boot_log
    _assert_win_displays_ux(pg)
    tbtn = _el(pg, "win-toggle-console-btn")
    tbtn.click()
    expect(tbtn).to_have_attribute("aria-expanded", "true")
    expect(_el(pg, "win-console-log")).to_be_visible()
    _assert_win_resize_and_macos_minimize(pg)
    _assert_win_macos_sticky_zoom_and_stalled_restore(pg)


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

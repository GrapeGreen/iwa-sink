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

"""Controlled Frame, X.509 DER Inspector & `cf://` / `web+cf://` Suite (`16` tests)."""

from __future__ import annotations

import contextlib
import resource
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

from playwright.sync_api import Locator, Page, expect

import tests.pw_harness as h

with contextlib.suppress(Exception):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

TESTS: list[h.TestSpec] = []


def _t(tid: str, tr: int, feat: str, ttl: str, err: bool = False) -> Any:
    return h.e2e_test(TESTS, tid, tr, feat, ttl, allow_console_errors=err)


def _el(pg: Page, test_id: str) -> Locator:
    return pg.get_by_test_id(test_id)


def _els(pg: Page, *ids: str) -> tuple[Locator, ...]:
    return tuple(pg.get_by_test_id(i) for i in ids)


def _ws(ctx: h.E2EContext) -> Page:
    ctx.session.activate_workspace("controlled-frame-tls")
    return ctx.session.page


def _sec(pg: Page, state: str, timeout: float = 5000) -> None:
    ind = _el(pg, "cf-security-indicator")
    expect(ind).to_have_attribute("data-security-state", state, timeout=timeout)


def _cert_hex(pg: Page) -> str:
    return h.normalize_hex(_el(pg, "tls-cert-sha256").text_content() or "")


def _sec_cert(pg: Page, sha: str) -> None:
    _sec(pg, "secure")
    assert _cert_hex(pg) == sha


def _copy_txt(pg: Page, tid: str) -> str:
    btn = _el(pg, tid)
    btn.click()
    expect(btn).to_contain_class("is-copied")
    return h.read_clipboard_text(pg)


def _nav_cf(ctx: h.E2EContext, url: str, ready: str = "") -> Page:
    pg = _ws(ctx)
    _el(pg, "cf-url-input").fill(url)
    _el(pg, "cf-navigate-btn").click()
    if ready:
        ctx.session.wait_for_cf_ready(ready)
    return pg


@_t("CF-01", 1, "Standby", "Cold standby <controlledframe> & zero shims")
def test_cf01(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    h.assert_no_deleted_zombie_dom(pg)
    expect(_el(pg, "cf-empty-backdrop")).to_be_visible()
    _sec(pg, "idle")
    for bid in ("cf-navigate-btn", "cf-copy-url-btn"):
        expect(_el(pg, bid)).to_be_enabled()
    off = "cf-back-btn cf-forward-btn cf-reload-btn cf-clear-data-btn cf-inject-js-btn cf-inject-css-btn tls-copy-subject-btn tls-copy-issuer-btn tls-copy-cipher-btn tls-copy-sha256-btn"
    for bid in off.split():
        expect(_el(pg, bid)).to_be_disabled()
    s_js = "() => { const c = document.querySelector('[data-testid=\"cf-viewport\"]'), sub = document.querySelector('[data-testid=\"panel-controlled-frame-tls\"] .workspace-subtitle')?.textContent || ''; return [c.getAttribute('src') || '', c.partition, c.getAttribute('tabindex'), c.getAttribute('aria-hidden'), sub]; }"
    s = pg.evaluate(s_js)
    assert s[:4] == ["", "persist:iwa-workspace", "-1", "true"]
    assert "securityInfoRawDer" not in s[4] and "GuestView" not in s[4]


@_t("CF-02", 2, "OmniboxErrors", "Omnibox rejects bad schemes, ports & userinfo")
def test_cf02(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    inp, nav, err = _els(pg, "cf-url-input", "cf-navigate-btn", "cf-url-error")
    iwa_u = "isolated-app://chhcd5bvnqwcbxvy6g2fijpce2odh36bbqehpzjbn7vikaehtudqaaic/"
    bads = f"javascript:alert(1) data:text/html,<h1>x</h1> file:///etc/hosts {iwa_u} https://user:pass@127.0.0.1/ //example.com http:example.com https://example..com/ https://example.com./ https://127.0.0.1/%00null https://127.0.0.1\\backslash"
    ports = [(f"https://127.0.0.1:{p}/", "port") for p in ("0", "70000", "")]
    for bad, kw in [(u, "") for u in bads.split()] + ports:
        inp.fill(bad)
        nav.click()
        expect(err).to_be_visible()
        expect(inp).to_have_attribute("aria-invalid", "true")
        expect(inp).to_have_attribute("aria-describedby", "cf-url-error-banner")
        if kw:
            assert kw in (err.text_content() or "").lower()
    assert _el(pg, "cf-viewport").get_attribute("src") in (None, "")
    inp.fill("example.com")
    expect(err).to_be_hidden()
    _sec(pg, "idle")


@_t("CF-03", 1, "OmniboxHttps", "Bare-host https:// normalization & URL copy")
def test_cf03(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"127.0.0.1:{ctx.tls.port}/page-a", "/page-a")
    url = f"https://127.0.0.1:{ctx.tls.port}/page-a"
    _sec(pg, "secure")
    expect(_el(pg, "cf-url-input")).to_have_value(url)
    expect(_el(pg, "cf-empty-backdrop")).to_contain_class("is-dismissed")
    assert _copy_txt(pg, "cf-copy-url-btn") == url


@_t("CF-04", 1, "HistoryNav", "Back, Forward, Reload & HTTP 204 state preservation")
def test_cf04(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/nav-lab", "/nav-lab")
    back, fwd, rel = _els(pg, "cf-back-btn", "cf-forward-btn", "cf-reload-btn")
    expect(back).to_be_disabled()
    expect(fwd).to_be_disabled()
    _nav_cf(ctx, f"{ctx.tls.base_url}/page-b", "/page-b")
    expect(back).to_be_enabled()
    expect(fwd).to_be_disabled()
    back.click()
    ctx.session.wait_for_cf_ready("/nav-lab")
    expect(fwd).to_be_enabled()
    ctx.session.eval_in_cf("document.getElementById('no-content-link').click() || 'ok'")
    pg.wait_for_timeout(150)
    assert "/nav-lab" in ctx.session.eval_in_cf("location.href")
    for btn in (fwd, rel):
        btn.click()
        ctx.session.wait_for_cf_ready("/page-b")
    _sec(pg, "secure")
    _el(pg, "cf-url-input").fill(f"{ctx.tls.base_url}/no-content-204")
    _el(pg, "cf-navigate-btn").click()
    expect(_el(pg, "cf-url-input")).to_have_value(f"{ctx.tls.base_url}/page-b")
    expect(rel).to_have_attribute("data-mode", "reload")
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)


@_t("CF-05", 2, "StopNav", "In-flight Stop from standby & committed page")
def test_cf05(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    inp, nav, rel = _els(pg, "cf-url-input", "cf-navigate-btn", "cf-reload-btn")
    inp.fill(f"{ctx.tls.base_url}/slow?ms=3500")
    nav.click()
    expect(rel).to_have_attribute("data-mode", "stop")
    rel.click()
    _sec(pg, "idle")
    expect(_el(pg, "cf-empty-backdrop")).to_be_visible()
    _nav_cf(ctx, f"{ctx.tls.base_url}/page-a", "/page-a")
    _sec(pg, "secure")
    inp.fill(f"{ctx.tls.base_url}/slow?ms=3500")
    nav.click()
    expect(rel).to_have_attribute("data-mode", "stop")
    rel.click()
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)


@_t("CF-06", 1, "X509Inspector", "X.509 DER fields, clipboard copy & partition reset")
def test_cf06(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/page-a", "/page-a")
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)
    expect(_el(pg, "tls-provenance-url")).to_contain_text(f"127.0.0.1:{ctx.tls.port}")
    expect(_el(pg, "tls-cert-subject")).to_contain_text("e2e-primary-tls.local")
    expect(_el(pg, "tls-cert-issuer")).to_contain_text("IWA Sink E2E Fixture")
    expect(_el(pg, "tls-cert-cipher")).to_contain_text("ECDSA P-256")
    for f in ("subject", "issuer", "cipher", "sha256"):
        expect(_el(pg, f"tls-copy-{f}-btn")).to_be_enabled()
    clip_hex = h.normalize_hex(_copy_txt(pg, "tls-copy-sha256-btn"))
    assert clip_hex == ctx.tls.cert_der_sha256_hex
    copy_sha = _el(pg, "tls-copy-sha256-btn")
    _el(pg, "cf-partition-select").select_option("ephemeral")
    expect(copy_sha).not_to_contain_class("is-copied")
    expect(copy_sha).to_be_disabled()


@_t("CF-07", 2, "X509AltVariants", "All 6 ASN.1 X.509 certificate variants parse")
def test_cf07(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    psel = _el(pg, "cf-partition-select")
    vspec = "bmpstring:bmp-leaf.local:s|rsa2048:RSA-2048:c|p384:ECDSA P-384:c|ip_only:127.0.0.1:s|no_cn:nocn-portal.local:s|no_cn_ip_org:Acme Appliance Org:s"
    for idx, item in enumerate(vspec.split("|")):
        var, tok, k = item.split(":")
        psel.select_option("ephemeral" if idx % 2 == 0 else "persist:iwa-workspace")
        with ctx.tls.temporary_alt_certificate(var) as meta:
            _nav_cf(ctx, f"{ctx.tls.base_url}/page-a?alt={var}", f"alt={var}")
            _sec_cert(pg, meta["cert_der_sha256_hex"])
            fid = "tls-cert-subject" if k == "s" else "tls-cert-cipher"
            expect(_el(pg, fid)).to_contain_text(tok)


@_t("CF-08", 2, "HttpAndRedirects", "Cleartext http:// insecure state & 302 redirect")
def test_cf08(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/page-a", "/page-a")
    expect(_el(pg, "tls-copy-sha256-btn")).to_be_enabled()
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "plain.html").write_text("<!doctype html><h1>Plain</h1>", "utf-8")
        with h.StaticDirHttpServer(td) as srv:
            _nav_cf(ctx, f"{srv.base_url}/plain.html", "/plain.html")
            _sec(pg, "insecure")
            expect(_el(pg, "tls-copy-sha256-btn")).to_be_disabled()
    r_url = f"{ctx.tls.base_url}/redirect-302?to=/page-b%3Ffrom_302%3D1"
    _nav_cf(ctx, r_url, "from_302=1")
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)


@_t("CF-09", 5, "SslMitmAndRefused", "Rogue SSL MITM, 1.35s hold & Reload", True)
def test_cf09(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/page-a", "/page-a")
    copy_sha = _el(pg, "tls-copy-sha256-btn")
    _sec(pg, "secure")
    expect(copy_sha).to_be_enabled()
    _nav_cf(ctx, f"{ctx.rogue_tls.base_url}/")
    _sec(pg, "error", 8000)
    expect(copy_sha).to_be_disabled()
    with ctx.tls.temporary_mitm_certificate(ctx.rogue_tls):
        _el(pg, "cf-partition-select").select_option("ephemeral")
        _nav_cf(ctx, f"{ctx.tls.base_url}/page-b")
        _sec(pg, "error", 8000)
        expect(copy_sha).to_be_disabled()
    _el(pg, "cf-reload-btn").click()
    ctx.session.wait_for_cf_ready("/page-b")
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)
    _nav_cf(ctx, f"https://127.0.0.1:{h.get_free_tcp_port()}/")
    _sec(pg, "error", 8000)
    pg.wait_for_timeout(1350)
    _sec(pg, "error")


@_t("CF-10", 3, "SubframeIsolation", "Broken subframes keep top-level cert", True)
def test_cf10(ctx: h.E2EContext) -> None:
    rp, cp = ctx.rogue_tls.port, h.get_free_tcp_port()
    u = f"{ctx.tls.base_url}/subframe-host?rogue_port={rp}&closed_port={cp}"
    pg = _nav_cf(ctx, u, "/subframe-host")
    pg.wait_for_timeout(350)
    _sec_cert(pg, ctx.tls.cert_der_sha256_hex)


@_t("CF-11", 1, "PartitionsClearData", "Partition isolation & clearData() focus keep")
def test_cf11(ctx: h.E2EContext) -> None:
    u_set = f"{ctx.tls.base_url}/storage-probe?set=persist_tok_1"
    pg = _nav_cf(ctx, u_set, "/storage-probe")
    probe_js = "document.getElementById('storage-readout').textContent"
    r1 = ctx.session.eval_in_cf(probe_js)
    assert "LS:persist_tok_1" in r1 and "iwa_probe=persist_tok_1" in r1
    psel = _el(pg, "cf-partition-select")
    psel.select_option("ephemeral")
    _sec(pg, "idle")
    _nav_cf(ctx, f"{ctx.tls.base_url}/storage-probe", "/storage-probe")
    assert ctx.session.eval_in_cf(probe_js) == "LS:|CK:"
    psel.select_option("persist:iwa-workspace")
    _nav_cf(ctx, f"{ctx.tls.base_url}/storage-probe", "/storage-probe")
    assert "LS:persist_tok_1" in ctx.session.eval_in_cf(probe_js)
    clear_btn = _el(pg, "cf-clear-data-btn")
    clear_btn.focus()
    clear_btn.click()
    expect(clear_btn).to_contain_text("Storage Cleared")
    expect(clear_btn).to_be_focused()
    ctx.session.wait_for_cf_ready("/storage-probe")
    assert ctx.session.eval_in_cf(probe_js) == "LS:|CK:"


@_t("CF-12", 3, "InjectJsCss", "Run Script (/dom-clobber, /csp-strict) & CSS", True)
def test_cf12(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/dom-clobber", "/dom-clobber")
    js_in, js_btn, st = _els(pg, "cf-js-input", "cf-inject-js-btn", "cf-inject-status")

    def _js(code: str, state: str, *toks: str) -> None:
        js_in.fill(code)
        js_btn.click()
        expect(st).to_have_attribute("data-state", state)
        for tok in toks:
            expect(st).to_contain_text(tok)

    c1 = "window.WeakSet = undefined; ({ heading: document.title, n: 40 + 2 })"
    _js(c1, "ok", "DOM Clobber Guest", "42")
    _js("throw new Error('guest_boom_99')", "error", "guest_boom_99")
    css = "html, body { background-color: rgb(18, 52, 86) !important; }"
    _el(pg, "cf-css-input").fill(css)
    _el(pg, "cf-inject-css-btn").click()
    expect(st).to_have_attribute("data-state", "ok")
    bg = ctx.session.eval_in_cf("getComputedStyle(document.body).backgroundColor")
    assert bg == "rgb(18, 52, 86)"
    _nav_cf(ctx, f"{ctx.tls.base_url}/csp-strict", "/csp-strict")
    h_js = "document.getElementById('guest-heading').textContent"
    _js(h_js, "ok", "Strict CSP Guest")


@_t("CF-13", 2, "ResizeHandle", "Resize keyboard, dblclick 480px & drag shield cleanup")
def test_cf13(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    handle = _el(pg, "cf-resize-handle")
    expect(handle).to_have_attribute("role", "separator")
    expect(handle).to_have_attribute("aria-valuenow", "480")
    handle.focus()
    for key, val in [("ArrowDown", "504"), ("Home", "240"), ("End", "1600")]:
        pg.keyboard.press(key)
        expect(handle).to_have_attribute("aria-valuenow", val)
    handle.dblclick()
    expect(handle).to_have_attribute("aria-valuenow", "480")
    box = handle.bounding_box()
    assert box is not None
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.mouse.down()
    resizing_js = "() => document.body.classList.contains('is-cf-resizing')"
    assert pg.evaluate(resizing_js)
    pg.evaluate(
        "() => document.querySelector('[data-testid=\"nav-overview\"]').click()"
    )
    expect(_el(pg, "panel-overview")).to_be_visible()
    assert not pg.evaluate(resizing_js)
    pg.mouse.up()


@_t("CF-14", 3, "GuestEventsCrash", "Guest dialog, newwindow & crash", True)
def test_cf14(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/popup-lab", "/popup-lab")
    tb, cb, log = _els(pg, "cf-toggle-console-btn", "cf-clear-log-btn", "cf-event-log")
    expect(tb).to_have_attribute("aria-expanded", "false")
    expect(cb).to_be_hidden()
    tb.click()
    expect(tb).to_have_attribute("aria-expanded", "true")
    expect(cb).to_be_visible()
    expect(log).to_have_attribute("role", "log")
    cm_js = "() => typeof document.querySelector('[data-testid=\"cf-viewport\"]')?.contextMenus?.create === 'function'"
    assert pg.evaluate(cm_js)
    dlg_res = ctx.session.eval_in_cf("(alert('probe_dialog'), 'after_alert')")
    assert dlg_res == "after_alert"
    expect(log).to_contain_text("[dialog]")
    ctx.session.eval_in_cf("document.getElementById('popup-js-link').click() || 'ok'")
    pg.wait_for_timeout(150)
    assert "/popup-lab" in ctx.session.eval_in_cf("location.href")
    ctx.session.eval_in_cf("document.getElementById('popup-valid-link').click() || 1")
    ctx.session.wait_for_cf_ready("from_popup=blank_link")
    ctx.session.crash_cf_guest()
    _sec(pg, "error", 6000)
    expect(_el(pg, "cf-viewport")).to_have_attribute("aria-hidden", "true")
    expect(log).to_contain_text("[exit] Guest process exited")
    expect(_el(pg, "tls-cert-issuer")).to_contain_text("ERR_GUEST_PROCESS")
    _el(pg, "cf-reload-btn").click()
    ctx.session.wait_for_cf_ready("from_popup=blank_link")
    _sec(pg, "secure")


@_t("CF-15", 4, "ProtocolLaunch", "cf://?text=Lucky&color=peachpuff & web+cf://")
def test_cf15(ctx: h.E2EContext) -> None:
    pg = _nav_cf(ctx, f"{ctx.tls.base_url}/page-a", "/page-a")
    ctx.session.activate_workspace("overview")
    inj_q = urllib.parse.quote("cf://?text=Lucky&color=peachpuff", safe="")
    ctx.session.launch_app_url(f"{ctx.session.origin}/?protocol={inj_q}")
    expect(_el(pg, "panel-controlled-frame-tls")).to_be_visible()
    st = _el(pg, "cf-inject-status")
    expect(st).to_have_attribute("data-state", "ok")
    for tok in ("Protocol injector applied", "I'm Feeling Lucky", "color=peachpuff"):
        expect(st).to_contain_text(tok)
    g_js = "({ text: document.documentElement.dataset.cfProtocolText, bg: getComputedStyle(document.body).backgroundColor })"
    assert ctx.session.eval_in_cf(g_js) == {"text": "Lucky", "bg": "rgb(255, 218, 185)"}
    tgt = f"{ctx.tls.base_url}/page-b?msg=hello%20world%26v%3D2#frag"
    wq = urllib.parse.quote(f"web+cf://{tgt}", safe="")
    ctx.session.launch_app_url(f"{ctx.session.origin}/?protocol={wq}")
    ready_u = ctx.session.wait_for_cf_ready("msg=hello%20world%26v%3D2#frag")
    assert ready_u.endswith("/page-b?msg=hello%20world%26v%3D2#frag")


@_t("CF-16", 5, "ProtocolAdversarial", "Hostile cf:// & web+cf:// payloads rejected")
def test_cf16(ctx: h.E2EContext) -> None:
    pg = _ws(ctx)
    _el(pg, "cf-toggle-console-btn").click()
    ctx.session.activate_workspace("overview")
    bads = f"cf://javascript:alert(1) web+cf://https://user:pass@127.0.0.1:{ctx.tls.port}/ cf://https://127.0.0.1:0/ cf://https://127.0.0.1:70000/"
    for raw in bads.split():
        q = urllib.parse.quote(raw, safe="")
        ctx.session.launch_app_url(f"{ctx.session.origin}/?protocol={q}")
        expect(_el(pg, "panel-overview")).to_be_visible()
    _ws(ctx)
    txt = _el(pg, "cf-event-log").text_content() or ""
    assert "[protocol] Rejected protocol" in txt and "Malformed target port" in txt


def build_tests() -> list[h.TestSpec]:
    return list(TESTS)

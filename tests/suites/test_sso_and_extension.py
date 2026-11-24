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

"""SSO Loopback (PKCE S256) & Extension Connectivity Suite (`14` tests)."""

from __future__ import annotations

import contextlib
import http.client
import json
import time
from collections.abc import Iterator
from typing import Any

from playwright.sync_api import Locator, Page, expect

import tests.pw_harness as h

TESTS: list[h.TestSpec] = []
_EXT_ID = "gopkidjpdjfamphfffkhpmmmbmknflmk"
_CLIENT_ID = "iwa-e2e-desktop.apps.googleusercontent.com"


def _t(tid: str, tr: int, feat: str, ttl: str, ce: bool = False) -> Any:
    return h.e2e_test(TESTS, tid, tr, feat, ttl, allow_console_errors=ce)


def _el(pg: Page, test_id: str) -> Locator:
    return pg.get_by_test_id(test_id)


def _els(pg: Page, *ids: str) -> tuple[Locator, ...]:
    return tuple(pg.get_by_test_id(i) for i in ids)


def _ls(pg: Page, key: str) -> Any:
    return pg.evaluate("(k) => localStorage.getItem(k)", key)


def _copy_txt(pg: Page, tid: str) -> str:
    btn = _el(pg, tid)
    btn.click()
    expect(btn).to_contain_class("is-copied")
    return h.read_clipboard_text(pg)


def _open_console(pg: Page, pfx: str, log_id: str) -> tuple[Locator, Locator, Locator]:
    tbtn, cbtn, log = _els(
        pg, f"{pfx}-toggle-console-btn", f"{pfx}-clear-log-btn", log_id
    )
    expect(tbtn).to_have_attribute("aria-expanded", "false")
    expect(cbtn).to_be_hidden()
    tbtn.click()
    expect(tbtn).to_have_attribute("aria-expanded", "true")
    expect(cbtn).to_be_visible()
    return tbtn, cbtn, log


def _prep_sso(ctx: h.E2EContext, userinfo: bool = False, start: bool = False) -> Page:
    pg = ctx.session.page
    ctx.session.activate_workspace("sso-offloading")
    cfg = ctx.oidc.client_config(include_userinfo=userinfo)
    pg.evaluate("(c) => { window.__IWA_TEST_OIDC_CONFIG__ = c; }", cfg)
    _el(pg, "sso-google-client-id").fill(_CLIENT_ID)
    if start:
        _el(pg, "sso-start-login-btn").click()
    return pg


def _ext_ws(ctx: h.E2EContext) -> Page:
    ctx.session.activate_workspace("extension-bridge")
    return ctx.session.page


@contextlib.contextmanager
def _mock_send(pg: Page, js_fn: str) -> Iterator[None]:
    set_js = f"() => {{ const r = window.chrome.runtime; window.__origSM = r.sendMessage; r.sendMessage = {js_fn}; }}"
    clr_js = "() => { if (window.__origSM) { window.chrome.runtime.sendMessage = window.__origSM; delete window.__origSM; } }"
    pg.evaluate(set_js)
    try:
        yield
    finally:
        pg.evaluate(clr_js)


def _raw_http_get(port: int, target: str) -> tuple[int, dict[str, str], str]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3.0)
    try:
        conn.putrequest("GET", target, skip_accept_encoding=True)
        conn.putheader("Host", f"127.0.0.1:{port}")
        conn.putheader("Connection", "close")
        conn.endheaders()
        r = conn.getresponse()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        return int(r.status), hdrs, r.read().decode("utf-8", "replace")
    finally:
        conn.close()


@_t("SSO-01", 2, "SsoValidation", "Client ID validation & memory-only Client Secret")
def test_sso01(ctx: h.E2EContext) -> None:
    pg = ctx.session.page
    pg.evaluate("() => localStorage.setItem('iwa-sink.google.clientSecret', 'leak')")
    pg.reload(wait_until="domcontentloaded")
    _el(pg, "shell-status-bar").wait_for(state="visible")
    assert _ls(pg, "iwa-sink.google.clientSecret") is None
    ctx.session.activate_workspace("sso-offloading")
    h.assert_no_deleted_zombie_dom(pg)
    cid, sec = _els(pg, "sso-google-client-id", "sso-google-client-secret")
    btn, err = _els(pg, "sso-start-login-btn", "sso-error-banner")
    expect(sec).to_have_attribute("type", "password")
    bads = ("", "has spaces.apps.googleusercontent.com", "bad!char", "missing-suffix")
    for bad in bads:
        cid.fill(bad)
        btn.click()
        expect(err).to_be_visible()
        expect(cid).to_have_attribute("aria-invalid", "true")
        expect(cid).to_have_attribute("aria-describedby", "sso-error-banner")
    assert ctx.oidc.snapshot_stats()["authRequestsCount"] == 0
    cid.fill(_CLIENT_ID)
    sec.fill("ram-only-secret")
    assert _ls(pg, "iwa-sink.google.clientId") == _CLIENT_ID
    assert _ls(pg, "iwa-sink.google.clientSecret") is None


@_t("SSO-02", 1, "SsoPkceLogin", "OAuth 2.0 + PKCE S256 login, id_token & copy token")
def test_sso02(ctx: h.E2EContext) -> None:
    pg = _prep_sso(ctx, userinfo=True)
    _el(pg, "sso-google-client-secret").fill("session-ram-secret")
    _el(pg, "sso-start-login-btn").click()
    expect(_el(pg, "sso-sign-out-btn")).to_be_visible(timeout=8000)
    expect(_el(pg, "sso-viewer-status")).to_contain_text("Signed in")
    expect(_el(pg, "sso-viewer-account")).to_contain_text("ada.lovelace@example.org")
    expect(_el(pg, "sso-viewer-subject")).to_contain_text("109876543210987654321")
    tok = _el(pg, "sso-viewer-token").text_content() or ""
    assert "id_token claims decoded" in tok and "verified" not in tok.lower()
    st = ctx.oidc.snapshot_stats()
    ar = st["authRequests"][0]
    assert st["authRequestsCount"] == 1 and st["tokenRequestsCount"] == 1
    assert ar["code_challenge_method"] == "S256" and len(ar["code_challenge"]) >= 43
    assert st["tokenRequests"][0]["hasClientSecret"] is True
    assert _ls(pg, "iwa-sink.google.clientSecret") is None
    clip = _copy_txt(pg, "sso-copy-token-btn")
    assert clip.startswith("iwa_e2e_oidc_") and "…" not in clip


@_t("SSO-03", 3, "SsoHttpProbes", "Pre-callback 405/404/400 & callback nonce-CSP HTML")
def test_sso03(ctx: h.E2EContext) -> None:
    with ctx.oidc.temporary_config(mode="success", pre_callback_probes=("all",)):
        pg = _prep_sso(ctx, start=True)
        expect(_el(pg, "sso-sign-out-btn")).to_be_visible(timeout=8000)
        pr = {p["probe"]: p for p in ctx.oidc.snapshot_stats()["probeResults"]}
        assert pr["post_callback"]["status"] == 405
        assert "GET" in pr["post_callback"]["allowHeader"].upper()
        ks = ("favicon", "robots", "garbage")
        assert [pr[k]["status"] for k in ks] == [404, 404, 400]
        _el(pg, "sso-sign-out-btn").click()
    with ctx.oidc.temporary_config(mode="hold"):
        pg = _prep_sso(ctx, start=True)
        assert ctx.oidc.auth_hit_event.wait(5.0)
        port = ctx.oidc.last_callback_port
        assert _raw_http_get(port, "//evil.example/callback")[0] == 400
        st, hdrs, body = _raw_http_get(port, "/callback?code=a&code=b&state=xyz")
        assert st == 400 and "nonce-" in hdrs.get("content-security-policy", "")
        assert hdrs.get("x-content-type-options") == "nosniff"
        assert hdrs.get("referrer-policy") == "no-referrer"
        assert 'name="viewport"' in body and "prefers-color-scheme: light" in body
        expect(_el(pg, "sso-error-banner")).to_be_visible()
    ctx.session.close_auxiliary_pages()


@_t("SSO-04", 2, "SsoStateMismatch", "CSRF state mismatch rejected with 0 /token calls")
def test_sso04(ctx: h.E2EContext) -> None:
    with ctx.oidc.temporary_config(mode="tampered_state"):
        pg = _prep_sso(ctx, start=True)
        err = _el(pg, "sso-error-banner")
        expect(err).to_be_visible(timeout=8000)
        assert "state" in (err.text_content() or "").lower()
        expect(_el(pg, "sso-sign-out-btn")).to_be_hidden()
        assert ctx.oidc.snapshot_stats()["tokenRequestsCount"] == 0


@_t("SSO-05", 2, "SsoIdpErrors", "IdP access_denied & /token HTTP 500", True)
def test_sso05(ctx: h.E2EContext) -> None:
    desc = "Denied_" + ("x" * 213)
    with ctx.oidc.temporary_config(mode="access_denied", error_description=desc):
        pg = _prep_sso(ctx, start=True)
        expect(_el(pg, "sso-error-banner")).to_be_visible(timeout=8000)
        assert ctx.oidc.snapshot_stats()["tokenRequestsCount"] == 0
        ov_js = "() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)"
        assert pg.evaluate(ov_js) == 0
    ctx.session.close_auxiliary_pages()
    ctx.oidc.reset()
    with ctx.oidc.temporary_config(mode="token_http_500"):
        pg = _prep_sso(ctx, start=True)
        expect(_el(pg, "sso-error-banner")).to_be_visible(timeout=8000)
        assert _ls(pg, "iwa-sink.sso.lastAccount") is None


@_t("SSO-06", 2, "SsoCancelPort", "In-flight Cancel closes port & Attempt #2 succeeds")
def test_sso06(ctx: h.E2EContext) -> None:
    with ctx.oidc.temporary_config(mode="hold"):
        pg = _prep_sso(ctx, start=True)
        assert ctx.oidc.auth_hit_event.wait(5.0)
        port = ctx.oidc.last_callback_port
        assert h.is_loopback_tcp_listening(port)
        cbtn = _el(pg, "sso-cancel-login-btn")
        expect(cbtn).to_be_visible()
        cbtn.click()
        expect(cbtn).to_be_hidden()
        dl = time.monotonic() + 3.0
        while time.monotonic() < dl and h.is_loopback_tcp_listening(port):
            pg.wait_for_timeout(50)
        assert not h.is_loopback_tcp_listening(port)
    ctx.session.close_auxiliary_pages()
    pg = _prep_sso(ctx, start=True)
    expect(_el(pg, "sso-sign-out-btn")).to_be_visible(timeout=8000)


@_t("SSO-07", 1, "SsoExpiryCopySignOut", "Expiry countdown, copy keep & Sign Out")
def test_sso07(ctx: h.E2EContext) -> None:
    with ctx.oidc.temporary_config(mode="success", expires_in=3):
        pg = _prep_sso(ctx, start=True)
        expect(_el(pg, "sso-sign-out-btn")).to_be_visible(timeout=8000)
        pg.wait_for_timeout(650)
        cp, exp = _els(pg, "sso-copy-expiry-btn", "sso-viewer-expiry")
        prev = exp.text_content() or ""
        cp.click()
        expect(cp).to_contain_class("is-copied")
        tick_js = "(p) => document.querySelector('[data-testid=\"sso-viewer-expiry\"]')?.textContent !== p"
        pg.wait_for_function(tick_js, arg=prev, timeout=2000)
        expect(cp).to_contain_class("is-copied")
        expect(exp).to_contain_text("Expired (0s remaining)", timeout=5000)
    assert _ls(pg, "iwa-sink.sso.lastAccount") is not None
    _el(pg, "sso-sign-out-btn").click()
    expect(_el(pg, "sso-sign-out-btn")).to_be_hidden()
    expect(_el(pg, "sso-copy-token-btn")).to_be_disabled()
    assert _ls(pg, "iwa-sink.sso.lastAccount") is None


@_t("SSO-08", 1, "SsoConsoleAria", "Collapsible Loopback Console ARIA & Clear button")
def test_sso08(ctx: h.E2EContext) -> None:
    pg = _prep_sso(ctx, start=True)
    expect(_el(pg, "sso-sign-out-btn")).to_be_visible(timeout=8000)
    tbtn, cbtn, log = _open_console(pg, "sso", "sso-event-log")
    expect(log).to_have_attribute("role", "log")
    assert (log.text_content() or "").strip() != ""
    cbtn.click()
    assert (log.text_content() or "").strip() == ""
    expect(tbtn).to_have_attribute("aria-expanded", "true")


@_t("EXT-01", 1, "ExtProfileVersion", "Extension getProfileUserInfo & 'version' echo")
def test_ext01(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    expect(_el(pg, "ext-id-input")).to_have_value(_EXT_ID)
    def_msg = '{"api":"chrome.identity.getProfileUserInfo"}'
    expect(_el(pg, "ext-message-input")).to_have_value(def_msg)
    _el(pg, "ext-send-btn").click()
    expect(_el(pg, "ext-response-status")).to_have_text("Received")
    r = json.loads(_el(pg, "ext-response-json").text_content() or "{}")
    assert r["apiName"] == "chrome.identity.getProfileUserInfo"
    assert r["status"] == "OK" and isinstance(r["output"], dict)
    _el(pg, "ext-message-input").fill('"version"')
    _el(pg, "ext-send-btn").click()
    expect(_el(pg, "ext-response-json")).to_contain_text('"version"')
    vr = json.loads(_el(pg, "ext-response-json").text_content() or "{}")
    assert vr["status"] == "OK" and "version" in vr
    assert json.loads(_copy_txt(pg, "ext-copy-response-btn"))["status"] == "OK"


@_t("EXT-02", 1, "ExtCustomEcho", "Custom JSON echo, null, '__proto__' & Error status")
def test_ext02(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    msg, send, pre = _els(pg, "ext-message-input", "ext-send-btn", "ext-response-json")
    msg.fill('{"items":[1,true,null],"__proto__":{"safeKey":7}}')
    send.click()
    expect(_el(pg, "ext-response-status")).to_have_text("Received")
    raw = pre.text_content() or ""
    p = json.loads(raw)
    assert '"__proto__"' in raw and p["echoed"]["items"] == [1, True, None]
    assert str(p["senderOrigin"]).startswith("isolated-app://")
    assert p["extensionId"] == _EXT_ID
    msg.fill("null")
    send.click()
    expect(pre).to_contain_text('"echoed": null')
    msg.fill('{"api":"chrome.identity.getProfileUserInfo","accountStatus":"INVALID"}')
    send.click()
    expect(_el(pg, "ext-response-status")).to_have_text("Extension Error")
    expect(_el(pg, "ext-error-banner")).to_be_visible()


@_t("EXT-03", 2, "ExtValidation", "Extension ID /^[a-p]{32}$/ & malformed JSON error")
def test_ext03(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    id_in, msg = _els(pg, "ext-id-input", "ext-message-input")
    send, err = _els(pg, "ext-send-btn", "ext-error-banner")
    for bad_id in ["", "shortid", "q" * 32, "1" * 32]:
        id_in.fill(bad_id)
        send.click()
        expect(err).to_be_visible()
        assert "32" in (err.text_content() or "")
    id_in.fill(_EXT_ID)
    for bad_json in ["", "{unterminated", "[1, 2,]"]:
        msg.fill(bad_json)
        send.click()
        expect(err).to_be_visible()
        assert "json" in (err.text_content() or "").lower()


@_t("EXT-04", 2, "ExtUnreachableHint", "Unreachable ID & UNPACKED_SETUP_HINT")
def test_ext04(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    id_in, send, err = _els(pg, "ext-id-input", "ext-send-btn", "ext-error-banner")
    id_in.fill("b" * 32)
    _el(pg, "ext-message-input").fill('"version"')
    send.click()
    expect(_el(pg, "ext-response-status")).to_have_text("Extension Unreachable")
    expect(err).to_be_visible()
    assert ("b" * 32) in (err.text_content() or "")
    id_in.fill(_EXT_ID)
    unreach_fn = "(_i, _m, cb) => { const r = window.chrome.runtime; Object.defineProperty(r, 'lastError', { value: { message: 'Receiving end does not exist.' }, configurable: true }); try { cb(undefined); } finally { delete r.lastError; } }"
    with _mock_send(pg, unreach_fn):
        send.click()
        expect(_el(pg, "ext-response-status")).to_have_text("Extension Unreachable")
        hint = "Load unpacked extension/IwaKitchenSinkExtension via chrome://extensions"
        expect(err).to_contain_text(hint)
        expect(_el(pg, "ext-response-json")).to_contain_text("setupHint")


@_t("EXT-05", 5, "ExtLargePayload", "40,000-item JSON response formats in < 500ms")
def test_ext05(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    big_fn = "(_i, _m, cb) => cb({ status: 'OK', items: Array.from({ length: 40000 }, (_, i) => i) })"
    with _mock_send(pg, big_fn):
        t0 = time.monotonic()
        _el(pg, "ext-send-btn").click()
        expect(_el(pg, "ext-response-status")).to_have_text("Received")
        assert (time.monotonic() - t0) < 0.5


@_t("EXT-06", 1, "ExtConsoleCopy", "Enter submit, input copy & Extension Console ARIA")
def test_ext06(ctx: h.E2EContext) -> None:
    pg = _ext_ws(ctx)
    assert _copy_txt(pg, "ext-copy-id-btn") == _EXT_ID
    msg = _el(pg, "ext-message-input")
    msg.fill('"version"')
    msg.press("Enter")
    expect(_el(pg, "ext-response-status")).to_have_text("Received")
    _, cbtn, log = _open_console(pg, "ext", "ext-console-log")
    for tok in ("[tx ->", "[rx <-"):
        expect(log).to_contain_text(tok)
    cbtn.click()
    assert (log.text_content() or "").strip() == ""


def build_tests() -> list[h.TestSpec]:
    return list(TESTS)

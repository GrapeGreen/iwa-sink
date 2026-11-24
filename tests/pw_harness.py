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

"""Playwright `connect_over_cdp` + FD 3/4 `CdpPipe` E2E harness for `isolated-app://`."""

from __future__ import annotations

import argparse
import base64
import contextlib
import glob
import hashlib
import http.server
import importlib.util
import json
import os
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Self

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

_QUIET: dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


def ensure_playwright_python() -> None:
    if importlib.util.find_spec("playwright") is not None:
        return
    if os.environ.get("_IWA_PW_REEXEC") != "1":
        pat = "~/.gemini/jetski/brain/*/scratch/pw_probe/.venv/bin/python3"
        cands = [os.environ.get("IWA_PYTHON", ""), f"{REPO_ROOT}/.venv/bin/python3"]
        cands.extend(sorted(glob.glob(os.path.expanduser(pat))))
        ok = lambda p: bool(p and os.path.isfile(p) and os.access(p, os.X_OK))
        for c in filter(ok, cands):
            chk = [c, "-c", "import playwright, cryptography"]
            if subprocess.run(chk, capture_output=True, check=False).returncode == 0:
                os.environ.update(_IWA_PW_REEXEC="1", PYTHONDONTWRITEBYTECODE="1")
                os.execv(c, [c, "-B", *sys.argv])
    raise RuntimeError("Missing playwright; pip install -r tests/requirements.txt")


if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, Page, Playwright

from tests.fixtures.oidc_test_server import OidcTestServer
from tests.fixtures.tls_test_server import TlsTestServer

DEFAULT_CHROME_BINARY = os.environ.get("IWA_CHROME_BINARY", "/opt/google/chrome/chrome")
_RF1 = ("IsolatedWebApps", "IsolatedWebAppDevMode", "DirectSockets", "ControlledFrame")
_RF2 = ("SubApps", "UnframedIwa", "DesktopPWAsAdditionalWindowingControls")
REQUIRED_CHROME_FEATURES = (*_RF1, *_RF2)
_IP1 = ("local-network-access", "local-network", "loopback-network", "direct-sockets")
_IP2 = ("window-management", "web-app-installation", "clipboard-read")
IWA_PERMISSIONS = (*_IP1, *_IP2, "clipboard-sanitized-write")
_LW1 = ("overview", "tcp-terminal", "controlled-frame-tls", "sso-offloading")
LINUX_WORKSPACE_IDS = (*_LW1, "sub-apps", "windowing-hud", "extension-bridge")
CROS_WORKSPACE_IDS = (*LINUX_WORKSPACE_IDS[:-1], "screen-capture", "extension-bridge")
_BF1 = ("--no-first-run", "--no-default-browser-check", "--password-store=basic")
_BF2 = ("--no-proxy-server", "--ozone-platform=x11", "--no-sandbox")
_BF3 = ("--window-size=1600,1000", "--disable-dev-shm-usage", "--remote-debugging-pipe")
_BF4 = ("--remote-allow-origins=*", "--enable-unsafe-extension-debugging")
_BF5 = ("--auto-select-screen-capture-source", "--disable-in-process-stack-traces")
_BASE_CHROME_FLAGS = (*_BF1, *_BF2, *_BF3, *_BF4, *_BF5)
_CF1 = ("--use-gl=angle", "--use-angle=swiftshader", "--login-profile=user")
_CF2 = ("--login-user=stub-user@example.com", "--disable-breakpad")
_CF3 = ("--ash-host-window-bounds=0+0-1280x800,1280+0-1024x768",)
_CF4 = ("--auto-select-desktop-capture-source=Display",)
_CROS_CHROME_FLAGS = (*_CF1, *_CF2, *_CF3, *_CF4)
_EXT_BG_RE = re.compile(r"^chrome-extension://([a-p]{32})/scripts/background\.js$")


class SkipTestCase(Exception):
    pass


@dataclass(frozen=True)
class TestSpec:
    test_id: str
    tier: int
    feature: str
    title: str
    fn: Callable[[E2EContext], None]
    requires_swbn: bool = False
    allow_console_errors: bool = False


_GLOBAL_REGISTRY: list[TestSpec] = []


def e2e_test(*a: Any, **kw: Any) -> Any:
    is_l = isinstance(a[0], list)
    reg, (tid, tr, feat, *rest) = (a[0], a[1:]) if is_l else (_GLOBAL_REGISTRY, a)
    ttl = str(rest[0] if rest else kw.get("title", ""))
    swbn, ace = bool(kw.get("requires_swbn")), bool(kw.get("allow_console_errors"))

    def _dec(fn: Callable[[E2EContext], None]) -> Callable[[E2EContext], None]:
        reg.append(sp := TestSpec(str(tid), int(tr), str(feat), ttl, fn, swbn, ace))
        fn.__test_spec__ = sp  # type: ignore[attr-defined]
        return fn

    return _dec


def get_free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_until(pred: Any, timeout: float = 6.0, step: float = 0.1) -> Any:
    dl = time.time() + timeout
    while time.time() < dl:
        if val := pred():
            return val
        time.sleep(step)
    return None


def get_workspace_ids(ctx_or_session: Any = None) -> tuple[str, ...]:
    if ctx_or_session is None:
        return LINUX_WORKSPACE_IDS
    sess = getattr(ctx_or_session, "session", ctx_or_session)
    return CROS_WORKSPACE_IDS if sess.is_cros else LINUX_WORKSPACE_IDS


def _is_chromeos_binary(chrome_binary: str) -> bool:
    real = os.path.realpath(chrome_binary)
    bdir = os.path.dirname(real)
    paks = ("keyboard_resources.pak", "ash_test_strings.pak")
    return "chromeos" in (chrome_binary + real).lower() or any(
        os.path.isfile(os.path.join(bdir, f)) for f in paks
    )


def _stop_proc(proc: subprocess.Popen[bytes] | None, timeout: float = 2.5) -> None:
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()


class CdpPipe:
    def __init__(self, c2b_w: int, b2c_r: int):
        self._w, self._r, self._seq, self._buf = c2b_w, b2c_r, 0, b""
        self._lock = threading.Lock()

    def send_only(self, method: str, params: Any = None, session_id: str = "") -> int:
        with self._lock:
            self._seq += 1
            p = params or {}
            msg: dict[str, Any] = {"id": self._seq, "method": method, "params": p}
            if session_id:
                msg["sessionId"] = session_id
            os.write(self._w, json.dumps(msg).encode("utf-8") + b"\x00")
            return self._seq

    def call(self, method: str, params: Any = None, **kw: Any) -> dict[str, Any]:
        sid = str(kw.get("session_id") or "")
        req_id = self.send_only(method, params, sid)
        dl = time.time() + float(kw.get("timeout", 20.0))
        while time.time() < dl:
            while b"\x00" in self._buf:
                raw, self._buf = self._buf.split(b"\x00", 1)
                dec = raw.decode("utf-8", "replace")
                if raw and (p := json.loads(dec)).get("id") == req_id:
                    return p
            if select.select([self._r], [], [], 0.1)[0]:
                if not (chunk := os.read(self._r, 65536)):
                    raise RuntimeError(f"CDP pipe closed during {method}")
                self._buf += chunk
        raise TimeoutError(f"CDP pipe timeout during {method}")

    def close(self) -> None:
        for fd in (self._w, self._r):
            with contextlib.suppress(OSError):
                os.close(fd)


class XvfbOpenboxEnv:
    def __init__(self, screen_spec: str = "1920x1080x24"):
        self.screen_spec, self.display_num, self.display = screen_spec, 0, ""
        self.xdg_dir: str | None = None
        self.xvfb_proc: subprocess.Popen[bytes] | None = None
        self.openbox_proc: subprocess.Popen[bytes] | None = None

    def start(self, timeout: float = 6.0) -> str:
        if self.xvfb_proc is not None:
            return self.display
        tr = tempfile.gettempdir()
        lck = lambda c: (f"{tr}/.X{c}-lock", f"{tr}/.X11-unix/X{c}")
        free = (c for c in range(105, 245) if not any(map(os.path.exists, lck(c))))
        if not (dnum := next(free, 0)):
            raise RuntimeError("No free Xvfb display in :105..:244")
        self.display_num, self.display = dnum, f":{dnum}"
        self.xdg_dir = tempfile.mkdtemp(prefix=f"iwa_xdg_{dnum}_")
        xvfb = shutil.which("Xvfb") or "/usr/bin/Xvfb"
        cmd = [xvfb, self.display, "-screen", "0", self.screen_spec, "-nolisten", "tcp"]
        self.xvfb_proc = subprocess.Popen([*cmd, "-ac"], **_QUIET)
        sock = f"{tr}/.X11-unix/X{dnum}"
        if not _wait_until(lambda: os.path.exists(sock), timeout=timeout, step=0.05):
            raise RuntimeError("Xvfb failed to start")
        if ob_bin := shutil.which("openbox"):
            wm_env = {**os.environ, "DISPLAY": self.display}
            for k, sub in (("CONFIG", "c"), ("CACHE", "ca"), ("DATA", "d")):
                os.makedirs(p := os.path.join(self.xdg_dir, sub), exist_ok=True)
                wm_env[f"XDG_{k}_HOME"] = p
            self.openbox_proc = subprocess.Popen([ob_bin], env=wm_env, **_QUIET)
            time.sleep(0.15)
        return self.display

    def stop(self) -> None:
        _stop_proc(self.openbox_proc)
        _stop_proc(self.xvfb_proc)
        self.openbox_proc = self.xvfb_proc = None
        if self.xdg_dir:
            shutil.rmtree(self.xdg_dir, ignore_errors=True)
            self.xdg_dir = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


class StaticDirHttpServer:
    def __init__(self, directory: str, host: str = "127.0.0.1", port: int = 0):
        self.directory, self.host, self.port = os.path.abspath(directory), host, port
        self._httpd: http.server.ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def start(self) -> str:
        if self._httpd is not None:
            return self.base_url
        rdir = self.directory

        class _H(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a: Any, **kw: Any) -> None:
                super().__init__(*a, directory=rdir, **kw)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self._httpd = http.server.ThreadingHTTPServer((self.host, self.port), _H)
        self.port = int(self._httpd.server_address[1])
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self.base_url

    def stop(self) -> None:
        if self._httpd is not None:
            with contextlib.suppress(Exception):
                self._httpd.shutdown()
                self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


def find_node_binary() -> str:
    if found := shutil.which("node"):
        return found
    nvm = os.path.expanduser("~/.nvm/versions/node")
    if os.path.isdir(nvm):
        for ver in sorted(os.listdir(nvm), reverse=True):
            if os.access(cand := os.path.join(nvm, ver, "bin", "node"), os.X_OK):
                return cand
    raise RuntimeError("Could not locate `node` binary")


def build_node_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env, p0 = os.environ.copy(), os.path.dirname(find_node_binary())
    parts = [p0, *([env["PATH"]] if env.get("PATH") else [])]
    npx = os.path.expanduser("~/.npm/_npx")
    if not shutil.which("pnpm", path=":".join(parts)) and os.path.isdir(npx):
        for e in sorted(os.listdir(npx)):
            if os.path.isfile(f"{(bdir := f'{npx}/{e}/node_modules/.bin')}/pnpm"):
                parts.insert(1, bdir)
                break
    env.update(PATH=":".join(parts), COREPACK_ENABLE_DOWNLOAD_PROMPT="0", CI="true")
    return {**env, **(extra or {})}


def find_pnpm_command(repo_root: str = REPO_ROOT) -> list[str]:
    path = build_node_env()["PATH"]
    if pnpm_bin := shutil.which("pnpm", path=path):
        return [pnpm_bin]
    if cp_bin := shutil.which("corepack", path=path):
        return [cp_bin, "pnpm@9.5.0"]
    raise RuntimeError("Could not locate `pnpm` or `corepack`")


class ViteDevServerManager:
    def __init__(self, repo_root: str = REPO_ROOT, external_url: str | None = None):
        self.repo_root, self.external_url = repo_root, external_url
        self.port, self.base_url, self.proc = 0, "", None

    def start(self, timeout: float = 20.0) -> str:
        if self.external_url:
            self.base_url = self.external_url.rstrip("/") + "/"
            if http_get(f"{self.base_url}.well-known/manifest.webmanifest")[0] != 200:
                raise RuntimeError(f"External Vite URL {self.base_url} not ready")
            return self.base_url
        if self.proc is not None:
            return self.base_url
        self.port = get_free_tcp_port()
        self.base_url = f"http://127.0.0.1:{self.port}/"
        vjs, env = (
            os.path.join(self.repo_root, "node_modules/vite/bin/vite.js"),
            build_node_env(),
        )
        args = ("--host", "127.0.0.1", "--port", str(self.port), "--strictPort")
        self.proc = subprocess.Popen(
            [find_node_binary(), vjs, *args], cwd=self.repo_root, env=env, **_QUIET
        )
        man_u = f"{self.base_url}.well-known/manifest.webmanifest"

        def _ready() -> bool:
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(f"Vite exited ({self.proc.returncode})")
            with contextlib.suppress(Exception):
                return http_get(man_u, timeout=0.6)[0] == 200
            return False

        if not _wait_until(_ready, timeout=timeout, step=0.1):
            raise TimeoutError(f"Vite did not become ready at {self.base_url}")
        return self.base_url

    def stop(self) -> None:
        _stop_proc(self.proc, timeout=3.0)
        self.proc = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


_HUD_PROBE_JS = """(() => { const b = document.querySelector('[data-testid="hud-display-mode"]'); if (!b || !(b.textContent || '').trim()) return null; const tb = document.querySelector('[data-testid="hud-drag-region"], .hud-titlebar'), cs = tb ? getComputedStyle(tb) : null; return { unframed: matchMedia('(display-mode: unframed)').matches, standalone: matchMedia('(display-mode: standalone)').matches, url: location.href, badgeText: (b.textContent || '').trim(), appRegion: cs ? (cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || '').trim() : '' }; })()"""

_RESET_APP_JS = """(async () => { const q = (tid) => document.querySelector(`[data-testid="${tid}"]`), setVal = (el, val) => { if (!el) return; const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, d = Object.getOwnPropertyDescriptor(p, 'value'); if (d && d.set) d.set.call(el, val); else el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; if (document.documentElement.getAttribute('data-theme') === 'light') q('theme-toggle-btn')?.click(); const disc = q('tcp-disconnect-btn'), stop = q('echo-stop-btn'); if (disc && !disc.disabled) disc.click(); if (stop && !stop.disabled) stop.click(); for (const dl = Date.now() + 700; Date.now() < dl && ((disc && !disc.disabled) || (stop && !stop.disabled)); ) await new Promise((r) => setTimeout(r, 25)); if (q('tcp-server-family-ipv4')?.getAttribute('aria-checked') === 'false' && !q('tcp-server-family-ipv4').disabled) q('tcp-server-family-ipv4').click(); setVal(q('echo-port-input'), '43821'); setVal(q('tcp-host-input'), '127.0.0.1'); setVal(q('tcp-port-input'), '43821'); setVal(q('tcp-payload-input'), ''); try { delete window.__IWA_TEST_OIDC_CONFIG__; } catch {}
  for (const tid of ['sso-cancel-login-btn', 'sso-sign-out-btn', 'screen-stop-all-btn', 'win-close-hud-btn']) { const b = q(tid); if (b && !b.disabled && !b.hidden) b.click(); } for (const k of ['iwa-sink.sso.lastAccount', 'iwa-sink.google.clientId', 'iwa-sink.google.clientSecret', 'iwa-sink.ext.lastResponse', 'iwa-sink:dynamic-subapps-v1']) { try { localStorage.removeItem(k); } catch {} } setVal(q('sso-google-client-id'), ''); setVal(q('sso-google-client-secret'), ''); setVal(q('ext-id-input'), 'gopkidjpdjfamphfffkhpmmmbmknflmk'); setVal(q('ext-message-input'), '{"api":"chrome.identity.getProfileUserInfo"}'); if (q('win-resizable-toggle')?.getAttribute('aria-checked') === 'false') q('win-resizable-toggle').click(); if (q('win-tab-controls')?.getAttribute('aria-selected') === 'false') q('win-tab-controls').click(); const cf = q('cf-viewport'), cfUrl = q('cf-url-input'), defUrl = cfUrl?.defaultValue || 'https://www.google.com', cfDirty = Boolean((cf && String(cf.src || cf.getAttribute('src') || '').trim()) || (q('cf-security-indicator')?.getAttribute('data-security-state') !== 'idle')); if (cfDirty && cf && typeof cf.clearData === 'function') { try { await Promise.race([cf.clearData({ since: 0 }, { cache: true, cookies: true, indexedDB: true, localStorage: true, persistentCookies: true, sessionCookies: true }), new Promise((r) => setTimeout(r, 800))]); } catch {} }
  const ps = q('cf-partition-select'), sel = ps instanceof HTMLSelectElement ? ps : ps?.querySelector('select'); if (sel instanceof HTMLSelectElement) { if (sel.value !== 'persist:iwa-workspace') setVal(sel, 'persist:iwa-workspace'); else if (cfDirty) { setVal(sel, 'ephemeral'); setVal(sel, 'persist:iwa-workspace'); } } if (cfUrl && cfUrl.value !== defUrl) setVal(cfUrl, defUrl); for (const tid of ['cf-js-input', 'cf-css-input']) { const ta = q(tid); if (ta?.defaultValue && ta.value !== ta.defaultValue) setVal(ta, ta.defaultValue); } if (q('cf-resize-handle') && q('cf-resize-handle').getAttribute('aria-valuenow') !== '480') q('cf-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); for (const tid of ['cf-toggle-cert-btn', 'cf-toggle-inject-btn']) { if (q(tid)?.getAttribute('aria-expanded') === 'false') q(tid).click(); } const api = window.subApps || navigator.subApps; if (api && typeof api.list === 'function' && typeof api.remove === 'function') { try { const l = await api.list(), ids = Array.isArray(l) ? l.map((x) => typeof x === 'string' ? x : (x?.installURL || x?.install_url || x?.id)).filter(Boolean) : l instanceof Map ? Array.from(l.keys()).map(String) : Object.keys(l || {}); if (ids.length) await api.remove(ids); } catch {} } try { await fetch('/__dev_dynamic_subapps?action=clear', { cache: 'no-store' }); } catch {} document.querySelectorAll('[data-testid="dyn-subapp-field-remove-btn"]').forEach((b) => b.click()); if (q('subapps-tab-bundled')?.getAttribute('aria-selected') === 'false') q('subapps-tab-bundled').click(); for (const tid of ['tcp-clear-btn', 'tcp-server-clear-btn', 'cf-clear-log-btn', 'sso-clear-log-btn', 'subapps-clear-log-btn', 'win-clear-log-btn', 'screen-clear-log-btn', 'ext-clear-log-btn']) q(tid)?.click(); for (const tid of ['cf-toggle-console-btn', 'sso-toggle-console-btn', 'subapps-toggle-console-btn', 'win-toggle-console-btn', 'screen-toggle-console-btn', 'ext-toggle-console-btn']) { if (q(tid)?.getAttribute('aria-expanded') === 'true') q(tid).click(); } if (q('sidebar-collapse-btn')?.getAttribute('aria-expanded') === 'false') q('sidebar-collapse-btn').click(); if (!q('panel-overview')?.classList.contains('is-active')) q('nav-overview')?.click(); window.scrollTo(0, 0); })()"""


class PlaywrightIwaSession:
    def __init__(
        self,
        pw: Playwright,
        xvfb_display: str,
        chrome_binary: str = DEFAULT_CHROME_BINARY,
        **kw: Any,
    ):
        self._pw, self.xvfb_display = pw, xvfb_display
        self.chrome_binary = chrome_binary
        self.is_cros = _is_chromeos_binary(chrome_binary)
        self.vite_url, self.swbn_path = (
            str(kw.get("vite_url", "")),
            str(kw.get("swbn_path", "")),
        )
        self.spki_hashes = list(kw.get("spki_hashes") or ())
        self.extra_features = list(kw.get("extra_features") or ())
        tag = "cros" if self.is_cros else "linux"
        self.user_data_dir = tempfile.mkdtemp(prefix=f"iwa_pw_{tag}_")
        self.cdp_port, self.proc = get_free_tcp_port(), None
        self.pipe: CdpPipe = None  # type: ignore[assignment]
        self.browser: Browser = None  # type: ignore[assignment]
        self.browser_cdp: Any = None
        self.context: BrowserContext = None  # type: ignore[assignment]
        self.page: Page = None  # type: ignore[assignment]
        self.bundle_id = self.origin = self.companion_extension_id = ""
        self.browser_context_id = ""
        self.cros_unframed_verified: dict[str, Any] | None = None
        self._diagnostics: list[tuple[int, str, str]] = []
        self._diag_seq, self._wired_pages = 0, set()

    def _pipe_targets(self) -> list[dict[str, Any]]:
        res = self.pipe.call("Target.getTargets").get("result") or {}
        return list(res.get("targetInfos", []))

    def _find_target(self, pred: Any, timeout: float) -> dict[str, Any] | None:
        hit = lambda: next((t for t in self._pipe_targets() if pred(t)), None)
        return _wait_until(hit, timeout)

    def _pipe_attach(self, target_id: str) -> str:
        p = {"targetId": target_id, "flatten": True}
        return str(
            (self.pipe.call("Target.attachToTarget", p).get("result") or {}).get(
                "sessionId"
            )
            or ""
        )

    def _pipe_eval(self, sid: str, expr: str, gesture: bool = False) -> Any:
        p = {"expression": expr, "returnByValue": True, "userGesture": gesture}
        r = self.pipe.call("Runtime.evaluate", p, session_id=sid)
        return ((r.get("result") or {}).get("result") or {}).get("value")

    def _record_diag(self, category: str, text: str) -> None:
        low = text.lower()
        if "permissions policy violation: camera is not allowed" in low:
            return
        if any(k in low for k in ("trustedtype", "trustedhtml", "trustedscript")):
            category = "trusted_types"
        elif "content security policy" in low:
            category = "csp"
        self._diag_seq += 1
        self._diagnostics.append((self._diag_seq, category, text[:1000]))

    def _wire_page_diagnostics(self, pg: Page) -> None:
        if id(pg) in self._wired_pages:
            return
        self._wired_pages.add(id(pg))
        iwa = lambda: pg.url.startswith("isolated-app://")
        pg.on(
            "pageerror",
            lambda e: self._record_diag("uncaught", str(e)) if iwa() else None,
        )

        def on_con(m: Any) -> None:
            if m.type == "error" and iwa():
                self._record_diag("console_error", m.text)

        pg.on("console", on_con)
        with contextlib.suppress(Exception):
            cdp = self.context.new_cdp_session(pg)
            cdp.send("Log.enable")
            on_l = lambda ev: self._on_cdp_log_entry(pg.url, ev.get("entry") or {})
            cdp.on("Log.entryAdded", on_l)

    def _on_cdp_log_entry(self, page_url: str, entry: dict[str, Any]) -> None:
        if page_url.startswith("isolated-app://") and entry.get("level") == "error":
            src = str(entry.get("source") or "")
            txt = f"[{src}] {entry.get('text', '')} ({entry.get('url', '')})".strip()
            ul, skip = (
                "unchecked runtime.lasterror" in txt.lower(),
                ("network", "favicon", "rendering", "other"),
            )
            if src == "security" or ul or src not in skip:
                self._record_diag("console_error", txt)

    def watermark(self) -> int:
        return self._diag_seq

    def assert_clean_diagnostics(
        self, allow_console_errors: bool = False, since_watermark: int | None = None
    ) -> None:
        wm = 0 if since_watermark is None else since_watermark
        cats = {"uncaught", "csp", "trusted_types"}
        if not allow_console_errors:
            cats.add("console_error")
        hits = [f"[{c}] {m}" for s, c, m in self._diagnostics if s > wm and c in cats]
        assert not hits, f"IWA runtime diagnostics errors: {hits}"

    def _grant_permissions(self, origin_with_slash: str, bcid: str = "") -> None:
        send = self.browser_cdp.send if self.browser_cdp is not None else self.pipe.call
        base: dict[str, Any] = {"setting": "granted", "origin": origin_with_slash}
        if bcid:
            base["browserContextId"] = bcid
        for perm in IWA_PERMISSIONS:
            with contextlib.suppress(Exception):
                send("Browser.setPermission", {"permission": {"name": perm}, **base})

    def _verify_cros_unframed_over_pipe(self, manifest_id: str) -> None:
        self.pipe.call("PWA.launch", {"manifestId": manifest_id})

        def is_app(t: dict[str, Any]) -> bool:
            return str(t.get("url", "")).startswith(self.origin) and t.get("type") in (
                "page",
                "app",
            )

        if not (main_t := self._find_target(is_app, 5.0)):
            return
        if main_t.get("browserContextId") and not self.browser_context_id:
            self.browser_context_id = str(main_t["browserContextId"])
            self._grant_permissions(manifest_id, self.browser_context_id)
        sid = self._pipe_attach(main_t["targetId"])
        bar_js = "Boolean(document.querySelector('[data-testid=\"shell-status-bar\"]'))"
        _wait_until(lambda: self._pipe_eval(sid, bar_js) is True, timeout=8.0)
        open_js = "Boolean(window.open('/hud.html?compact=1#live', 'iwa_sink_unframed_hud', 'popup=yes,width=440,height=300'))"
        self._pipe_eval(sid, open_js, gesture=True)
        if hud_t := self._find_target(
            lambda t: "/hud.html" in str(t.get("url", "")), 4.0
        ):
            hsid = self._pipe_attach(hud_t["targetId"])

            def chk() -> Any:
                v = self._pipe_eval(hsid, _HUD_PROBE_JS)
                return v if isinstance(v, dict) and v.get("unframed") is True else None

            self.cros_unframed_verified = _wait_until(chk, timeout=4.0)
            self.pipe.call("Target.closeTarget", {"targetId": hud_t["targetId"]})
        self.pipe.call("Target.closeTarget", {"targetId": main_t["targetId"]})
        _wait_until(lambda: not any(map(is_app, self._pipe_targets())), timeout=3.0)

    def start(self) -> PlaywrightIwaSession:
        if self.proc is not None:
            return self
        prefs: dict[str, Any] = {"profile": {"content_settings": {"pref_version": 1}}}
        prefs["profile"]["default_content_setting_values"] = {
            "sub_apps_without_prompts": 1
        }
        for sub in ("Default", "user", "u-user") if self.is_cros else ("Default",):
            os.makedirs(pdir := os.path.join(self.user_data_dir, sub), exist_ok=True)
            with open(os.path.join(pdir, "Preferences"), "w", encoding="utf-8") as f:
                json.dump(prefs, f)
        c2b_r, c2b_w = os.pipe()
        b2c_r, b2c_w = os.pipe()
        ext_dir = os.path.join(REPO_ROOT, "extension/IwaKitchenSinkExtension")
        has_ext = os.path.isfile(os.path.join(ext_dir, "manifest.json"))
        feats = ",".join(
            dict.fromkeys([*REQUIRED_CHROME_FEATURES, *self.extra_features])
        )
        ext_f = [f"--load-extension={ext_dir}"] if has_ext else []
        plat_f = [*_CROS_CHROME_FLAGS, *ext_f] if self.is_cros else ["--disable-gpu"]
        bid = (
            extract_ed25519_web_bundle_id_from_swbn(s) if (s := self.swbn_path) else ""
        )
        self.bundle_id = bid or generate_dev_web_bundle_id()
        self.origin = f"isolated-app://{self.bundle_id}"
        manifest_id, mid_p = f"{self.origin}/", {"manifestId": f"{self.origin}/"}
        u_arg = f"--user-data-dir={self.user_data_dir}"
        p_arg = f"--remote-debugging-port={self.cdp_port}"
        cmd = [self.chrome_binary, u_arg, *_BASE_CHROME_FLAGS, *plat_f, p_arg]
        cmd.append(f"--enable-features={feats}")
        if sh := ",".join(self.spki_hashes):
            cmd.append(f"--ignore-certificate-errors-spki-list={sh}")
        if self.swbn_path:
            cmd.append(f"--install-isolated-web-app-from-file={self.swbn_path}")
        cmd.append("about:blank")
        p_env = {**os.environ, "DISPLAY": self.xvfb_display}
        dup_fds = lambda: (os.dup2(c2b_r, 3), os.dup2(b2c_w, 4))
        pkw: dict[str, Any] = {"env": p_env, "pass_fds": (3, 4, c2b_r, b2c_w), **_QUIET}
        self.proc = subprocess.Popen(cmd, preexec_fn=dup_fds, **pkw)  # noqa: PLW1509
        os.close(c2b_r)
        os.close(b2c_w)
        self.pipe = CdpPipe(c2b_w, b2c_r)
        if has_ext:
            if self.is_cros:
                m_ext = lambda t: _EXT_BG_RE.match(str(t.get("url", "")))
                if ext_t := self._find_target(m_ext, 6.0):
                    self.companion_extension_id = str(ext_t["url"]).split("/")[2]
                    self.browser_context_id = str(ext_t.get("browserContextId") or "")
            else:
                res_e = self.pipe.call("Extensions.loadUnpacked", {"path": ext_dir})
                self.companion_extension_id = str(
                    (res_e.get("result") or {}).get("id", "")
                )
        if self.swbn_path:
            chk_app = lambda: "result" in self.pipe.call("PWA.getOsAppState", mid_p)
            _wait_until(chk_app, 9.0, 0.15)
        elif self.vite_url:
            ip = {**mid_p, "installUrlOrBundleUrl": self.vite_url.rstrip("/") + "/"}
            if "error" in (inst := self.pipe.call("PWA.install", ip)):
                raise RuntimeError(f"PWA.install failed: {inst}")
        self._grant_permissions(manifest_id, self.browser_context_id)
        if self.is_cros:
            self._verify_cros_unframed_over_pipe(manifest_id)
        cdp_u = f"http://127.0.0.1:{self.cdp_port}"
        for _ in range(50):
            with contextlib.suppress(Exception):
                self.browser = self._pw.chromium.connect_over_cdp(cdp_u)
                break
            time.sleep(0.15)
        if self.browser is None:
            raise RuntimeError("Playwright connect_over_cdp failed")
        self.browser_cdp = self.browser.new_browser_cdp_session()
        self._grant_permissions(manifest_id, self.browser_context_id)
        if "error" in (lres := self.pipe.call("PWA.launch", mid_p)):
            raise RuntimeError(f"PWA.launch failed: {lres}")
        for _ in range(60):
            ts = self.browser_cdp.send("Target.getTargets").get("targetInfos", [])
            is_m = lambda t: str(t.get("url", "")).startswith(manifest_id)
            bcids = [str(t.get("browserContextId") or "") for t in ts if is_m(t)]
            if bcids and bcids[0] and bcids[0] != self.browser_context_id:
                self.browser_context_id = bcids[0]
                self._grant_permissions(manifest_id, bcids[0])
            for ctx in self.browser.contexts:
                for pg in ctx.pages:
                    if pg.url.startswith(self.origin):
                        self.context, self.page = ctx, pg
                        break
            if self.page is not None:
                break
            time.sleep(0.1)
        if self.page is None or self.context is None:
            raise RuntimeError("Failed to attach Playwright Page to IWA window")
        on_we = lambda we: self._record_diag("uncaught", str(we.error))
        self.context.on("weberror", on_we)
        self.context.on("page", self._wire_page_diagnostics)
        for pg in self.context.pages:
            self._wire_page_diagnostics(pg)
        bar = self.page.get_by_test_id("shell-status-bar")
        bar.wait_for(state="visible", timeout=12000)
        return self

    def activate_workspace(self, ws_id: str) -> None:
        panel = self.page.get_by_test_id(f"panel-{ws_id}")
        if not panel.is_visible():
            self.page.get_by_test_id(f"nav-{ws_id}").click()
            panel.wait_for(state="visible", timeout=6000)

    def _await_new_page(self, before: set[Page], timeout: float = 8.0) -> Page | None:
        dl = time.time() + timeout
        while time.time() < dl:
            for pg in self.context.pages:
                if pg not in before and pg.url.startswith(self.origin):
                    pg.wait_for_load_state("domcontentloaded", timeout=8000)
                    self._wire_page_diagnostics(pg)
                    return pg
            self.page.wait_for_timeout(80)
        return None

    def launch_app_url(self, url: str) -> Page:
        before, p = (
            set(self.context.pages),
            {"manifestId": f"{self.origin}/", "url": url},
        )
        if "error" in (res := self.pipe.call("PWA.launch", p)):
            raise RuntimeError(f"PWA.launch({url!r}) failed: {res}")
        is_aux = any(s in url for s in ("/sub/", "/dynamic/", "/hud.html"))
        if is_aux and (child := self._await_new_page(before)):
            return child
        self.page.wait_for_timeout(120)
        return self.page

    def launch_files_in_app(self, start_url: str, paths: list[str]) -> Page:
        pfx = "" if start_url.startswith("isolated-app://") else f"{self.origin}/"
        mid = start_url if not pfx else pfx + start_url.lstrip("/")
        before, files = set(self.context.pages), [os.path.abspath(p) for p in paths]
        p = {"manifestId": mid, "files": files}
        if "error" in (res := self.pipe.call("PWA.launchFilesInApp", p)):
            raise RuntimeError(f"PWA.launchFilesInApp({mid!r}) failed: {res}")
        fb = next((g for g in reversed(self.context.pages) if mid in g.url), self.page)
        return self._await_new_page(before) or fb

    def eval_in_cf(
        self, expr: str, timeout_ms: int = 4000, testid: str = "cf-viewport"
    ) -> Any:
        js = """async ({ expr, timeoutMs, testid }) => { const cf = document.querySelector(`[data-testid="${testid}"]`); if (!cf || typeof cf.executeScript !== 'function') throw new Error(`Missing <controlledframe data-testid="${testid}">`); const run = async (code, parse) => { const r = await Promise.race([cf.executeScript({ code }), new Promise((_, rej) => setTimeout(() => rej(new Error('eval_in_cf timeout')), timeoutMs))]); const v = Array.isArray(r) ? r[0] : r; return !parse || v === '__CF_UNDEF__' ? (v === '__CF_UNDEF__' ? undefined : v) : (typeof v === 'string' ? JSON.parse(v) : v); }; try { return await run(`(() => { const __v = (${expr}); return __v === undefined ? "__CF_UNDEF__" : JSON.stringify(__v); })()`, true); } catch { return await run(expr, false); } }"""
        return self.page.evaluate(
            js, {"expr": expr, "timeoutMs": timeout_ms, "testid": testid}
        )

    def wait_for_cf_ready(
        self, expected_url_substr: str = "", timeout: float = 8.0
    ) -> str:
        dl = time.time() + timeout
        while time.time() < dl:
            with contextlib.suppress(Exception):
                q = "({ ready: document.readyState, href: location.href })"
                info = self.eval_in_cf(q, 1500)
                ok = isinstance(info, dict) and info.get("ready") == "complete"
                if ok and expected_url_substr in (href := str(info.get("href") or "")):
                    return href
            self.page.wait_for_timeout(100)
        raise TimeoutError(f"<controlledframe> not ready ({expected_url_substr!r})")

    def crash_cf_guest(self) -> None:
        ts = self.browser_cdp.send("Target.getTargets").get("targetInfos", [])
        guests = [
            t
            for t in ts
            if t.get("type") == "webview"
            and not str(t.get("url", "")).startswith("isolated-app://")
        ]
        if not guests:
            raise RuntimeError("No active <controlledframe> GuestView target")
        tid = guests[0]["targetId"]
        self.pipe.send_only("Page.crash", session_id=self._pipe_attach(tid))
        dl = time.time() + 4.0
        while time.time() < dl:
            cur = self.browser_cdp.send("Target.getTargets").get("targetInfos", [])
            if not any(t.get("targetId") == tid for t in cur):
                break
            self.page.wait_for_timeout(80)

    def close_auxiliary_pages(self) -> None:
        for pg in list(self.context.pages):
            if pg is not self.page:
                with contextlib.suppress(Exception):
                    pg.close()
        aux = ("/sub/", "/dynamic/", "/hud.html", "127.0.0.1", "localhost")
        with contextlib.suppress(Exception):
            for t in self.browser_cdp.send("Target.getTargets").get("targetInfos", []):
                u = str(t.get("url") or "")
                is_aux = t.get("type") in ("page", "app") and u != self.page.url
                if (
                    is_aux
                    and not u.startswith("chrome-extension://")
                    and any(k in u for k in aux)
                ):
                    self.pipe.call("Target.closeTarget", {"targetId": t["targetId"]})

    def reset_app_state(self) -> None:
        self.close_auxiliary_pages()
        with contextlib.suppress(Exception):
            cdp = self.context.new_cdp_session(self.page)
            cdp.send("Emulation.clearDeviceMetricsOverride")
            cdp.detach()
        with contextlib.suppress(Exception):
            self.page.evaluate(_RESET_APP_JS)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            if self.browser is not None:
                self.browser.close()
        if self.pipe is not None:
            self.pipe.close()
        _stop_proc(self.proc, timeout=3.0)
        self.proc = None
        shutil.rmtree(self.user_data_dir, ignore_errors=True)


class E2EContext:
    def __init__(
        self,
        repo_root: str,
        vite_url: str,
        session: PlaywrightIwaSession,
        tls: TlsTestServer,
        rogue_tls: TlsTestServer,
        oidc: OidcTestServer,
        include_swbn: bool = False,
        **kw: Any,
    ):
        self.repo_root, self.vite_url = repo_root, vite_url.rstrip("/") + "/"
        self.session, self.tls, self.rogue_tls = session, tls, rogue_tls
        self.oidc, self.include_swbn = oidc, include_swbn
        self._cros_session = session if session.is_cros else None
        self._non_cros_session = None if session.is_cros else session
        self._cros_factory = kw.get("cros_factory")
        self._non_cros_factory = kw.get("non_cros_factory")
        self._swbn_session_factory = kw.get("swbn_session_factory")

    def __getattr__(self, name: str) -> Any:
        return getattr(self.session, name)

    @property
    def cros_session(self) -> PlaywrightIwaSession | None:
        if self._cros_session is None and self._cros_factory is not None:
            self._cros_session = self._cros_factory()
        return self._cros_session

    @property
    def non_cros_session(self) -> PlaywrightIwaSession | None:
        if self._non_cros_session is None and self._non_cros_factory is not None:
            self._non_cros_session = self._non_cros_factory()
        return self._non_cros_session

    @property
    def cros_unframed_verified(self) -> dict[str, Any] | None:
        return self.cros_session.cros_unframed_verified if self.cros_session else None

    def require_cros_session(self) -> PlaywrightIwaSession:
        if (cs := self.cros_session) is None:
            raise SkipTestCase("ChromeOS (`linux-chromeos`) binary is not available.")
        return cs

    def require_non_cros_session(self) -> PlaywrightIwaSession:
        if (ncs := self.non_cros_session) is None:
            raise SkipTestCase("Linux Chrome binary is not available.")
        return ncs

    def launch_swbn_session(self, swbn_path: str, is_cros: bool = False) -> Any:
        if self._swbn_session_factory is None:
            raise RuntimeError("No swbn_session_factory configured")
        return self._swbn_session_factory(swbn_path, is_cros)

    def initialized_sessions(self) -> list[PlaywrightIwaSession]:
        all_s = (self.session, self._cros_session, self._non_cros_session)
        return list(dict.fromkeys(s for s in all_s if s is not None))

    def reset_app_state(self) -> None:
        for s in self.initialized_sessions():
            s.reset_app_state()
        self.oidc.reset()


class EphemeralTcpPeerServer:
    def __init__(
        self,
        greeting: bytes = b"\x1b[32mGREEN_OK\x1b[0m\r\n",
        echo_prefix: bytes = b"PEER_ACK:",
        abrupt_close_after_greeting: bool = False,
    ):
        self.greeting, self.echo_prefix = greeting, echo_prefix
        self.abrupt_close_after_greeting = abrupt_close_after_greeting
        self.host, self.port, self.received_chunks = "127.0.0.1", 0, []
        self._srv: socket.socket | None = None
        self._running, self._thread = False, None

    def start(self) -> int:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.host, 0))
        srv.listen(8)
        srv.settimeout(0.2)
        self.port, self._srv, self._running = int(srv.getsockname()[1]), srv, True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self.port

    def _handle(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(2.0)
            if self.greeting:
                conn.sendall(self.greeting)
            if self.abrupt_close_after_greeting:
                time.sleep(0.08)
                linger = struct.pack("ii", 1, 0)
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
                return
            while self._running:
                try:
                    data = conn.recv(4096)
                except TimeoutError:
                    continue
                if not data:
                    break
                self.received_chunks.append(data)
                conn.sendall(self.echo_prefix + data)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                conn.close()

    def _loop(self) -> None:
        assert self._srv is not None
        while self._running:
            try:
                conn, _ = self._srv.accept()
                threading.Thread(target=self._handle, args=(conn,), daemon=True).start()
            except TimeoutError:
                continue
            except OSError:
                break

    def stop(self) -> None:
        self._running = False
        if self._srv is not None:
            with contextlib.suppress(OSError):
                self._srv.close()
            self._srv = None
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


def normalize_hex(text: str) -> str:
    return re.sub(r"[^0-9a-fA-F]", "", text or "").lower()


def extract_ints(text: str) -> list[int]:
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text or "")
    s2 = re.sub(r"(?<![0-9A-Za-z_])-+\d+(?:\.\d+)?", " ", s)
    return [int(m) for m in re.findall(r"\d+", s2)]


def extract_port(text: str) -> int | None:
    if not text:
        return None
    s = re.sub(r"(?<![:\w])\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?![:\w])", " ", text)
    v6 = r"(?<![0-9A-Za-z_:])(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:.%-]*(?![0-9A-Za-z_:])"
    for pat, rep in (
        (r"\[[0-9a-fA-F:.%-]*:[0-9a-fA-F:.%-]*\]", "_H_"),
        (v6, " "),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "_H_"),
        (r"(?<![:\w.])(?:[01]?\d|2[0-3]):[0-5]\d(?![:\w.])", " "),
        (r"(?<=\d),(?=\d{3}\b)", ""),
        (r"(?<![0-9A-Za-z_])-+\d+(?:\.\d+)?", " "),
    ):
        s = re.sub(pat, rep, s)
    for raw in re.findall(r"\bport\s*[:=#]?\s*(\d{1,5})\b", s, flags=re.IGNORECASE):
        if 1 <= int(raw) <= 65535:
            return int(raw)
    raw_c = re.findall(r"(?<![:\d]):(\d{2,5})\b(?!:)", s)
    if col := [int(m) for m in raw_c if 1 <= int(m) <= 65535]:
        return next((v for v in col if v >= 1024), col[0])
    u_pat = r"\b\d+(?:\.\d+)?\s*(?:clients?|conns?|connections?|bytes?|[kmg]?b|ms|s)\b"
    s = re.sub(u_pat, " ", s, flags=re.IGNORECASE)
    bares = [int(m) for m in re.findall(r"\b(\d{1,5})\b", s) if 1 <= int(m) <= 65535]
    return next((v for v in bares if v >= 1024), bares[0] if bares else None)


def is_loopback_tcp_listening(port: int) -> bool:
    if not (1 <= int(port) <= 65535):
        return False
    hp = f":{int(port):04X}"
    if pfiles := [p for p in ("/proc/net/tcp", "/proc/net/tcp6") if os.path.isfile(p)]:
        for pf in pfiles:
            with contextlib.suppress(OSError):
                with open(pf, encoding="utf-8", errors="ignore") as f:
                    cs = [c for ln in f.readlines()[1:] if len(c := ln.split()) >= 4]
                if any(c[3].upper() == "0A" and c[1].upper().endswith(hp) for c in cs):
                    return True
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def http_get(url: str, timeout: float = 5.0) -> tuple[int, dict[str, str], bytes]:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return int(r.status), {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as err:
        hdrs = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
        return int(err.code), hdrs, err.read()


def fetch_iwa_asset(page: Page, path: str) -> tuple[int, dict[str, str], bytes]:
    js = """async (p) => { const r = await fetch(p, { cache: 'no-store' }), hdrs = {}; r.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; }); const buf = new Uint8Array(await r.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]); return { status: r.status, headers: hdrs, b64: btoa(bin) }; }"""
    res = page.evaluate(js, path)
    return int(res["status"]), dict(res["headers"]), base64.b64decode(res["b64"])


def read_clipboard_text(page_or_session: Any) -> str:
    pg: Page = getattr(page_or_session, "page", page_or_session)
    cdp = pg.context.new_cdp_session(pg)
    try:
        with contextlib.suppress(Exception):
            cdp.send("Page.bringToFront")
        pg.evaluate(
            """() => { document.getElementById('__pw_clip_probe__')?.remove(); window.__pwClipVal = ''; const ta = document.createElement('textarea'); ta.id = '__pw_clip_probe__'; ta.setAttribute('aria-hidden', 'true'); ta.tabIndex = -1; ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;'; ta.addEventListener('paste', (e) => { window.__pwClipVal = e.clipboardData?.getData('text/plain') || ''; }); document.body.appendChild(ta); ta.focus({ preventScroll: true }); }"""
        )
        kb = {"key": "v", "code": "KeyV", "windowsVirtualKeyCode": 86}
        down = {**kb, "type": "keyDown", "modifiers": 2, "commands": ["Paste"]}
        cdp.send("Input.dispatchKeyEvent", down)
        cdp.send("Input.dispatchKeyEvent", {**kb, "type": "keyUp", "modifiers": 0})
        val = pg.evaluate(
            """() => { const ta = document.getElementById('__pw_clip_probe__'), v = window.__pwClipVal || ta?.value || ''; ta?.remove(); delete window.__pwClipVal; return String(v); }"""
        )
        return str(val)
    finally:
        with contextlib.suppress(Exception):
            cdp.detach()


def generate_dev_web_bundle_id(seed: str = "iwa-sink-revamp-dev-v1") -> str:
    raw = hashlib.sha256(seed.encode("utf-8")).digest() + b"\x00\x00\x02"
    return base64.b32encode(raw).decode("ascii").lower()


def extract_ed25519_web_bundle_id_from_swbn(swbn_path: str) -> str:
    with open(swbn_path, "rb") as f:
        head = f.read(4096)
    idx = head.find(marker := b"ed25519PublicKey\x58\x20")
    if idx == -1 or idx + len(marker) + 32 > len(head):
        raise ValueError(f"Missing Ed25519 public key in {swbn_path}")
    pub = head[idx + len(marker) : idx + len(marker) + 32]
    return base64.b32encode(pub + b"\x00\x01\x02").decode("ascii").lower()


def verify_png_bytes(
    raw_bytes: bytes, expected_size: tuple[int, int] | None = (512, 512)
) -> dict[str, Any]:
    assert len(raw_bytes) >= 33 and raw_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    off, chunks, idat, w, h, depth, ctype = 8, [], bytearray(), 0, 0, 0, 0
    while off + 8 <= len(raw_bytes):
        ln = struct.unpack("!I", raw_bytes[off : off + 4])[0]
        ct, end = raw_bytes[off + 4 : off + 8], off + 8 + ln
        crc = zlib.crc32(ct + raw_bytes[off + 8 : end]) & 0xFFFFFFFF
        assert end + 4 <= len(raw_bytes)
        assert crc == struct.unpack("!I", raw_bytes[end : end + 4])[0]
        chunks.append(ct.decode("ascii", "replace"))
        if ct == b"IHDR":
            w, h, depth, ctype, *_ = struct.unpack("!IIBBBBB", raw_bytes[off + 8 : end])
        elif ct == b"IDAT":
            idat.extend(raw_bytes[off + 8 : end])
        elif ct == b"IEND":
            break
        off = end + 4
    assert {"IHDR", "IDAT", "IEND"}.issubset(chunks), f"Missing PNG chunks: {chunks}"
    decomp = zlib.decompress(bytes(idat))
    assert expected_size is None or (w, h) == expected_size
    res = {"valid": True, "width": w, "height": h, "bitDepth": depth}
    return {**res, "colorType": ctype, "decompressedBytes": len(decomp)}


def verify_swbn_integrity_v2(swbn_path: str) -> dict[str, Any]:
    with open(swbn_path, "rb") as f:
        data = f.read()
    assert len(data) >= 1024 and b"\xf0\x9f\x96\x8b\xf0\x9f\x93\xa6" in data[:32]
    assert b"\x442b\x00\x00" in data[:64]
    assert b"\xf0\x9f\x8c\x90\xf0\x9f\x93\xa6" in data[:4096]
    assert b"manifest.webmanifest" in data
    bid = extract_ed25519_web_bundle_id_from_swbn(swbn_path)
    assert len(bid) == 56 and bid.endswith("aaic")
    return {"valid": True, "sizeBytes": len(data), "bundleId": bid}


_TSC_CACHE: dict[str, tuple[int, str]] = {}
_SWBN_CACHE: dict[str, tuple[int, str, str]] = {}


def _run_node(cmd: list[str], repo_root: str, timeout: float) -> tuple[int, str]:
    kw: dict[str, Any] = {"cwd": repo_root, "env": build_node_env(), "text": True}
    kw.update(stdin=subprocess.DEVNULL, capture_output=True)
    p = subprocess.run(cmd, timeout=timeout, check=False, **kw)
    return p.returncode, f"{p.stdout}\n{p.stderr}".strip()


def run_tsc_no_emit(
    repo_root: str = REPO_ROOT, use_cache: bool = True
) -> tuple[int, str]:
    if use_cache and repo_root in _TSC_CACHE:
        return _TSC_CACHE[repo_root]
    tsc = f"{repo_root}/node_modules/typescript/bin/tsc"
    _TSC_CACHE[repo_root] = res = _run_node(
        [find_node_binary(), tsc, "--noEmit", "--pretty", "false"], repo_root, 45.0
    )
    return res


def run_clean_pnpm_build(
    repo_root: str = REPO_ROOT, use_cache: bool = True
) -> tuple[int, str, str]:
    if use_cache and repo_root in _SWBN_CACHE:
        return _SWBN_CACHE[repo_root]
    rc, out = _run_node([*find_pnpm_command(repo_root), "build"], repo_root, 90.0)
    _SWBN_CACHE[repo_root] = res = (rc, out, f"{repo_root}/dist/iwa-sink.swbn")
    return res


def assert_no_deleted_zombie_dom(page_or_session: Any) -> None:
    pg: Page = getattr(page_or_session, "page", page_or_session)
    hits = pg.evaluate(
        """() => { const h = Array.from(document.querySelectorAll('[data-testid^="mdns-"],[data-testid^="shell-pill-"],[data-testid^="sso-mode-"],[data-testid^="cf-protocol-"],[data-testid^="proto-"]')).map((e) => 'testid:' + e.getAttribute('data-testid')); if (document.querySelector('.shell-status-pills-tucked')) h.push('.shell-status-pills-tucked'); if (document.querySelector('.nav-item .status-dot')) h.push('.nav-item .status-dot'); if (document.querySelector('[data-testid="panel-controlled-frame-tls"] .seg-tab-bar')) h.push('cf:.seg-tab-bar'); if (typeof window.__IWA_MDNS_TELEMETRY__ !== 'undefined') h.push('__IWA_MDNS_TELEMETRY__'); for (const el of document.querySelectorAll('[data-testid]')) { if (!el.closest('.is-hidden, [hidden], .is-copy-disabled')) { const cs = getComputedStyle(el); if (parseFloat(cs.left) < -5000 || parseFloat(cs.top) < -5000) h.push('offscreen:' + el.getAttribute('data-testid')); } } return h; }"""
    )
    assert not hits, f"Retired zombie DOM nodes found: {hits}"


_WCAG_AUDIT_JS = """() => { try { document.getAnimations?.().forEach((a) => a.finish?.()); } catch {} const c = document.createElement('canvas'); c.width = 1; c.height = 1; const ctx = c.getContext('2d', { willReadFrequently: true }); const rgba = (s) => { const t = (s || '').trim(); if (!t || t === 'transparent') return [0, 0, 0, 0]; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = t; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }; const blend = (f, b) => { const a = f[3] + b[3] * (1 - f[3]); return a <= 0 ? [0, 0, 0, 0] : [(f[0]*f[3] + b[0]*b[3]*(1-f[3]))/a, (f[1]*f[3] + b[1]*b[3]*(1-f[3]))/a, (f[2]*f[3] + b[2]*b[3]*(1-f[3]))/a, a]; }; const lum = (rgb) => { const l = rgb.slice(0, 3).map((v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }; const ratio = (c1, c2) => { const l1 = lum(c1), l2 = lum(c2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }; const effBg = (el) => { const ch = []; for (let cur = el; cur instanceof Element; cur = cur.parentElement) ch.push(rgba(getComputedStyle(cur).backgroundColor)); let acc = document.documentElement.getAttribute('data-theme') === 'light' ? [250, 247, 242, 1] : [36, 33, 30, 1]; for (let i = ch.length - 1; i >= 0; i--) acc = blend(ch[i], acc); return acc; }; const vis = (el) => { if (!el || el.closest('.is-hidden, [hidden], [aria-hidden="true"]')) return false; const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && r.width > 0 && r.height > 0; };
  const overflowPx = Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)), textFailures = [], targetFailures = [], fontFailures = [], borderFailures = []; for (const el of document.querySelectorAll('h1, h2, h3, p, span, label, button, a, input, select, textarea, pre')) { if (!vis(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue; const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize); if (fs > 0 && fs < 11.9) fontFailures.push(`${el.tagName}.${el.className}:${fs}px`); const dt = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join('').trim(), vt = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value.trim() : ''; if (!dt && !vt) continue; const bg = effBg(el), cr = ratio(blend(rgba(cs.color), bg), bg), large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700); if (cr < (large ? 3.0 : 4.5)) textFailures.push({ tag: el.tagName, tid: el.getAttribute('data-testid') || el.className, cr: Math.round(cr * 100) / 100 }); }
  for (const el of document.querySelectorAll('button, input, select, [role="tab"], [role="switch"]')) { if (!vis(el) || el.disabled || el.classList.contains('is-copy-disabled')) continue; const r = el.getBoundingClientRect(), minSz = el.closest('[data-testid="app-sidebar"]') ? 31.5 : 23.5; if (r.width < minSz || r.height < minSz) targetFailures.push({ tid: el.getAttribute('data-testid') || el.className, w: Math.round(r.width), h: Math.round(r.height) }); } for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) { if (!vis(el) || el.disabled) continue; const wrap = el.closest('.cf-url-omnibox') || el, cs = getComputedStyle(wrap); if (parseFloat(cs.borderTopWidth) > 0) { const pBg = effBg(wrap.parentElement || document.body), cr = ratio(blend(rgba(cs.borderTopColor), pBg), pBg); if (cr < 3.0) borderFailures.push({ tid: el.getAttribute('data-testid') || wrap.className, cr: Math.round(cr * 100) / 100 }); } } return { overflowPx, textFailures, targetFailures, fontFailures, borderFailures }; }"""


def audit_wcag_and_overflow(
    page: Page,
    viewports: Sequence[tuple[int, int]] = ((1440, 900), (768, 1024), (390, 844)),
) -> dict[str, Any]:
    cdp = page.context.new_cdp_session(page)
    results: dict[str, Any] = {}
    try:
        for w, h in viewports:
            ov = {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}
            cdp.send("Emulation.setDeviceMetricsOverride", ov)
            page.wait_for_timeout(60)
            snap = page.evaluate(_WCAG_AUDIT_JS)
            assert snap["overflowPx"] == 0, f"Overflow {w}x{h}: {snap['overflowPx']}px"
            keys = ("textFailures", "targetFailures", "fontFailures", "borderFailures")
            for key in keys:
                assert not snap[key], f"WCAG {key} at {w}x{h}: {snap[key]}"
            results[f"{w}x{h}"] = snap
    finally:
        with contextlib.suppress(Exception):
            cdp.send("Emulation.clearDeviceMetricsOverride")
            cdp.detach()
    return results


_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQEpH4DwABuAE+SR2jiwAAAABJRU5ErkJggg=="
)


def run_self_test() -> dict[str, Any]:
    ensure_playwright_python()
    pinfo = verify_png_bytes(_TINY_PNG, (1, 1))
    assert extract_port("Listening on [::1]:43821 (12:34:56)") == 43821
    with EphemeralTcpPeerServer() as peer:
        assert is_loopback_tcp_listening(peer.port)
    bid = generate_dev_web_bundle_id()
    return {"selfTest": "PASS", "png": pinfo, "devBundleId": bid}


def main() -> None:
    p = argparse.ArgumentParser(description="Playwright + CdpPipe IWA E2E Harness")
    p.add_argument("--self-test", action="store_true")
    if p.parse_args().self_test:
        print(json.dumps(run_self_test(), indent=2))


if __name__ == "__main__":
    main()

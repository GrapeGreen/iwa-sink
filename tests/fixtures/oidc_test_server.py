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

"""Local HTTPS Loopback OIDC / OAuth 2.0 PKCE (S256) Test Server."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import hmac
import http.client
import http.server
import json
import os
import secrets
import shutil
import socket
import ssl
import sys
import tempfile
import threading
import time
import urllib.parse
from collections.abc import Iterator
from typing import Any, Self

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from tests.fixtures.tls_test_server import generate_ephemeral_ecdsa_cert


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def compute_pkce_s256_challenge(code_verifier: str) -> str:
    return _b64url_encode(hashlib.sha256(code_verifier.encode("ascii")).digest())


_DEFAULTS: dict[str, Any] = {
    "mode": "success",
    "pre_callback_probes": (),
    "expires_in": 3600,
}
_DEFAULTS.update(
    error_description="User denied consent in browser", user_name="Ada Lovelace"
)
_DEFAULTS.update(
    user_email="ada.lovelace@example.org", user_sub="109876543210987654321"
)
_CORS_HEADERS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"}
_CORS_HEADERS["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
_CORS_HEADERS["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
_CORS_HEADERS["Cross-Origin-Resource-Policy"] = "cross-origin"
_AK1 = ("client_id", "redirect_uri", "response_type")
_AUTH_KEYS = (*_AK1, "state", "code_challenge", "code_challenge_method")
_HOLD_DOC = b"<!doctype html><html><head><title>Sign in</title></head><body><h1 id='oidc-hold-heading'>Awaiting user consent...</h1></body></html>"


class _OidcHandler(http.server.BaseHTTPRequestHandler):
    server: _QuietTlsOidcHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _reply(self, status: int, ctype: str, raw: bytes, loc: str = "") -> None:
        self.send_response(status)
        for k, v in _CORS_HEADERS.items():
            self.send_header(k, v)
        if loc:
            self.send_header("Location", loc)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def _json(self, status: int, data: dict[str, Any]) -> None:
        raw = json.dumps(data).encode()
        self._reply(status, "application/json; charset=utf-8", raw)

    def _err(self, st: int, err: str, desc: str = "") -> None:
        self._json(st, {"error": err, **({"error_description": desc} if desc else {})})

    def do_OPTIONS(self) -> None:
        self._reply(204, "", b"")

    def do_GET(self) -> None:
        ow, sp = self.server.owner, urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(sp.query, keep_blank_values=True)
        qv = lambda k, d="": (qs.get(k) or [d])[0].strip()

        if sp.path == "/auth":
            qm = {k: qv(k) for k in _AUTH_KEYS}
            qm["scope"] = qv("scope", "openid email profile")
            ru, st_v = qm["redirect_uri"], qm["state"]
            rs = urllib.parse.urlsplit(ru)
            cb_host, cb_port = rs.hostname or "127.0.0.1", int(rs.port or 0)
            rec = {**qm, "query": dict(qm), "callback_port": cb_port, "ts": time.time()}
            with ow._lock:
                ow.auth_requests.append(rec)
                if cb_port > 0:
                    ow.last_callback_port = cb_port
                if ru:
                    ow.last_callback_url = ru
                ow.last_state = st_v
                mode, probes = ow.mode, bool(ow.pre_callback_probes)
                err_d = ow.error_description
                u_info = (ow.user_email, ow.user_name, ow.user_sub, ow.expires_in)
            ow.auth_hit_event.set()
            ok_h = cb_host in ("127.0.0.1", "::1", "localhost")
            ok_cb = rs.scheme == "http" and ok_h and 1 <= cb_port <= 65535
            ccm, cc = qm["code_challenge_method"], qm["code_challenge"]
            ok_pkce = ccm == "S256" and 43 <= len(cc) <= 128
            ok_req = bool(qm["client_id"] and qm["response_type"] == "code" and st_v)
            if not (ok_req and ok_cb and ok_pkce):
                return self._json(400, {"error": "invalid_request", "received": rec})
            if mode == "hold":
                return self._reply(200, "text/html; charset=utf-8", _HOLD_DOC)
            sep = "&" if "?" in ru else "?"
            if mode == "access_denied":
                ed = {
                    "error": "access_denied",
                    "error_description": err_d,
                    "state": st_v,
                }
                return self._reply(
                    302, "", b"", f"{ru}{sep}{urllib.parse.urlencode(ed)}"
                )
            code = f"oidc_code_{secrets.token_urlsafe(18)}"
            u_em, u_nm, u_sb, exp = u_info
            sc = qm["scope"] or "openid email profile"
            issued = {**qm, "scope": sc, "email": u_em, "name": u_nm}
            issued.update(sub=u_sb, exp=exp)
            with ow._lock:
                ow._codes[code] = issued
            if probes and cb_port > 0:
                pres = ow._run_pre_callback_probes(cb_host, cb_port)
                with ow._lock:
                    ow.probe_results.extend(pres)
            out_st = f"TAMPERED_CSRF_{st_v}" if mode == "tampered_state" else st_v
            qs_ok = urllib.parse.urlencode({"code": code, "state": out_st})
            return self._reply(302, "", b"", f"{ru}{sep}{qs_ok}")

        if sp.path == "/userinfo":
            ah = (self.headers.get("Authorization") or "").strip()
            tok_s = ah[7:].strip() if ah.startswith("Bearer ") else ""
            with ow._lock:
                ow.userinfo_requests.append({"auth": ah, "ts": time.time()})
                tm = ow._tokens.get(tok_s) if tok_s else None
            if not tm:
                return self._err(401, "invalid_token")
            u = {k: tm[k] for k in ("sub", "email", "name")}
            return self._json(200, {**u, "email_verified": True})

        if sp.path == "/.well-known/openid-configuration":
            b = ow.base_url
            eps = (
                ("authorization", "auth"),
                ("token", "token"),
                ("userinfo", "userinfo"),
            )
            cfg: dict[str, Any] = {f"{k}_endpoint": f"{b}/{p}" for k, p in eps}
            cfg.update(issuer=b, revocation_endpoint=f"{b}/revoke")
            cfg["response_types_supported"] = ["code"]
            cfg["grant_types_supported"] = ["authorization_code"]
            cfg["code_challenge_methods_supported"] = ["S256"]
            cfg["id_token_signing_alg_values_supported"] = ["ES256"]
            return self._json(200, cfg)
        ok = sp.path == "/health"
        self._json(200 if ok else 404, {"ok": True} if ok else {"error": "not_found"})

    def do_POST(self) -> None:
        ow, sp = self.server.owner, urllib.parse.urlsplit(self.path)
        ln = max(0, min(int(self.headers.get("Content-Length") or "0"), 65536))
        raw_q = self.rfile.read(ln).decode("utf-8", errors="replace")
        pqs = urllib.parse.parse_qs(raw_q, keep_blank_values=True)
        form = {k: (v[0] if v else "") for k, v in pqs.items()}
        fv = lambda k: form.get(k, "").strip()
        if sp.path == "/revoke":
            if tok := fv("token"):
                with ow._lock:
                    ow._tokens.pop(tok, None)
            return self._json(200, {"revoked": True})
        if sp.path != "/token":
            return self._err(404, "not_found")
        tr = {**form, "hasClientSecret": bool(fv("client_secret")), "ts": time.time()}
        with ow._lock:
            ow.token_requests.append(tr)
            cur_mode = ow.mode
        if cur_mode == "token_http_500":
            return self._err(500, "server_error", "Simulated upstream HTTP 500")
        if fv("grant_type") != "authorization_code":
            return self._err(400, "invalid_request", "Unsupported grant_type")
        code, ver = fv("code"), fv("code_verifier")
        redir, cid = fv("redirect_uri"), fv("client_id")
        with ow._lock:
            issued = ow._codes.pop(code, None)
        bad_c = bool(cid and cid != issued["client_id"]) if issued else True
        if not issued or redir != issued["redirect_uri"] or bad_c:
            return self._err(400, "invalid_grant")
        got_c, cc = compute_pkce_s256_challenge(ver), issued["code_challenge"]
        if not (43 <= len(ver) <= 128) or not hmac.compare_digest(got_c, cc):
            return self._err(400, "invalid_grant", "PKCE S256 mismatch")
        atok = f"iwa_e2e_oidc_{secrets.token_urlsafe(24)}"
        id_tok, exp_i = ow._mint_es256_id_token(issued), issued["exp"]
        tmeta = {k: issued[k] for k in ("sub", "email", "name", "scope", "client_id")}
        with ow._lock:
            ow._tokens[atok] = {**tmeta, "created_at": time.time()}
        resp = {"access_token": atok, "token_type": "Bearer", "expires_in": exp_i}
        self._json(200, {**resp, "scope": issued["scope"], "id_token": id_tok})


class _QuietTlsOidcHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads, allow_reuse_address = True, True

    def __init__(self, addr: Any, ssl_ctx: ssl.SSLContext, owner: OidcTestServer):
        super().__init__(addr, _OidcHandler)
        self._ssl_ctx, self.owner = ssl_ctx, owner

    def get_request(self) -> tuple[socket.socket, Any]:
        sock, addr = super().get_request()
        sock.settimeout(5.0)
        try:
            return self._ssl_ctx.wrap_socket(sock, server_side=True), addr
        except Exception:
            with contextlib.suppress(OSError):
                sock.close()
            raise

    def handle_error(self, request: Any, client_address: Any) -> None:
        pass


class OidcTestServer:
    _M1 = ("success", "access_denied", "tampered_state")
    VALID_MODES = frozenset((*_M1, "hold", "token_http_500"))

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        label: str = "iwa-sink-oidc-fixture.local",
    ):
        self.host, self.port, self.label = host, port, label
        cn = label if "." in label else f"{label}.local"
        cp, kp, der, sha, spki = generate_ephemeral_ecdsa_cert(cn)
        self.cert_pem, self.key_pem, self.cert_der = cp, kp, der
        self.cert_der_sha256_hex, self.spki_sha256_b64 = sha, spki
        sk = serialization.load_pem_private_key(self.key_pem, password=None)
        assert isinstance(sk, ec.EllipticCurvePrivateKey)
        self._signing_key, self._lock = sk, threading.Lock()
        for k, v in _DEFAULTS.items():
            setattr(self, k, v)
        self._codes: dict[str, dict[str, Any]] = {}
        self._tokens: dict[str, dict[str, Any]] = {}
        self.auth_requests: list[dict[str, Any]] = []
        self.token_requests: list[dict[str, Any]] = []
        self.userinfo_requests: list[dict[str, Any]] = []
        self.probe_results: list[dict[str, Any]] = []
        self.last_callback_port, self.last_callback_url, self.last_state = 0, "", ""
        self.auth_hit_event = threading.Event()
        self._cert_dir: str | None = None
        self._httpd: _QuietTlsOidcHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        return f"https://{self.host}:{self.port}"

    @property
    def auth_endpoint(self) -> str:
        return f"{self.base_url}/auth"

    @property
    def token_endpoint(self) -> str:
        return f"{self.base_url}/token"

    @property
    def userinfo_endpoint(self) -> str:
        return f"{self.base_url}/userinfo"

    def client_config(self, include_userinfo: bool = False) -> dict[str, str]:
        d = {"authEndpoint": self.auth_endpoint, "tokenEndpoint": self.token_endpoint}
        if include_userinfo:
            d["userinfoEndpoint"] = self.userinfo_endpoint
        return d

    def configure_mode(self, mode: str = "success", **overrides: Any) -> None:
        if mode not in self.VALID_MODES:
            raise ValueError(f"Unsupported OidcTestServer mode {mode!r}")
        merged = {**_DEFAULTS, **overrides, "mode": mode}
        with self._lock:
            for k in _DEFAULTS:
                setattr(self, k, merged[k])
            self.probe_results.clear()
            self.auth_hit_event.clear()

    def reset(self) -> None:
        self.configure_mode("success")
        with self._lock:
            cols = (self._codes, self._tokens, self.auth_requests, self.token_requests)
            for col in (*cols, self.userinfo_requests):
                col.clear()
            self.last_callback_port, self.last_callback_url, self.last_state = 0, "", ""

    @contextlib.contextmanager
    def temporary_config(self, *, mode: str = "success", **kw: Any) -> Iterator[Self]:
        with self._lock:
            prev = {k: getattr(self, k) for k in _DEFAULTS}
        self.configure_mode(mode, **kw)
        try:
            yield self
        finally:
            with self._lock:
                for k, v in prev.items():
                    setattr(self, k, v)

    def snapshot_stats(self) -> dict[str, Any]:
        with self._lock:
            a, t, u = self.auth_requests, self.token_requests, self.userinfo_requests
            d: dict[str, Any] = {
                "authRequestsCount": len(a),
                "lastState": self.last_state,
            }
            d.update(tokenRequestsCount=len(t), userinfoRequestsCount=len(u))
            d.update(authRequests=list(a), tokenRequests=list(t))
            d.update(probeResults=list(self.probe_results))
            d.update(lastCallbackPort=self.last_callback_port)
            return {**d, "lastCallbackUrl": self.last_callback_url}

    def _mint_es256_id_token(self, issued: dict[str, Any]) -> str:
        now_s = int(time.time())
        enc = lambda o: _b64url_encode(json.dumps(o, separators=(",", ":")).encode())
        claims: dict[str, Any] = {
            "iss": self.base_url,
            "sub": issued["sub"],
            "aud": issued["client_id"],
        }
        claims.update(email=issued["email"], email_verified=True, name=issued["name"])
        claims.update(iat=now_s, exp=now_s + int(issued["exp"]))
        msg = f"{enc({'alg': 'ES256', 'typ': 'JWT', 'kid': 'iwa-oidc-e2e-1'})}.{enc(claims)}"
        sig = self._signing_key.sign(msg.encode("ascii"), ec.ECDSA(hashes.SHA256()))
        r_i, s_i = decode_dss_signature(sig)
        raw_sig = r_i.to_bytes(32, "big") + s_i.to_bytes(32, "big")
        return f"{msg}.{_b64url_encode(raw_sig)}"

    @staticmethod
    def _run_pre_callback_probes(cb_host: str, cb_port: int) -> list[dict[str, Any]]:
        def _req(m: str, p: str, body: bytes = b"") -> tuple[int, str, dict[str, str]]:
            conn = http.client.HTTPConnection(cb_host, cb_port, timeout=3.0)
            try:
                ct = "application/x-www-form-urlencoded"
                fh = {"Content-Type": ct, "Content-Length": str(len(body))}
                conn.request(
                    m,
                    p,
                    body=body or None,
                    headers={"Connection": "close", **(fh if body else {})},
                )
                r = conn.getresponse()
                r.read()
                hs = {k.lower(): v for k, v in r.getheaders()}
                return int(r.status), f"HTTP/1.1 {r.status} {r.reason}", hs
            finally:
                conn.close()

        p_url = "/callback?code=STRAY_POST_CODE&state=STRAY_POST_STATE"
        sp, lp, hp = _req("POST", p_url, b"unexpected=post")
        sf, lf, _ = _req("GET", "/favicon.ico")
        sr, lr, _ = _req("GET", "/robots.txt")
        with socket.create_connection((cb_host, cb_port), timeout=3.0) as bs:
            bs.settimeout(3.0)
            bs.sendall(b"\xff\xfeNOT_HTTP_REQUEST_LINE\r\n\r\n")
            raw_bad = bs.recv(2048)
        s_bad = raw_bad.decode("utf-8", errors="replace")
        bl, gs = (
            (s_bad.splitlines()[0] if raw_bad else ""),
            (400 if b"400" in raw_bad else 0),
        )
        r1 = {
            "probe": "post_callback",
            "status": sp,
            "firstLine": lp,
            "allowHeader": hp.get("allow", ""),
        }
        r2, r3 = (
            {"probe": "favicon", "status": sf, "firstLine": lf},
            {"probe": "robots", "status": sr, "firstLine": lr},
        )
        return [r1, r2, r3, {"probe": "garbage", "status": gs, "firstLine": bl}]

    def start(self) -> str:
        if self._httpd is not None:
            return self.base_url
        self._cert_dir = tmp = tempfile.mkdtemp(prefix="iwa_oidc_fixture_")
        cp, kp = os.path.join(tmp, "c.pem"), os.path.join(tmp, "k.pem")
        with open(cp, "wb") as cf, open(kp, "wb") as kf:
            cf.write(self.cert_pem)
            kf.write(self.key_pem)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ssl_ctx.load_cert_chain(certfile=cp, keyfile=kp)
        srv = _QuietTlsOidcHTTPServer((self.host, self.port), ssl_ctx, self)
        self.port, self._httpd = int(srv.server_address[1]), srv
        self._thread = threading.Thread(
            target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self._thread.start()
        return self.base_url

    def stop(self) -> None:
        if self._httpd is not None:
            with contextlib.suppress(Exception):
                self._httpd.shutdown()
                self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._cert_dir is not None:
            shutil.rmtree(self._cert_dir, ignore_errors=True)
            self._cert_dir = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


def run_self_test() -> dict[str, Any]:
    with OidcTestServer(label="oidc-self-test-fixture") as srv:
        cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        cctx.check_hostname, cctx.verify_mode = False, ssl.CERT_NONE

        def _https(m: str, p: str, body: Any = None, hdrs: Any = None) -> Any:
            conn = http.client.HTTPSConnection(
                srv.host, srv.port, context=cctx, timeout=5.0
            )
            try:
                ct = "application/x-www-form-urlencoded"
                fh = {"Content-Type": ct, "Content-Length": str(len(body or b""))}
                h_all = {**(hdrs or {}), **(fh if body is not None else {})}
                conn.request(m, p, body=body, headers=h_all)
                r = conn.getresponse()
                return (
                    int(r.status),
                    {k.lower(): v for k, v in r.getheaders()},
                    r.read(),
                )
            finally:
                conn.close()

        st_d, _, raw_d = _https("GET", "/.well-known/openid-configuration")
        assert st_d == 200 and json.loads(raw_d)[
            "code_challenge_methods_supported"
        ] == ["S256"]
        ver, state = secrets.token_urlsafe(48), secrets.token_urlsafe(16)
        redir, cid = "http://127.0.0.1:43210/callback", "self-test-desktop-client"
        ap = {"client_id": cid, "redirect_uri": redir, "response_type": "code"}
        ap.update(
            state=state, scope="openid email profile", code_challenge_method="S256"
        )
        ap["code_challenge"] = compute_pkce_s256_challenge(ver)
        st_a, hd_a, _ = _https("GET", f"/auth?{urllib.parse.urlencode(ap)}")
        assert st_a == 302 and hd_a.get("location", "").startswith(redir)
        cb_qs = urllib.parse.parse_qs(urllib.parse.urlsplit(hd_a["location"]).query)
        code = cb_qs["code"][0]
        assert code.startswith("oidc_code_") and cb_qs["state"][0] == state
        tp = {"grant_type": "authorization_code", "code": code, "redirect_uri": redir}
        tp.update(client_id=cid, code_verifier=ver)
        tbody = urllib.parse.urlencode(tp).encode()
        st_t, _, raw_t = _https("POST", "/token", body=tbody)
        tok = json.loads(raw_t)
        assert st_t == 200 and len(tok["id_token"].split(".")) == 3
        assert _https("POST", "/token", body=tbody)[0] == 400
        bhdr = {"Authorization": f"Bearer {tok['access_token']}"}
        st_u, _, raw_u = _https("GET", "/userinfo", hdrs=bhdr)
        assert st_u == 200 and json.loads(raw_u)["email"] == srv.user_email
        rbody = urllib.parse.urlencode({"token": tok["access_token"]}).encode()
        assert _https("POST", "/revoke", body=rbody)[0] == 200
        assert _https("GET", "/userinfo", hdrs=bhdr)[0] == 401
        return {"selfTest": "PASS", "port": srv.port, "stats": srv.snapshot_stats()}


def main() -> None:
    p = argparse.ArgumentParser(description="Local HTTPS OIDC PKCE S256 Test Server")
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--port", type=int, default=0)
    args = p.parse_args()
    if args.self_test:
        print(json.dumps(run_self_test(), indent=2))
        return
    with OidcTestServer(port=args.port) as srv:
        print(json.dumps(srv.snapshot_stats(), indent=2), flush=True)
        with contextlib.suppress(KeyboardInterrupt):
            threading.Event().wait()


if __name__ == "__main__":
    main()

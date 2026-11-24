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

"""Local HTTPS TLS 1.3 test server for Controlled Frame & X.509 DER E2E verification."""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime
import hashlib
import html
import http.server
import ipaddress
import json
import os
import shutil
import socket
import socketserver
import ssl
import tempfile
import threading
import time
import urllib.parse
from typing import Any, Self

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.name import _ASN1Type
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_PEM, _DER = serialization.Encoding.PEM, serialization.Encoding.DER
_SPKI = serialization.PublicFormat.SubjectPublicKeyInfo
_PKCS8, _NOENC = serialization.PrivateFormat.PKCS8, serialization.NoEncryption()


def _xname(org: str = "", cn: str = "", asn1: Any = None) -> x509.Name:
    na = x509.NameAttribute
    pairs = ((NameOID.ORGANIZATION_NAME, org), (NameOID.COMMON_NAME, cn))
    return x509.Name([na(o, v, asn1) if asn1 else na(o, v) for o, v in pairs if v])


def _colon_hex(sha: str) -> str:
    return ":".join(sha[i : i + 2].upper() for i in range(0, 64, 2))


def _cert(sub: Any, iss: Any, lk: Any, sk: Any, sans: Any, **kw: Any) -> dict[str, Any]:
    now = datetime.datetime.now(datetime.UTC)
    exp = kw.get("exp") or (now + datetime.timedelta(days=30))
    b = x509.CertificateBuilder().subject_name(sub).issuer_name(iss)
    b = b.public_key(lk.public_key()).serial_number(x509.random_serial_number())
    b = b.not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(exp)
    b = b.add_extension(x509.SubjectAlternativeName(sans), critical=bool(kw.get("sc")))
    bc = x509.BasicConstraints(ca=False, path_length=None)
    b = b.add_extension(bc, critical=True)
    if kw.get("ku"):
        flags = (True, False, False, False, True, False, False, False, False)
        b = b.add_extension(x509.KeyUsage(*flags), critical=True)
    eku = x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH])
    c = b.add_extension(eku, critical=False).sign(sk, kw.get("halg") or hashes.SHA256())
    der, kp = c.public_bytes(_DER), lk.private_bytes(_PEM, _PKCS8, _NOENC)
    sha = hashlib.sha256(der).hexdigest()
    spki_raw = c.public_key().public_bytes(_DER, _SPKI)
    spki = base64.b64encode(hashlib.sha256(spki_raw).digest()).decode()
    d = {"cert_pem": c.public_bytes(_PEM), "key_pem": kp, "cert_der": der}
    d.update(cert_der_sha256_hex=sha, spki_sha256_b64=spki)
    return {**d, "cert_der_sha256_colon": _colon_hex(sha)}


def generate_ephemeral_ecdsa_cert(
    common_name: str = "iwa-sink-tls-fixture.local",
) -> tuple[bytes, bytes, bytes, str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    nm = _xname("IWA Sink E2E Fixture", common_name)
    ips = [x509.IPAddress(ipaddress.ip_address(a)) for a in ("127.0.0.1", "::1")]
    sans = [*ips, x509.DNSName("localhost"), x509.DNSName(common_name)]
    m = _cert(nm, nm, key, key, sans, ku=True)
    ks = ("cert_pem", "key_pem", "cert_der", "cert_der_sha256_hex", "spki_sha256_b64")
    return tuple(m[k] for k in ks)  # type: ignore[return-value]


def generate_alt_x509_variants() -> dict[str, dict[str, Any]]:
    ip4, ip6 = (x509.IPAddress(ipaddress.ip_address(a)) for a in ("127.0.0.1", "::1"))
    dns = x509.DNSName
    loop: list[x509.GeneralName] = [ip4, ip6, dns("localhost")]
    k1, k2, k3, k4 = (ec.generate_private_key(ec.SECP256R1()) for _ in range(4))
    ca_k, rsa_k = (rsa.generate_private_key(65537, 2048) for _ in range(2))
    p384_k = ec.generate_private_key(ec.SECP384R1())
    p384_nm = _xname("IWA P384 Authority", "p384-gen.local")
    acme_ca, bmp = _xname("Acme Cloud Root CA", "Acme Modern G2"), _ASN1Type.BMPString
    b_sub = _xname("BMP Leaf Org", "bmp-leaf.local", bmp)
    b_iss = _xname("CafeRootCA", "BMP Issuing CA", bmp)
    r_sub = _xname("IWA Portal Leaf", "rsa2048-portal.local")
    r_iss = _xname("IWA Test Root CA", "IWA RSA Root")
    exp55 = datetime.datetime(2055, 6, 15, tzinfo=datetime.UTC)
    pkw = {"exp": exp55, "halg": hashes.SHA384()}
    nc_sub = _xname("Acme Cloud Corp")
    v1 = _cert(b_sub, b_iss, k1, k1, [*loop, dns("bmp-leaf.local")])
    v2 = _cert(r_sub, r_iss, rsa_k, ca_k, [*loop, dns("rsa2048-portal.local")])
    v3 = _cert(p384_nm, p384_nm, p384_k, p384_k, [*loop, dns("p384-gen.local")], **pkw)
    v4 = _cert(_xname(), _xname("IP Only CA"), k2, k2, [ip4, ip6], sc=True)
    v5 = _cert(nc_sub, acme_ca, k3, k3, [ip4, dns("nocn-portal.local")])
    v6 = _cert(_xname("Acme Appliance Org"), acme_ca, k4, k4, [ip4, ip6])
    ks = ("bmpstring", "rsa2048", "p384", "ip_only", "no_cn", "no_cn_ip_org")
    return dict(zip(ks, (v1, v2, v3, v4, v5, v6), strict=True))


_STRICT_CSP = "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; object-src 'none'"
_CSP_BODY = "<h1 id='guest-heading'>Strict CSP Guest</h1><p id='csp-note'>Locked down with strict Content-Security-Policy.</p>"
_CLOBBER_HTML = "<h1 id='guest-heading'>DOM Clobber Guest</h1><form id='form-only-id'><input name='id' value='user_123'></form><form id='clobbered-all'><input name='id' value='evil_id'><input name='nodeType' value='99'><input name='nodeName' value='EVIL_NODE'><input name='tagName' value='EVIL_TAG'></form>"
_CACHE_BODY = "<h1 id='guest-heading'>Cacheable HTTPS Guest</h1>"
_CSP_HDR = {"Content-Security-Policy": _STRICT_CSP}
_CC_HDR = {"Cache-Control": "public, max-age=300"}
_STATIC_DOCS: dict[str, tuple[str, str, dict[str, str] | None]] = {
    "/csp-strict": ("Strict CSP Guest", _CSP_BODY, _CSP_HDR),
    "/dom-clobber": ("DOM Clobber Guest", _CLOBBER_HTML, None),
    "/cacheable-page": ("Cacheable HTTPS Guest", _CACHE_BODY, _CC_HDR),
}
_IFR = "<iframe id='{}' src='https://127.0.0.1:{}/{}' width='120' height='60'></iframe>"


class _TlsHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _TrackedTlsHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send(self, st: int, ct: str, body: bytes, extra: Any = None) -> None:
        fx, ex = self.server.fixture_ref, extra or {}
        self.close_connection = True
        self.send_response(st)
        if ct:
            self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        if not any(k.lower() == "cache-control" for k in ex):
            self.send_header("Cache-Control", "no-store")
        h = {"X-IWA-TLS-Fixture": fx.label, "X-Cert-SHA256": fx.cert_der_sha256_hex}
        for k, v in {**h, "Connection": "close", **ex}.items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)
        self.wfile.flush()

    def _doc(self, title: str, inner: str, extra: Any = None) -> None:
        doc = f"<!doctype html><html><head><meta charset='utf-8'><title>{title}</title></head><body data-fixture-ready='true'>{inner}</body></html>"
        self._send(200, "text/html; charset=utf-8", doc.encode(), extra)

    def do_GET(self) -> None:
        fx = self.server.fixture_ref
        ua = self.headers.get("User-Agent", "")
        with fx._lock:
            fx.requests_log.append(
                {"method": "GET", "path": self.path, "userAgent": ua}
            )
        sp = urllib.parse.urlsplit(self.path)
        route, qs = sp.path or "/", urllib.parse.parse_qs(sp.query)
        if route in _STATIC_DOCS:
            return self._doc(*_STATIC_DOCS[route])
        if route == "/tls-check" or route.startswith("/api/"):
            p: dict[str, Any] = {"ok": True, "server": fx.label, "tls_verified": True}
            p.update(path=self.path, cert_sha256=fx.cert_der_sha256_hex)
            p["cert_der_len"] = len(fx.cert_der)
            raw_j = json.dumps(p).encode()
            return self._send(200, "application/json; charset=utf-8", raw_j)
        if route == "/storage-probe":
            sv = qs.get("set", [""])[0]
            ck = f"iwa_probe={urllib.parse.quote(sv)}; Path=/; Secure; SameSite=None"
            js = f"const sv={json.dumps(sv)};if(sv){{try{{localStorage.setItem('iwa_partition_probe',sv);}}catch{{}}}}let cur='';try{{cur=localStorage.getItem('iwa_partition_probe')||'';}}catch{{}}document.getElementById('storage-readout').textContent='LS:'+cur+'|CK:'+document.cookie;"
            b = f"<h1 id='guest-heading'>Storage Probe ({html.escape(fx.label)})</h1><div id='storage-readout'></div><script>{js}</script>"
            return self._doc("Storage Probe", b, {"Set-Cookie": ck} if sv else None)
        if route == "/no-content-204":
            return self._send(204, "", b"")
        if route == "/redirect-302":
            loc = {"Location": qs.get("to", ["/page-b?from_302=1"])[0]}
            return self._send(302, "text/plain; charset=utf-8", b"Redirecting...", loc)
        if route in ("/slow", "/slow-after-first"):
            ms_r = qs.get("ms", ["1800" if route == "/slow" else "2200"])[0]
            ms = max(50, min(5000, int(ms_r))) if ms_r.lstrip("-").isdigit() else 1800
            title, wait_now = "Slow Complete", True
            if route == "/slow-after-first":
                k = qs.get("key", ["default"])[0]
                with fx._lock:
                    n = fx._slow_counts[k] = fx._slow_counts.get(k, 0) + 1
                title, wait_now = f"Hit {n}", n >= 2
            if wait_now and (fx._stop_evt.wait(ms / 1000.0) or fx._stop_evt.is_set()):
                return
            return self._doc(title, f"<h1 id='guest-heading'>{title}</h1>")
        if route == "/nav-lab":
            rp = qs.get("rogue_port", [""])[0]
            p_i = int(rp) if rp.isdigit() else 0
            rh = f"https://127.0.0.1:{p_i}/untrusted-via-link" if p_i else "/page-b"
            body = f"<h1 id='guest-heading'>Controlled Frame Navigation Lab</h1><nav><a id='link-page-b' href='/page-b'>Page B</a> | <a id='slow-link' href='/slow?ms=2500'>Slow Link</a> | <a id='hash-link' href='#sec2'>Hash Sec 2</a> | <a id='no-content-link' href='/no-content-204'>204 Link</a> | <a id='rogue-link' href='{html.escape(rh)}'>Untrusted Link</a></nav><section id='sec2'><h2>Section 2</h2></section>"
            return self._doc("Controlled Frame Navigation Lab", body)
        if route == "/popup-lab":
            cu = f"https://user:pass@127.0.0.1:{fx.port}/page-b?from_popup=cred"
            body = f"<h1 id='guest-heading'>Popup &amp; Dialog Lab</h1><nav><a id='popup-valid-link' href='/page-b?from_popup=blank_link' target='_blank' rel='noopener'>Valid _blank Link</a> | <a id='popup-js-link' href='javascript:window.__POPUP_XSS=1' target='_blank'>Unsafe JS _blank Link</a> | <a id='popup-data-link' href='data:text/html,&lt;h1&gt;popup-data&lt;/h1&gt;' target='_blank'>Unsafe Data _blank Link</a> | <a id='popup-blank-link' href='about:blank' target='_blank'>About Blank _blank Link</a> | <a id='popup-cred-link' href='{html.escape(cu)}' target='_blank'>Credentialed _blank Link</a></nav>"
            return self._doc("Popup &amp; Dialog Lab", body)
        if route == "/subframe-host":
            rp, cp = qs.get("rogue_port", [""])[0], qs.get("closed_port", [""])[0]
            mk = lambda i, p, s: _IFR.format(i, int(p), s) if p.isdigit() else ""
            h1 = f"<h1 id='guest-heading'>Subframe Isolation Host</h1>{mk('if-rogue', rp, 'sub-rogue')}{mk('if-refused', cp, 'sub-refused')}"
            return self._doc("Subframe Isolation Host", h1)
        titles = {
            "/": f"HTTPS Portal Root ({fx.label})",
            "/page-a": "Controlled Frame Guest Page A",
            "/page-b": "Controlled Frame Guest Page B",
        }
        et = html.escape(titles.get(route, f"Guest Route {route}"))
        raw = f"<!doctype html><html><head><meta charset='utf-8'><title>{et}</title><style>body{{font-family:sans-serif;background:#111318;color:#f3f4f6;margin:20px}}</style></head><body data-fixture-ready='true'><h1 id='guest-heading'>{et}</h1><p id='guest-meta'>server={html.escape(fx.label)} sha256={fx.cert_der_sha256_hex}</p><nav><a id='link-page-a' href='/page-a'>Page A</a> | <a id='link-page-b' href='/page-b'>Page B</a></nav></body></html>".encode()
        self._send(200, "text/html; charset=utf-8", raw)


class _TrackedTlsHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads, allow_reuse_address = True, True

    def __init__(self, addr: Any, ssl_ctx: ssl.SSLContext, fx: TlsTestServer):
        if ":" in addr[0]:
            self.address_family = socket.AF_INET6
        super().__init__(addr, _TlsHandler)
        self.ssl_context, self.fixture_ref = ssl_ctx, fx

    def get_request(self) -> tuple[socket.socket, Any]:
        raw_sock, addr = super().get_request()
        with self.fixture_ref._lock:
            self.fixture_ref.tcp_accepts += 1
        raw_sock.settimeout(5.0)
        return raw_sock, addr

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        ssl_sock, fx = None, self.fixture_ref
        try:
            try:
                ssl_sock = self.ssl_context.wrap_socket(request, server_side=True)
            except (OSError, ValueError) as exc:
                with fx._lock:
                    fx.tls_handshake_errors += 1
                    fx.last_handshake_error = str(exc)
                return
            with fx._lock:
                fx.tls_handshakes_ok += 1
                fx.last_tls_version = ssl_sock.version() or "unknown"
                fx.last_cipher = (ssl_sock.cipher() or ("unknown",))[0]
            with contextlib.suppress(Exception):
                self.finish_request(ssl_sock, client_address)
        finally:
            self.shutdown_request(ssl_sock or request)

    def handle_error(self, request: Any, client_address: Any) -> None:
        pass


class TlsTestServer:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        label: str = "iwa-sink-tls-fixture",
        include_alt_certs: bool = False,
    ):
        self.host, self.requested_port, self.port = host.strip("[]"), port, port
        self.label = label
        cp, kp, der, sha, spki = generate_ephemeral_ecdsa_cert(f"{label}.local")
        self.cert_pem, self.key_pem, self.cert_der = cp, kp, der
        self.cert_der_sha256_hex, self.spki_sha256_b64 = sha, spki
        self.cert_der_sha256_colon = _colon_hex(sha)
        self.alt_certs = generate_alt_x509_variants() if include_alt_certs else {}
        alts = self.alt_certs.values()
        self.extra_spki_hashes = [str(m["spki_sha256_b64"]) for m in alts]
        self._lock, self._stop_evt = threading.Lock(), threading.Event()
        self._slow_counts: dict[str, int] = {}
        self.tcp_accepts = self.tls_handshakes_ok = self.tls_handshake_errors = 0
        self.last_tls_version = self.last_cipher = self.last_handshake_error = None
        self.requests_log: list[dict[str, Any]] = []
        self._tmp_dir: str | None = None
        self._alt_ssl_contexts: dict[str, ssl.SSLContext] = {}
        self._httpd: _TrackedTlsHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        h = f"[{self.host}]" if ":" in self.host else self.host
        return f"https://{h}:{self.port}"

    def snapshot_stats(self) -> dict[str, Any]:
        with self._lock:
            d: dict[str, Any] = {"label": self.label, "port": self.port}
            d.update(certDerLen=len(self.cert_der), tcpAccepts=self.tcp_accepts)
            d.update(
                certDerSha256Hex=self.cert_der_sha256_hex,
                spkiSha256B64=self.spki_sha256_b64,
            )
            d.update(
                tlsHandshakesOk=self.tls_handshakes_ok,
                tlsHandshakeErrors=self.tls_handshake_errors,
            )
            d.update(lastTlsVersion=self.last_tls_version, lastCipher=self.last_cipher)
            return {
                **d,
                "lastHandshakeError": self.last_handshake_error,
                "httpRequestsCount": len(self.requests_log),
            }

    @staticmethod
    def _ssl_ctx(tmp: str, tag: str, cert_pem: bytes, key_pem: bytes) -> ssl.SSLContext:
        cp, kp = os.path.join(tmp, f"c_{tag}.pem"), os.path.join(tmp, f"k_{tag}.pem")
        with open(cp, "wb") as cf, open(kp, "wb") as kf:
            cf.write(cert_pem)
            kf.write(key_pem)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.maximum_version = ssl.TLSVersion.TLSv1_3
        ctx.load_cert_chain(certfile=cp, keyfile=kp)
        return ctx

    def start(self) -> None:
        if self._httpd is not None:
            return
        self._stop_evt.clear()
        self._tmp_dir = tmp = tempfile.mkdtemp(prefix="iwa_tls_fixture_")
        try:
            ssl_ctx = self._ssl_ctx(tmp, "main", self.cert_pem, self.key_pem)
            self._alt_ssl_contexts = {
                k: self._ssl_ctx(tmp, k, v["cert_pem"], v["key_pem"])
                for k, v in self.alt_certs.items()
            }
            srv = _TrackedTlsHTTPServer((self.host, self.requested_port), ssl_ctx, self)
            self._httpd, self.port = srv, int(srv.server_address[1])
            self._thread = threading.Thread(
                target=srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True
            )
            self._thread.start()
        except BaseException:
            self.stop()
            raise

    @contextlib.contextmanager
    def temporary_mitm_certificate(self, rogue_server: TlsTestServer) -> Any:
        assert self._httpd is not None and rogue_server._httpd is not None
        orig = self._httpd.ssl_context
        self._httpd.ssl_context = rogue_server._httpd.ssl_context
        try:
            yield
        finally:
            if self._httpd is not None:
                self._httpd.ssl_context = orig

    @contextlib.contextmanager
    def temporary_alt_certificate(self, variant: str) -> Any:
        assert self._httpd is not None and variant in self._alt_ssl_contexts
        orig = self._httpd.ssl_context
        self._httpd.ssl_context = self._alt_ssl_contexts[variant]
        try:
            yield self.alt_certs[variant]
        finally:
            if self._httpd is not None:
                self._httpd.ssl_context = orig

    def stop(self) -> None:
        self._stop_evt.set()
        if self._httpd is not None:
            with contextlib.suppress(Exception):
                self._httpd.shutdown()
                self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._tmp_dir is not None:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


def run_self_test() -> dict[str, Any]:
    with (
        TlsTestServer(label="primary-fixture", include_alt_certs=True) as primary,
        TlsTestServer(label="rogue-mitm-fixture") as rogue,
    ):
        assert len(primary.cert_der) > 200 and len(primary.alt_certs) == 6
        assert primary.cert_der_sha256_hex != rogue.cert_der_sha256_hex
        cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        cctx.check_hostname, cctx.verify_mode = False, ssl.CERT_NONE
        cctx.minimum_version = cctx.maximum_version = ssl.TLSVersion.TLSv1_3
        with (
            socket.create_connection((primary.host, primary.port), timeout=5.0) as raw,
            cctx.wrap_socket(raw, server_hostname="127.0.0.1") as ts,
        ):
            assert ts.version() == "TLSv1.3"
            assert ts.getpeercert(binary_form=True) == primary.cert_der
            req = f"GET /tls-check HTTP/1.1\r\nHost: 127.0.0.1:{primary.port}\r\nConnection: close\r\n\r\n"
            ts.sendall(req.encode())
            resp = b"".join(iter(lambda: ts.recv(4096), b"")).decode()
            parsed = json.loads(resp.split("\r\n\r\n", 1)[1])
            assert parsed["tls_verified"]
            assert parsed["cert_sha256"] == primary.cert_der_sha256_hex
        strict = ssl.create_default_context()
        with (
            contextlib.suppress(ssl.SSLError),
            socket.create_connection((primary.host, primary.port), timeout=5.0) as r2,
        ):
            strict.wrap_socket(r2, server_hostname="127.0.0.1").close()
            raise AssertionError("Expected SSL alert")
        dl = time.time() + 2.0
        while time.time() < dl and primary.snapshot_stats()["tlsHandshakeErrors"] < 1:
            time.sleep(0.02)
        stats, r_sha = primary.snapshot_stats(), rogue.cert_der_sha256_hex
        assert stats["tlsHandshakesOk"] == 1 and stats["tlsHandshakeErrors"] >= 1
        return {"selfTest": "PASS", "primary": stats, "rogueCertSha256": r_sha}


def main() -> None:
    p = argparse.ArgumentParser(description="Local TLS 1.3 HTTPS E2E Fixture Server")
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--port", type=int, default=0)
    args = p.parse_args()
    if args.self_test:
        print(json.dumps(run_self_test(), indent=2))
        return
    with TlsTestServer(port=args.port) as srv:
        print(json.dumps(srv.snapshot_stats(), indent=2), flush=True)
        with contextlib.suppress(KeyboardInterrupt):
            threading.Event().wait()


if __name__ == "__main__":
    main()

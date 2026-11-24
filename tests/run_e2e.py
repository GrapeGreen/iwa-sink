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

"""CLI test runner for the IWA Sink Playwright + FD 3/4 `CdpPipe` E2E suite."""

from __future__ import annotations

import argparse
import contextlib
import glob
import importlib
import json
import os
import sys
import time
import traceback
from collections.abc import Iterator
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import tests.pw_harness as h


def _default_cros_binary() -> str:
    env = os.environ
    if b := env.get("IWA_CROS_CHROME_BINARY") or env.get("CROS_CHROME_BINARY"):
        return b
    cand = os.path.expanduser("~/chromium/src/out/linux-chromeos/chrome")
    return cand if os.path.isfile(cand) and os.access(cand, os.X_OK) else ""


def discover_suite_specs(suite_filter: str = "") -> list[tuple[str, h.TestSpec]]:
    collected: list[tuple[str, h.TestSpec]] = []
    seen_ids: set[str] = set()
    sf = suite_filter.strip().lower()
    for path in sorted(glob.glob(os.path.join(REPO_ROOT, "tests/suites/test_*.py"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if sf and sf not in stem.lower():
            continue
        before = len(h._GLOBAL_REGISTRY)
        mod = importlib.import_module(f"tests.suites.{stem}")
        fn = getattr(mod, "build_tests", None)
        specs = list(fn() if fn else getattr(mod, "TESTS", h._GLOBAL_REGISTRY[before:]))
        for spec in specs:
            if spec.test_id not in seen_ids:
                seen_ids.add(spec.test_id)
                collected.append((stem, spec))
    return collected


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run IWA Sink Playwright E2E tests.")
    p.add_argument("--tier", choices=["1", "2", "3", "4", "5", "all"], default="all")
    p.add_argument("--suite", default="", help="Substring filter on suite name")
    p.add_argument("--filter", default="", help="Substring filter on ID/feature/title")
    p.add_argument("--include-swbn", action="store_true", help="Include .swbn tests")
    p.add_argument("--vite-url", default="", help="Existing Vite dev server URL")
    p.add_argument("--chrome-binary", default=h.DEFAULT_CHROME_BINARY)
    p.add_argument("--cros-chrome-binary", default=_default_cros_binary())
    p.add_argument("--json-report", "--json-out", dest="json_report", default="")
    p.add_argument("--list", action="store_true", help="List discovered tests")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    h.ensure_playwright_python()
    qf = args.filter.strip().lower()
    selected = [
        (sn, sp)
        for sn, sp in discover_suite_specs(args.suite)
        if (args.tier == "all" or str(sp.tier) == args.tier)
        and (not qf or qf in f"{sn} {sp.test_id} {sp.feature} {sp.title}".lower())
    ]
    if args.list:
        for sn, sp in selected:
            tag = " [swbn]" if sp.requires_swbn else ""
            print(f"[{sn}] T{sp.tier} {sp.test_id} ({sp.feature}): {sp.title}{tag}")
        print(f"Total listed: {len(selected)}")
        return 0
    if not selected:
        print("No matching E2E tests found.", file=sys.stderr)
        return 1

    from playwright.sync_api import sync_playwright

    results: list[dict[str, Any]] = []
    passed = failed = skipped = 0
    t_suite = time.time()

    def rec(sp: h.TestSpec, sn: str, st: str, ms: float, det: str = "") -> None:
        d = {"id": sp.test_id, "suite": sn, "tier": sp.tier, "status": st, "ms": ms}
        results.append({**d, **({"detail": det} if det else {})})

    with (
        h.TlsTestServer(label="e2e-primary-tls", include_alt_certs=True) as tls,
        h.TlsTestServer(label="e2e-rogue-tls") as rogue_tls,
        h.OidcTestServer(label="e2e-oidc") as oidc,
        h.ViteDevServerManager(REPO_ROOT, external_url=args.vite_url or None) as vite,
        h.XvfbOpenboxEnv(screen_spec="2560x1080x24") as xvfb,
        sync_playwright() as pw,
    ):
        spki = [tls.spki_sha256_b64, *tls.extra_spki_hashes, oidc.spki_sha256_b64]

        def mk_sess(cb: str, **kw: Any) -> h.PlaywrightIwaSession:
            s = h.PlaywrightIwaSession(pw, xvfb.display, cb, spki_hashes=spki, **kw)
            return s.start()

        primary = mk_sess(args.chrome_binary, vite_url=vite.base_url)
        extras: list[h.PlaywrightIwaSession] = []

        def _spawn_alt(cbin: str) -> h.PlaywrightIwaSession | None:
            if not cbin or not os.path.isfile(cbin):
                return None
            extras.append(sess := mk_sess(cbin, vite_url=vite.base_url))
            return sess

        @contextlib.contextmanager
        def _swbn_session(swbn_path: str, is_cros: bool = False) -> Iterator[Any]:
            cb = (args.cros_chrome_binary or args.chrome_binary) if is_cros else ""
            sess = mk_sess(cb or args.chrome_binary, swbn_path=swbn_path)
            try:
                yield sess
            finally:
                sess.close()

        cf = lambda: primary if primary.is_cros else _spawn_alt(args.cros_chrome_binary)
        ncf = lambda: (
            primary if not primary.is_cros else _spawn_alt(h.DEFAULT_CHROME_BINARY)
        )
        pos = (REPO_ROOT, vite.base_url, primary, tls, rogue_tls, oidc)
        fkw = {"cros_factory": cf, "non_cros_factory": ncf}
        ctx = h.E2EContext(
            *pos, args.include_swbn, swbn_session_factory=_swbn_session, **fkw
        )
        try:
            for idx, (sn, spec) in enumerate(selected):
                if spec.requires_swbn and not args.include_swbn:
                    skipped += 1
                    print(f"[SKIP] {spec.test_id} ({spec.title}) — pass --include-swbn")
                    rec(spec, sn, "SKIP", 0.0)
                    continue
                if idx > 0:
                    ctx.reset_app_state()
                wms = {id(s): s.watermark() for s in ctx.initialized_sessions()}
                t0 = time.time()
                try:
                    spec.fn(ctx)
                    ac = spec.allow_console_errors
                    for s in ctx.initialized_sessions():
                        s.assert_clean_diagnostics(ac, wms.get(id(s), 0))
                    ms = round((time.time() - t0) * 1000, 1)
                    passed += 1
                    print(
                        f"[PASS] {spec.test_id} [{sn}] {spec.title} ({ms}ms)",
                        flush=True,
                    )
                    rec(spec, sn, "PASS", ms)
                except h.SkipTestCase as sk:
                    ms = round((time.time() - t0) * 1000, 1)
                    skipped += 1
                    print(f"[SKIP] {spec.test_id} [{sn}] {sk} ({ms}ms)", flush=True)
                    rec(spec, sn, "SKIP", ms, str(sk))
                except Exception as exc:  # noqa: BLE001
                    ms = round((time.time() - t0) * 1000, 1)
                    failed += 1
                    tb = traceback.format_exc()
                    print(
                        f"[FAIL] {spec.test_id} [{sn}] {spec.title} ({ms}ms)\n{tb}",
                        flush=True,
                    )
                    rec(spec, sn, "FAIL", ms, str(exc))
        finally:
            for s in reversed(extras):
                s.close()
            primary.close()

    dur = round(time.time() - t_suite, 2)
    print(f"\nSummary: {passed} passed, {failed} failed, {skipped} skipped ({dur}s)")
    if args.json_report:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_report)), exist_ok=True)
        out: dict[str, Any] = {"passed": passed, "failed": failed, "skipped": skipped}
        out.update(durationSec=dur, results=results)
        with open(args.json_report, "w", encoding="utf-8") as jf:
            json.dump(out, jf, indent=2)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

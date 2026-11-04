# IWA Sink — Cross-Platform Isolated Web App Reference Suite

`iwa-sink` is a cross-platform desktop **Isolated Web App (IWA)** reference suite running across **Windows**, **macOS**, **Linux**, and **ChromeOS** (Chrome `>= 156`).

Built with Vanilla TypeScript, Vite 7, and Integrity Block v2 Ed25519 Web Bundle signing (`rollup-plugin-webbundle` + `wbn-sign`), `iwa-sink` demonstrates desktop-grade IWA capabilities inside a persistent **Warm Dark (`#24211e`) / Warm Light (`#faf7f2`)** single-page application shell that preserves live TCP sockets, `<controlledframe>` guest processes, `WebRequest` certificate inspectors, cross-window `BroadcastChannel` buses, and companion Chrome Extension connections across workspace navigation.

---

## Architecture Highlights

1. **Persistent Warm Dark / Warm Light SPA Shell (`index.html`, `src/main.ts`, `src/style.css`)**:
   - Mounts all supported capability workspaces once at startup into persistent `.workspace-view` containers (**7 workspaces on Windows, macOS, and Linux**; **8 workspaces on ChromeOS**, where `Screen Capture` and `Windowing → Unframed Window` are enabled).
   - Switching workspaces toggles non-detaching offscreen CSS (`.is-active` / `.is-hidden`) rather than unmounting DOM nodes or applying `display: none`, keeping active `TCPServerSocket`, `TCPSocket`, and `<controlledframe>` instances uninterrupted.
   - Synchronizes Warm Dark and Warm Light themes live across the parent shell, installed sub-app windows, and the ChromeOS `/hud.html` companion window via `BroadcastChannel('iwa-sink-theme')` and `BroadcastChannel('iwa-sink-subapps')`.
2. **Strict IWA CSP, COOP/COEP & Trusted Types Compliance**:
   - Enforces `base-uri 'none'`, `default-src 'self'`, `object-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `require-trusted-types-for 'script'`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: same-origin` (`window.crossOriginIsolated === true`).
   - Zero inline `<script>` tags and zero raw DOM string sinks in application code; all UI rendering uses `src/lib/dom.ts` (`document.createElement`, `createElementNS`, `textContent`, `replaceChildren`) and a singleton `TrustedTypePolicy` (`iwa-sink-sw`) for `/sw.js` Service Worker registration.
   - Respects IWA `connect-src 'self' https: wss: blob: data:` by serving loopback OAuth redirects over Direct Sockets (`TCPServerSocket` / `TCPSocket`) rather than cleartext renderer `fetch`.
3. **Multi-Entrypoint Sub-Apps, ChromeOS `unframed` Companion & Dynamic Service Worker**:
   - Framed standalone parent shell at `/` (`index.html`).
   - ChromeOS chromeless `(display-mode: unframed)` companion window at `/hud.html` (`src/hud/main.ts`), scoped via `URLPatternInit` `display_override` in `public/.well-known/manifest.webmanifest` (rendering a clear platform notice if opened directly on non-ChromeOS).
   - Bundled standalone Telnet sub-app in a disjoint scope (`/sub/telnet/index.html`) plus runtime user-defined dynamic sub-apps (`/dynamic/<slug>/*`) served identically by `src/sw.ts` in production `.swbn` bundles and `vite.config.ts` dev-proxy middleware.

---

## Capability Workspaces

### 1. Overview (`src/workspaces/overview/`)

- Default landing workspace presenting an interactive **Capability Directory** with platform-aware plain-English descriptions and one-click `Open →` workspace launchers (`6` capability cards on Windows/macOS/Linux; `7` on ChromeOS including `Screen Capture`).

### 2. TCP Echo — Direct Sockets Server & ANSI Terminal Client (`src/workspaces/tcp-terminal/`, `src/lib/streams.ts`)

- Runs an in-app single-family loopback `TCPServerSocket` echo listener bound strictly to `127.0.0.1` (IPv4) or `::1` (IPv6) with `dualStack: false`, supporting OS-assigned ephemeral ports (`0` or blank) or custom ports (`1–65535`), honest `ADDRINUSE` conflict reporting, active client and echoed byte counters (`tabular-nums`), and server-to-client broadcast messaging.
- Pairs with an interactive `TCPSocket` ANSI SGR terminal client supporting local loopback echo or arbitrary remote `host:port` targets, streaming UTF-8 decoding, non-trapping keyboard navigation (WCAG 2.2 AA `SC 2.1.2`), immediate `AbortController` mid-SYN disconnect cancellation, and lock-free `ReadableStream` / `WritableStream` teardown.

### 3. Controlled Frame & Live X.509 Certificate Inspector (`src/workspaces/controlled-frame-tls/`, `src/lib/protocol.ts`)

- Embeds cross-origin HTTPS and HTTP pages inside `<controlledframe>` using an isolated `persist:iwa-workspace` storage partition with URL omnibox, Back / Forward / Reload navigation, `clearData()` storage wipe, `executeScript()` JavaScript and `insertCSS()` stylesheet injection, and resizable viewport height.
- Inspects live server X.509 leaf certificates captured via `WebRequest.onHeadersReceived` (`securityInfo` + `securityInfoRawDer`), parsing ASN.1 DER Subject, SAN count, Issuer, Public Key algorithm & validity window, and colon-delimited SHA-256 fingerprint (`src/workspaces/controlled-frame-tls/x509-der-parser.ts`), while routing incoming `cf://` and `web+cf://` OS protocol launches via `window.launchQueue` (`client_mode: "focus-existing"`) to open Controlled Frame and run predefined CSS/JS injectors (such as `cf://?text=Lucky&color=peachpuff` or `web+cf://https://example.com`).

### 4. SSO Loopback — External-Browser OAuth 2.0 PKCE (`src/workspaces/sso-offloading/`)

- Performs extension-free desktop OAuth 2.0 + RFC 7636 **PKCE (`S256`)** authentication by validating the OAuth 2.0 Desktop `Client ID`, binding an ephemeral `TCPServerSocket('127.0.0.1')` HTTP/1.1 callback listener (`/callback`), and launching the authorization URL in the system browser (`window.open(..., 'iwa_sso_oauth_popup', 'popup=yes,width=520,height=680,...,noopener')`).
- Serves a CSP-hardened (`nonce-...`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`), Dark/Light WCAG-compliant callback completion page, exchanges the single-use authorization code + `code_verifier` for tokens (keeping optional `Client Secret` strictly in memory — never written to `localStorage`), decodes `id_token` claims (`id_token claims decoded`), tracks live remaining token expiry across reloads, and provides race-free `Cancel` and `Sign Out` controls.

### 5. Sub-Apps & Dynamic Service-Worker App Builder (`src/workspaces/sub-apps/`, `src/sw.ts`, `sub/telnet/`)

- Wraps `window.subApps` / `navigator.subApps` (`add`, `list`, `remove`) to install, launch, track, and uninstall standalone child IWAs synchronized over `BroadcastChannel('iwa-sink-subapps')`.
- Ships the bundled **Telnet Terminal** sub-app (`/sub/telnet/index.html`) alongside an interactive **Custom App Builder** that synthesizes `/dynamic/<slug>/index.html`, `/dynamic/<slug>/manifest.webmanifest` (with optional `file_handlers` and custom manifest fields), and `512×512` RGBA maskable PNG icons (`src/lib/png512.ts`) on the fly.

### 6. Windowing & ChromeOS `unframed` Companion (`src/workspaces/windowing-hud/`, `hud.html`, `src/hud/main.ts`)

- Exercises Desktop Additional Windowing Controls (`window.minimize()`, `window.maximize()`, `window.restore()`, `window.setResizable()`) with serialized rollback on unsupported window managers, live window geometry telemetry, and multi-display inspection (`window.getScreenDetails()`).
- On **ChromeOS**, exposes a second **Unframed Window** tab that spawns and focuses `/hud.html` in `(display-mode: unframed)` with custom `app-region: drag` / `app-region: no-drag` titlebar controls (`Focus Shell` and `Close`) and live shell telemetry.

### 7. Screen Capture — ChromeOS Only (`src/workspaces/screen-capture/`)

- Mounted exclusively on **ChromeOS**: captures a single display via `navigator.mediaDevices.getDisplayMedia()` or streams all connected displays simultaneously via `navigator.mediaDevices.getAllScreensMedia()` into live `<video>` tiles with real track dimensions/frame rates, per-tile `Stop` and `Stop All` teardown, and actionable `MultiScreenCaptureAllowedForUrls` enterprise policy guidance when multi-screen capture is restricted.

### 8. Extension Connectivity (`src/workspaces/extension-bridge/`, `extension/IwaKitchenSinkExtension/`)

- Dispatches structured JSON messages from the IWA to an `externally_connectable` Manifest V3 Chrome Extension via `chrome.runtime.sendMessage(extensionId, payload, callback)`, enforcing strict `/^[a-p]{32}$/` Extension ID and `JSON.parse` validation before dispatch.
- Renders prettified JSON responses (recursively unwrapping nested JSON strings while preserving `null` and `"__proto__"` keys) with one-click clipboard copy and collapsible console logs, paired with the unpacked companion extension in `extension/IwaKitchenSinkExtension/`.

---

## Prerequisites & Required Chrome `>= 156` Flags

- **Desktop OS**: **Windows** 10/11, **macOS** 13+, **Linux** (X11/Wayland), or **ChromeOS**.
- **Browser**: Google Chrome / Chromium **156 or newer**.
- **Node.js & Package Manager**: Node.js `>= 22` and `pnpm` (`pnpm@9.5.0`, pinned to `https://registry.npmjs.org/` via `.npmrc`).
- **Python 3** (`>= 3.10`, optional for running the automated Playwright + Chrome CDP E2E suite in `tests/run_e2e.py`; install Python and X11 prerequisites via `pip install -r tests/requirements.txt` and `sudo apt-get install -y xvfb openbox`).

Launch Chrome `>= 156` with the required IWA capability feature flags enabled:

```bash
# Linux
/opt/google/chrome/chrome \
  --user-data-dir=/tmp/iwa-sink-profile \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode,DirectSockets,ControlledFrame,SubApps,UnframedIwa,DesktopPWAsAdditionalWindowingControls

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/iwa-sink-profile \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode,DirectSockets,ControlledFrame,SubApps,UnframedIwa,DesktopPWAsAdditionalWindowingControls

# Windows (PowerShell)
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:TEMP\iwa-sink-profile" `
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode,DirectSockets,ControlledFrame,SubApps,UnframedIwa,DesktopPWAsAdditionalWindowingControls
```

On **ChromeOS**, enable `chrome://flags/#enable-isolated-web-apps` and `chrome://flags/#enable-isolated-web-app-dev-mode` (and configure the `MultiScreenCaptureAllowedForUrls` policy for the IWA's `isolated-app://` origin when testing unattended `getAllScreensMedia()`).

---

## Dev-Proxy Quickstart

Iterate directly against the live Vite 7 dev server before building a signed `.swbn` bundle:

```bash
# 1. Install dependencies from the public npm registry
pnpm install

# 2. Run strict TypeScript verification (tsc --noEmit)
pnpm typecheck

# 3. Start the Vite dev server on http://127.0.0.1:5193
pnpm dev
```

To install the running dev-proxy IWA into Chrome:

1. Launch Chrome `>= 156` with the `--enable-features=...` flags shown above.
2. Open `chrome://web-app-internals`.
3. Under **Install IWA from Dev Mode Proxy**, enter `http://127.0.0.1:5193/` and click **Install**.
4. Launch **IWA Sink** from `chrome://apps` (or your OS app launcher). When prompted (or via Site Settings for the `isolated-app://` origin), allow **Direct Sockets**, **Local network / Loopback network**, **Window management**, and **Sub-Apps**.

---

## Building & Installing a Signed Web Bundle (`.swbn`)

`vite.config.ts` packages all multi-entry HTML routes (`index.html`, `hud.html`, `sub/telnet/index.html`), the root Service Worker (`src/sw.ts` → `sw.js`), the dynamic sub-app client (`src/lib/subapp-dynamic-client.ts` → `subapp-dynamic-client.js`), and `public/.well-known/manifest.webmanifest` into an Integrity Block v2 Ed25519-signed Web Bundle at `dist/iwa-sink.swbn`:

```bash
pnpm build
```

- **Zero-Config Dev Key Auto-Generation**: When neither `SIGNING_KEY` nor `KEY` is set in your environment or `.env`, `vite.config.ts` automatically generates an unencrypted Ed25519 PKCS#8 private key at `certs/dev-ed25519.pem` (gitignored) so `pnpm build` succeeds headlessly from a clean checkout without interactive prompts.
- **Custom or Encrypted Ed25519 Signing Key**: Set `SIGNING_KEY=/path/to/ed25519.pem` (and optional `KEY_PASSPHRASE` when using an encrypted PKCS#8 PEM key) in your environment or `.env` before running `pnpm build`.
- **Installing `dist/iwa-sink.swbn`**: Open `chrome://web-app-internals`, click **Select file...** under **Install IWA from Signed Web Bundle**, and select `dist/iwa-sink.swbn`.

---

## Companion Chrome Extension Setup (`Extension Connectivity`)

`extension/IwaKitchenSinkExtension/` provides the unpacked Manifest V3 companion extension (`"externally_connectable": { "matches": ["isolated-app://*/*"] }`) pinned to the deterministic Extension ID `gopkidjpdjfamphfffkhpmmmbmknflmk` (alongside `extension/IwaKitchenSinkExtension.crx` and `extension/extension_manifest.xml` for managed ChromeOS policy deployments):

1. In the same Chrome profile where **IWA Sink** is installed, open `chrome://extensions`.
2. Toggle **Developer mode** on in the top-right corner.
3. Click **Load unpacked** and select the `extension/IwaKitchenSinkExtension` directory from this repository.
4. Confirm the card displays **IWA Kitchen Sink Companion Extension** with ID `gopkidjpdjfamphfffkhpmmmbmknflmk`.
5. In **IWA Sink → Extension**, click **Send Message** to test:
   - `{"api":"chrome.identity.getProfileUserInfo"}` (or `{"api":"chrome.identity.getProfileUserInfo","accountStatus":"ANY"}`) — queries `chrome.identity.getProfileUserInfo` and unwraps the nested JSON profile output.
   - `"version"` — returns `{"status":"OK","version":"1.1"}`.
   - Any other valid JSON value (object, array, string, number, boolean, or `null`) — echoed back with `senderOrigin` and `extensionId`.

---

## Google Cloud Desktop OAuth 2.0 Client Setup (`SSO Loopback`)

To authenticate with a live Google account in **SSO Loopback**:

1. Open the [Google Cloud Console Credentials page](https://console.cloud.google.com/apis/credentials) in a project with an OAuth consent screen configured.
2. Click **Create Credentials → OAuth client ID** and select Application type **Desktop app** (Desktop OAuth clients permit dynamic `http://127.0.0.1:<port>/callback` loopback redirects per RFC 8252).
3. Copy the generated Client ID (`<YOUR_CLIENT_ID>.apps.googleusercontent.com`) and, if issued by Google Cloud for your Desktop client, the Client Secret.
4. In **IWA Sink → SSO Loopback**, paste your **Client ID** (persisted locally under `localStorage['iwa-sink.google.clientId']`) and optional **Client Secret** (kept strictly in memory for the active session and never written to `localStorage`).
5. Click **Sign in with Google ↗** — `IWA Sink` binds an ephemeral `127.0.0.1:<port>` listener, opens Google's consent screen in the system browser, verifies the `state` token on `/callback`, exchanges the authorization code + PKCE `code_verifier`, and displays the decoded account profile and live token expiry.

_(Automated E2E suites exercise the exact same PKCE `S256` + `127.0.0.1` callback codepath offline via the local HTTPS `tests/fixtures/oidc_test_server.py` fixture.)_

---

## Automated Playwright + Chrome CDP End-to-End Suite (`tests/run_e2e.py`)

`tests/run_e2e.py` and `tests/pw_harness.py` drive isolated `Xvfb` + `openbox` Chrome `156+` and ChromeOS (`linux-chromeos`) sessions via Playwright `connect_over_cdp` paired with a minimal FD 3/4 `--remote-debugging-pipe` client (`PWA.install`, `PWA.launch`, `PWA.launchFilesInApp`, `PWA.getOsAppState`, `Extensions.loadUnpacked`), spinning up deterministic local TLS (`tests/fixtures/tls_test_server.py`) and HTTPS OIDC PKCE (`tests/fixtures/oidc_test_server.py`) fixtures across **72 end-to-end test cases** in `tests/suites/` (`test_shell_hygiene_wcag.py`, `test_controlled_frame.py`, `test_sso_and_extension.py`, `test_subapps_and_swbn.py`, and `test_tcp_win_cros.py`):

```bash
# Install Python test dependencies and headless X11 window manager prerequisites (Debian/Ubuntu)
pip install -r tests/requirements.txt
sudo apt-get install -y xvfb openbox

# List all registered E2E test cases without launching Chrome
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --list

# Run individual suites or tiers against the live Vite dev-proxy IWA
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --suite test_shell_hygiene_wcag
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --tier 1

# Run the complete E2E suite PLUS clean `pnpm build` & signed `dist/iwa-sink.swbn` install gate
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --tier all --include-swbn --json-report /tmp/e2e-report.json

# Filter by feature/test ID or override Chrome / ChromeOS binaries
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --filter SH-07
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --tier all --include-swbn \
  --chrome-binary /opt/google/chrome/chrome \
  --cros-chrome-binary /path/to/linux-chromeos/chrome
```

---

## Repository Layout

| Path                                                        | Purpose                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                              | Scripts (`dev`, `build`, `typecheck`, `preview`, `format`, `bump`) and Vite 7 / `wbn-sign` toolchain                                                                 |
| `public/.well-known/manifest.webmanifest`                   | Chrome 156+ IWA manifest (`permissions_policy`, `/hud.html` `unframed` `display_override`, `cf`/`web+cf` `protocol_handlers`, `focus-existing` `launch_handler`)     |
| `vite.config.ts`                                            | Multi-entry Rollup config, dev-proxy dynamic sub-app middleware, and headless Ed25519 `.swbn` bundler (`SIGNING_KEY` or auto-generated `certs/dev-ed25519.pem`)      |
| `index.html`, `src/main.ts`, `src/style.css`                | Persistent Warm Dark / Warm Light SPA shell, `ShellContext`, `window.launchQueue` router, and `BroadcastChannel` telemetry emitter                                   |
| `hud.html` & `src/hud/main.ts`                              | ChromeOS `(display-mode: unframed)` companion window (`app-region: drag` / `no-drag`) and non-ChromeOS platform guard                                                |
| `src/sw.ts`                                                 | Root Service Worker (`/sw.js`) serving dynamic sub-app HTML, manifests (`file_handlers`), IWA COI/CSP headers, and `512×512` maskable PNGs                           |
| `src/lib/`                                                  | Trusted-Types DOM utilities (`dom.ts`), `TCPSocket`/`TCPServerSocket` stream wrappers (`streams.ts`), protocol parser (`protocol.ts`), bus, and PNG/sub-app builders |
| `src/workspaces/overview/`                                  | Workspace 1 — Platform-aware Capability Directory & workspace launcher                                                                                               |
| `src/workspaces/tcp-terminal/`                              | Workspace 2 — Single-family IPv4/IPv6 `TCPServerSocket` echo server & interactive `TCPSocket` ANSI terminal                                                          |
| `src/workspaces/controlled-frame-tls/`                      | Workspace 3 — `<controlledframe>` browser, script/CSS injection, `cf://`/`web+cf://` consumer & live X.509 certificate inspector                                     |
| `src/workspaces/sso-offloading/`                            | Workspace 4 — External-browser Google OAuth 2.0 PKCE (`S256`) sign-in over `127.0.0.1` `TCPServerSocket` HTTP/1.1 loopback                                           |
| `src/workspaces/sub-apps/` & `sub/telnet/`                  | Workspace 5 — `SubApps` manager, bundled Telnet Terminal sub-app (`/sub/telnet/index.html`), and Dynamic Sub-App Builder                                             |
| `src/workspaces/windowing-hud/`                             | Workspace 6 — Additional Windowing Controls, `getScreenDetails()`, and ChromeOS `unframed` `/hud.html` companion launcher                                            |
| `src/workspaces/screen-capture/`                            | Workspace 7 (ChromeOS only) — `getDisplayMedia()` single-screen & `getAllScreensMedia()` multi-screen video tile capture                                             |
| `src/workspaces/extension-bridge/`                          | Workspace 8 — External MV3 Chrome Extension JSON bridge (`chrome.runtime.sendMessage`)                                                                               |
| `extension/IwaKitchenSinkExtension/`                        | Unpacked Manifest V3 companion Chrome Extension (`gopkidjpdjfamphfffkhpmmmbmknflmk`, `externally_connectable` for `isolated-app://*/*`)                              |
| `tests/run_e2e.py`, `tests/pw_harness.py` & `tests/suites/` | Playwright `connect_over_cdp` + `CdpPipe` Chrome 156+ & ChromeOS E2E runner, capability suites (72 tests), and local TLS/OIDC fixtures (`tests/fixtures/`)           |

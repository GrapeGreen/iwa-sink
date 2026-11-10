# How to Contribute

We would love to accept your patches and contributions to this project.

## Before you begin

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about) (CLA).
You (or your employer) retain the copyright to your contribution; this simply
gives us permission to use and redistribute your contributions as part of the
project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or to
sign a new one.

### Review our Community Guidelines

This project follows [Google's Open Source Community
Guidelines](https://opensource.google/conduct/).

## Contribution process

### Code Reviews

All submissions, including submissions by project members, require review. We
use [GitHub pull requests](https://docs.github.com/articles/about-pull-requests)
for this purpose.

## Local Development & Signing Setup

### 1. Zero-Config Local Development & `.swbn` Build

`vite.config.ts` automatically generates an unencrypted Ed25519 PKCS#8 development signing key at `certs/dev-ed25519.pem` (gitignored) whenever `SIGNING_KEY` and `KEY` are unset, so clean checkouts build headlessly without manual key setup:

```bash
# Install dependencies (Node.js >= 22, pnpm@9.5.0)
pnpm install

# Verify strict TypeScript types
pnpm typecheck

# Start the Vite dev-proxy server on http://127.0.0.1:5193
pnpm dev

# Build dist/ and sign dist/iwa-sink.swbn (auto-creates certs/dev-ed25519.pem if absent)
pnpm build
```

### 2. Using a Custom or Encrypted Ed25519 Signing Key (Optional)

If you want to sign `dist/iwa-sink.swbn` with your own encrypted PKCS#8 Ed25519 key instead of the auto-generated `certs/dev-ed25519.pem` key, specify **both** `SIGNING_KEY` (or `KEY`) and `KEY_PASSPHRASE` in `.env` (or environment variables):

```bash
mkdir -p certs
openssl genpkey -algorithm Ed25519 -out certs/temp.pem
openssl pkcs8 -in certs/temp.pem -topk8 -out certs/encrypted_key.pem
rm certs/temp.pem
```

Create `.env` (gitignored):

```env
SIGNING_KEY=certs/encrypted_key.pem
KEY_PASSPHRASE=your_passphrase
```

Then run `pnpm build`. Never commit `.env` files, private `.pem` keys, or OAuth client secrets to version control.

### 3. Loading the Unpacked Companion Extension (Optional)

When working on the **Extension Connectivity** workspace (`src/workspaces/extension-bridge/`):

1. Open `chrome://extensions` in your test Chrome profile and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/IwaKitchenSinkExtension` (pinned to deterministic ID `gopkidjpdjfamphfffkhpmmmbmknflmk`).

### 4. Verification Gates Before Submitting a Pull Request

Please verify type safety, production `.swbn` bundling, and the automated Playwright + Chrome CDP E2E suite (`tests/run_e2e.py`) before opening a PR (on Linux, install the E2E suite prerequisites first with `pip install -r tests/requirements.txt` and `sudo apt-get install -y xvfb openbox`):

```bash
pip install -r tests/requirements.txt
pnpm typecheck
pnpm build
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/run_e2e.py --tier all --include-swbn
```

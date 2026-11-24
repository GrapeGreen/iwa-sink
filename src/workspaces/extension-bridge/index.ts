/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createAlertBanner,
  createCard,
  createCopyIconButton,
  createLogConsole,
  createWorkspaceHeader,
  el,
  formatLogTime,
  syncCopyButton,
  wrapInputWithCopy,
} from '../../lib/dom';
import type {
  ShellContext,
  WorkspaceDefinition,
  WorkspaceLiveStatus,
} from '../../shell/contracts';

const DEFAULT_EXT_ID = 'gopkidjpdjfamphfffkhpmmmbmknflmk';
const DEFAULT_PAYLOAD = '{"api":"chrome.identity.getProfileUserInfo"}';
const SUBTITLE =
  'Dispatch external JSON messages (such as "version", {"api":"chrome.identity.getProfileUserInfo"}, or custom JSON) to an unpacked or installed companion Chrome Extension (extension/IwaKitchenSinkExtension via chrome://extensions).';
const EMPTY_TEXT =
  'No response yet — click "Send Message" above to query the extension.';
const UNPACKED_SETUP_HINT =
  'Load unpacked extension/IwaKitchenSinkExtension via chrome://extensions (enable Developer mode) to connect the default companion extension.';
const NO_RT_ERR = 'Extension is not installed or is not externally_connectable';
const EMPTY_MSG_ERR =
  'Message Payload is empty — enter valid JSON (e.g. "version").';
const EXT_ID_RE = /^[a-p]{32}$/;
const TIMEOUT_MS = 8000;
const MAX_NODES = 512;
const MAX_PRETTY = 16384;
const MAX_RENDER = 8192;
const DATA_DESC = { enumerable: true, configurable: true, writable: true };

interface ChromeRuntimeExt {
  lastError?: { message?: string };
  sendMessage?: (id: string, msg: unknown, cb: (resp: unknown) => void) => void;
}
type RespTone = 'ok' | 'err' | 'pending';
type Kids = Array<Node | string>;

const div = (c: string, ...ch: Kids) => el('div', c, ...ch);
const span = (c: string | null, t: string) => el('span', c, t);
const errStr = (e: unknown) => (e instanceof Error ? e.message : String(e));

function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
function mkInput(id: string, val: string, ph: string) {
  const i = tid(el('input', 'form-input mono sso-cred-input'), id);
  i.id = id;
  i.type = 'text';
  i.value = val;
  i.placeholder = ph;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

function normalizeJson(v: unknown, b: { n: number }, d = 0): unknown {
  if (d > 5 || b.n >= MAX_NODES) return v;
  b.n += 1;
  if (typeof v === 'string') {
    const t = v.trim();
    const pair = `${t[0] ?? ''}${t[t.length - 1] ?? ''}`;
    if (t.length <= MAX_PRETTY && (pair === '{}' || pair === '[]')) {
      try {
        return normalizeJson(JSON.parse(t), b, d + 1);
      } catch {}
    }
    return v;
  }
  if (Array.isArray(v))
    return v.length > MAX_NODES ? v : v.map((x) => normalizeJson(x, b, d + 1));
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length > MAX_NODES) return v;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const value = normalizeJson(rec[k], b, d + 1);
      Object.defineProperty(out, k, { ...DATA_DESC, value });
    }
    return out;
  }
  return v;
}

function formatExtensionResponseJson(val: unknown): string {
  try {
    const compact = JSON.stringify(val);
    const trunc = (s: string) => {
      const cut = s.length - MAX_RENDER;
      return cut > 0
        ? `${s.slice(0, MAX_RENDER)}\n… [truncated ${cut} characters]`
        : s;
    };
    if (compact !== undefined && compact.length > MAX_PRETTY)
      return trunc(compact);
    const norm = normalizeJson(val, { n: 0 });
    return trunc(JSON.stringify(norm, null, 2) ?? String(norm));
  } catch {
    return String(val);
  }
}

function logPreview(val: unknown): string {
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val) ?? `${val}`;
    return s.length > 320 ? `${s.slice(0, 320)}… (${s.length} chars)` : s;
  } catch {
    return String(val).slice(0, 320);
  }
}

function mountExtensionBridge(container: HTMLElement, ctx: ShellContext): void {
  const setStatus = (state: WorkspaceLiveStatus['state'], label: string) =>
    ctx.setWorkspaceStatus('extension-bridge', { state, label });
  const initLine = `[${formatLogTime()}] [init] Extension bridge ready — load unpacked extension/IwaKitchenSinkExtension in chrome://extensions (Developer mode) or enter any 32-character Extension ID, then click "Send Message".`;
  const log = createLogConsole({
    title: 'Extension Console Log',
    logTestId: 'ext-console-log',
    clearBtnTestId: 'ext-clear-log-btn',
    toggleTestId: 'ext-toggle-console-btn',
    cardTestId: 'ext-console-card',
    cardClassName: 'sso-log-card',
    bodyId: 'ext-console-panel',
    ariaLabel: 'Extension Console Log',
    maxLines: 100,
    initialLines: [initLine],
  });
  const L = (s: string) => log.append(s);

  const idInp = mkInput('ext-id-input', DEFAULT_EXT_ID, DEFAULT_EXT_ID);
  const msgPh = `e.g. ${DEFAULT_PAYLOAD} or "version"`;
  const msgInp = mkInput('ext-message-input', DEFAULT_PAYLOAD, msgPh);
  const withCopy = (i: HTMLInputElement, testId: string, title: string) =>
    wrapInputWithCopy(i, { testId, title, alwaysShow: true });
  const idWrap = withCopy(idInp, 'ext-copy-id-btn', 'Copy Extension ID');
  const msgWrap = withCopy(
    msgInp,
    'ext-copy-payload-btn',
    'Copy Message Payload',
  );
  const errBanner = createAlertBanner({
    id: 'ext-error-banner',
    testId: 'ext-error-banner',
    className: 'ext-error-banner',
  });

  const setInvalid = (inp: HTMLInputElement, bad: boolean) => {
    if (bad) {
      inp.setAttribute('aria-invalid', 'true');
      inp.setAttribute('aria-describedby', 'ext-error-banner');
    } else {
      inp.removeAttribute('aria-invalid');
      inp.removeAttribute('aria-describedby');
    }
    inp.classList.toggle('is-invalid', bad);
    (inp === idInp ? idWrap : msgWrap).classList.toggle('is-invalid', bad);
  };
  const clearErr = () => {
    errBanner.clear();
    setInvalid(idInp, false);
    setInvalid(msgInp, false);
  };

  const sendCls = 'btn btn-primary btn-sm ext-send-btn';
  const sendBtn = el('button', sendCls, span(null, 'Send Message'));
  tid(sendBtn, 'ext-send-btn').type = 'button';
  const stCls = 'sso-account-status-badge ext-response-status mono';
  const statusEl = tid(span(stCls, 'Idle'), 'ext-response-status');
  const preCls =
    'terminal-surface cf-console-log ext-json-viewer is-empty mono tabular-nums';
  const respPre = tid(el('pre', preCls, EMPTY_TEXT), 'ext-response-json');
  respPre.tabIndex = 0;
  respPre.setAttribute('aria-label', 'Extension Response JSON');

  let hasResp = false;
  const copyRespBtn = createCopyIconButton({
    getText: () => (hasResp ? respPre.textContent ?? '' : ''),
    title: 'Copy response JSON',
    testId: 'ext-copy-response-btn',
    className: 'ext-copy-json-btn',
    size: 14,
    watchEl: respPre,
  });
  const setResp = (
    b: string,
    tone: RespTone,
    okBody: boolean,
    body?: unknown,
  ) => {
    statusEl.textContent = statusEl.title = b;
    statusEl.classList.toggle('is-authenticated', tone === 'ok');
    statusEl.classList.toggle('is-error', tone === 'err');
    hasResp = tone !== 'pending' && okBody;
    respPre.classList.toggle('is-empty', !hasResp);
    const wait = 'Sending message to companion extension…';
    const fb = tone === 'pending' ? wait : EMPTY_TEXT;
    respPre.textContent = hasResp ? formatExtensionResponseJson(body) : fb;
    respPre.scrollTop = 0;
    syncCopyButton(copyRespBtn);
  };

  let activeReqSeq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  window.addEventListener('pagehide', () => {
    activeReqSeq += 1;
    clearTimer();
  });

  const failInvalid = (inp: HTMLInputElement, b: string, error: string) => {
    const extensionId = idInp.value.trim();
    errBanner.show(error);
    setInvalid(inp, true);
    L(`[validation] ${error}`);
    setResp(b, 'err', true, { ok: false, extensionId, error });
    setStatus('offline', b);
  };
  const failUnreach = (
    id: string,
    req: unknown,
    base: string,
    nav: string,
    bnr = base,
  ) => {
    const isDef = id === DEFAULT_EXT_ID;
    const full = isDef ? `${bnr} — ${UNPACKED_SETUP_HINT}` : bnr;
    errBanner.show(full);
    L(`[error <- ${id}] ${full}`);
    const hint = isDef ? { setupHint: UNPACKED_SETUP_HINT } : {};
    const body = {
      ok: false,
      extensionId: id,
      request: req,
      error: base,
      ...hint,
    };
    setResp('Extension Unreachable', 'err', true, body);
    setStatus('portal', nav);
  };

  const dispatch = () => {
    sendBtn.classList.add('is-pressed');
    setTimeout(() => sendBtn.classList.remove('is-pressed'), 160);
    activeReqSeq += 1;
    clearTimer();
    clearErr();

    const extId = idInp.value.trim();
    if (!EXT_ID_RE.test(extId)) {
      const err = extId
        ? `Invalid Extension ID "${extId}" — expected a 32-character lowercase Chrome Extension ID ([a-p]{32}).`
        : 'Extension ID is required — enter a 32-character Chrome Extension ID ([a-p]{32}).';
      return failInvalid(idInp, 'Invalid Extension ID', err);
    }
    if (idInp.value !== extId) idInp.value = extId;

    const raw = msgInp.value.trim();
    if (!raw) return failInvalid(msgInp, 'Invalid JSON', EMPTY_MSG_ERR);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      const msg = `Invalid JSON payload: ${errStr(e)}`;
      return failInvalid(msgInp, 'Invalid JSON', msg);
    }

    L(`[tx -> ${extId}] (json) chrome.runtime.sendMessage(${logPreview(raw)})`);
    const w = window as unknown as { chrome?: { runtime?: ChromeRuntimeExt } };
    const rt = w.chrome?.runtime;
    if (!rt || typeof rt.sendMessage !== 'function')
      return failUnreach(extId, payload, NO_RT_ERR, 'API Unavailable');

    const mySeq = activeReqSeq;
    setResp('Sending…', 'pending', false);
    setStatus('probing', `Sending to ${extId.slice(0, 8)}…`);
    timer = setTimeout(() => {
      timer = null;
      if (mySeq !== activeReqSeq) return;
      activeReqSeq += 1;
      const msg = `Extension ${extId} did not respond within ${TIMEOUT_MS / 1000}s.`;
      failUnreach(extId, payload, msg, 'Extension Timeout');
    }, TIMEOUT_MS);

    try {
      rt.sendMessage(extId, payload, (resp: unknown) => {
        const lastErr = rt.lastError;
        if (mySeq !== activeReqSeq) return;
        clearTimer();
        if (lastErr) {
          const m = lastErr.message ?? 'Unknown runtime.lastError';
          const bnr = `Extension unreachable (${extId}): ${m}`;
          return failUnreach(extId, payload, m, 'Extension Unreachable', bnr);
        }
        const isObj = Boolean(resp && typeof resp === 'object');
        const obj = isObj ? (resp as Record<string, unknown>) : null;
        if (obj?.status === 'Error') {
          const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
          const fb = 'Companion extension reported an error.';
          const d = str(obj.output) || str(obj.message) || str(obj.error) || fb;
          errBanner.show(`Extension returned an error: ${d}`);
          L(`[error <- ${extId}] ${logPreview(resp)}`);
          setResp('Extension Error', 'err', true, resp);
          return setStatus('portal', 'Extension Error');
        }
        clearErr();
        const eff = resp === undefined ? { ok: true, response: null } : resp;
        L(`[rx <- ${extId}] ${logPreview(eff)}`);
        setResp('Received', 'ok', true, eff);
        setStatus('online', 'Connected');
      });
    } catch (err) {
      if (mySeq !== activeReqSeq) return;
      clearTimer();
      const m = errStr(err);
      const bnr = `Extension dispatch failed (${extId}): ${m}`;
      failUnreach(extId, payload, m, 'Extension Unreachable', bnr);
    }
  };

  sendBtn.addEventListener('click', dispatch);
  for (const a of [idInp, msgInp]) {
    const b = a === idInp ? msgInp : idInp;
    a.addEventListener('input', () => {
      setInvalid(a, false);
      if (!b.hasAttribute('aria-invalid')) errBanner.clear();
    });
    a.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      dispatch();
    });
  }

  const mkCol = (cls: string, id: string, lbl: string, wrap: HTMLElement) => {
    const l = el('label', 'sso-field-label', lbl);
    l.htmlFor = id;
    return div(`sso-field-col ${cls}`, l, wrap);
  };
  const idCol = mkCol('ext-field-id', 'ext-id-input', 'Extension ID', idWrap);
  const msgColCls = 'sso-field-id ext-field-payload';
  const msgCol = mkCol(
    msgColCls,
    'ext-message-input',
    'Message Payload (JSON)',
    msgWrap,
  );
  const row = div('sso-creds-row ext-inputs-row', idCol, msgCol, sendBtn);
  const bridgeCard = createCard({
    title: 'Companion Extension Bridge',
    testId: 'ext-bridge-card',
    className: 'sso-creds-card ext-bridge-card',
    headerClassName: 'sso-card-header',
    bodyClassName: 'sso-creds-body',
    body: [row, errBanner.root],
  });
  const rHdrCls = 'cf-tls-card-header sso-account-header ext-response-header';
  const respCard = createCard({
    title: 'Extension Response',
    headerRight: div('ext-response-header-right', statusEl, copyRespBtn),
    testId: 'ext-response-card',
    className: 'cf-tls-card sso-account-card ext-response-card',
    headerClassName: rHdrCls,
    bodyClassName: 'cf-tls-cert-body sso-account-body ext-response-body',
    body: respPre,
  });
  const hdr = createWorkspaceHeader({
    title: 'Extension Connectivity',
    subtitle: SUBTITLE,
    className: 'sso-header',
  });
  container.replaceChildren(hdr, bridgeCard.root, respCard.root, log.root);
  setStatus('probing', 'Standby');
  L(`[ready] Default companion Extension ID ${DEFAULT_EXT_ID} loaded.`);
}

export const extensionBridgeWorkspace: WorkspaceDefinition = {
  id: 'extension-bridge',
  navLabel: 'Extension',
  title: 'Extension Connectivity',
  subtitle: SUBTITLE,
  mount: mountExtensionBridge,
};

export const workspace = extensionBridgeWorkspace;
export default extensionBridgeWorkspace;

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
  createMetaBox,
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
import {
  type OAuthCallbackServerHandle,
  startOAuthCallbackServer,
} from './http-loopback';
import { generatePkceMaterial } from './pkce';

interface TestOidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint?: string;
}
declare global {
  interface Window {
    __IWA_TEST_OIDC_CONFIG__?: TestOidcConfig;
  }
}
interface AccountSnap {
  name: string;
  email: string;
  sub: string;
  issuer: string;
  scope: string;
  expiresIn: number;
  expiresInSec: number;
  accessToken: string;
  idToken?: string;
  providerLabel: string;
  signedInAtIso: string;
}
type BadgeMode = 'idle' | 'ok' | 'err';

const KEY_ID = 'iwa-sink.google.clientId';
const KEY_OLD_SEC = 'iwa-sink.google.clientSecret';
const KEY_ACCT = 'iwa-sink.sso.lastAccount';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SFX = '.apps.googleusercontent.com';
const TOK_HINT =
  'Click "Sign in with Google ↗" above to capture an OAuth 2.0 Bearer token.';
const REQ_SCOPE = 'openid email profile';
const ACCT_NONE = 'No account signed in yet';
const ERR_ID = 'sso-error-banner';

const tid = <T extends HTMLElement>(n: T, id: string): T => (
  (n.dataset.testid = id), n
);
const getStore = (k: string): string => {
  try {
    return window.localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const setStore = (k: string, v: string): void => {
  try {
    if (v) window.localStorage.setItem(k, v);
    else window.localStorage.removeItem(k);
  } catch {}
};
const isAbort = (e: unknown): boolean =>
  (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
const isRec = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
const rStr = (o: Record<string, unknown> | null, k: string, fb = ''): string =>
  o && typeof o[k] === 'string' ? (o[k] as string).trim() || fb : fb;

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const seg = jwt.split('.')[1];
    if (!seg) return null;
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const bin = window.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTokenErr(status: number, bodyText: string): string {
  const t = bodyText.trim();
  if (!t) return `Token endpoint returned HTTP ${status}.`;
  try {
    const p: unknown = JSON.parse(t);
    if (isRec(p)) {
      const c = rStr(p, 'error');
      const d = rStr(p, 'error_description') || rStr(p, 'message');
      if (c || d) return c && d ? `${c} — ${d}` : c || d;
    }
  } catch {}
  return t.slice(0, 160);
}

function getTestCfg(): TestOidcConfig | null {
  const c = window.__IWA_TEST_OIDC_CONFIG__;
  if (!isRec(c)) return null;
  const [authEndpoint, tokenEndpoint] = [
    rStr(c, 'authEndpoint'),
    rStr(c, 'tokenEndpoint'),
  ];
  const userinfoEndpoint = rStr(c, 'userinfoEndpoint') || undefined;
  return authEndpoint && tokenEndpoint
    ? { authEndpoint, tokenEndpoint, userinfoEndpoint }
    : null;
}

function checkClientId(raw: string, hasOverride: boolean): string | null {
  if (/[\x00-\x1f\x7f]/.test(raw))
    return 'Invalid Client ID: Client ID must not contain control characters.';
  const t = raw.trim();
  if (!t)
    return 'Client ID is required. Enter your OAuth 2.0 Desktop Client ID before signing in.';
  if (/\s/.test(t))
    return 'Invalid Client ID: Client ID must not contain whitespace.';
  if (t.length > 256 || !/^[A-Za-z0-9._:@-]+$/.test(t))
    return 'Invalid Client ID: Use only letters, digits, dots, hyphens, underscores, colons, or @.';
  const gRe = /^[a-z0-9][a-z0-9._-]*\.apps\.googleusercontent\.com$/i;
  if (!hasOverride && (!t.toLowerCase().endsWith(GOOGLE_SFX) || !gRe.test(t)))
    return 'Invalid Client ID: Google Cloud Desktop OAuth 2.0 Client IDs must end with ".apps.googleusercontent.com".';
  return null;
}

const remSec = (s: AccountSnap): number => {
  const ttl = Math.max(0, Math.floor(s.expiresInSec ?? s.expiresIn ?? 0));
  const at = Date.parse(s.signedInAtIso);
  const elap = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return Number.isFinite(at) ? Math.max(0, ttl - elap) : ttl;
};
const fmtExp = (rem: number, sc: string) =>
  `Bearer · ${rem > 0 ? `Expires in ${rem}s` : 'Expired (0s remaining)'} · ${sc}`;

function mkIn(k: 'id' | 'secret', type: string, val: string, ph: string) {
  const inp = el('input', 'form-input mono sso-cred-input');
  tid(inp, `sso-google-client-${k}`);
  inp.id = `sso-google-client-${k}-input`;
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  return Object.assign(inp, { type, value: val, placeholder: ph });
}

const setBtnVis = (b: HTMLButtonElement, vis: boolean): void => {
  b.hidden = b.disabled = !vis;
  b.classList.toggle('is-hidden', !vis);
  b.setAttribute('aria-disabled', `${!vis}`);
};

function mkHideBtn(cls: string, id: string, txt: string) {
  const b = tid(el('button', `btn btn-subtle ${cls} is-hidden`, txt), id);
  b.type = 'button';
  return setBtnVis(b, false), b;
}

function openCenteredPopup(url: string): void {
  try {
    const cx = (window.screenX || 0) + ((window.outerWidth || 1024) - 520) / 2;
    const cy = (window.screenY || 0) + ((window.outerHeight || 768) - 680) / 2;
    const [l, t] = [Math.max(0, Math.round(cx)), Math.max(0, Math.round(cy))];
    const feat = `popup=yes,width=520,height=680,left=${l},top=${t},noopener`;
    window.open(url, 'iwa_sso_oauth_popup', feat);
  } catch {}
}

interface ExchangeOpts {
  tokenUrl: string;
  userinfoUrl?: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  signal: AbortSignal;
}

async function exchangeOAuthCode(o: ExchangeOpts) {
  const fail = (detail: string, status?: number) => {
    return { ok: false as const, detail, status };
  };
  const params = new URLSearchParams({
    code: o.code,
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: o.codeVerifier,
  });
  if (o.clientSecret) params.set('client_secret', o.clientSecret);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const req = { method: 'POST', headers, body: `${params}`, signal: o.signal };
  const res = await window.fetch(o.tokenUrl, req);
  const txt = await res.text().catch(() => '');
  if (!res.ok) return fail(extractTokenErr(res.status, txt), res.status);

  let body: unknown;
  try {
    body = JSON.parse(txt);
  } catch {
    return fail('Token endpoint returned malformed JSON.');
  }
  if (!isRec(body)) return fail('Token endpoint did not return a JSON object.');
  const accessToken = rStr(body, 'access_token');
  if (!accessToken) return fail('Token response omitted access_token.');

  const idToken = rStr(body, 'id_token');
  const re = body.expires_in;
  const okExp = typeof re === 'number' && Number.isFinite(re) && re > 0;
  const expiresIn = okExp ? Math.floor(re) : 3600;
  const scope = rStr(body, 'scope', REQ_SCOPE);
  const claims = idToken ? decodeJwtClaims(idToken) : null;
  let ui: Record<string, unknown> | null = null;
  if (o.userinfoUrl) {
    try {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const ur = await window.fetch(o.userinfoUrl, {
        headers,
        signal: o.signal,
      });
      const ut = await ur.text().catch(() => '');
      const pu: unknown = ur.ok && ut ? JSON.parse(ut) : null;
      if (isRec(pu)) ui = pu;
    } catch (e) {
      if (isAbort(e)) throw e;
    }
  }
  const email =
    rStr(ui, 'email') ||
    rStr(claims, 'email') ||
    'authenticated@google-oauth.user';
  const name =
    rStr(ui, 'name') || rStr(claims, 'name') || email || 'Google OAuth User';
  const sub = rStr(ui, 'sub') || rStr(claims, 'sub') || 'google-oauth-subject';
  const issuer = rStr(claims, 'iss', 'https://accounts.google.com');
  const snap: AccountSnap = {
    name,
    email,
    sub,
    issuer,
    scope,
    expiresIn,
    expiresInSec: expiresIn,
    accessToken,
    idToken: idToken || undefined,
    providerLabel: 'Google OAuth 2.0',
    signedInAtIso: new Date().toISOString(),
  };
  return { ok: true as const, snap };
}

function parseSavedAccount(raw: string): AccountSnap | null {
  try {
    const p: unknown = raw ? JSON.parse(raw) : null;
    if (!isRec(p) || !rStr(p, 'email') || !rStr(p, 'accessToken')) return null;
    const email = rStr(p, 'email');
    const eSec = typeof p.expiresInSec === 'number' ? p.expiresInSec : null;
    const ttl = eSec ?? (typeof p.expiresIn === 'number' ? p.expiresIn : 3599);
    return {
      name: rStr(p, 'name', email),
      email,
      sub: rStr(p, 'sub', 'google-sub'),
      issuer: rStr(p, 'issuer', 'https://accounts.google.com'),
      scope: rStr(p, 'scope', REQ_SCOPE),
      expiresIn: ttl,
      expiresInSec: ttl,
      accessToken: rStr(p, 'accessToken'),
      idToken: rStr(p, 'idToken') || undefined,
      providerLabel: rStr(p, 'providerLabel', 'Google OAuth 2.0'),
      signedInAtIso: rStr(p, 'signedInAtIso', new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

function mountSsoWorkspace(container: HTMLElement, ctx: ShellContext): void {
  setStore(KEY_OLD_SEC, '');
  const setWs = (state: WorkspaceLiveStatus['state'], label: string) =>
    ctx.setWorkspaceStatus('sso-offloading', { state, label });
  setWs('probing', 'Idle');

  const boot = `[${formatLogTime()}] [tcp-server] Ready — enter Client ID and click "Sign in with Google ↗" to bind 127.0.0.1:<port>.`;
  const logConsole = createLogConsole({
    title: 'Loopback Console Log',
    logTestId: 'sso-event-log',
    clearBtnTestId: 'sso-clear-log-btn',
    toggleTestId: 'sso-toggle-console-btn',
    cardTestId: 'sso-log-card',
    cardClassName: 'sso-log-card',
    bodyId: 'sso-console-panel',
    maxLines: 160,
    initialExpanded: false,
    initialLines: [boot],
  });
  const log = (m: string) => logConsole.append(m);

  const st = {
    id: 0,
    busy: false,
    signedIn: false,
    rawTok: '',
    cb: null as OAuthCallbackServerHandle | null,
    ac: null as AbortController | null,
    snap: null as AccountSnap | null,
    timer: null as ReturnType<typeof setInterval> | null,
  };
  const stopTimer = () => {
    if (st.timer !== null) clearInterval(st.timer);
    st.timer = null;
  };

  const errSpec = { id: ERR_ID, testId: ERR_ID, className: ERR_ID };
  const ssoError = createAlertBanner(errSpec);
  const badgeEl = el('span', 'sso-account-status-badge mono', 'Not signed in');
  tid(badgeEl, 'sso-viewer-status');
  const setBadge = (txt: string, mode: BadgeMode = 'idle', title = txt) => {
    badgeEl.textContent = txt;
    badgeEl.title = title;
    badgeEl.classList.toggle('is-authenticated', mode === 'ok');
    badgeEl.classList.toggle('is-error', mode === 'err');
  };

  const signOutCls = 'btn-sm sso-sign-out-btn';
  const signOutBtn = mkHideBtn(signOutCls, 'sso-sign-out-btn', 'Sign Out');
  function mkMeta(label: string, k: string, initialText?: string, rst = true) {
    let b: ReturnType<typeof createMetaBox> | undefined;
    const ct = label.replace(' (sub)', '').replace(/^Token /, '');
    b = createMetaBox({
      label,
      valueTestId: `sso-viewer-${k}`,
      copyTestId: `sso-copy-${k}-btn`,
      copyTitle: `Copy ${ct}`,
      initialText,
      mono: true,
      bold: Boolean(initialText),
      resetCopyOnTextChange: rst,
      getCopyText: () => (st.signedIn ? b?.valueEl.textContent ?? '' : ''),
    });
    return b;
  }
  const accountMeta = mkMeta('Account', 'account', ACCT_NONE);
  const subjectMeta = mkMeta('Subject (sub) & Issuer', 'subject');
  const expiryMeta = mkMeta('Token Scope & Expiry', 'expiry', undefined, false);
  const metas = [accountMeta, subjectMeta, expiryMeta];

  const tokCls =
    'ws-kv-bar-val cf-tls-fingerprint-val mono tabular-nums sso-viewer-token-val';
  const tokenEl = tid(el('span', tokCls, TOK_HINT), 'sso-viewer-token');
  tokenEl.title = TOK_HINT;
  const copyTokBtn = createCopyIconButton({
    getText: () => (st.signedIn ? st.rawTok : ''),
    title: 'Copy Access Token',
    testId: 'sso-copy-token-btn',
    className: 'sso-copy-token-btn',
    watchEl: tokenEl,
  });
  const copyBtns = [...metas.map((m) => m.copyBtn), copyTokBtn];
  const syncCopies = () => copyBtns.forEach(syncCopyButton);
  syncCopies();

  const clearSession = () => {
    stopTimer();
    Object.assign(st, { snap: null, signedIn: false, rawTok: '' });
    setStore(KEY_ACCT, '');
    setBtnVis(signOutBtn, false);
  };

  function setView(b: string, a: string, tok: string, s = '—', x = '—') {
    setBadge(b);
    accountMeta.setValue(a);
    subjectMeta.setValue(s);
    expiryMeta.setValue(x);
    tokenEl.textContent = tokenEl.title = tok;
    syncCopies();
  }

  const tickExpiry = () => {
    if (!st.snap || !st.signedIn) return stopTimer();
    const rem = remSec(st.snap);
    const ok = rem > 0;
    expiryMeta.setValue(fmtExp(rem, st.snap.scope));
    setBadge(
      `${ok ? 'Signed in' : 'Expired'} · ${st.snap.providerLabel}`,
      ok ? 'ok' : 'idle',
    );
    if (!ok) setWs('portal', `Expired: ${st.snap.email}`), stopTimer();
  };

  const applyAccount = (s: AccountSnap, persist: boolean) => {
    stopTimer();
    Object.assign(st, { snap: s, signedIn: true, rawTok: s.accessToken });
    setBtnVis(signOutBtn, true);
    const rem = remSec(s);
    const ok = rem > 0;
    const t = s.accessToken;
    const prev = t.length > 48 ? `${t.slice(0, 30)}…${t.slice(-12)}` : t;
    const acct =
      s.name && s.name !== s.email ? `${s.email} (${s.name})` : s.email;
    const subj = `${s.sub} · ${s.issuer.replace(/^https?:\/\//i, '')}`;
    const tok = `${prev}${s.idToken ? ' · id_token claims decoded' : ''}`;
    const bTxt = `${ok ? 'Signed in' : 'Expired'} · ${s.providerLabel}`;
    setView(bTxt, acct, tok, subj, fmtExp(rem, s.scope));
    setBadge(bTxt, ok ? 'ok' : 'idle');
    setWs(ok ? 'online' : 'portal', `${ok ? 'SSO' : 'Expired'}: ${s.email}`);
    if (persist) setStore(KEY_ACCT, JSON.stringify(s));
    if (ok) st.timer = setInterval(tickExpiry, 1000);
  };

  const idPh = '123456789-abc.apps.googleusercontent.com';
  const clientIdIn = mkIn('id', 'text', getStore(KEY_ID), idPh);
  const secretIn = mkIn('secret', 'password', '', 'Optional (memory only)');
  const copyIdCfg = {
    testId: 'sso-copy-client-id-btn',
    title: 'Copy Client ID',
    alwaysShow: true,
  };
  const wrappedId = wrapInputWithCopy(clientIdIn, copyIdCfg);

  const setInv = (inp: HTMLInputElement, bad: boolean) => {
    if (bad)
      inp.setAttribute('aria-invalid', 'true'),
        inp.setAttribute('aria-describedby', ERR_ID);
    else
      inp.removeAttribute('aria-invalid'),
        inp.removeAttribute('aria-describedby');
    inp.classList.toggle('is-invalid', bad);
    if (inp === clientIdIn) wrappedId.classList.toggle('is-invalid', bad);
  };
  const clearErr = () => (
    ssoError.clear(), setInv(clientIdIn, false), setInv(secretIn, false)
  );
  const saveId = () => setStore(KEY_ID, clientIdIn.value.trim());

  const saved = parseSavedAccount(getStore(KEY_ACCT));
  if (saved) applyAccount(saved, false);

  const startLbl = el('span', null, 'Sign in with Google');
  const startArr = el('span', 'sso-start-arrow', '↗');
  const startCls = 'btn btn-primary sso-start-btn';
  const startBtn = el('button', startCls, startLbl, startArr);
  tid(startBtn, 'sso-start-login-btn').type = 'button';
  const cancelId = 'sso-cancel-login-btn';
  const cancelBtn = mkHideBtn('sso-cancel-btn', cancelId, 'Cancel');

  const syncBtns = (busy: boolean, lbl = 'Listening…') => {
    startBtn.disabled = busy;
    startBtn.setAttribute('aria-disabled', `${busy}`);
    startLbl.textContent = busy ? lbl : 'Sign in with Google';
    startArr.hidden = busy;
    startArr.classList.toggle('is-hidden', busy);
    setBtnVis(cancelBtn, busy);
  };

  const cancelHint =
    'Sign-in cancelled — click "Sign in with Google ↗" above to try again.';
  const showCancelled = () => {
    clearErr(), clearSession();
    setView('Sign-in cancelled', ACCT_NONE, cancelHint);
    setWs('probing', 'Sign-in cancelled');
  };

  const cancelAttempt = async (reason: 'user' | 'teardown' | 'signout') => {
    const cid = ++st.id;
    st.busy = false;
    syncBtns(false);
    st.ac?.abort();
    const srv = st.cb;
    Object.assign(st, { ac: null, cb: null });
    if (reason === 'user') showCancelled();
    if (srv) await srv.stop();
    if (cid === st.id && reason === 'user') {
      showCancelled();
      log(
        '[callback] Sign-in cancelled — closed loopback TCPServerSocket listener.',
      );
    }
  };

  cancelBtn.addEventListener('click', () => void cancelAttempt('user'));
  signOutBtn.addEventListener('click', () => {
    void cancelAttempt('signout'), clearErr(), clearSession();
    setView('Not signed in', ACCT_NONE, TOK_HINT), setWs('probing', 'Idle');
    log('[session] Signed out — cleared cached OAuth 2.0 account session.');
  });

  function failFlow(ws: string, m: string, t: string, d: string, bt?: string) {
    ssoError.show(m), setWs('offline', ws), clearSession();
    setView(t, `${t} — ${d}`, d), setBadge(t, 'err', bt);
  }

  function failIn(inp: HTMLInputElement, e: string, b: string, ws?: string) {
    st.id++, ssoError.show(e), setInv(inp, true);
    if (!st.signedIn) setBadge(b, 'err'), ws && setWs('offline', ws);
    log(`[validation] ${e}`);
  }

  const runLogin = async () => {
    if (st.busy) return;
    const cfg = getTestCfg();
    const idErr = checkClientId(clientIdIn.value, Boolean(cfg));
    const badId = 'Invalid Client ID';
    if (idErr) return failIn(clientIdIn, idErr, badId, badId);
    if (/[\r\n\x00-\x1f\x7f]/.test(secretIn.value)) {
      const sErr =
        'Invalid Client Secret: Client Secret must not contain control characters.';
      return failIn(secretIn, sErr, 'Invalid Client Secret');
    }

    const clientId = (clientIdIn.value = clientIdIn.value.trim());
    const clientSecret = secretIn.value.trim();
    saveId(), clearErr();

    const myId = ++st.id;
    const ac = new AbortController();
    Object.assign(st, { busy: true, ac });
    clearSession(), syncCopies(), syncBtns(true, 'Starting listener…');

    const authUrl = cfg?.authEndpoint ?? AUTH_URL;
    const tokenUrl = cfg?.tokenEndpoint ?? TOKEN_URL;
    const userinfoUrl = cfg ? cfg.userinfoEndpoint : USERINFO_URL;

    try {
      const pkce = await generatePkceMaterial();
      if (myId !== st.id) return;
      const cb = await startOAuthCallbackServer(pkce.state, log);
      if (myId !== st.id) return void (await cb.stop());
      st.cb = cb;

      const lTxt = `Listening on 127.0.0.1:${cb.port}…`;
      syncBtns(true, lTxt);
      const waitAcct = `Awaiting OAuth 2.0 redirect on ${cb.redirectUri}…`;
      setView(lTxt, waitAcct, 'Waiting for authorization code exchange…');
      setWs('portal', `Callback :${cb.port}`);
      log(
        `[tcp-server] Bound 127.0.0.1:${cb.port} (redirect_uri=${cb.redirectUri})`,
      );

      const u = new URL(authUrl);
      for (const [k, v] of Object.entries({
        client_id: clientId,
        redirect_uri: cb.redirectUri,
        response_type: 'code',
        scope: REQ_SCOPE,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
        state: pkce.state,
        access_type: 'offline',
        prompt: 'consent',
      }))
        u.searchParams.set(k, v);
      openCenteredPopup(u.toString());
      log(`[browser] Opened popup → ${u.toString()}`);

      const out = await cb.outcome;
      if (st.cb === cb) st.cb = null;
      if (myId !== st.id) return;
      if (out.kind === 'cancelled') return showCancelled();
      if (out.kind === 'timed_out') {
        const m =
          'Loopback listener timed out after 120s waiting for an OAuth 2.0 callback — click "Sign in with Google ↗" to retry.';
        return failFlow('Callback Timed Out', m, 'Callback Timed Out', m);
      }
      if (out.kind === 'state_mismatch') {
        const m =
          'CSRF State Mismatch: OAuth callback state parameter did not match the active PKCE session.';
        log('[http-rx] Security abort: CSRF state mismatch (HTTP 400).');
        return failFlow('CSRF Blocked', m, 'CSRF State Mismatch', m);
      }
      if (out.kind === 'oauth_error') {
        const { error: err, errorDescription: ed } = out;
        const c = err.length > 40 ? `${err.slice(0, 37)}…` : err;
        const d = ed.length > 220 ? `${ed.slice(0, 217)}…` : ed;
        const e120 = err.slice(0, 120);
        log(`[http-rx] Provider error: ${e120} (${d})`);
        const ban = `OAuth authorization declined (${e120}): ${d}`;
        const ot = `OAuth Declined (${err})`;
        return failFlow(`OAuth ${c}`, ban, `OAuth Declined (${c})`, d, ot);
      }

      syncBtns(true, 'Exchanging code…'), setBadge('Exchanging Code…', 'idle');
      log(`[token] POST ${tokenUrl} (PKCE S256)…`);
      const tokOut = await exchangeOAuthCode({
        tokenUrl,
        userinfoUrl,
        code: out.code,
        clientId,
        clientSecret,
        redirectUri: cb.redirectUri,
        codeVerifier: pkce.codeVerifier,
        signal: ac.signal,
      });
      if (myId !== st.id) return;
      if (!tokOut.ok) {
        const sfx = tokOut.status ? ` (HTTP ${tokOut.status})` : '';
        const t = `Token Exchange Failed${sfx}`;
        log(`[token] ✕ ${t}: ${tokOut.detail}`);
        return failFlow(
          'Token Error',
          `${t}: ${tokOut.detail}`,
          t,
          tokOut.detail,
        );
      }

      clearErr(), applyAccount(tokOut.snap, true);
      log(`[token] ✓ POST ${tokenUrl} → 200 OK (user=${tokOut.snap.email})`);
    } catch (e) {
      if (myId !== st.id || isAbort(e)) return;
      const m = e instanceof Error ? e.message : String(e);
      failFlow('SSO Error', `SSO Flow Error: ${m}`, 'SSO Flow Error', m);
      log(`[token] Error: ${m}`);
    } finally {
      if (myId === st.id) {
        st.busy = false;
        if (st.ac === ac) st.ac = null;
        syncBtns(false);
      }
    }
  };

  startBtn.addEventListener('click', () => void runLogin());
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' && !st.busy) ev.preventDefault(), void runLogin();
  };
  function bindIn(a: HTMLInputElement, b: HTMLInputElement, fn?: () => void) {
    a.addEventListener('input', () => {
      setInv(a, false);
      if (!b.hasAttribute('aria-invalid')) ssoError.clear();
      fn?.();
    });
    a.addEventListener('keydown', onKey);
  }
  bindIn(clientIdIn, secretIn, saveId);
  clientIdIn.addEventListener('change', saveId);
  bindIn(secretIn, clientIdIn);
  const onHide = () => (stopTimer(), void cancelAttempt('teardown'));
  window.addEventListener('pagehide', onHide);
  if (clientIdIn.value) clientIdIn.dispatchEvent(new Event('input'));

  const mkCol = (k: 'id' | 'secret', lbl: string, ctrl: HTMLElement) => {
    const l = el('label', 'ws-field-label sso-field-label', lbl);
    l.htmlFor = `sso-google-client-${k}-input`;
    return el('div', `sso-field-col sso-field-${k}`, l, ctrl);
  };
  const colId = mkCol('id', 'Client ID', wrappedId);
  const colSec = mkCol('secret', 'Client Secret (optional)', secretIn);
  const acts = el('div', 'sso-creds-actions', startBtn, cancelBtn);
  const credsRow = el('div', 'ws-field-row sso-creds-row', colId, colSec, acts);
  const credsCard = createCard({
    title: 'Google OAuth 2.0 Credentials',
    className: 'sso-creds-card',
    headerClassName: 'sso-card-header',
    bodyClassName: 'sso-creds-body',
    body: [credsRow, ssoError.root],
  }).root;

  const metaEls = metas.map((m) => m.root);
  const metaGrid = el('div', 'ws-meta-grid cf-tls-meta-grid', ...metaEls);
  const kvLblCls = 'ws-kv-bar-label cf-tls-fingerprint-label';
  const tokLbl = el('span', kvLblCls, 'Access Token:');
  const barCls = 'ws-kv-bar cf-tls-fingerprint-bar sso-token-bar';
  const tokBar = el('div', barCls, tokLbl, tokenEl, copyTokBtn);
  const acctCard = createCard({
    title: 'Signed-In Account',
    testId: 'sso-account-card',
    className: 'cf-tls-card sso-account-card',
    headerClassName: 'cf-tls-card-header sso-account-header',
    bodyClassName: 'cf-tls-cert-body sso-account-body',
    headerRight: [badgeEl, signOutBtn],
    body: [metaGrid, tokBar],
  }).root;

  const { title, subtitle } = ssoOffloadingWorkspace;
  const h = createWorkspaceHeader({ title, subtitle, className: 'sso-header' });
  container.replaceChildren(h, credsCard, acctCard, logConsole.root);
}

export const ssoOffloadingWorkspace: WorkspaceDefinition = {
  id: 'sso-offloading',
  navLabel: 'SSO Loopback',
  title: 'SSO Loopback',
  subtitle:
    'Authenticate via the system browser using Direct Sockets TCPServerSocket on 127.0.0.1:<port> to capture the OAuth 2.0 PKCE redirect code and exchange it for tokens.',
  mount: mountSsoWorkspace,
};
export const workspace = ssoOffloadingWorkspace;
export default ssoOffloadingWorkspace;

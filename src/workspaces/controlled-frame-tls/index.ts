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
  createCollapsibleSection,
  createCopyIconButton,
  createLogConsole,
  createMetaBox,
  createWorkspaceHeader,
  el,
  svg,
  syncCopyButton,
} from '../../lib/dom';
import type { ProtocolInjectorSpec } from '../../lib/protocol';
import type {
  ShellContext,
  WorkspaceDefinition,
  WorkspaceLiveStatus,
} from '../../shell/contracts';
import { parseX509IdentityFromDer, sha256Hex } from './x509-der-parser';

interface CapturedCert {
  hostPort: string;
  rawDer: Uint8Array;
  sha256Hex: string;
  securityState: string;
}
interface AbortInfo {
  url: string;
  hostPort: string;
  host: string;
  reason: string;
  at: number;
}
interface GuestScriptEnv {
  ok: boolean;
  formatted?: string;
  error?: string;
  cspBlocked?: boolean;
}
type SecurityState = 'idle' | 'loading' | 'secure' | 'insecure' | 'error';
type InjectTone = 'idle' | 'ready' | 'running' | 'ok' | 'error';
type ParseUrl = { ok: true; url: URL } | { ok: false; reason: string };
type CfEl = HTMLControlledFrameElement;
type ProtoSc = 'cf' | 'web+cf' | null;
type Fn = () => void;
type StrN = string | null;
type UrlN = URL | null;
type AbortN = AbortInfo | null;
type Btn = HTMLButtonElement | null;

const INIT_SHA_HINT =
  'Awaiting HTTPS navigation — load an https:// page above to inspect its X.509 leaf certificate.';
const STANDBY_INJECT =
  'Navigate to an HTTP(S) page above to enable script and stylesheet injection.';
const READY_INJECT =
  'Ready — click Run Script or Apply CSS to inspect live guest results.';
const DEF_URL = 'https://www.google.com';
const DEF_PART = 'persist:iwa-workspace';
const ERR_BANNER_ID = 'cf-url-error-banner';
const PROV_INIT = 'Awaiting HTTPS navigation';
const TIMEOUT_SYM = Symbol('cf-timeout');
const MAX_INJECT = 2000;
const [DEF_H, MIN_H, MAX_H] = [480, 240, 1600];

const CLEAR_TYPES = Object.fromEntries(
  'appcache,cache,cookies,fileSystems,indexedDB,localStorage,persistentCookies,sessionCookies,webSQL'
    .split(',')
    .map((k) => [k, true]),
);
const BAD_SCHEMES = new Set(
  'about|blob|cf|chrome|chrome-error|chrome-extension|data|devtools|file|ftp|isolated-app|javascript|mailto|sms|tel|vbscript|view-source|ws|wss'.split(
    '|',
  ),
);

const tid = <T extends HTMLElement>(n: T, id: string): T => (
  (n.dataset.testid = id), n
);
const sAttrs = <T extends HTMLElement>(n: T, a: Record<string, string>): T => {
  for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
  return n;
};
const snip = (raw: string, max = 96): string => {
  const c = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return c.length <= max ? c : `${c.slice(0, Math.max(1, max - 1))}…`;
};

function parseOmniboxUrl(raw: string): ParseUrl {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (/[\x00-\x1f\x7f]/.test(raw))
    return fail('Invalid URL: control characters are not permitted.');
  const t = raw.trim();
  if (!t) return fail('Enter an HTTP or HTTPS URL before navigating.');
  if (/\s/.test(t)) return fail('Invalid URL: spaces are not permitted.');
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(t))
    return fail('Invalid URL: percent-encoded control characters are blocked.');
  if (t.includes('\\') || /%5c/i.test(t))
    return fail('Invalid URL: backslashes ("\\") are not permitted.');
  if (t.startsWith('//'))
    return fail('Protocol-relative URLs ("//…") require http:// or https://.');
  const badUrl = () => fail(`Invalid HTTP(S) URL: "${snip(t)}".`);
  if (/^[/?#]/.test(t)) return badUrl();

  let cand = t;
  const sm = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(t);
  if (sm) {
    const [sc, rest] = [sm[1].toLowerCase(), sm[2]];
    const isHost =
      (sc === 'localhost' || sc.includes('.')) && /^(?:[/?#]|$)/.test(rest);
    const canPrepend =
      !rest.startsWith('//') &&
      !BAD_SCHEMES.has(sc) &&
      !sc.startsWith('web+') &&
      (/^\d+(?:[/?#]|$)/.test(rest) || isHost);
    if (sc === 'http' || sc === 'https') {
      if (!rest.startsWith('//'))
        return fail(`Malformed ${sc}: URL — expected "${sc}://<host>".`);
    } else if (canPrepend) {
      cand = `https://${t}`;
    } else {
      const uErr = `Unsupported URL scheme "${snip(sc, 48)}:". Only http(s):// permitted.`;
      return fail(uErr);
    }
  } else cand = `https://${t}`;

  const am = /^https?:\/\/([^/?#]*)/i.exec(cand);
  if (am) {
    let auth = am[1];
    if (!auth) return fail('Invalid URL: missing hostname.');
    if (auth.includes('%')) {
      if (/%(?![0-9a-f]{2})/i.test(auth)) return badUrl();
      try {
        auth = decodeURIComponent(auth);
      } catch {
        return badUrl();
      }
      const ctrlPct = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(auth);
      if (/[\x00-\x1f\x7f\\]/.test(auth) || ctrlPct)
        return fail('Invalid URL: unsafe characters in authority.');
      if (/[\s/]/.test(auth)) return badUrl();
    }
    if (auth.includes('@'))
      return fail('Credentials (user:pass@) are not permitted in URLs.');

    let [host, port]: [string, string | undefined] = ['', undefined];
    if (auth.startsWith('[')) {
      const v6 = /^\[([^\]]+)\](?::(.*))?$/.exec(auth);
      if (!v6 || !v6[1].includes(':')) return badUrl();
      [host, port] = [`[${v6[1]}]`, v6[2]];
    } else {
      if (auth.includes(']')) return badUrl();
      const c = auth.indexOf(':');
      host = c >= 0 ? auth.slice(0, c) : auth;
      port = c >= 0 ? auth.slice(c + 1) : undefined;
    }
    if (!host) return fail('Invalid URL: missing hostname.');
    if (port !== undefined) {
      const ds = /^\d+$/.test(port) ? port.replace(/^0+/, '') : '';
      const num = ds ? Number.parseInt(ds, 10) : 0;
      if (!ds || ds.length > 5 || num < 1 || num > 65535) {
        const p16 = snip(port, 16);
        return fail(`Invalid port ":${p16}" — TCP port must be 1..65535.`);
      }
    }
    if (!host.startsWith('[')) {
      const nh = host.replace(/[\u3002\uff0e\uff61]/g, '.');
      if (/(?:^\.|\.$|\.\.|[\[\]])/.test(nh))
        return fail(`Invalid hostname "${snip(host, 64)}".`);
    }
  }

  try {
    const u = new URL(cand);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return fail(`Unsupported URL scheme "${snip(u.protocol, 48)}".`);
    if (!u.hostname) return fail('Invalid URL: missing hostname.');
    const badHost = u.hostname.startsWith('[')
      ? !u.hostname.endsWith(']') || !u.hostname.includes(':')
      : /(?:^\.|\.$|\.\.)/.test(u.hostname) ||
        !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(u.hostname);
    if (badHost) return fail(`Invalid hostname "${snip(u.hostname, 64)}".`);
    if (u.username || u.password)
      return fail('Credentials (user:pass@) are not permitted in URLs.');
    if (u.port === '0')
      return fail('Invalid port ":0" — TCP port must be 1..65535.');
    return { ok: true, url: u };
  } catch {
    return badUrl();
  }
}

const normHttp = (raw: string): UrlN => {
  const r = parseOmniboxUrl(raw);
  return r.ok ? r.url : null;
};
const stripHash = (u: URL) => `${u.origin}${u.pathname}${u.search}`;
const hostPortKey = (u: URL): string => {
  const p = u.port ? Number.parseInt(u.port, 10) : NaN;
  const def = u.protocol === 'https:' ? 443 : 80;
  return `${u.hostname}:${Number.isFinite(p) && p >= 0 ? p : def}`;
};
const fmtErr = (e: unknown) => (e instanceof Error ? e.message : String(e));
const colonHex = (hex: string): string => {
  const c = hex.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return c.length === 64 ? c.match(/.{2}/g)?.join(':') ?? hex : hex;
};
const isCapped = (s: string) =>
  /\u2026 \(\d+ chars\)$/.test(s) && s.length <= 2032;
const capInject = (s: string): string =>
  s.length <= MAX_INJECT || isCapped(s)
    ? s
    : `${s.slice(0, MAX_INJECT)}… (${s.length} chars)`;

function describeCert(rawDer: Uint8Array, fbHost: string) {
  const len = rawDer.byteLength;
  try {
    const id = parseX509IdentityFromDer(rawDer);
    const b = id.subjectCommonName || id.firstDnsSan || id.subjectOrganization;
    const base = b || id.dnsNames[0] || fbHost || '—';
    const n = id.dnsNames.length;
    const subject = n > 1 ? `${base} (${n} SANs)` : base;
    const [io, ic] = [id.issuerOrganization, id.issuerCommonName];
    const iss = io && ic ? `${io} (CN=${ic})` : ic ? `CN=${ic}` : io;
    const issuer = iss || `X.509 Leaf (${len} B DER)`;
    const exp = id.validityNotAfter ? ` · Exp ${id.validityNotAfter}` : '';
    const cipher = `${id.publicKeyAlgorithmLabel} · ${len} B${exp}`;
    return { subject, issuer, cipher };
  } catch {
    const subject = fbHost || '—';
    const issuer = `X.509 Leaf (${len} B DER)`;
    return { subject, issuer, cipher: `Unparsed SPKI · ${len} B DER` };
  }
}

const GUEST_FMT_SRC = `
const __cap=(s,n=${MAX_INJECT})=>typeof s==='string'&&s.length>n?s.slice(0,n)+'… ('+s.length+' chars)':String(s);
const __fe=(e)=>{try{if(e==null||typeof e!=='object')return __cap(String(e));const nm=typeof e.name==='string'?e.name:'',m=typeof e.message==='string'?e.message:'';if(nm||m)return __cap(nm&&m?nm+': '+m:(m?'Error: '+m:nm));try{return __cap(String(e));}catch{return'[Unprintable object]';}}catch{return'Thrown guest exception';}};
const __fv=(v,sn=[],d=0)=>{try{if(v===undefined)return'undefined';if(v===null)return'null';if(typeof v==='string')return d===0?__cap(v):JSON.stringify(__cap(v,240));if(typeof v==='number'||typeof v==='boolean')return String(v);if(typeof v==='bigint')return __cap(v.toString()+'n');if(typeof v==='symbol')return __cap(v.toString());if(typeof v==='function')return'[Function: '+(v.name||'anonymous')+']';if(typeof v==='object'){if(v instanceof Promise)return'[Promise]';if(v===globalThis||(typeof Window==='function'&&v instanceof Window))return'[Window]';if(typeof Node==='function'&&v instanceof Node){const nt=Object.getOwnPropertyDescriptor(Node.prototype,'nodeType')?.get?.call(v)??v.nodeType;if(nt===1){const tg=String(Object.getOwnPropertyDescriptor(Element.prototype,'tagName')?.get?.call(v)||'element').toLowerCase(),id=Element.prototype.getAttribute?.call(v,'id');return __cap('<'+__cap(tg,120)+(id?'#'+__cap(id,240):'')+'>');}return nt===9?'[Document]':'[Node]';}if(v instanceof Error)return __fe(v);if(v instanceof RegExp||v instanceof Date)return __cap(String(v));if(v instanceof Map)return'Map('+v.size+')';if(v instanceof Set)return'Set('+v.size+')';if(sn.includes(v))return'[Circular]';if(d>=3)return'[Object]';const ns=sn.concat([v]);if(Array.isArray(v))return __cap('['+v.slice(0,20).map(x=>__fv(x,ns,d+1)).join(', ')+(v.length>20?', …':'')+']');return __cap('{'+Object.keys(v).slice(0,20).map(k=>{let pv;try{pv=v[k];}catch{pv='[Getter]';}return JSON.stringify(k)+':'+__fv(pv,ns,d+1);}).join(',')+'}');}return __cap(String(v));}catch{return'[Object]';}};`;

const makeExecKey = (seq: number) =>
  `__iwaExec_${seq}_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

const buildEvalEnvelope = (code: string, key: string): string => {
  const kj = JSON.stringify(key);
  return `(()=>{${GUEST_FMT_SRC}try{return{[${kj}]:{ok:true,formatted:__fv((0,eval)(${JSON.stringify(code)}),[],0)}};}catch(e){let c=false;try{const m=String((e&&e.message)||'');c=((typeof EvalError==='function'&&e instanceof EvalError)||Boolean(e&&e.name==='EvalError'))&&/Content Security Policy|unsafe-eval/i.test(m);}catch{}return{[${kj}]:{ok:false,cspBlocked:c,error:__fe(e)}};}})()`;
};

const LOCK_RECT = {
  tag: 'rect' as const,
  attrs: { x: 3, y: 11, width: 18, height: 11, rx: 2, ry: 2 },
};
const SEC_SHAPES: Record<SecurityState, Parameters<typeof svg>[0]> = {
  idle: [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 9 } },
    'M3.6 9h16.8',
    'M3.6 15h16.8',
    'M12 3a14.5 14.5 0 0 1 0 18',
    'M12 3a14.5 14.5 0 0 0 0 18',
  ],
  loading: ['M21 12a9 9 0 1 1-6.22-8.56'],
  secure: [LOCK_RECT, 'M7 11V7a5 5 0 0 1 10 0v4'],
  insecure: [LOCK_RECT, 'M7 11V7a5 5 0 0 1 9.9-1'],
  error: [
    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    'M12 9v4',
    'M12 17h.01',
  ],
};
const RELOAD_SHAPES = ['M21 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L21 10'];
const STOP_SHAPES = ['M18 6L6 18', 'M6 6l12 12'];

function withTimeout<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const fin = (v: T) => {
      if (!done) (done = true), clearTimeout(t), resolve(v);
    };
    const t = setTimeout(() => fin(fb), ms);
    p.then(fin, () => fin(fb));
  });
}

function raceReject<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}

function assignCfSrc(f: CfEl, href: string, rst = true) {
  if (rst && f.getAttribute('src') === href) f.removeAttribute('src');
  f.src = href;
  if (f.getAttribute('src') !== href) f.setAttribute('src', href);
}

function mkBtn(cls: string, id: string, txt: string, fn: Fn, dis = false) {
  const b = tid(el('button', `btn ${cls}`, txt), id);
  b.type = 'button';
  b.disabled = dis;
  return b.addEventListener('click', fn), b;
}

const mkAbort = (u: UrlN, reason: string, host = '—'): AbortInfo => ({
  url: u?.href ?? '',
  hostPort: u ? hostPortKey(u) : '',
  host,
  reason,
  at: performance.now(),
});

function mountCf(container: HTMLElement, ctx: ShellContext): void {
  const setWs = (state: WorkspaceLiveStatus['state'], label: string) =>
    ctx.setWorkspaceStatus('controlled-frame-tls', { state, label });
  setWs('probing', 'Standby');

  const logConsole = createLogConsole({
    title: 'Controlled Frame Console Log',
    logTestId: 'cf-event-log',
    clearBtnTestId: 'cf-clear-log-btn',
    toggleTestId: 'cf-toggle-console-btn',
    maxLines: 160,
    initialExpanded: false,
  });
  const log = (msg: string) => logConsole.append(msg);

  let cf!: CfEl;
  let [menuSeq, histSeq, navSeq, secSeq, injectSeq] = [0, 0, 0, 0, 0];
  let [part, scriptActive, clearBusy] = [DEF_PART, false, false];
  let [hasCertUi, syncingUrl, stopAt, redriveAt] = [false, false, 0, 0];
  let [navigated, settled, exited, loading] = [false, false, false, false];
  let [stopReq, sawStart, committed] = [false, false, false];
  let [scriptErr, stopHref]: [StrN, StrN] = [null, null];
  let [redriveHref, pendScheme]: [StrN, ProtoSc] = [null, null];
  let [commitUrl, pendUrl, lastUrl]: [UrlN, UrlN, UrlN] = [null, null, null];
  let [abort, priorAbort]: [AbortN, AbortN] = [null, null];
  let cert: CapturedCert | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let pendInj: ProtocolInjectorSpec | null = null;
  const bumpInject = () => (
    (scriptActive = false), (scriptErr = null), ++injectSeq
  );
  const pins = new Map<string, CapturedCert>();

  const idleHint = 'Standby — click Navigate to load URL';
  const secIndEl = el('span', 'cf-security-indicator');
  tid(secIndEl, 'cf-security-indicator').dataset.securityState = 'idle';
  secIndEl.title = idleHint;
  sAttrs(secIndEl, { role: 'img', 'aria-label': idleHint });
  const lockOpts = { size: 16, className: 'cf-url-lock-icon' };
  secIndEl.appendChild(svg(SEC_SHAPES.idle, lockOpts));

  const setSecInd = (s: SecurityState, label: string) => {
    secIndEl.dataset.securityState = s;
    secIndEl.title = label;
    secIndEl.setAttribute('aria-label', label);
    const cls = `cf-url-lock-icon${s === 'loading' ? ' is-spinning' : ''}`;
    secIndEl.replaceChildren(svg(SEC_SHAPES[s], { size: 16, className: cls }));
  };

  const urlInput = tid(el('input', 'cf-url-input mono'), 'cf-url-input');
  sAttrs(urlInput, {
    type: 'text',
    inputmode: 'url',
    value: DEF_URL,
    placeholder: DEF_URL,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Browser Target URL',
  });
  urlInput.defaultValue = urlInput.value = DEF_URL;

  const standbyLabel = () =>
    urlInput.value.trim() ? idleHint : 'Standby — enter an HTTP or HTTPS URL';
  const httpsLbl = (o: string, s = 'secure') => `HTTPS (${s}) · ${o}`;
  const httpLbl = (o: string) => `Unencrypted HTTP connection (${o})`;

  const urlCopyBtn = createCopyIconButton({
    getText: () => urlInput.value.trim(),
    watchEl: urlInput,
    title: 'Copy target URL',
    testId: 'cf-copy-url-btn',
    className: 'cf-omnibox-copy-btn',
  });
  const omniboxEl = el('div', 'cf-url-omnibox', secIndEl, urlInput, urlCopyBtn);
  const errOpts = { id: ERR_BANNER_ID, testId: 'cf-url-error' };
  const urlError = createAlertBanner(errOpts);
  const invAttrs = {
    'aria-invalid': 'true',
    'aria-describedby': ERR_BANNER_ID,
  };

  const setUrlError = (msg?: string) => {
    const bad = Boolean(msg);
    if (msg) urlError.show(msg);
    else urlError.clear();
    omniboxEl.classList.toggle('is-invalid', bad);
    if (bad) sAttrs(urlInput, invAttrs);
    else
      ['aria-invalid', 'aria-describedby'].forEach((a) =>
        urlInput.removeAttribute(a),
      );
  };

  const setOmnibox = (val: string) => {
    syncingUrl = true;
    urlInput.value = val;
    syncingUrl = false;
    syncCopyButton(urlCopyBtn), syncToolbar();
  };

  const fmtProvenance = (rawUrl: string): string => {
    const p = normHttp(rawUrl);
    if (!p) return rawUrl.trim() || PROV_INIT;
    return p.pathname === '/' && !p.search && !p.hash ? p.origin : p.href;
  };
  const provenanceEl = el('span', 'cf-tls-provenance-url mono', PROV_INIT);
  tid(provenanceEl, 'tls-provenance-url').title = PROV_INIT;
  const setProvenance = (txt: string, full = txt) => {
    provenanceEl.textContent = txt;
    provenanceEl.title = full;
  };

  function mkCertMeta(label: string, key: string) {
    let box: ReturnType<typeof createMetaBox> | undefined;
    const ct = key === 'cipher' ? label : `certificate ${label}`;
    box = createMetaBox({
      label,
      valueTestId: `tls-cert-${key}`,
      copyTestId: `tls-copy-${key}-btn`,
      copyTitle: `Copy ${ct}`,
      mono: true,
      bold: key === 'subject',
      getCopyText: () => (hasCertUi ? box?.valueEl.textContent ?? '' : ''),
    });
    return box;
  }
  const subjectMeta = mkCertMeta('Subject', 'subject');
  const issuerMeta = mkCertMeta('Issuer', 'issuer');
  const cipherMeta = mkCertMeta('Public Key & Validity', 'cipher');

  const shaCls = 'ws-kv-bar-val cf-tls-fingerprint-val mono tabular-nums';
  const certShaEl = tid(el('span', shaCls, INIT_SHA_HINT), 'tls-cert-sha256');
  certShaEl.title = INIT_SHA_HINT;
  const getSha = () =>
    !hasCertUi
      ? ''
      : cert
        ? colonHex(cert.sha256Hex)
        : certShaEl.textContent ?? '';
  const copyShaBtn = createCopyIconButton({
    getText: getSha,
    title: 'Copy SHA-256 fingerprint',
    testId: 'tls-copy-sha256-btn',
    className: 'cf-copy-sha256-btn',
    watchEl: certShaEl,
  });

  function setCert(s = '—', i = '—', c = '—', sha = INIT_SHA_HINT, ok = false) {
    hasCertUi = ok;
    subjectMeta.setValue(s);
    issuerMeta.setValue(i);
    cipherMeta.setValue(c);
    certShaEl.textContent = certShaEl.title = sha;
    syncCopyButton(copyShaBtn);
  }
  const httpIss = 'Unencrypted HTTP (no TLS certificate)';
  const setHttpCert = (h: string) =>
    setCert(h || '—', httpIss, 'Cleartext HTTP', 'None (http:// connection)');

  const bdCls = 'ws-empty-badge frame-empty-badge mono';
  const bdBadge = el('span', bdCls, 'CONTROLLED FRAME · STANDBY');
  const bdTxt =
    'Enter a web address above and click Navigate to load it in an isolated storage partition.';
  const bdCap = el('span', 'frame-empty-caption', bdTxt);
  const backdrop = el('div', 'frame-empty-backdrop', bdBadge, bdCap);
  tid(backdrop, 'cf-empty-backdrop').setAttribute('aria-hidden', 'true');

  let [backBtn, fwdBtn, reloadBtn]: [Btn, Btn, Btn] = [null, null, null];
  let [navBtn, clrBtn]: [Btn, Btn] = [null, null];
  let [jsBtn, cssBtn]: [Btn, Btn] = [null, null];

  const syncToolbar = () => {
    if (navBtn) navBtn.disabled = !urlInput.value.trim();
    if (!navigated) {
      if (backBtn) backBtn.disabled = true;
      if (fwdBtn) fwdBtn.disabled = true;
    }
    if (reloadBtn) {
      const stop = navigated && loading;
      const mode = stop ? 'stop' : 'reload';
      const prev = reloadBtn.dataset.mode;
      reloadBtn.dataset.mode = mode;
      reloadBtn.disabled = !navigated;
      const lbl = stop ? 'Stop loading' : 'Reload';
      reloadBtn.title = lbl;
      reloadBtn.setAttribute('aria-label', lbl);
      if (prev !== mode)
        reloadBtn.replaceChildren(svg(stop ? STOP_SHAPES : RELOAD_SHAPES));
    }
    if (clrBtn) clrBtn.disabled = !navigated || clearBusy;
  };

  const syncHistory = async () => {
    const [tCf, seq] = [cf, ++histSeq];
    if (!navigated || !tCf) {
      if (backBtn) backBtn.disabled = true;
      if (fwdBtn) fwdBtn.disabled = true;
      return;
    }
    const p = (fn?: () => Promise<boolean> | boolean) =>
      typeof fn === 'function'
        ? withTimeout(Promise.resolve(fn.call(tCf)), 1200, false)
        : Promise.resolve(false);
    const [b, f] = await Promise.all([tCf.canGoBack, tCf.canGoForward].map(p));
    if (tCf !== cf || seq !== histSeq || !navigated) return;
    if (backBtn) backBtn.disabled = !b;
    if (fwdBtn) fwdBtn.disabled = !f;
  };

  const syncCommittedInd = () => {
    if (!commitUrl) return;
    if (commitUrl.protocol === 'http:')
      return setSecInd('insecure', httpLbl(commitUrl.origin));
    const s = cert?.securityState ?? 'secure';
    const mode: SecurityState = cert && s !== 'secure' ? 'insecure' : 'secure';
    setSecInd(mode, httpsLbl(commitUrl.origin, s));
  };

  const applyCommittedSecurity = (url: URL, pinFirst = false) => {
    if (url.protocol === 'http:') {
      cert = null;
      setHttpCert(url.hostname), setSecInd('insecure', httpLbl(url.origin));
      return setWs('portal', `HTTP ${url.hostname}`);
    }
    const hp = hostPortKey(url);
    const cur = cert?.hostPort === hp ? cert : null;
    const hit = pinFirst ? pins.get(hp) ?? cur : cur ?? pins.get(hp) ?? null;
    if (hit) {
      cert = hit;
      const m = describeCert(hit.rawDer, url.hostname);
      setCert(m.subject, m.issuer, m.cipher, colonHex(hit.sha256Hex), true);
      const ok = hit.securityState === 'secure';
      const stLbl = httpsLbl(url.origin, hit.securityState);
      setSecInd(ok ? 'secure' : 'insecure', stLbl);
      setWs(
        ok ? 'online' : 'portal',
        `${url.hostname} (${hit.sha256Hex.slice(0, 8)}…)`,
      );
    } else {
      cert = null;
      const resIss =
        'HTTPS (session resumed — click Reload to inspect raw DER)';
      const resSha = 'Click Reload to capture fresh X.509 leaf certificate';
      setCert(url.hostname || '—', resIss, 'TLS (session resumed)', resSha);
      setSecInd('secure', httpsLbl(url.origin)), setWs('online', url.hostname);
    }
  };

  function mkTa(id: string, def: string, ph: string) {
    const ta = el('textarea', 'form-input mono cf-inject-textarea', def);
    sAttrs(tid(ta, id), {
      id,
      rows: '4',
      placeholder: ph,
      spellcheck: 'false',
    });
    return (ta.defaultValue = ta.value = def), ta;
  }
  const defJs =
    "document.title = `[IWA] ${document.title}`;\nconst h1 = document.querySelector('h1');\nif (h1) h1.textContent = 'Modified by Host IWA';\ndocument.title;";
  const defCss =
    'html, body {\n  background: #f3efe8 !important;\n  color: #24211e !important;\n}';
  const jsPh = 'JavaScript expression to run in guest';
  const jsInput = mkTa('cf-js-input', defJs, jsPh);
  const cssIn = mkTa('cf-css-input', defCss, 'CSS rules to inject into guest');

  const injectStatusEl = el('div', 'cf-inject-status mono', STANDBY_INJECT);
  tid(injectStatusEl, 'cf-inject-status').dataset.state = 'idle';
  sAttrs(injectStatusEl, {
    role: 'status',
    'aria-live': 'polite',
    'aria-label': 'Script and stylesheet injection status',
  });
  const setInject = (tone: InjectTone, msg: string) => {
    injectStatusEl.dataset.state = tone;
    injectStatusEl.textContent = msg;
    injectStatusEl.classList.toggle('is-ok', tone === 'ok');
    injectStatusEl.classList.toggle('is-error', tone === 'error');
  };

  const syncInjectBtns = () => {
    if (jsBtn) jsBtn.disabled = !committed || !jsInput.value.trim();
    if (cssBtn) cssBtn.disabled = !committed || !cssIn.value.trim();
  };
  for (const inp of [jsInput, cssIn]) {
    inp.addEventListener('input', syncInjectBtns);
    inp.addEventListener('change', syncInjectBtns);
  }

  const reportScript = (ok: boolean, text: string) => {
    const c = capInject(text);
    const pfx = ok ? 'Script result' : 'Script error';
    setInject(ok ? 'ok' : 'error', `${pfx}: ${c}`);
    log(`[exec-js${ok ? '' : ' error'}] ${ok ? `result: ${c}` : c}`);
  };

  const runJs = () => {
    const code = jsInput.value.trim();
    if (!committed || !code) return;
    const [tCf, opSeq] = [cf, bumpInject()];
    const key = makeExecKey(opSeq);
    [scriptActive, scriptErr] = [true, null];
    setInject('running', 'Running JavaScript in guest page…');

    void (async () => {
      try {
        if (typeof tCf.executeScript !== 'function') {
          setInject('error', 'Script error: executeScript unavailable.');
          return log('[exec-js] executeScript unavailable');
        }
        const exec = (c: string) => {
          const p = Promise.resolve(tCf.executeScript({ code: c }));
          return withTimeout<unknown>(p, 4000, TIMEOUT_SYM);
        };
        const raw = await exec(buildEvalEnvelope(code, key));
        if (tCf !== cf || opSeq !== injectSeq) return;
        const toMsg = 'Timed out waiting for guest script completion';
        if (raw === TIMEOUT_SYM) return reportScript(false, toMsg);

        const first = Array.isArray(raw) ? raw[0] : raw;
        const rec =
          first && typeof first === 'object'
            ? (first as Record<string, GuestScriptEnv>)
            : null;
        const env = rec && key in rec ? rec[key] ?? null : null;
        if (!env) return reportScript(true, 'undefined');
        if (env.ok) return reportScript(true, env.formatted ?? 'undefined');
        if (!env.cspBlocked) return reportScript(false, env.error ?? 'Error');

        scriptErr = null;
        const fbRaw = await exec(code);
        if (tCf !== cf || opSeq !== injectSeq) return;
        if (fbRaw === TIMEOUT_SYM) return reportScript(false, toMsg);
        const fbVal = Array.isArray(fbRaw) ? fbRaw[0] : fbRaw;
        if (fbVal === undefined && !scriptErr)
          await new Promise<void>((r) => setTimeout(r, 40));
        if (tCf !== cf || opSeq !== injectSeq) return;
        if (fbVal === undefined && scriptErr)
          return reportScript(false, scriptErr);
        let fmt = 'undefined';
        try {
          if (fbVal === null) fmt = 'null';
          else if (typeof fbVal === 'string') fmt = fbVal;
          else if (fbVal !== undefined)
            fmt = JSON.stringify(fbVal) ?? String(fbVal);
        } catch {
          fmt = '[Object]';
        }
        reportScript(true, fmt);
      } catch (err) {
        if (tCf === cf && opSeq === injectSeq) reportScript(false, fmtErr(err));
      } finally {
        if (injectSeq === opSeq) [scriptActive, scriptErr] = [false, null];
      }
    })();
  };

  const applyCss = () => {
    const code = cssIn.value.trim();
    if (!committed || !code) return;
    const [tCf, opSeq] = [cf, bumpInject()];
    setInject('running', 'Applying stylesheet to guest page…');
    void (async () => {
      try {
        if (typeof tCf.insertCSS !== 'function') {
          setInject('error', 'Stylesheet error: insertCSS unavailable.');
          return log('[inject-css] insertCSS unavailable');
        }
        const pCss = Promise.resolve(tCf.insertCSS({ code })).then(() => true);
        const ok = await withTimeout(pCss, 4000, false);
        if (tCf !== cf || opSeq !== injectSeq) return;
        if (!ok) {
          const toErr = 'Timed out waiting for insertCSS';
          setInject('error', `Stylesheet error: ${toErr}.`);
          return log(`[inject-css error] ${toErr}`);
        }
        setInject('ok', `Stylesheet applied (${code.length} chars)`);
        log(`[inject-css] Injected stylesheet (${code.length} chars)`);
      } catch (err) {
        if (tCf !== cf || opSeq !== injectSeq) return;
        const m = fmtErr(err);
        setInject('error', `Stylesheet error: ${m}`),
          log(`[inject-css error] ${m}`);
      }
    })();
  };

  const jsCls = 'btn-primary cf-run-script-btn';
  jsBtn = mkBtn(jsCls, 'cf-inject-js-btn', 'Run Script', runJs, true);
  cssBtn = mkBtn(
    'cf-apply-css-btn',
    'cf-inject-css-btn',
    'Apply CSS',
    applyCss,
    true,
  );

  let mountControlledFrame!: (partition: string) => void;

  const syncFocusability = () => {
    if (!cf) return;
    const bdVis = !backdrop.classList.contains('is-dismissed');
    if (bdVis || exited) {
      cf.tabIndex = -1;
      sAttrs(cf, { tabindex: '-1', 'aria-hidden': 'true' });
    } else cf.removeAttribute('tabindex'), cf.removeAttribute('aria-hidden');
  };
  const setDismissed = (dismissed: boolean) => {
    backdrop.classList.toggle('is-dismissed', dismissed);
    syncFocusability();
  };

  const resetTransient = (keepPrior = false, bumpInj = true) => {
    if (keepPrior) priorAbort = !committed ? abort ?? priorAbort : null;
    stopReq = exited = false;
    stopHref = redriveHref = abort = null;
    ++navSeq;
    if (bumpInj) ++secSeq, bumpInject();
  };

  const syncAll = () => (syncToolbar(), syncInjectBtns(), void syncHistory());

  const restoreCommitted = (url: URL) => {
    loading = exited = sawStart = false;
    pendUrl = abort = priorAbort = null;
    lastUrl = url;
    setDismissed(true), setOmnibox(url.href);
    setProvenance(fmtProvenance(url.href), url.href);
    applyCommittedSecurity(url, false);
    if (injectStatusEl.dataset.state === 'idle')
      setInject('ready', READY_INJECT);
    syncAll();
  };

  const restoreAbort = (info: AbortInfo) => {
    abort = priorAbort = info;
    navigated = settled = true;
    loading = sawStart = committed = false;
    pendUrl = commitUrl = cert = null;
    setDismissed(true);
    const pf = normHttp(info.url);
    if (pf) {
      lastUrl = pf;
      setOmnibox(pf.href), setProvenance(fmtProvenance(pf.href), pf.href);
    } else if (info.url) {
      setOmnibox(info.url), setProvenance(fmtProvenance(info.url), info.url);
    } else setProvenance(info.host !== '—' ? info.host : 'Navigation error');

    const failMsg = `Navigation failed (${info.reason})`;
    setSecInd('error', failMsg);
    const r = info.reason;
    setCert(info.host || '—', `Failed — ${r}`, '—', `Unavailable — ${r}`);
    issuerMeta.valueEl.title = failMsg;
    setInject('idle', STANDBY_INJECT);
    syncAll(), setWs('offline', 'Navigation Error');
  };

  const restoreStandby = () => {
    navigated = settled = exited = false;
    loading = sawStart = committed = false;
    pendUrl = lastUrl = commitUrl = null;
    abort = priorAbort = cert = null;
    setDismissed(false), setSecInd('idle', standbyLabel());
    setProvenance(PROV_INIT), setCert(), setInject('idle', STANDBY_INJECT);
    syncAll(), setWs('probing', 'Standby');
  };

  const stepHistory = (dir: 'back' | 'forward') => {
    const btn = dir === 'back' ? backBtn : fwdBtn;
    if (!navigated || !btn || btn.disabled) return;
    const [tCf, wasExited] = [cf, exited];
    resetTransient(true, true), syncFocusability(), setUrlError();
    const reqSeq = navSeq;
    if (committed) setInject('ready', READY_INJECT);

    const restoreIfUnmoved = () => {
      if (navSeq === reqSeq && !loading && !committed && priorAbort) {
        [abort, exited] = [priorAbort, wasExited];
        syncFocusability();
        setSecInd('error', `Navigation failed (${priorAbort.reason})`);
      }
    };
    try {
      const fn = dir === 'back' ? tCf.back : tCf.forward;
      if (typeof fn === 'function') {
        void Promise.resolve(fn.call(tCf))
          .then((moved) => {
            if (tCf !== cf) return;
            if (!moved) restoreIfUnmoved();
            log(`[nav] ${dir}() -> ${moved ? 'ok' : 'boundary'}`),
              void syncHistory();
          })
          .catch((e) => {
            if (tCf !== cf) return;
            restoreIfUnmoved();
            log(`[nav] ${dir}() skipped: ${fmtErr(e)}`), void syncHistory();
          });
      }
    } catch (e) {
      restoreIfUnmoved(), log(`[nav] ${dir}() unavailable: ${fmtErr(e)}`);
    }
  };

  function mkIconBtn(id: string, label: string, d: string, fn: Fn) {
    const b = mkBtn('cf-icon-btn', id, '', fn, true);
    sAttrs(b, { title: label, 'aria-label': label });
    return b.replaceChildren(svg([d])), b;
  }
  const go = (d: 'back' | 'forward') => () => stepHistory(d);
  backBtn = mkIconBtn('cf-back-btn', 'Back', 'M15 18l-6-6 6-6', go('back'));
  const fwdId = 'cf-forward-btn';
  fwdBtn = mkIconBtn(fwdId, 'Forward', 'M9 18l6-6-6-6', go('forward'));

  const onReloadOrStop = () => {
    if (!navigated) return;
    setUrlError();
    try {
      if (loading && reloadBtn?.dataset.mode === 'stop') {
        const tCf = cf;
        const curRaw = String(tCf.src || tCf.getAttribute('src') || '');
        const toStop = pendUrl?.href ?? normHttp(curRaw)?.href ?? null;
        [stopReq, sawStart, stopAt] = [true, false, performance.now()];
        [stopHref, redriveHref] = [toStop, null];
        const stopSeq = ++navSeq;
        ++secSeq, bumpInject(), tCf.stop?.();
        const actAbort = abort ?? priorAbort;
        if (committed && commitUrl) {
          restoreCommitted(commitUrl);
          [stopReq, stopHref] = [true, toStop];
        } else if (actAbort) {
          restoreAbort(actAbort);
          [stopReq, stopHref] = [true, toStop];
        } else if (!settled) {
          mountControlledFrame(part);
          return log(`[nav] stop() (${toStop || 'cold-standby'})`);
        } else {
          loading = sawStart = false;
          pendUrl = null;
          if (secIndEl.dataset.securityState === 'loading')
            setSecInd('error', 'Navigation failed (ERR_ABORTED)');
          syncAll();
        }
        queueMicrotask(() => {
          if (stopReq && navSeq === stopSeq && tCf === cf) {
            try {
              tCf.stop?.();
            } catch {}
          }
        });
        return log(`[nav] stop() (${toStop || tCf.src || 'in-flight'})`);
      }

      const [target, wasExited] = [commitUrl ?? lastUrl, exited];
      resetTransient(true, true);
      sawStart = loading = true;
      pendUrl = target;
      setSecInd('loading', 'Reloading page…');
      if (wasExited && target) {
        lastUrl = target;
        setDismissed(true), syncToolbar(), assignCfSrc(cf, target.href);
        return log(`[nav] reload() (${target.href})`);
      }
      if (typeof cf.reload === 'function') {
        if (committed) setInject('ready', READY_INJECT);
        syncToolbar(),
          cf.reload(),
          log(`[nav] reload() (${cf.src || 'current'})`);
      }
    } catch (e) {
      loading = stopReq = sawStart = false;
      stopHref = null;
      if (secIndEl.dataset.securityState === 'loading') {
        const fb = abort ?? priorAbort;
        if (committed && commitUrl) syncCommittedInd();
        else if (fb) setSecInd('error', `Navigation failed (${fb.reason})`);
        else setSecInd('idle', standbyLabel());
      }
      syncToolbar(), log(`[nav] reload/stop error: ${fmtErr(e)}`);
    }
  };

  reloadBtn = mkBtn('cf-icon-btn', 'cf-reload-btn', '', onReloadOrStop, true);
  reloadBtn.dataset.mode = 'reload';
  sAttrs(reloadBtn, { title: 'Reload', 'aria-label': 'Reload' });
  reloadBtn.replaceChildren(svg(RELOAD_SHAPES));

  urlInput.addEventListener('input', () => {
    if (syncingUrl) return;
    setUrlError();
    const s = secIndEl.dataset.securityState;
    if (s === 'error') {
      const fb = abort ?? (settled ? priorAbort : null);
      const ldLbl = pendUrl ? `Loading ${pendUrl.origin}…` : 'Loading…';
      if (loading) setSecInd('loading', ldLbl);
      else if (committed && commitUrl) syncCommittedInd();
      else if (fb) setSecInd('error', `Navigation failed (${fb.reason})`);
      else setSecInd('idle', standbyLabel());
    } else if (s === 'idle') setSecInd('idle', standbyLabel());
    syncToolbar();
  });

  const resetClearFeedback = () => {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
    if (clrBtn) {
      clrBtn.textContent = 'Clear Storage';
      clrBtn.classList.remove('is-cleared');
      delete clrBtn.dataset.clearState;
    }
  };

  const navigateFrame = (rawTarget: string, source: string): UrlN => {
    const res = parseOmniboxUrl(rawTarget);
    if (!res.ok) {
      setUrlError(res.reason), setSecInd('error', res.reason);
      const bad = snip(rawTarget) || '(empty)';
      return log(`[${source}] Rejected URL "${bad}": ${res.reason}`), null;
    }
    const u = res.url;
    setUrlError(), resetClearFeedback();
    const curSrc = String(cf?.src || cf?.getAttribute('src') || '').trim();
    if (loading && !stopReq && pendUrl?.href === u.href)
      return setOmnibox(u.href), u;

    const sameBase =
      committed && commitUrl && stripHash(commitUrl) === stripHash(u);
    const sameDocHash = Boolean(sameBase && commitUrl!.hash !== u.hash);
    resetTransient(true, !sameDocHash);
    sawStart = !sameDocHash;
    navigated = loading = true;
    pendUrl = lastUrl = u;
    setOmnibox(u.href), setProvenance(fmtProvenance(u.href), u.href);
    setSecInd('loading', `Loading ${u.origin}…`);
    if (!committed) setInject('idle', STANDBY_INJECT);
    else if (!sameDocHash) setInject('ready', READY_INJECT);
    syncInjectBtns();

    if (!sameDocHash) {
      if (u.protocol === 'http:') setHttpCert(u.hostname);
      else {
        const capHint =
          'Capturing X.509 leaf certificate from top-level HTTPS navigation…';
        setCert(u.hostname || '—', 'Waiting for HTTPS response…', '—', capHint);
      }
    }
    try {
      const sameHref =
        curSrc === u.href && committed && commitUrl?.href === u.href;
      if (!sameDocHash && sameHref && typeof cf.reload === 'function')
        cf.reload();
      else assignCfSrc(cf, u.href, !sameDocHash);
      setDismissed(true), syncToolbar();
      log(`[${source}] Navigating (${part}) -> ${u.href}`);
    } catch (e) {
      loading = false;
      syncToolbar(), log(`[${source}] Navigation error: ${fmtErr(e)}`);
    }
    return u;
  };

  const navCls = 'btn-primary cf-navigate-btn';
  const onNav = () => void navigateFrame(urlInput.value, 'omnibox');
  navBtn = mkBtn(navCls, 'cf-navigate-btn', 'Navigate', onNav);
  urlInput.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') ev.preventDefault(), onNav();
  });

  const optPersist = el('option', null, 'Partition: Persistent');
  optPersist.value = DEF_PART;
  optPersist.selected = true;
  const optEphem = el('option', null, 'Partition: Ephemeral');
  optEphem.value = 'ephemeral';
  const pOpts = [optPersist, optEphem];
  const partSel = el('select', 'form-select cf-partition-select', ...pOpts);
  tid(partSel, 'cf-partition-select');
  partSel.setAttribute('aria-label', 'Storage Partition');

  const onClear = () => {
    if (!navigated || clearBusy || !clrBtn) return;
    const [tCf, cBtn] = [cf, clrBtn];
    const keepFocus = document.activeElement === cBtn;
    clearBusy = true;
    resetClearFeedback();
    cBtn.textContent = 'Clearing…';
    syncToolbar();

    void (async () => {
      try {
        if (typeof tCf.clearData !== 'function') {
          return resetClearFeedback(), log('[clearData] API unavailable');
        }
        const pClr = Promise.resolve(tCf.clearData({ since: 0 }, CLEAR_TYPES));
        const clrTo = 'Timed out waiting for clearData() completion';
        await raceReject(pClr, 2500, clrTo);
        if (tCf !== cf) return;
        log(`[clearData] Cleared storage for "${part}"`);
        cBtn.textContent = 'Storage Cleared';
        cBtn.classList.add('is-cleared');
        cBtn.dataset.clearState = 'cleared';
        clearTimer = setTimeout(resetClearFeedback, 1600);

        const hasDoc = !loading && committed && commitUrl;
        if (loading && pendUrl) {
          const u = pendUrl;
          resetTransient(false, true);
          [redriveHref, redriveAt] = [u.href, performance.now()];
          sawStart = loading = true;
          pendUrl = lastUrl = u;
          setDismissed(true), setOmnibox(u.href);
          setProvenance(fmtProvenance(u.href), u.href);
          setSecInd('loading', `Loading ${u.origin}…`);
          syncToolbar(), assignCfSrc(tCf, u.href);
        } else if (hasDoc && typeof tCf.reload === 'function') {
          priorAbort = null;
          resetTransient(false, true);
          sawStart = loading = true;
          pendUrl = commitUrl;
          setSecInd('loading', 'Reloading cleared page…');
          setInject('ready', READY_INJECT), syncToolbar(), tCf.reload();
        }
      } catch (e) {
        if (tCf === cf)
          resetClearFeedback(), log(`[clearData] Failed: ${fmtErr(e)}`);
      } finally {
        if (tCf === cf) {
          clearBusy = false;
          syncToolbar();
          const ae = document.activeElement;
          const lost =
            ae === document.body || ae === document.documentElement || !ae;
          const vis = !container.classList.contains('is-hidden');
          if (keepFocus && !cBtn.disabled && (lost || ae === cBtn) && vis)
            cBtn.focus({ preventScroll: true });
        }
      }
    })();
  };

  const clrCls = 'cf-clear-storage-btn';
  clrBtn = mkBtn(clrCls, 'cf-clear-data-btn', 'Clear Storage', onClear, true);
  clrBtn.setAttribute('aria-live', 'polite');

  const isStopGuard = (u: UrlN) =>
    stopReq &&
    performance.now() - stopAt < 1500 &&
    (!stopHref || u?.href === stopHref);

  const clearMatchAbort = (u: UrlN) => {
    const match =
      abort && u && (abort.url === u.href || abort.hostPort === hostPortKey(u));
    if (match) abort = null;
  };

  type SecInfo = WebRequestSecurityInfo;
  const handleSec = async (tCf: CfEl, reqUrl: string, sec: SecInfo) => {
    if (tCf !== cf) return;
    const pu = normHttp(reqUrl);
    if (isStopGuard(pu)) return;
    const [cNav, cSec, s] = [navSeq, ++secSeq, sec.state || 'unknown'];
    clearMatchAbort(pu);

    const rawBuf = sec.certificates?.[0]?.rawDER;
    if (!rawBuf || !rawBuf.byteLength || !pu) {
      const fresh =
        cNav === navSeq && cSec === secSeq && (!sawStart || !committed);
      if (pu?.protocol === 'http:' && fresh) {
        cert = null;
        setHttpCert(pu.hostname);
        if (committed && commitUrl?.protocol === 'http:')
          setSecInd('insecure', httpLbl(pu.origin));
      }
      const target = reqUrl || '(unknown)';
      return log(`[headersreceived] ${target} state=${s} (no DER)`);
    }

    const rawDer = new Uint8Array(rawBuf.slice(0));
    const digest = await sha256Hex(rawDer);
    if (tCf !== cf) return;
    const hp = hostPortKey(pu);
    if (abort?.hostPort === hp) return;

    const rec = { hostPort: hp, rawDer, sha256Hex: digest, securityState: s };
    const prevHp = lastUrl ? hostPortKey(lastUrl) : '';
    pins.set(hp, rec);
    const sameWww = hp === `www.${prevHp}` || prevHp === `www.${hp}`;
    if (prevHp && prevHp !== hp && sameWww) pins.set(prevHp, rec);
    log(`[x509] Captured DER for ${hp}: state=${s}, sha256=${digest}`);

    const cu = commitUrl;
    const match =
      committed && cu?.protocol === 'https:' && hostPortKey(cu) === hp;
    if (cNav !== navSeq || cSec !== secSeq || sawStart || !match || !cu) return;
    [cert, lastUrl] = [rec, cu];
    setProvenance(fmtProvenance(cu.href), cu.href);
    applyCommittedSecurity(cu, true);
  };

  const stageCls = 'frame-stage cf-viewport-container';
  const frameStage = tid(el('div', stageCls), 'cf-viewport-container');
  const resizeShieldEl = el('div', 'cf-resize-shield');
  resizeShieldEl.setAttribute('aria-hidden', 'true');
  const grip = el('span', 'cf-resize-grip');
  const resizeHandleEl = tid(
    el('div', 'cf-resize-handle', grip),
    'cf-resize-handle',
  );
  sAttrs(resizeHandleEl, {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'horizontal',
    'aria-valuemin': `${MIN_H}`,
    'aria-valuemax': `${MAX_H}`,
    'aria-valuenow': `${DEF_H}`,
    'aria-label': 'Resize Controlled Frame height',
    title:
      'Drag or use Up/Down/PageUp/PageDown/Home/End keys to resize height (double-click resets to 480px)',
  });

  let [curH, pendH, dragY, startH] = [DEF_H, DEF_H, 0, DEF_H];
  let [dragPid, rafId]: [number | null, number | null] = [null, null];
  let dragAc: AbortController | null = null;

  const setHeight = (px: number) => {
    const c = Math.round(Math.min(MAX_H, Math.max(MIN_H, px)));
    curH = pendH = c;
    frameStage.style.height = `${c}px`;
    resizeHandleEl.setAttribute('aria-valuenow', `${c}`);
  };

  const endDrag = (ev?: PointerEvent | FocusEvent) => {
    const wrongPtr =
      ev instanceof PointerEvent &&
      dragPid !== null &&
      ev.pointerId !== dragPid;
    if (!dragAc || wrongPtr) return;
    const pid = dragPid;
    dragPid = null;
    dragAc.abort();
    dragAc = null;
    if (rafId !== null) window.cancelAnimationFrame(rafId);
    rafId = null;
    setHeight(pendH);
    resizeHandleEl.classList.remove('is-dragging');
    resizeShieldEl.classList.remove('is-active');
    document.body.classList.remove('is-cf-resizing');
    if (cf) cf.style.pointerEvents = '';
    if (pid !== null) {
      try {
        if (resizeHandleEl.hasPointerCapture(pid))
          resizeHandleEl.releasePointerCapture(pid);
      } catch {}
    }
  };

  resizeHandleEl.addEventListener('lostpointercapture', endDrag);
  const isHidden = () =>
    container.classList.contains('is-hidden') ||
    container.hidden ||
    container.getAttribute('aria-hidden') === 'true';
  new MutationObserver(() => {
    if (dragAc && isHidden()) endDrag();
  }).observe(container, {
    attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden'],
  });

  resizeHandleEl.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault(), endDrag();
    dragAc = new AbortController();
    const { signal } = dragAc;
    [dragPid, dragY] = [ev.pointerId, ev.clientY];
    startH = pendH = frameStage.getBoundingClientRect().height || curH;
    resizeHandleEl.classList.add('is-dragging');
    resizeShieldEl.classList.add('is-active');
    document.body.classList.add('is-cf-resizing');
    if (cf) cf.style.pointerEvents = 'none';
    const onMove = (me: PointerEvent) => {
      if (dragPid !== null && me.pointerId !== dragPid) return;
      if ((me.buttons & 1) === 0) return endDrag(me);
      me.preventDefault();
      const raw = startH + (me.clientY - dragY);
      pendH = Math.round(Math.min(MAX_H, Math.max(MIN_H, raw)));
      if (rafId === null)
        rafId = window.requestAnimationFrame(
          () => ((rafId = null), setHeight(pendH)),
        );
    };
    window.addEventListener('pointermove', onMove, { passive: false, signal });
    for (const t of ['pointerup', 'pointercancel', 'blur'] as const)
      window.addEventListener(t, endDrag as EventListener, { signal });
    const onEsc = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') ke.preventDefault(), endDrag();
    };
    window.addEventListener('keydown', onEsc, { signal });
    document.addEventListener('visibilitychange', () => endDrag(), { signal });
    try {
      resizeHandleEl.setPointerCapture(ev.pointerId);
    } catch {}
  });
  resizeHandleEl.addEventListener('dblclick', () => setHeight(DEF_H));
  resizeHandleEl.addEventListener('keydown', (ev: KeyboardEvent) => {
    const map: Record<string, number> = {
      ArrowDown: curH + 24,
      ArrowUp: curH - 24,
      PageDown: curH + 120,
      PageUp: curH - 120,
      Home: MIN_H,
      End: MAX_H,
    };
    if (ev.key in map) ev.preventDefault(), setHeight(map[ev.key]);
  });

  type InjSpec = ProtocolInjectorSpec;
  function runInjector(tCf: CfEl, href: string, inj: InjSpec, sc0: ProtoSc) {
    const sc = sc0 ?? 'cf';
    if (!inj.color && !inj.css && !inj.text && !inj.js) {
      const code = `document.documentElement.dataset.cfProtocolLaunched = ${JSON.stringify(sc)};`;
      if (typeof tCf.executeScript === 'function')
        void Promise.resolve(tCf.executeScript({ code })).catch(() => {});
      return log(`[protocol] Executed ${sc}:// protocol injector on ${href}`);
    }
    void (async () => {
      try {
        if (inj.color || inj.css) {
          const css =
            inj.css ?? `body { background: ${inj.color} !important; }`;
          cssIn.value = css;
          if (typeof tCf.insertCSS === 'function')
            await tCf.insertCSS({ code: css });
          log(`[protocol] Injected CSS via ${sc}://: ${css}`);
        }
        if (inj.text || inj.js) {
          const js =
            inj.js ??
            `(() => { const t = ${JSON.stringify(inj.text)}; document.documentElement.dataset.cfProtocolText = t; document.querySelectorAll('[aria-label="I\\'m Feeling Lucky"], [aria-label="Ik doe een gok"], input[name="btnI"]').forEach((b) => { b.value = "I'm Feeling " + t; b.textContent = "I'm Feeling " + t; }); return "I'm Feeling " + t; })()`;
          jsInput.value = js;
          if (typeof tCf.executeScript === 'function')
            await tCf.executeScript({ code: js });
          log(`[protocol] Injected script via ${sc}://`);
        }
        const parts = [
          inj.text ? `text="I'm Feeling ${inj.text}"` : '',
          inj.color ? `color=${inj.color}` : '',
          inj.js ? 'custom JS' : '',
          inj.css ? 'custom CSS' : '',
        ].filter(Boolean);
        setInject('ok', `Protocol injector applied (${parts.join(', ')})`);
      } catch (e) {
        log(`[protocol] Injector notice: ${fmtErr(e)}`);
      }
    })();
  }

  const onLoadStart = (tCf: CfEl, ev: Event) => {
    const ls = ev as LoadStartEvent;
    const url = ls.loadInfo?.url ?? ls.url ?? '';
    const top = ls.loadInfo?.isTopLevel ?? ls.isTopLevel ?? true;
    if (!top || !url || url === 'about:blank') return;
    const ps = normHttp(url);
    if (isStopGuard(ps)) {
      stopAt = performance.now();
      ++navSeq, ++secSeq;
      try {
        tCf.stop?.();
      } catch {}
      return log(`[loadstart] ${url} (stopped)`);
    }
    if (ps && !(!loading && abort?.url === ps.href)) {
      stopReq = exited = false;
      stopHref = abort = null;
      sawStart = true;
      if (pendUrl?.href !== ps.href) ++navSeq, bumpInject();
      navigated = loading = true;
      pendUrl = lastUrl = ps;
      setDismissed(true);
      setSecInd('loading', `Loading ${ps.origin}…`), syncToolbar();
    }
    log(`[loadstart] ${url}`);
  };

  const onLoadCommit = (ev: Event) => {
    const lc = ev as LoadCommitEvent & { url?: string; isTopLevel?: boolean };
    const cUrl = lc.loadInfo?.url ?? lc.url ?? '';
    const isTop = lc.loadInfo?.isTopLevel ?? lc.isTopLevel ?? true;
    if (!isTop || !cUrl) return;

    [exited, redriveHref] = [false, null];
    const pc = normHttp(cUrl);
    const isErr =
      cUrl.startsWith('chrome-error://') || cUrl.includes('chromewebdata');
    if (isErr || abort !== null) {
      [stopReq, stopHref] = [false, null];
      ++secSeq, bumpInject();
      const fp = normHttp(abort?.url ?? '') ?? pendUrl ?? lastUrl ?? pc;
      const reason = abort?.reason ?? priorAbort?.reason ?? 'ERR_FAILED';
      const host = priorAbort?.host || fp?.hostname || '—';
      restoreAbort(abort ?? mkAbort(fp, reason, host));
      return log(`[loadcommit] (${part}) error-interstitial (${reason})`);
    }

    if (/^(https?|data|blob):/i.test(cUrl)) setDismissed(true);
    if (pc) {
      stopReq = false;
      stopHref = abort = priorAbort = null;
      const prev = commitUrl;
      const sameDoc =
        committed &&
        prev !== null &&
        (!sawStart
          ? prev.origin === pc.origin
          : stripHash(prev) === stripHash(pc) &&
            pendUrl !== null &&
            pendUrl.href !== pc.href);
      sawStart = false;
      if (sameDoc) {
        if (loading) ++navSeq, ++secSeq;
        [loading, pendUrl] = [false, null];
      } else bumpInject();
      navigated = settled = committed = true;
      commitUrl = lastUrl = pc;
      if (pc.protocol === 'http:') ++secSeq;
      applyCommittedSecurity(pc, true), setOmnibox(pc.href);
      setProvenance(fmtProvenance(pc.href), pc.href);
      if (!sameDoc || injectStatusEl.dataset.state === 'idle')
        setInject('ready', READY_INJECT);
      syncInjectBtns();
    }
    syncToolbar(), void syncHistory(), log(`[loadcommit] (${part}) ${cUrl}`);
  };

  const onLoadStop = (tCf: CfEl) => {
    const curSrc = String(tCf.src || tCf.getAttribute('src') || '').trim();
    loading = sawStart = false;
    pendUrl = redriveHref = null;
    if (secIndEl.dataset.securityState === 'loading') {
      const fb = abort ?? priorAbort;
      if (committed && commitUrl) syncCommittedInd();
      else if (fb) restoreAbort(fb);
      else if (!navigated || !settled) restoreStandby();
      else setSecInd('error', 'Navigation failed (ERR_ABORTED)');
    }
    syncToolbar(), void syncHistory();
    log(`[loadstop] (${part}) ${curSrc || 'about:blank'}`);
    if (committed && commitUrl && pendInj !== null) {
      const [inj, sc] = [pendInj, pendScheme];
      [pendInj, pendScheme] = [null, null];
      runInjector(tCf, commitUrl.href, inj, sc);
    }
  };

  type LaEv = LoadAbortEvent & {
    url?: string;
    reason?: string;
    isTopLevel?: boolean;
  };
  const onLoadAbort = (ev: Event) => {
    const la = ev as LaEv;
    const aUrl = la.loadAbortInfo?.url ?? la.url ?? '';
    const reason = la.loadAbortInfo?.reason ?? la.reason ?? 'ERR_ABORTED';
    const isTop = la.loadAbortInfo?.isTopLevel ?? la.isTopLevel ?? true;
    log(`[loadabort] ${aUrl} reason=${reason}`);
    if (!isTop || !aUrl) return;

    const pa = normHttp(aUrl) ?? pendUrl ?? lastUrl;
    const ahp = pa ? hostPortKey(pa) : '';
    const isAborted = reason === 'ERR_ABORTED';
    const inRedrive =
      !stopReq && redriveHref !== null && performance.now() - redriveAt < 1500;
    if (isAborted && inRedrive && (!pa || pa.href === redriveHref))
      return void (redriveHref = null);
    redriveHref = null;

    const stale =
      !stopReq && loading && pendUrl && pa && pa.href !== pendUrl.href;
    if (isAborted && stale) return;
    if (isAborted && committed && commitUrl)
      return ++navSeq, ++secSeq, restoreCommitted(commitUrl);

    const pres = abort ?? priorAbort;
    if (isAborted && !committed) {
      if (stopReq) {
        ++navSeq, ++secSeq;
        if (pres) restoreAbort(pres);
        else if (!settled) restoreStandby();
        return;
      }
      if (
        pres &&
        pres.reason !== 'ERR_ABORTED' &&
        (!pa || pa.href === pres.url)
      )
        return ++navSeq, ++secSeq, restoreAbort(pres);
    }

    if (!isAborted && ahp) {
      pins.delete(ahp);
      if (cert?.hostPort === ahp) cert = null;
    }
    resetTransient(false, true);
    restoreAbort(mkAbort(pa, reason, pa?.hostname || aUrl || '—'));
  };

  const onExit = (tCf: CfEl, ev: Event) => {
    const ex = ev as ExitEvent;
    const rawR = String(ex.reason ?? ex.exitInfo?.reason ?? '').trim();
    if (!rawR || rawR === 'normal' || !navigated) return;
    const exPidRaw = ex.processId ?? ex.exitInfo?.processId;
    const exPid =
      typeof exPidRaw === 'number' && Number.isFinite(exPidRaw) ? exPidRaw : 0;
    let curPid = 0;
    try {
      const p = tCf.getProcessId?.();
      if (typeof p === 'number' && Number.isFinite(p)) curPid = p;
    } catch {}
    if (exPid > 0 && curPid > 0 && exPid !== curPid) return;
    const isAbortedIdle = () =>
      !loading && !committed && abort !== null && !exited;
    if (isAbortedIdle()) return;

    const applyCrash = () => {
      if (tCf !== cf || !navigated || isAbortedIdle()) return;
      log(`[exit] Guest process exited (reason=${rawR})`);
      const sfx = rawR.replace(/[^a-z0-9_]+/gi, '_').toUpperCase() || 'CRASHED';
      const u = commitUrl ?? pendUrl ?? lastUrl;
      resetTransient(false, true);
      [exited, sawStart] = [true, false];
      restoreAbort(mkAbort(u, `ERR_GUEST_PROCESS_${sfx}`, u?.hostname || '—'));
      setWs('offline', 'Guest Process Exited');
    };

    const idleDoc = !curPid && exPid > 0 && !loading && committed;
    if (idleDoc && typeof tCf.executeScript === 'function') {
      const chk = navSeq;
      void (async () => {
        const p = Promise.resolve(tCf.executeScript({ code: '1' })).catch(
          () => null,
        );
        const pr: unknown = await withTimeout<unknown>(p, 400, null);
        const alive = (Array.isArray(pr) ? pr[0] : pr) === 1;
        if (tCf === cf && navSeq === chk && !alive) applyCrash();
      })();
      return;
    }
    applyCrash();
  };

  type HrReq = {
    url?: string;
    type?: string;
    frameType?: string;
    frameId?: number;
    parentFrameId?: number;
  };
  const setupWebRequest = (tCf: CfEl) => {
    try {
      if (typeof tCf.request?.createWebRequestInterceptor !== 'function')
        return;
      const ic = tCf.request.createWebRequestInterceptor({
        urlPatterns: ['http://*/*', 'https://*/*'],
        resourceTypes: ['main-frame'],
        securityInfo: true,
        securityInfoRawDer: true,
      });
      ic.addEventListener('headersreceived', (ev) => {
        if (tCf !== cf) return;
        const hr = ev as WebRequestHeadersReceivedEvent & HrReq;
        const ro = (hr.request ?? {}) as HrReq;
        const rt = ro.type ?? hr.type ?? '';
        if (rt && rt !== 'main-frame' && rt !== 'main_frame') return;
        const ft = String(ro.frameType ?? hr.frameType ?? '');
        if (ft && ft !== 'outermost-frame' && ft !== 'outermost_frame') return;
        const fid = ro.frameId ?? hr.frameId;
        if (typeof fid === 'number' && fid !== 0) return;
        const pfid = ro.parentFrameId ?? hr.parentFrameId;
        if (typeof pfid === 'number' && pfid !== -1) return;
        const reqUrl = ro.url ?? hr.url ?? '';
        clearMatchAbort(normHttp(reqUrl));
        if (hr.securityInfo) void handleSec(tCf, reqUrl, hr.securityInfo);
      });
    } catch (e) {
      log(`[webrequest] Interceptor setup notice: ${fmtErr(e)}`);
    }
  };

  const setupContextMenus = (tCf: CfEl) => {
    try {
      if (typeof tCf.contextMenus?.create !== 'function') return;
      const menuId = `iwa-cf-inspect-${++menuSeq}`;
      const title = 'Log Page & X.509 Certificate Status to Console Log';
      void Promise.resolve(
        tCf.contextMenus.create({ id: menuId, title, contexts: ['all'] }),
      ).catch(() => {});
      tCf.contextMenus.addEventListener('click', (ev) => {
        if (tCf !== cf) return;
        const cc = ev as ContextMenusClickEvent & { menuItemId?: string };
        const id = cc.menuItem?.id ?? cc.menuItemId ?? menuId;
        const certTxt = cert ? `${cert.sha256Hex.slice(0, 12)}…` : 'none';
        const pg = cc.pageURL ?? tCf.src ?? 'guest';
        log(`[contextMenu] Clicked "${id}" on ${pg} (cert=${certTxt})`);
      });
    } catch (e) {
      log(`[contextMenus] Setup notice: ${fmtErr(e)}`);
    }
  };

  mountControlledFrame = (partition: string) => {
    endDrag();
    [part, stopAt, redriveAt, clearBusy] = [partition, 0, 0, false];
    resetTransient(false, true), pins.clear();
    if (!parseOmniboxUrl(urlInput.value).ok) {
      syncingUrl = true;
      urlInput.value = urlInput.defaultValue;
      syncingUrl = false;
    }
    setUrlError(), resetClearFeedback();

    const nextCf = document.createElement('controlledframe');
    nextCf.dataset.testid = 'cf-viewport';
    const cfLbl = 'Controlled Frame embedded web content';
    nextCf.title = cfLbl;
    nextCf.partition = partition;
    nextCf.tabIndex = -1;
    sAttrs(nextCf, {
      'aria-label': cfLbl,
      tabindex: '-1',
      'aria-hidden': 'true',
    });
    backdrop.classList.remove('is-dismissed');

    frameStage.replaceChildren(nextCf, backdrop, resizeShieldEl);
    cf = nextCf;
    syncCopyButton(urlCopyBtn), restoreStandby();

    const bind = (type: string, fn: (ev: Event) => void) =>
      nextCf.addEventListener(type, (ev) => {
        if (nextCf === cf) fn(ev);
      });
    bind('loadstart', (ev) => onLoadStart(nextCf, ev));
    bind('loadcommit', onLoadCommit);
    bind('loadstop', () => onLoadStop(nextCf));
    bind('loadabort', onLoadAbort);
    bind('newwindow', (ev) => {
      const nw = ev as NewWindowEvent;
      const u0 = nw.newWindow?.targetUrl ?? nw.targetUrl ?? '';
      const rawUrl = String(u0).trim();
      try {
        (nw.newWindow?.window ?? nw.window)?.discard?.();
      } catch {}
      const res = parseOmniboxUrl(rawUrl);
      if (res.ok) {
        log(`[newwindow] Navigating in-frame -> ${res.url.href}`);
        navigateFrame(res.url.href, 'newwindow');
      } else {
        const bad = snip(rawUrl) || 'about:blank';
        log(`[newwindow] Blocked popup "${bad}": ${res.reason}`);
      }
    });
    bind('dialog', (ev) => {
      const dg = ev as DialogEvent;
      const mt = dg.dialogMessage?.messageType ?? dg.messageType ?? 'dialog';
      const txt = String(dg.dialogMessage?.messageText ?? dg.messageText ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
      try {
        (dg.dialogMessage?.dialog ?? dg.dialog)?.cancel?.();
      } catch {}
      log(`[dialog] Auto-dismissed guest ${mt}: "${snip(txt)}"`);
    });
    bind('exit', (ev) => onExit(nextCf, ev));
    bind('consolemessage', (ev) => {
      const cm = ev as ConsoleMessageEvent & { message?: string };
      const msg = cm.consoleMessage?.message ?? cm.message ?? '';
      if (!msg) return;
      if (scriptActive && !scriptErr && /(?:SyntaxError|Uncaught)/i.test(msg))
        scriptErr = msg.replace(/^Uncaught\s+/i, '').trim();
      log(`[guest-console] ${msg}`);
    });
    bind('permissionrequest', (ev) => {
      const pr = ev as PermissionRequestEvent & {
        permission?: string;
        request?: { deny?: Fn };
      };
      const perm =
        pr.permissionRequest?.permission ?? pr.permission ?? 'unknown';
      try {
        pr.permissionRequest?.request?.cancel?.(), pr.request?.deny?.();
      } catch {}
      log(`[permission] Denied guest "${perm}" request`);
    });
    setupWebRequest(nextCf), setupContextMenus(nextCf);
    log(`[partition] Mounted <controlledframe> on "${partition}"`);
  };

  partSel.addEventListener('change', () => {
    const isEph = partSel.value.toLowerCase().includes('ephemeral');
    const sel = isEph ? 'ephemeral' : DEF_PART;
    if (sel !== part) mountControlledFrame(sel);
  });

  ctx.onProtocolLaunch((rawUrl, parsedUrl, res) => {
    if (!res.valid) {
      const bad = snip(parsedUrl || rawUrl, 160);
      return log(`[protocol] Rejected protocol launch "${bad}": ${res.reason}`);
    }
    log(`[protocol] Received ${res.scheme}:// launch -> ${res.httpTarget}`);
  });

  ctx.registerControlledFrameNavigator((incomingUrl, inspection) => {
    if (ctx.getActiveWorkspace() !== 'controlled-frame-tls')
      ctx.activateWorkspace('controlled-frame-tls');
    const inj = inspection?.valid ? inspection.injector ?? {} : {};
    const sc = inspection?.valid ? inspection.scheme : 'cf';
    const noTarget =
      inspection?.valid && inspection.hasExplicitTarget === false;
    if (noTarget && committed && commitUrl && !loading) {
      [pendInj, pendScheme] = [null, null];
      return runInjector(cf, commitUrl.href, inj, sc);
    }
    [pendInj, pendScheme] = [inj, sc];
    navigateFrame(incomingUrl, 'protocol');
  });

  const navGroup = el('div', 'cf-nav-icon-group', backBtn, fwdBtn, reloadBtn);
  const tbLeft = el('div', 'cf-toolbar-left', navGroup, omniboxEl, navBtn);
  const tbRight = el('div', 'cf-toolbar-right', partSel, clrBtn);
  const toolbar = el('div', 'cf-browser-toolbar', tbLeft, tbRight);
  const stageOuter = el('div', 'cf-stage-outer', frameStage, resizeHandleEl);
  const browserTopCard = createCard({
    className: 'cf-browser-card',
    attrs: { 'aria-label': 'Controlled Frame Browser Viewport' },
    rawChildren: [toolbar, urlError.root, stageOuter],
  }).root;

  const certMetas = [subjectMeta.root, issuerMeta.root, cipherMeta.root];
  const certGrid = el('div', 'ws-meta-grid cf-tls-meta-grid', ...certMetas);
  const kvLblCls = 'ws-kv-bar-label cf-tls-fingerprint-label';
  const shaLbl = el('span', kvLblCls, 'SHA-256 Fingerprint:');
  const barCls = 'ws-kv-bar cf-tls-fingerprint-bar';
  const shaBar = el('div', barCls, shaLbl, certShaEl, copyShaBtn);
  const certCard = createCollapsibleSection({
    title: 'Server X.509 Certificate',
    toggleTestId: 'cf-toggle-cert-btn',
    cardClassName: 'cf-tls-card',
    bodyClassName: 'cf-tls-cert-body',
    headerRight: provenanceEl,
    initialExpanded: true,
    children: [certGrid, shaBar],
  }).root;

  function mkInjCol(lbl: string, id: string, b: HTMLElement, ta: HTMLElement) {
    const l = el('label', 'cf-inject-label', lbl);
    l.htmlFor = id;
    const hd = el('div', 'cf-inject-col-header', l, b);
    return el('div', 'cf-inject-col', hd, ta);
  }
  const jsCol = mkInjCol('JavaScript', 'cf-js-input', jsBtn, jsInput);
  const cssCol = mkInjCol('Stylesheet', 'cf-css-input', cssBtn, cssIn);
  const injectGrid = el('div', 'ws-split-grid cf-inject-grid', jsCol, cssCol);
  const injectCard = createCollapsibleSection({
    title: 'Inject Scripts & Styles',
    toggleTestId: 'cf-toggle-inject-btn',
    cardClassName: 'cf-inject-card',
    bodyClassName: 'cf-inject-body',
    initialExpanded: true,
    children: [injectGrid, injectStatusEl],
  }).root;

  const { title, subtitle } = controlledFrameTlsWorkspace;
  const h = createWorkspaceHeader({ title, subtitle, className: 'cf-header' });
  const cards = [browserTopCard, certCard, injectCard, logConsole.root];
  const stack = el('div', 'ws-stack cf-workspace-stack', ...cards);
  container.replaceChildren(h, stack);
  mountControlledFrame(DEF_PART);
}

export const controlledFrameTlsWorkspace: WorkspaceDefinition = {
  id: 'controlled-frame-tls',
  navLabel: 'Controlled Frame',
  shortCode: 'TLS',
  title: 'Controlled Frame',
  subtitle:
    'Embed cross-origin web pages in an isolated partition, inspect live X.509 certificates, and inject scripts or styles.',
  mount: mountCf,
};
export const workspace = controlledFrameTlsWorkspace;
export default controlledFrameTlsWorkspace;

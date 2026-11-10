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

type Scheme = 'cf' | 'web+cf';

export interface ProtocolInjectorSpec {
  readonly text?: string;
  readonly color?: string;
  readonly js?: string;
  readonly css?: string;
}

export type ProtocolInspectionResult =
  | {
      readonly valid: true;
      readonly scheme: Scheme;
      readonly httpTarget: string;
      readonly hasExplicitTarget?: boolean;
      readonly injector?: ProtocolInjectorSpec;
    }
  | {
      readonly valid: false;
      readonly scheme: Scheme | null;
      readonly httpTarget: null;
      readonly reason: string;
    };

const PREFIX_RE = /^(web\+cf|cf):(.*)$/is;
const BLOCKED_RE =
  /^(javascript|data|vbscript|file|blob|about|isolated-app|chrome|chrome-extension|devtools|view-source|mailto|sms|tel|ws|wss|ftp):/i;
const CTRL_RE = /[\x00-\x1f\x7f]/;
const PCT_CTRL_RE = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const COLOR_RE =
  /^(#[0-9a-f]{3,8}|[a-z]{3,32}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;

const E_CTRL = 'Blocked ASCII control characters in protocol URL';
const E_SCHEME = 'Blocked unsafe URI scheme';
const E_BSLASH = 'Blocked backslash in protocol URL';
const E_PCT = 'Malformed percent-encoding (URIError)';
const E_URL = 'Malformed HTTP(S) target URL';
const E_PORT = 'Malformed target port';
const E_NON_HTTP = 'Unsupported non-HTTP(S) protocol payload';
const E_PROTO = 'Unsupported target protocol';

const decPct = (v: string): string | null => {
  if (!v.includes('%')) return v;
  if (/%(?![0-9a-f]{2})/i.test(v)) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
};
const okPort = (p: string) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;
const isBlocked = (s: string) =>
  BLOCKED_RE.test(s.replace(/[\x00-\x20\x7f]+/g, ''));
const okHost = (raw: string, needDot: boolean) => {
  const h = raw.replace(/[\u3002\uff0e\uff61]/g, '.');
  const clean = Boolean(h) && !/(?:^\.|\.$|\.\.|[\s\\[\]@:])/.test(h);
  return clean && (!needDot || h.includes('.') || /^localhost$/i.test(h));
};

function normHttpTarget(
  input: string,
): { ok: true; href: string } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  const dec = input.replace(/^\/+(?=https?:\/\/)/i, '');
  if (!dec) return bad('Empty protocol payload');
  if (isBlocked(dec)) return bad(E_SCHEME);
  if (CTRL_RE.test(dec) || PCT_CTRL_RE.test(dec)) return bad(E_CTRL);
  if (dec.includes('\\') || /%5c/i.test(dec)) return bad(E_BSLASH);
  if (/^(?:[\s/#])|\s/.test(dec)) return bad(E_NON_HTTP);
  const hasHttp = /^https?:\/\//i.test(dec);
  if (!hasHttp && /^[a-z][a-z0-9+.-]*:\/\//i.test(dec)) return bad(E_PROTO);

  const rest = hasHttp ? dec.replace(/^https?:\/\//i, '') : dec;
  const auth = decPct(rest.split(/[/?#]/, 1)[0] ?? '');
  if (!auth || /[\s/]/.test(auth)) return bad(E_URL);
  if (CTRL_RE.test(auth)) return bad(E_CTRL);
  if (auth.includes('\\')) return bad(E_BSLASH);
  if (auth.includes('@'))
    return bad('Blocked credentialed URL (userinfo not permitted)');

  if (auth.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(.*))?$/.exec(auth);
    if (!m || !m[1].includes(':')) return bad(E_URL);
    if (m[2] !== undefined && !okPort(m[2])) return bad(E_PORT);
  } else {
    if (auth.includes(']')) return bad(E_URL);
    const c = auth.indexOf(':');
    const host = c >= 0 ? auth.slice(0, c) : auth;
    const port = c >= 0 ? auth.slice(c + 1) : undefined;
    if (!host) return bad(E_URL);
    if (port !== undefined) {
      if (!port || /^\d+$/.test(port)) {
        if (!port || !okPort(port)) return bad(E_PORT);
      } else return bad(okHost(host, true) ? E_PORT : E_PROTO);
    }
    if (!okHost(host, !hasHttp && port === undefined))
      return bad(hasHttp ? E_URL : E_NON_HTTP);
  }
  try {
    const u = new URL(hasHttp ? dec : `https://${dec}`);
    const badH = !u.hostname || /(?:^\.|\.$|\.\.)/.test(u.hostname);
    const ok =
      /^https?:$/.test(u.protocol) &&
      !badH &&
      !u.username &&
      !u.password &&
      u.port !== '0';
    return ok ? { ok: true, href: u.href } : bad(E_URL);
  } catch {
    return bad(E_URL);
  }
}

const mkFail = (scheme: Scheme | null, reason: string) => ({
  valid: false as const,
  scheme,
  httpTarget: null,
  reason,
});
const mkOk = (
  scheme: Scheme,
  httpTarget: string,
  hasExplicitTarget: boolean,
  injector?: ProtocolInjectorSpec,
) => ({
  valid: true as const,
  scheme,
  httpTarget,
  hasExplicitTarget,
  ...(injector ? { injector } : {}),
});

export function inspectProtocolPayload(
  rawUrl: string,
  parsedFromShell?: string,
): ProtocolInspectionResult {
  const raw = parsedFromShell ?? rawUrl ?? '';
  const hasCtrl = CTRL_RE.test(raw) || CTRL_RE.test(rawUrl ?? '');
  const cand = raw.replace(/^ +| +$/g, '');
  if (!cand) return mkFail(null, hasCtrl ? E_CTRL : 'Empty protocol URL');
  const m = PREFIX_RE.exec(cand);
  const badSc = 'Unsupported scheme (expected cf:// or web+cf://)';
  if (!m) return mkFail(null, hasCtrl ? E_CTRL : badSc);
  const sc = m[1].toLowerCase() as Scheme;

  const body = m[2]
    .replace(/^\/\//, '')
    .replace(/^\/+(?=https?:\/\/|https?%3a%2f%2f)/i, '')
    .replace(/^ +| +$/g, '');
  if (!body) return mkFail(sc, hasCtrl ? E_CTRL : 'Empty protocol payload');
  if (isBlocked(body)) return mkFail(sc, E_SCHEME);
  if (hasCtrl || CTRL_RE.test(body) || PCT_CTRL_RE.test(body))
    return mkFail(sc, E_CTRL);
  if (body.includes('\\')) return mkFail(sc, E_BSLASH);

  const fullDec = decPct(body);
  if (fullDec === null) return mkFail(sc, E_PCT);
  if (CTRL_RE.test(fullDec) || PCT_CTRL_RE.test(fullDec))
    return mkFail(sc, E_CTRL);
  if (isBlocked(fullDec) || isBlocked(decPct(fullDec) ?? ''))
    return mkFail(sc, E_SCHEME);

  const dIdx = body.search(/[/?#]/);
  const head = dIdx < 0 ? body : body.slice(0, dIdx);
  const tail = dIdx < 0 ? '' : body.slice(dIdx);
  const decoded = (head.includes('%') ? `${decPct(head) ?? head}${tail}` : body)
    .replace(/^ +| +$/g, '')
    .replace(/^\/+(?=https?:\/\/)/i, '');
  if (!decoded.startsWith('?')) {
    const norm = normHttpTarget(decoded);
    return norm.ok ? mkOk(sc, norm.href, true) : mkFail(sc, norm.reason);
  }

  const hIdx = decoded.indexOf('#');
  const qStr = hIdx >= 0 ? decoded.slice(1, hIdx) : decoded.slice(1);
  const hash = hIdx >= 0 ? decoded.slice(hIdx) : '';
  const segs = qStr ? qStr.split('&') : [];
  let nested: string | null = null;
  const inj: { text?: string; color?: string; js?: string; css?: string } = {};

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const eq = seg.indexOf('=');
    const k = decPct(eq >= 0 ? seg.slice(0, eq) : seg);
    const rv = (eq >= 0 ? seg.slice(eq + 1) : '').trim();
    const v = decPct(rv);
    if (k === null || v === null) return mkFail(sc, E_PCT);
    if (CTRL_RE.test(k) || CTRL_RE.test(v) || PCT_CTRL_RE.test(v))
      return mkFail(sc, E_CTRL);
    if (k === 'url' || k === 'target') {
      if (!rv) return mkFail(sc, E_NON_HTTP);
      if (rv.includes('\\') || v.includes('\\')) return mkFail(sc, E_BSLASH);
      const extra = rv.includes('?') ? segs.slice(i + 1).filter(Boolean) : [];
      const base = v.replace(/ /g, '%20');
      nested = extra.length ? `${base}&${extra.join('&')}` : base;
      if (hash && !nested.includes('#')) nested += hash;
      break;
    }
    const tv = v.trim();
    if (!tv) continue;
    if (k === 'text' || k === 'js' || k === 'css') inj[k] = tv;
    else if (k === 'color') {
      if (!COLOR_RE.test(tv))
        return mkFail(sc, 'Invalid protocol color parameter');
      inj.color = tv;
    }
  }
  const hasInj = Boolean(inj.text || inj.color || inj.js || inj.css);
  if (nested !== null) {
    const norm = normHttpTarget(nested);
    return norm.ok
      ? mkOk(sc, norm.href, true, hasInj ? inj : undefined)
      : mkFail(sc, norm.reason);
  }
  return hasInj
    ? mkOk(sc, 'https://www.google.com/', false, inj)
    : mkFail(sc, E_NON_HTTP);
}

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

import { type ManagedTcpConnection, ManagedTcpServer } from '../../lib/streams';
import { randomHex } from './pkce';

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { fatal: false });
const MAX_HDR = 16 * 1024;
const MAX_REQ = 64 * 1024;
const CHUNKED_RE = /(?:^|\r\n)0(?:;[^\r\n]*)?\r\n(?:[^\r\n]*\r\n)*\r\n/;
const REQ_LINE_RE = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+HTTP\/1\.[01]$/;
const DEF_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DUP_KEYS = ['code', 'state', 'error', 'error_description'];

type Hdrs = Record<string, string>;
interface HttpReq {
  method: string;
  target: string;
  headers: Hdrs;
}
interface HttpResp {
  code: number;
  headers?: Hdrs;
  body?: string;
}
type OAuthCallbackOutcome =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'state_mismatch'; receivedState: string }
  | { kind: 'oauth_error'; error: string; errorDescription: string }
  | { kind: 'timed_out' }
  | { kind: 'cancelled' };

export interface OAuthCallbackServerHandle {
  readonly port: number;
  readonly redirectUri: string;
  readonly outcome: Promise<OAuthCallbackOutcome>;
  stop(): Promise<void>;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const badByte = (b: Uint8Array) => b.some((x) => x < 0x20 || x >= 0x7f);
const txt = (code: number, body?: string, headers?: Hdrs): HttpResp => ({
  code,
  body: body ?? REASONS[code] ?? 'Error',
  headers,
});

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) out.set(c, off), (off += c.byteLength);
  return out;
}

function findHdrEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++)
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10)
      return i;
  return -1;
}

function encodeResp(r: HttpResp): Uint8Array {
  const body = utf8Enc.encode(r.body ?? '');
  const hdrs: Hdrs = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': DEF_CSP,
    Connection: 'close',
    ...r.headers,
    'Content-Length': `${body.byteLength}`,
  };
  let h = `HTTP/1.1 ${r.code} ${REASONS[r.code] ?? 'Response'}\r\n`;
  for (const [k, v] of Object.entries(hdrs)) h += `${k}: ${v}\r\n`;
  const hb = utf8Enc.encode(`${h}\r\n`);
  const out = new Uint8Array(hb.length + body.length);
  out.set(hb, 0), out.set(body, hb.length);
  return out;
}

async function serveConn(
  conn: ManagedTcpConnection,
  onCleanup: () => void,
  handler: (req: HttpReq) => HttpResp,
  afterSent?: () => void,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let [len, done, cleaned] = [0, false, false];
  const clean = () => {
    if (!cleaned) (cleaned = true), onCleanup();
  };
  const send = async (r: HttpResp) => {
    if (done) return;
    (done = true), clearTimeout(guard);
    try {
      await conn.send(encodeResp(r));
    } catch {
    } finally {
      await conn.close();
      clean(), afterSent?.();
    }
  };
  const rel = () => (clearTimeout(guard), clean());
  const guard = setTimeout(
    () => void send(txt(400, 'Bad Request (idle timeout)')),
    8000,
  );

  try {
    await conn.open({
      onChunk: async (c) => {
        if (done) return;
        chunks.push(c), (len += c.byteLength);
        if (len > MAX_REQ) return send(txt(413));
        const buf = concat(chunks, len);
        const hEnd = findHdrEnd(buf);
        if (hEnd < 0) {
          const lf = buf.indexOf(10);
          const end = lf > 0 && buf[lf - 1] === 13 ? lf - 1 : lf;
          if (lf >= 0 && badByte(buf.subarray(0, end))) return send(txt(400));
          if (len > MAX_HDR) await send(txt(431));
          return;
        }
        if (hEnd > MAX_HDR) return send(txt(431));
        const hb = buf.subarray(0, hEnd);
        const cr = hb.indexOf(13);
        if (badByte(cr >= 0 ? hb.subarray(0, cr) : hb)) return send(txt(400));
        const lines = utf8Dec.decode(hb).split('\r\n');
        const m = REQ_LINE_RE.exec(lines[0] ?? '');
        if (!m) return send(txt(400));
        const headers: Hdrs = {};
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(':');
          if (idx > 0)
            headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
              .slice(idx + 1)
              .trim();
        }
        const bOff = hEnd + 4;
        if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) {
          if (!CHUNKED_RE.test(utf8Dec.decode(buf.subarray(bOff)))) return;
        } else {
          const cl = Math.max(
            0,
            Number.parseInt(headers['content-length'] ?? '0', 10) || 0,
          );
          if (bOff + cl > MAX_REQ) return send(txt(413));
          if (buf.length - bOff < cl) return;
        }
        let out: HttpResp;
        try {
          out = handler({ method: m[1].toUpperCase(), target: m[2], headers });
        } catch {
          out = txt(500);
        }
        await send(out);
      },
      onClose: rel,
      onError: rel,
    });
  } catch {
    rel(), await conn.close();
  }
}

function htmlResp(code: number, title: string, detail: string): HttpResp {
  const ok = code === 200;
  const n = randomHex(16);
  const csp = `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(title)}</title>` +
    `<style nonce="${n}">:root{--accent:${ok ? '#86c991' : '#f28b82'}}*{box-sizing:border-box}body{margin:0;padding:16px;min-height:100vh;display:grid;place-items:center;background:#181614;color:#f5efe6;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif}.card{width:100%;max-width:460px;padding:24px 28px;background:#211e1b;border:1px solid rgba(245,235,220,.14);border-top:3px solid var(--accent);border-radius:12px;overflow-wrap:anywhere;word-break:break-word}h1{margin:0 0 10px;font-size:17px;color:var(--accent)}p{margin:0;color:#b5ada2;font-size:13.5px;line-height:1.5}p.sub{margin-top:12px;color:#f5efe6;font-size:12.5px}@media (prefers-color-scheme: light){:root{--accent:${ok ? '#137333' : '#a50e0e'}}body{background:#f5efe6;color:#292524}.card{background:#ffffff;border-color:#e6e0d6}p{color:#57534e}p.sub{color:#292524}}</style></head>` +
    `<body><div class="card"><h1>${esc(title)}</h1><p>${esc(detail)}</p><p class="sub" id="sub-msg">Closing this tab automatically in <strong id="cd">5</strong>s…</p>` +
    `<script nonce="${n}">(function(){var s=5,el=document.getElementById('cd'),sub=document.getElementById('sub-msg'),iv=setInterval(function(){s--;if(el&&s>=0)el.textContent=String(s);if(s<=0)clearInterval(iv);},1000);setTimeout(function(){try{window.close();}catch(e){}setTimeout(function(){if(!window.closed&&sub)sub.textContent='You can now safely close this tab and return to IWA Sink.';},200);},5000);})();</script></div></body></html>`;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
  };
  return { code, headers, body };
}

export async function startOAuthCallbackServer(
  expectedState: string,
  onLog?: (msg: string) => void,
): Promise<OAuthCallbackServerHandle> {
  const server = new ManagedTcpServer();
  let settled = false;
  let resolveOut!: (v: OAuthCallbackOutcome) => void;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  let stopP: Promise<void> | null = null;
  const outcome = new Promise<OAuthCallbackOutcome>((r) => (resolveOut = r));
  const clr = () => {
    if (backstop) clearTimeout(backstop);
    backstop = null;
  };
  const stopOnce = () => (
    clr(), clearTimeout(ttlTimer), (stopP ??= server.stop())
  );
  const settle = (v: OAuthCallbackOutcome): boolean => {
    if (settled) return false;
    (settled = true), clearTimeout(ttlTimer), resolveOut(v), clr();
    backstop = setTimeout(() => void stopOnce(), 5000);
    return true;
  };
  const ttlTimer = setTimeout(() => {
    if (settle({ kind: 'timed_out' })) {
      onLog?.('[callback] Loopback OAuth listener timed out after 120s.');
      void stopOnce();
    }
  }, 120_000);

  const route = (req: HttpReq, mark: (v: OAuthCallbackOutcome) => void) => {
    if (!req.target.startsWith('/') || req.target.startsWith('//')) {
      onLog?.(`[http-rx] ${req.method} ${req.target.slice(0, 64)} → 400`);
      return txt(400);
    }
    const base = `http://127.0.0.1:${server.localPort}`;
    let url: URL;
    try {
      url = new URL(req.target, base);
    } catch {
      return txt(400);
    }
    if (url.origin !== base) return txt(400);
    if (url.pathname !== '/callback') {
      onLog?.(`[http-rx] ${req.method} ${url.pathname} → 404 Not Found`);
      return txt(404);
    }
    if (req.method !== 'GET') {
      onLog?.(`[http-rx] ${req.method} /callback → 405 (Allow: GET)`);
      return txt(405, undefined, { Allow: 'GET' });
    }
    if (settled) return txt(400, 'OAuth callback already processed');

    function fin(v: OAuthCallbackOutcome, c: number, t: string, d: string) {
      return mark(v), htmlResp(c, t, d);
    }
    const errH = (e: string, d: string, t: string, l: string) => {
      onLog?.(l);
      return fin(
        { kind: 'oauth_error', error: e, errorDescription: d },
        400,
        t,
        d,
      );
    };

    const q = url.searchParams;
    const dup = DUP_KEYS.find((k) => q.getAll(k).length > 1);
    if (dup) {
      const d = `Duplicate "${dup}" query parameter is not permitted in an OAuth 2.0 callback.`;
      const t = 'Invalid OAuth Callback — Duplicate Parameter';
      return errH('invalid_request', d, t, `[callback] Rejected: ${d}`);
    }
    if (q.has('error')) {
      const e = q.get('error') || 'oauth_error';
      const fb = 'Authorization request was denied or cancelled.';
      const d = q.get('error_description') || fb;
      const l = `[callback] OAuth error on 127.0.0.1:${server.localPort}: ${e} (${d})`;
      return errH(e, d, `OAuth Error: ${e}`, l);
    }
    const rxState = q.get('state') ?? '';
    if (!rxState || rxState !== expectedState) {
      const d =
        'The state parameter did not match the active PKCE session. No token exchange was performed.';
      const t = 'CSRF state mismatch — OAuth callback rejected';
      onLog?.(`[callback] CSRF state mismatch ("${rxState || '(missing)'}")`);
      return fin({ kind: 'state_mismatch', receivedState: rxState }, 400, t, d);
    }
    const code = q.get('code') ?? '';
    if (!code) {
      const d = 'OAuth callback missing code parameter.';
      const t = 'Missing Authorization Code';
      return errH('missing_code', d, t, '[callback] Missing code');
    }
    const okMsg =
      'PKCE authorization code verified on loopback socket. You can close this page and return to IWA Sink.';
    const okT = 'Authentication Complete — You can close this page';
    onLog?.(`[http-rx] GET /callback?code=${code.slice(0, 14)}… → 200 OK`);
    return fin({ kind: 'code', code, state: rxState }, 200, okT, okMsg);
  };

  const { localPort } = await server.start({
    host: '127.0.0.1',
    port: 0,
    dualStack: false,
    onClient: (conn) => {
      let hit = false;
      const mark = (v: OAuthCallbackOutcome) => {
        if (settle(v)) hit = true;
      };
      const flush = () => {
        if (hit) clr(), (backstop = setTimeout(() => void stopOnce(), 250));
      };
      const drop = () => server.removeConnection(conn);
      return serveConn(conn, drop, (req) => route(req, mark), flush);
    },
  });

  return {
    port: localPort,
    redirectUri: `http://127.0.0.1:${localPort}/callback`,
    outcome,
    stop: async () => (settle({ kind: 'cancelled' }), stopOnce()),
  };
}

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

import { el } from '../../lib/dom';
import { ManagedTcpConnection } from '../../lib/streams';
import type { WorkspaceLiveStatus } from '../../shell/contracts';
import { AnsiTerminalSurface } from './ansi-terminal';

interface TcpClientPanelOptions {
  title?: string;
  captionTag?: string;
  defaultHost?: string;
  defaultPort?: string;
  onConnectionChange?: (on: boolean, st: WorkspaceLiveStatus) => void;
}
type ParsedOk = { ok: true; host: string; embeddedPort: number | null };
type ParsedErr = { ok: false; statusError: string; bannerError: string };
type ParsedTcpTargetEndpoint = ParsedOk | ParsedErr;
type Kids = Array<Node | string | null>;

const MAX_PREVIEW = 4_096;
const LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const BAD_RX_LINE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\ufffd]/;
const ANSI_IN_RE =
  /\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]?|O[\x40-\x7e]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x20-\x7e]?)|\x9b[\x20-\x3f]*[\x40-\x7e]?/g;
const BAD_HOST =
  'Invalid target host: enter a valid IPv4 address, IPv6 address, or hostname.';
const V6_PORT_HINT =
  'Invalid IPv6 target host (use [::1]:port when specifying a port).';
const READY_MSG =
  '[ready] Client disconnected. Enter a target host and port, then click "Connect".';
const INP_CLS = 'form-input tcp-side-input mono tabular-nums';
const enc = new TextEncoder();
const div = (c: string, ...ch: Kids) => el('div', c, ...ch);
const span = (c: string, t: string) => el('span', c, t);
const onClick = (b: HTMLElement, fn: () => unknown) =>
  b.addEventListener('click', () => void fn());

function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
function btn(id: string, txt: string, cls: string, disabled = false) {
  const b = tid(el('button', cls, txt), id);
  return Object.assign(b, { type: 'button' as const, disabled });
}
function inp(id: string, val: string, ph: string, c = INP_CLS, num = false) {
  const i = Object.assign(tid(el('input', c), id), { id, type: 'text' });
  Object.assign(i, { value: val, placeholder: ph, spellcheck: false });
  i.autocomplete = 'off';
  if (num) i.inputMode = 'numeric';
  return i;
}
function mkField(mod: string, lbl: string, i: HTMLInputElement) {
  const l = el('label', `tcp-side-field ${mod}`, span('form-label', lbl), i);
  l.htmlFor = i.id;
  return l;
}
function onEnter(n: HTMLElement, fn: () => unknown) {
  n.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    void fn();
  });
}

function isValidIpv4(raw: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return false;
  return raw.split('.').every((p) => {
    const n = Number(p);
    return !(p.length > 1 && p[0] === '0') && n >= 0 && n <= 255;
  });
}

function isValidIpv6(raw: string): boolean {
  const hex = /^[0-9a-fA-F:.]+$/.test(raw);
  if (!raw || raw.length > 45 || !raw.includes(':') || !hex) return false;
  if (raw.includes('.')) {
    const i = raw.lastIndexOf(':');
    if (i < 0 || raw.slice(0, i).includes('.')) return false;
    if (!isValidIpv4(raw.slice(i + 1))) return false;
  }
  try {
    const u = new URL(`http://[${raw}]/`);
    return !u.port && u.hostname.startsWith('[') && u.hostname.endsWith(']');
  } catch {
    return false;
  }
}

function isValidHost(raw: string): boolean {
  if (!raw || raw.length > 253 || raw.startsWith('.') || raw.endsWith('.'))
    return false;
  const ls = raw.split('.');
  const okLbl = (l: string) =>
    l.length >= 1 && l.length <= 63 && LABEL_RE.test(l);
  return ls.every(okLbl) && !/^\d+$/.test(ls[ls.length - 1]);
}

const isV4OrHost = (s: string) => isValidIpv4(s) || isValidHost(s);
const isCleanLine = (s: string) =>
  Boolean(s) && !BAD_RX_LINE.test(s.replace(/(?:\r\n|\r|\n)$/, ''));

function parsePortStrict(raw: string) {
  const t = raw.trim();
  if (!t || !/^\d+$/.test(t))
    return { ok: false as const, error: 'Enter a valid TCP port (1–65535)' };
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 && n <= 65535
    ? { ok: true as const, port: n }
    : { ok: false as const, error: 'TCP port out of range (1–65535)' };
}

function badHost(
  bannerError: string,
  statusError = 'Invalid target host',
): ParsedErr {
  return { ok: false, statusError, bannerError };
}
const okHost = (
  host: string,
  embeddedPort: number | null = null,
): ParsedOk => ({
  ok: true,
  host,
  embeddedPort,
});
function withPort(host: string, rawPort: string): ParsedTcpTargetEndpoint {
  const p = parsePortStrict(rawPort);
  return p.ok ? okHost(host, p.port) : badHost(p.error, p.error);
}

export function parseTcpTargetEndpoint(raw: string): ParsedTcpTargetEndpoint {
  const t = raw.trim();
  if (!t) return badHost('Target host cannot be empty.', 'Host required');
  if (/[\s\x00-\x1f\x7f/\\@?#%]/.test(t)) return badHost(BAD_HOST);
  if (t.startsWith('[')) {
    const ci = t.indexOf(']');
    if (ci <= 1 || t.slice(1).includes('[') || t.slice(ci + 1).includes(']'))
      return badHost('Invalid bracketed IPv6 target host.');
    const [v6, suf] = [t.slice(1, ci), t.slice(ci + 1)];
    if (!isValidIpv6(v6))
      return badHost('Bracketed target host must be a valid IPv6 literal.');
    if (!suf) return okHost(v6);
    if (!suf.startsWith(':'))
      return badHost('Invalid bracketed IPv6 target host.');
    return withPort(v6, suf.slice(1));
  }
  if (t.includes('[') || t.includes(']'))
    return badHost('Unexpected bracket character.');
  const fc = t.indexOf(':');
  if (fc === -1) return isV4OrHost(t) ? okHost(t) : badHost(BAD_HOST);
  if (fc === t.lastIndexOf(':')) {
    const h = t.slice(0, fc);
    return h && isV4OrHost(h)
      ? withPort(h, t.slice(fc + 1))
      : badHost(BAD_HOST);
  }
  return isValidIpv6(t) ? okHost(t) : badHost(V6_PORT_HINT);
}

export const formatBindAddress = (a: string) =>
  !a ? '—' : a.includes(':') ? `[${a}]` : a;
export const formatEndpoint = (h: string, p: number) =>
  `${formatBindAddress(h)}:${p}`;

export function hookInputValueChange(elIn: HTMLInputElement, fn: () => void) {
  const p =
    typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null;
  const d =
    Object.getOwnPropertyDescriptor(elIn, 'value') ??
    (p ? Object.getOwnPropertyDescriptor(p, 'value') : undefined);
  const [get, set] = [d?.get, d?.set];
  if (get && set) {
    const enumerable = d?.enumerable ?? true;
    const setVal = (v: string) => {
      set.call(elIn, v);
      fn();
    };
    try {
      const getVal = () => get.call(elIn) as string;
      Object.defineProperty(elIn, 'value', {
        configurable: true,
        enumerable,
        get: getVal,
        set: setVal,
      });
    } catch {}
  }
  for (const e of ['input', 'change']) elIn.addEventListener(e, fn);
}

export function createTcpClientPanel(opts: TcpClientPanelOptions = {}) {
  let activeConn: ManagedTcpConnection | null = null;
  let pendingAbort: AbortController | null = null;
  let pendingConn: ManagedTcpConnection | null = null;
  let opChain: Promise<void> = Promise.resolve();
  let [epoch, lineBuf] = [0, ''];
  let rxDec = new TextDecoder('utf-8', { fatal: false });

  const resetBufs = () => {
    lineBuf = '';
    rxDec = new TextDecoder('utf-8', { fatal: false });
  };
  const enqueue = (fn: () => Promise<void>) => {
    const next = opChain.then(fn, fn);
    opChain = next.catch(() => {});
    return next;
  };

  const stCls = 'tcp-side-header-meta tcp-server-status mono tabular-nums';
  const statusEl = tid(span(stCls, 'Disconnected'), 'tcp-client-status');
  statusEl.title = 'Disconnected';
  statusEl.setAttribute('data-state', 'probing');
  const defH = opts.defaultHost ?? '127.0.0.1';
  const defP = opts.defaultPort ?? '43821';
  const hostInp = inp('tcp-host-input', defH, '127.0.0.1 or ::1');
  const portInp = inp('tcp-port-input', defP, 'Port', INP_CLS, true);
  const actCls = 'btn tcp-side-action-btn';
  const connBtn = btn('tcp-connect-btn', 'Connect', `${actCls} btn-primary`);
  const discBtn = btn('tcp-disconnect-btn', 'Disconnect', actCls, true);
  const payCls = 'form-input terminal-input mono';
  const payPh = 'Send message to server...';
  const payInp = inp('tcp-payload-input', '', payPh, payCls);
  const sCls = 'btn btn-primary tcp-side-send-btn';
  const sendBtn = btn('tcp-send-btn', 'Send to Server', sCls, true);

  const isConn = () => activeConn !== null && !activeConn.isClosed;
  const isPend = () => pendingAbort !== null || pendingConn !== null;
  const syncBtns = () => {
    const [on, pend] = [isConn(), isPend()];
    connBtn.disabled = pend || on;
    discBtn.disabled = !pend && !on;
    sendBtn.disabled = !on || !payInp.value.length;
  };
  hookInputValueChange(payInp, syncBtns);

  const setInp = (i: HTMLInputElement, v: string | number) => {
    i.value = `${v}`;
    i.removeAttribute('aria-invalid');
  };
  const setHostPort = (host: string, port: number | string) => {
    setInp(hostInp, host);
    setInp(portInp, port);
  };
  for (const i of [hostInp, portInp]) {
    i.addEventListener('input', () => i.removeAttribute('aria-invalid'));
    onEnter(i, () => !connBtn.disabled && connect());
  }
  hostInp.addEventListener('paste', (ev: ClipboardEvent) => {
    const clip = ev.clipboardData?.getData('text/plain') ?? '';
    if (connBtn.disabled || !clip) return;
    const v = hostInp.value;
    const [s, e] = [
      hostInp.selectionStart ?? 0,
      hostInp.selectionEnd ?? v.length,
    ];
    const p = parseTcpTargetEndpoint(`${v.slice(0, s)}${clip}${v.slice(e)}`);
    if (p.ok && p.embeddedPort !== null) {
      ev.preventDefault();
      setHostPort(p.host, p.embeddedPort);
    }
  });

  const setStatus = (state: WorkspaceLiveStatus['state'], label: string) => {
    statusEl.textContent = statusEl.title = label;
    statusEl.setAttribute('data-state', state);
    statusEl.classList.toggle('is-online', state === 'online');
    statusEl.classList.toggle('is-error', state === 'offline');
    syncBtns();
    opts.onConnectionChange?.(isConn(), { state, label });
  };
  const syncIdle = () =>
    !isPend() && !isConn() ? setStatus('probing', 'Disconnected') : syncBtns();
  const cancelPending = () => {
    const [ac, pc] = [pendingAbort, pendingConn];
    pendingAbort = pendingConn = null;
    ac?.abort();
    void pc?.close();
  };

  const onInput = (data: string) => {
    if (!activeConn || activeConn.isClosed) return;
    for (const ch of data.replace(ANSI_IN_RE, '')) {
      if (ch === '\x7f' || ch === '\b')
        lineBuf = [...lineBuf].slice(0, -1).join('');
      else if (ch === '\r' || ch === '\n') {
        const out = `${lineBuf}\r\n`;
        lineBuf = '';
        void activeConn.send(out).catch(() => {});
      } else if (ch === '\t' || ch.charCodeAt(0) >= 0x20) lineBuf += ch;
    }
  };
  const terminal = new AnsiTerminalSurface({
    testId: 'tcp-terminal-screen',
    onInput,
  });
  const sys = (m: string, t: 'info' | 'ok' | 'err' = 'info') =>
    terminal.writeSystemBanner(m, t);
  sys(READY_MSG);

  const failField = (i: HTMLInputElement, stErr: string, bnrErr = stErr) => {
    i.setAttribute('aria-invalid', 'true');
    setStatus('offline', stErr);
    sys(`[error] ${bnrErr}`, 'err');
  };

  const connect = async (ovH?: string, ovP?: number | string) => {
    if (isConn() || isPend()) return;
    if (ovH !== undefined) setInp(hostInp, ovH);
    if (ovP !== undefined) setInp(portInp, ovP);
    const pt = parseTcpTargetEndpoint(hostInp.value);
    if (!pt.ok) return failField(hostInp, pt.statusError, pt.bannerError);
    setInp(hostInp, pt.host);
    if (pt.embeddedPort !== null && ovP === undefined)
      setInp(portInp, pt.embeddedPort);
    const pp = parsePortStrict(portInp.value);
    if (!pp.ok) return failField(portInp, pp.error);
    portInp.removeAttribute('aria-invalid');

    cancelPending();
    const [h, p, ep] = [pt.host, pp.port, formatEndpoint(pt.host, pp.port)];
    const [seq, ac] = [++epoch, new AbortController()];
    pendingAbort = ac;
    setStatus('probing', `Connecting · ${ep}`);

    return enqueue(async () => {
      let conn: ManagedTcpConnection | null = null;
      const q: Array<() => void> = [];
      const clearPend = () => {
        if (pendingAbort === ac) pendingAbort = null;
        if (conn && pendingConn === conn) pendingConn = null;
      };
      try {
        if (activeConn) {
          const prev = activeConn;
          activeConn = null;
          await prev.close();
          terminal.flushDecoder();
        }
        if (seq !== epoch || ac.signal.aborted) return;
        if (typeof TCPSocket === 'undefined') {
          clearPend();
          setStatus('offline', 'TCP API unavailable');
          return sys('[error] Direct Sockets TCP API is unavailable.', 'err');
        }
        setStatus('probing', `Connecting · ${ep}`);
        let [peerErr, ready] = [false, false];
        const defer = (fn: () => void) => (ready ? fn() : void q.push(fn));
        resetBufs();

        const onChunk = (c: Uint8Array) => {
          if (activeConn !== conn) return;
          const pre = rxDec.decode(c, { stream: true });
          const ts = new Date().toISOString().slice(11, 23);
          if (terminal.isAtCleanLineStart() && isCleanLine(pre))
            terminal.writeLocalEcho(`[${ts}] [rx <- server] `);
          terminal.writeBytes(c);
        };
        const finishPeer = (err?: unknown, isErr = false) => {
          if (isErr) peerErr = true;
          if (activeConn !== conn) return;
          activeConn = null;
          resetBufs();
          terminal.flushDecoder();
          if (isErr) {
            const r = err instanceof Error ? err.message : 'connection reset';
            sys(`[reset] Peer closed ${ep}: ${r}`, 'err');
            setStatus('offline', 'Disconnected (peer reset)');
          } else if (!peerErr) {
            sys(`[disconnected] Closed ${ep}`);
            setStatus('probing', 'Disconnected');
          }
        };

        const sock = new TCPSocket(h, p, { noDelay: true });
        conn = pendingConn = new ManagedTcpConnection(sock);
        const handlers = {
          onChunk: (c: Uint8Array) => {
            const cp = c.slice();
            defer(() => onChunk(cp));
          },
          onClose: () => defer(() => finishPeer()),
          onError: (e: unknown) => defer(() => finishPeer(e, true)),
        };
        await conn.open(handlers, { signal: ac.signal });
        clearPend();
        if (seq !== epoch || ac.signal.aborted) {
          q.length = 0;
          return await conn.close();
        }
        terminal.flushDecoder();
        activeConn = conn;
        ready = true;
        lineBuf = '';
        const okMsg = `[connected] Established TCP stream -> ${ep} (local :${conn.localPort})`;
        sys(okMsg, 'ok');
        setStatus('online', `Connected · ${ep}`);
        for (const fn of q.splice(0)) fn();
      } catch (err: unknown) {
        clearPend();
        q.length = 0;
        await conn?.close();
        activeConn = null;
        if (seq !== epoch || ac.signal.aborted) return;
        const raw = err instanceof Error ? err.message : String(err);
        sys(`[error] Failed connecting to ${ep}: ${raw}`, 'err');
        const short = raw.length > 56 ? `${raw.slice(0, 56)}…` : raw;
        setStatus('offline', `Connect failed: ${short}`);
      } finally {
        clearPend();
        if (seq !== epoch || ac.signal.aborted) syncIdle();
      }
    });
  };

  const disconnect = async (): Promise<void> => {
    epoch += 1;
    resetBufs();
    const hadPend = isPend();
    cancelPending();
    if (hadPend && !activeConn) {
      terminal.flushDecoder();
      sys('[disconnected] Connection attempt cancelled');
      setStatus('probing', 'Disconnected');
    }
    return enqueue(async () => {
      resetBufs();
      if (!activeConn) return setStatus('probing', 'Disconnected');
      const conn = activeConn;
      activeConn = null;
      await conn.close();
      terminal.flushDecoder();
      sys('[disconnected] Session closed cleanly');
      setStatus('probing', 'Disconnected');
    });
  };

  const sendPayload = async () => {
    if (!activeConn || activeConn.isClosed)
      return sys('[warn] Not connected — click "Connect" first.', 'err');
    const raw = payInp.value;
    if (!raw) return;
    payInp.value = '';
    syncBtns();
    const wire = raw.endsWith('\n') ? raw : `${raw}\r\n`;
    if (!raw.includes('\x1b')) {
      const c = raw.replace(/\r?\n$/, '');
      const pre = c.length > MAX_PREVIEW ? `${c.slice(0, MAX_PREVIEW)}…` : c;
      sys(`[tx -> server] "${pre}" (${enc.encode(wire).byteLength} B)`);
    }
    await activeConn.send(wire).catch(() => {});
  };

  onClick(connBtn, connect);
  onClick(discBtn, disconnect);
  onClick(sendBtn, sendPayload);
  onEnter(payInp, sendPayload);
  const clearBtn = btn('tcp-clear-btn', 'Clear', 'btn tcp-side-clear-btn');
  clearBtn.setAttribute('aria-label', 'Clear client log');
  onClick(clearBtn, () => {
    resetBufs();
    terminal.clear();
  });

  const tag = opts.captionTag
    ? span('workspace-tag mono', opts.captionTag)
    : null;
  const cap = span('workspace-caption', opts.title ?? 'TCP Client');
  const hL = div('workspace-bar-left', cap, tag);
  const hR = div('workspace-bar-right', statusEl);
  const hdr = div('workspace-bar tcp-side-card-header', hL, hR);
  const fHost = mkField('tcp-side-field-grow', 'Target Host', hostInp);
  const fPort = mkField('tcp-side-field-port', 'Target Port', portInp);
  const acts = div(
    'tcp-side-actions tcp-side-config-actions',
    connBtn,
    discBtn,
  );
  const cfgBar = div('tcp-side-config-bar', fHost, fPort, acts);
  const logTitle = span('tcp-side-log-title', 'CLIENT LOG');
  const logHdr = div('tcp-side-log-header', logTitle, clearBtn);
  const stage = div('tcp-side-log-stage', terminal.root);
  tid(stage, 'tcp-terminal-output');
  const logSec = div('tcp-side-log-section', logHdr, stage);
  const fPay = mkField('tcp-send-field', 'Message', payInp);
  const sendBar = div('tcp-side-send-bar', fPay, sendBtn);
  const cardCls = 'workspace-card tcp-client-card tcp-side-card';
  const root = el('section', cardCls, hdr, cfgBar, logSec, sendBar);
  tid(root, 'tcp-client-panel');

  syncBtns();
  return {
    root,
    terminal,
    isConnected: isConn,
    isConnecting: isPend,
    isIdle: () => !isConn() && !isPend(),
    getHost: () => hostInp.value,
    getPort: () => portInp.value,
    setHostPort,
    connect,
    disconnect,
    loadTranscriptText(name: string, content: string): void {
      sys(`[file-handler] Loaded "${name}" (${content.length} chars)`, 'ok');
      if (content)
        terminal.writeLocalEcho(`${content.replace(/\r?\n/g, '\r\n')}\r\n`);
    },
  };
}

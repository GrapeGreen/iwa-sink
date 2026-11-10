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
  createWorkspaceHeader,
  el,
  updateLogTextStickToBottom,
} from '../../lib/dom';
import { type ManagedTcpConnection, ManagedTcpServer } from '../../lib/streams';
import type {
  ShellContext,
  WorkspaceDefinition,
  WorkspaceLiveStatus,
} from '../../shell/contracts';
import {
  createTcpClientPanel,
  formatBindAddress,
  formatEndpoint,
  hookInputValueChange,
} from './tcp-client-panel';

type BadgeState = 'online' | 'offline' | 'probing';
type Family = 'ipv4' | 'ipv6';
type Kids = Array<Node | string | null>;

const [DEF_PORT, MAX_PREVIEW, MAX_LOG_LINES] = ['43821', 4_096, 500];
const LOOPBACKS = ['', '127.0.0.1', '::1', '[::1]', 'localhost'];
const SUBTITLE =
  'Bind a local IPv4 or IPv6 loopback echo listener and connect the interactive TCP client to exchange live messages with local or remote endpoints.';
const BCAST_NO_CLI = '[warn] Cannot broadcast: 0 active clients connected.';
const BAD_PORT_FMT =
  'Invalid port: enter 0–65535 (0 or empty for OS ephemeral port).';
const CTRL_ESC_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const FAM_SPECS: Array<[Family, string, string]> = [
  ['ipv4', '127.0.0.1', 'IPv4'],
  ['ipv6', '::1', 'IPv6'],
];
const div = (c: string, ...ch: Kids) => el('div', c, ...ch);
const span = (c: string | null, ...ch: Kids) => el('span', c, ...ch);
const isoTs = () => new Date().toISOString().slice(11, 23);
const hexEsc = (c: string) =>
  `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
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
function inp(id: string, c: string, val: string, ph: string, num = false) {
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

function parseEchoPort(raw: string) {
  const t = raw.trim();
  if (t === '' || t === '0') return { ok: true as const, port: undefined };
  if (!/^\d+$/.test(t)) return { ok: false as const, error: BAD_PORT_FMT };
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 && n <= 65535
    ? { ok: true as const, port: n === 0 ? undefined : n }
    : { ok: false as const, error: 'Port out of range (enter 0–65535).' };
}

function hasBinCtrl(c: Uint8Array): boolean {
  for (let i = 0; i < c.byteLength; i++) {
    const b = c[i];
    const ctrl = b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 27;
    if (b === 0 || b === 0x7f || ctrl) return true;
  }
  return false;
}

function fmtPreview(raw: string): string {
  const esc = raw.replace(/\r?\n$/, '').replace(CTRL_ESC_RE, hexEsc);
  return esc.length > MAX_PREVIEW ? `${esc.slice(0, MAX_PREVIEW)}…` : esc;
}

function mountTcpTerminal(container: HTMLElement, ctx: ShellContext): void {
  const setStatus = (state: WorkspaceLiveStatus['state'], label: string) =>
    ctx.setWorkspaceStatus('tcp-terminal', { state, label });
  const srv = new ManagedTcpServer();
  let [nextSid, echoedTotal, opSeq, clientConn] = [0, 0, 0, false];
  let inFlight: 'running' | 'stopped' | null = null;
  let lastErr: string | null = null;
  let family: Family = 'ipv4';
  let opChain: Promise<void> = Promise.resolve();

  const enqueue = (fn: () => Promise<void>) => {
    const next = opChain.then(fn, fn);
    opChain = next.catch(() => {});
    return next;
  };
  const famHost = () => (family === 'ipv6' ? '::1' : '127.0.0.1');

  const pfxEl = span(null, 'Idle');
  const portBadgeEl = tid(span('mono tabular-nums', ''), 'echo-bound-port');
  portBadgeEl.hidden = true;
  const bdgCls = 'tcp-side-header-meta tcp-server-status mono tabular-nums';
  const badgeEl = tid(span(bdgCls, pfxEl, portBadgeEl), 'echo-status-badge');
  badgeEl.title = 'Idle';
  badgeEl.setAttribute('data-state', 'probing');
  const errBanner = createAlertBanner({
    testId: 'tcp-server-error',
    inset: true,
  });
  errBanner.root.classList.add('tcp-error-banner');

  const [v4Btn, v6Btn] = FAM_SPECS.map(([id, txt, label], idx) => {
    const on = idx === 0;
    const cls = `seg-tab mono${on ? ' active' : ''}`;
    const b = btn(`tcp-server-family-${id}`, txt, cls);
    b.title = `${label} Loopback (${txt})`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', `${on}`);
    b.tabIndex = on ? 0 : -1;
    onClick(b, () => setFamily(id));
    return b;
  });

  const pCls = 'form-input tcp-side-input mono tabular-nums';
  const portInp = inp('echo-port-input', pCls, DEF_PORT, 'Port', true);
  const actCls = 'btn tcp-side-action-btn';
  const startCls = `${actCls} btn-primary`;
  const startBtn = btn('echo-start-btn', 'Start Server', startCls);
  const stopBtn = btn('echo-stop-btn', 'Stop Server', actCls, true);
  const statCls = 'tcp-side-stat-val mono tabular-nums';
  const clientsEl = tid(span(statCls, '0'), 'echo-active-clients');
  const bytesEl = tid(span(statCls, '0 B'), 'echo-bytes-counter');

  const initLog = `[${isoTs()}] [ready] Server idle. Choose 127.0.0.1 or ::1 and click "Start Server".`;
  const logLines = [initLog];
  const preCls = 'terminal-surface tcp-server-log-surface mono tabular-nums';
  const logPre = tid(el('pre', preCls, initLog), 'tcp-server-log');
  logPre.tabIndex = 0;
  logPre.setAttribute('role', 'log');
  logPre.setAttribute('aria-live', 'polite');
  logPre.setAttribute('aria-label', 'TCP Server Conversation Log');

  const appendLog = (line: string) => {
    logLines.push(`[${isoTs()}] ${line}`);
    if (logLines.length > MAX_LOG_LINES)
      logLines.splice(0, logLines.length - MAX_LOG_LINES);
    updateLogTextStickToBottom(logPre, logLines.join('\n'));
  };

  const clrCls = 'btn tcp-side-clear-btn';
  const clearBtn = btn('tcp-server-clear-btn', 'Clear', clrCls);
  clearBtn.setAttribute('aria-label', 'Clear server log');
  onClick(clearBtn, () => {
    logLines.length = 0;
    logPre.textContent = '';
  });

  const bcCls = 'form-input terminal-input mono';
  const bcPh = 'Broadcast message to connected client(s)...';
  const bcastInp = inp(
    'tcp-server-send-input',
    bcCls,
    'SERVER_BROADCAST_HELLO',
    bcPh,
  );
  const bcBtnCls = 'btn btn-primary tcp-side-send-btn';
  const bcLbl = 'Send to Client(s)';
  const bcastBtn = btn('tcp-server-send-btn', bcLbl, bcBtnCls, true);

  const syncBtns = () => {
    const on = srv.isRunning();
    const eff = inFlight !== null ? inFlight === 'running' : on;
    startBtn.disabled = eff;
    stopBtn.disabled = !eff;
    const canBc = on && srv.activeClientCount > 0 && bcastInp.value.length > 0;
    bcastBtn.disabled = !canBc;
  };
  hookInputValueChange(bcastInp, syncBtns);

  const syncShell = () => {
    if (srv.isRunning() && srv.localPort > 0) {
      const n = srv.activeClientCount;
      const ep = formatEndpoint(srv.localAddress || famHost(), srv.localPort);
      setStatus('online', `Echo ${ep} (${n} client${n === 1 ? '' : 's'})`);
    } else if (inFlight === 'running') setStatus('probing', 'Starting…');
    else if (lastErr) setStatus('offline', 'Bind error');
    else if (clientConn) setStatus('portal', 'Client active (Echo idle)');
    else setStatus('probing', 'Ready');
  };

  const setBadge = (st: BadgeState, pfx: string, p = '') => {
    pfxEl.textContent = pfx;
    portBadgeEl.textContent = p;
    portBadgeEl.hidden = !p;
    badgeEl.setAttribute('data-state', st);
    badgeEl.classList.toggle('is-online', st === 'online');
    badgeEl.classList.toggle('is-error', st === 'offline');
    badgeEl.title = `${pfx}${p}`;
  };

  const syncUi = () => {
    clientsEl.textContent = `${srv.activeClientCount}`;
    bytesEl.textContent = `${echoedTotal} B`;
    syncBtns();
    if (inFlight === 'running') setBadge('probing', 'Starting…');
    else if (srv.isRunning() && srv.localPort > 0) {
      const pfx = `Listening · ${formatBindAddress(srv.localAddress)}:`;
      setBadge('online', pfx, `${srv.localPort}`);
    } else if (lastErr) {
      const msg = lastErr.startsWith('Error:') ? lastErr : `Error: ${lastErr}`;
      setBadge('offline', msg);
    } else setBadge('probing', 'Idle');
    syncShell();
  };

  const onConnectionChange = (on: boolean) => {
    clientConn = on;
    syncShell();
  };
  const cOpts = {
    title: 'TCP Client',
    defaultHost: '127.0.0.1',
    defaultPort: DEF_PORT,
  };
  const clientPanel = createTcpClientPanel({ ...cOpts, onConnectionChange });

  const syncLoopback = (host: string, port?: number | null) => {
    const cur = clientPanel.getHost().trim().toLowerCase();
    if (!clientPanel.isIdle() || !LOOPBACKS.includes(cur)) return;
    const p = port && port >= 1 && port <= 65535 ? port : clientPanel.getPort();
    clientPanel.setHostPort(host, p);
  };
  const clearStickyErr = () => {
    portInp.removeAttribute('aria-invalid');
    const had = lastErr !== null || errBanner.isVisible();
    if (!srv.isRunning()) lastErr = null;
    if (errBanner.isVisible()) errBanner.clear();
    if (had) syncUi();
  };
  portInp.addEventListener('input', () => {
    clearStickyErr();
    if (!srv.isRunning() && inFlight !== 'running') {
      const r = parseEchoPort(portInp.value);
      if (r.ok && r.port) syncLoopback(famHost(), r.port);
    }
  });

  const handleClient = async (conn: ManagedTcpConnection) => {
    const sid = ++nextSid;
    let [peer, pend] = ['connecting...', 0];
    let dec = new TextDecoder('utf-8', { fatal: false });
    syncUi();
    const logEcho = (pre: string, rx: number, tx: number) => {
      appendLog(`[rx <- client #${sid}] ${pre} (${rx} B)`);
      appendLog(`[echo -> client #${sid}] ${pre} (${tx} B)`);
      syncUi();
    };
    const drop = (disc: boolean) => {
      dec.decode();
      pend = 0;
      srv.removeConnection(conn);
      if (disc) appendLog(`[close] Client #${sid} (${peer}) disconnected.`);
      syncUi();
    };
    try {
      const info = await conn.open({
        onChunk: async (chunk: Uint8Array) => {
          const len = chunk.byteLength;
          const echoed = (await conn.send(chunk)) > 0 ? len : 0;
          echoedTotal += echoed;
          const txt = hasBinCtrl(chunk)
            ? '\ufffd'
            : dec.decode(chunk, { stream: true });
          if (txt.includes('\ufffd')) {
            dec = new TextDecoder('utf-8', { fatal: false });
            const pre = `<${pend + len} B binary>`;
            pend = 0;
            return logEcho(pre, len, echoed);
          }
          if (!txt.length) {
            pend += len;
            return syncUi();
          }
          const rx = pend + len;
          pend = 0;
          logEcho(`"${fmtPreview(txt)}"`, rx, echoed > 0 ? rx : 0);
        },
        onClose: () => drop(true),
        onError: () => drop(false),
      });
      const rAddr = formatBindAddress(info.remoteAddress ?? 'peer');
      peer = `${rAddr}:${info.remotePort ?? 0}`;
      appendLog(`[accept] Client #${sid} connected from ${peer}`);
      syncUi();
    } catch {
      drop(false);
    }
  };

  const startServer = async () => {
    const parsed = parseEchoPort(portInp.value);
    if (!parsed.ok) {
      portInp.setAttribute('aria-invalid', 'true');
      errBanner.show(parsed.error);
      appendLog(`[error] ${parsed.error}`);
      if (!srv.isRunning()) lastErr = parsed.error;
      return syncUi();
    }
    portInp.removeAttribute('aria-invalid');
    errBanner.clear();
    const [bindHost, reqPort, mySeq] = [famHost(), parsed.port, ++opSeq];
    inFlight = 'running';
    lastErr = null;
    syncUi();
    return enqueue(async () => {
      if (mySeq !== opSeq) return;
      if (srv.isRunning()) {
        appendLog('[stop] Stopping active listener before rebind…');
        await srv.stop();
        if (mySeq !== opSeq) return;
      }
      echoedTotal = nextSid = 0;
      try {
        const [host, port, onClient] = [bindHost, reqPort, handleClient];
        await srv.start({ host, port, dualStack: false, onClient });
        if (mySeq !== opSeq) return;
        inFlight = lastErr = null;
        errBanner.clear();
        if (srv.localPort > 0) portInp.value = `${srv.localPort}`;
        const ep = formatEndpoint(srv.localAddress || bindHost, srv.localPort);
        const fam = bindHost === '::1' ? 'IPv6' : 'IPv4';
        appendLog(`[listen] Listening on ${ep} (${fam} loopback)`);
        syncLoopback(bindHost, srv.localPort);
        syncUi();
      } catch (err: unknown) {
        if (mySeq !== opSeq) return;
        inFlight = null;
        const raw = err instanceof Error ? err.message : String(err);
        const fbAddr = formatBindAddress(bindHost);
        const tgt = reqPort ? formatEndpoint(bindHost, reqPort) : fbAddr;
        const short = raw.length > 44 ? `${raw.slice(0, 44)}…` : raw;
        lastErr = `Bind failed on ${tgt} (${short})`;
        errBanner.show(`Failed to bind ${tgt}: ${raw}`);
        appendLog(`[error] Bind failed on ${tgt}: ${raw}`);
        syncUi();
      }
    });
  };

  const stopServer = async () => {
    const mySeq = ++opSeq;
    inFlight = 'stopped';
    syncBtns();
    return enqueue(async () => {
      if (srv.isRunning()) {
        appendLog('[stop] Stopping TCP listener…');
        await srv.stop();
        appendLog('[stop] TCP listener stopped.');
      }
      if (mySeq !== opSeq) return;
      inFlight = lastErr = null;
      errBanner.clear();
      portInp.removeAttribute('aria-invalid');
      syncUi();
    });
  };

  const setFamily = (next: Family, focus = false) => {
    const changed = family !== next;
    family = next;
    [v4Btn, v6Btn].forEach((b, i) => {
      const cur = (i === 0) === (next === 'ipv4');
      b.classList.toggle('active', cur);
      b.setAttribute('aria-checked', `${cur}`);
      b.tabIndex = cur ? 0 : -1;
      if (focus && cur) b.focus();
    });
    if (changed) clearStickyErr();
    const h = famHost();
    if (!srv.isRunning() && inFlight !== 'running') {
      const r = parseEchoPort(portInp.value);
      syncLoopback(h, r.ok ? r.port : null);
    }
    if (changed && srv.isRunning())
      appendLog(`[family] Selected ${formatBindAddress(h)} for next start.`);
  };

  const onRadioKey = (ev: KeyboardEvent) => {
    const k = ev.key;
    let next: Family | null = null;
    if (k.startsWith('Arrow')) next = family === 'ipv4' ? 'ipv6' : 'ipv4';
    else if (k === 'Home' || k === 'End') next = k === 'Home' ? 'ipv4' : 'ipv6';
    else if (k === ' ') next = ev.currentTarget === v6Btn ? 'ipv6' : 'ipv4';
    if (!next) return;
    ev.preventDefault();
    setFamily(next, true);
  };
  for (const b of [v4Btn, v6Btn]) b.addEventListener('keydown', onRadioKey);
  onClick(startBtn, startServer);
  onClick(stopBtn, stopServer);
  onEnter(portInp, startServer);

  const broadcast = async () => {
    const raw = bcastInp.value;
    if (!raw) return;
    const idleWarn = '[warn] Cannot broadcast: start the TCP Server first.';
    if (!srv.isRunning()) return appendLog(idleWarn);
    if (!srv.activeClientCount) return appendLog(BCAST_NO_CLI);
    const wire = raw.endsWith('\n') ? raw : `${raw}\r\n`;
    const { clientsSent: n, bytesSent: b } = await srv.broadcast(wire);
    if (n > 0) {
      bcastInp.value = '';
      const msg = `[tx -> all clients] "${fmtPreview(raw)}" (${b} B -> ${n} client${n === 1 ? '' : 's'})`;
      appendLog(msg);
    } else appendLog(BCAST_NO_CLI);
    syncUi();
  };
  onClick(bcastBtn, broadcast);
  onEnter(bcastInp, broadcast);
  window.addEventListener('pagehide', () => {
    void clientPanel.disconnect();
    void srv.stop();
  });

  const famLbl = span('form-label', 'Loopback Family');
  famLbl.id = 'tcp-server-family-label';
  const radios = div('seg-tabs tcp-family-seg-tabs', v4Btn, v6Btn);
  radios.setAttribute('role', 'radiogroup');
  radios.setAttribute('aria-labelledby', 'tcp-server-family-label');

  const hL = div('workspace-bar-left', span('workspace-caption', 'TCP Server'));
  const hR = div('workspace-bar-right', badgeEl);
  const cardHdr = div('workspace-bar tcp-side-card-header', hL, hR);
  const fFam = div('tcp-side-field tcp-side-field-family', famLbl, radios);
  const fPort = mkField('tcp-side-field-port', 'Port', portInp);
  const cfgActs = div('tcp-side-actions', startBtn, stopBtn);
  const cfgBar = div('tcp-side-config-bar', fFam, fPort, cfgActs);
  const stMetaCls = 'tcp-side-header-meta mono tabular-nums';
  const stParts = ['Connections: ', clientsEl, ' · Echoed: ', bytesEl];
  const stEl = span(stMetaCls, ...stParts);
  const lRight = div(
    'workspace-bar-right tcp-side-header-stats',
    stEl,
    clearBtn,
  );
  const lTitle = span('tcp-side-log-title', 'SERVER CONVERSATION LOG');
  const logHdr = div('tcp-side-log-header', lTitle, lRight);
  const stage = div('tcp-side-log-stage', logPre);
  const logSec = div('tcp-side-log-section', logHdr, stage);
  const fBc = mkField('tcp-send-field', 'Broadcast Message', bcastInp);
  const sendBar = div('tcp-side-send-bar', fBc, bcastBtn);
  const sCls = 'workspace-card tcp-server-card tcp-side-card';
  const sBody = [cardHdr, cfgBar, errBanner.root, logSec, sendBar];
  const echoCard = tid(el('section', sCls, ...sBody), 'tcp-echo-server-panel');

  syncUi();
  const grid = tid(
    div('tcp-side-by-side-grid', clientPanel.root, echoCard),
    'tcp-side-by-side-grid',
  );
  const wsHdr = createWorkspaceHeader({
    title: 'TCP Echo',
    subtitle: SUBTITLE,
    className: 'tcp-header',
  });
  container.replaceChildren(wsHdr, grid);
}

export const tcpTerminalWorkspace: WorkspaceDefinition = {
  id: 'tcp-terminal',
  navLabel: 'TCP Echo',
  title: 'TCP Echo',
  subtitle: SUBTITLE,
  mount: mountTcpTerminal,
};

export const workspace = tcpTerminalWorkspace;
export default tcpTerminalWorkspace;

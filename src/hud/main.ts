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

import '../style.css';
import {
  applyDocumentTheme,
  createBrandEmblemSvg,
  el,
  initChildThemeSync,
} from '../lib/dom';
import {
  connectChildSubAppBus,
  type SubAppBusMessage,
} from '../lib/subapp-bus';

type TelemetryMsg = Extract<SubAppBusMessage, { type: 'SHELL_TELEMETRY' }>;
type AppEntry = { appId: string; title: string; ts: number };

const HUD = '/hud.html';
const HUD_TITLE = 'IWA Sink Companion';
const INST_KEY = 'iwa-sink.subapp.instanceId:/hud.html';
const MODES =
  'unframed|window-controls-overlay|standalone|minimal-ui|browser'.split('|');
const WS_PAIRS =
  'overview:Overview|tcp-terminal:TCP Echo|controlled-frame-tls:Controlled Frame|sso-offloading:SSO Loopback|sub-apps:Sub-Apps|windowing-hud:Windowing|screen-capture:Screen Capture|extension-bridge:Extension Connectivity';
const WS_TITLES: Record<string, string> = Object.fromEntries(
  WS_PAIRS.split('|').map((p) => p.split(':')),
);
const div = (c: string, ...ch: Array<Node | string>) => el('div', c, ...ch);
const span = (c: string, t: string) => el('span', c, t);
const onClick = (b: HTMLElement, fn: () => unknown) =>
  b.addEventListener('click', () => void fn());

function safe(fn: () => void) {
  try {
    fn();
  } catch {}
}
function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
function btn(id: string, txt: string, cls: string) {
  const b = tid(el('button', cls, txt), id);
  b.type = 'button';
  return b;
}

const detectMode = () =>
  MODES.find((m) => window.matchMedia?.(`(display-mode: ${m})`).matches) ??
  'browser';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const b = Math.floor(n);
  if (b < 1024) return `${b} B`;
  return b < 1048576
    ? `${(n / 1024).toFixed(1)} KiB (${b} B)`
    : `${(n / 1048576).toFixed(2)} MiB (${b} B)`;
}

function fmtPort(port: number | null, rawHost?: string | null): string {
  if (port === null || port <= 0) return 'active';
  const h = (rawHost ?? '').trim();
  if (h === '::1' || h === '[::1]') return `[::1]:${port}`;
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]:${port}`;
  return h && h !== '127.0.0.1' ? `${h}:${port}` : `:${port}`;
}

const themeCh = initChildThemeSync();
const root = document.getElementById('hud-app');
const isCrOS =
  typeof navigator !== 'undefined' && /\bCrOS\b/i.test(navigator.userAgent);

if (root && !isCrOS) {
  const b = window.opener
    ? btn('hud-close-btn', 'Close', 'btn btn-sm no-drag')
    : null;
  if (b) {
    b.setAttribute('aria-label', 'Close window');
    onClick(b, () => window.close());
  }
  const h1 = el('h1', 'hud-cros-guard-title', 'ChromeOS Required');
  const desc = 'Unframed windows are supported on ChromeOS only.';
  const guard = el(
    'main',
    'hud-cros-guard',
    h1,
    el('p', 'hud-cros-guard-desc', desc),
    b,
  );
  root.replaceChildren(tid(guard, 'hud-cros-only-notice'));
  window.addEventListener('pagehide', () => themeCh?.close());
} else if (root) {
  const modeBadge = tid(
    span('meta-tag hud-mode-badge tabular-nums', detectMode()),
    'hud-display-mode',
  );
  const wsVal = span('kv-val tabular-nums', 'Syncing…');
  const tcpVal = span('kv-val tabular-nums', 'Idle (0 B)');
  const subVal = span('kv-val tabular-nums', '0 open');
  const row = (k: string, v: HTMLElement) =>
    div('kv-row', span('kv-key', k), v);
  const cardCls = 'data-card hud-telemetry-card tabular-nums';
  const summaryCard = tid(
    div(
      cardCls,
      row('Active Workspace', wsVal),
      row('TCP Echo', tcpVal),
      row('Sub-App Windows', subVal),
    ),
    'hud-telemetry-summary',
  );

  const openApps = new Map<string, AppEntry>();
  const syncSub = () => {
    const now = Date.now();
    for (const [k, v] of openApps) if (now - v.ts > 5000) openApps.delete(k);
    const n = openApps.size;
    const f = n === 1 ? openApps.values().next().value : undefined;
    subVal.textContent = !n
      ? '0 open'
      : n === 1 && f?.title
        ? `1 open · ${f.title}`
        : `${n} open`;
  };
  const renderTelemetry = (m: TelemetryMsg) => {
    if (m.theme === 'light' || m.theme === 'dark') applyDocumentTheme(m.theme);
    const ws = m.activeWorkspace || 'overview';
    wsVal.textContent = WS_TITLES[ws] ?? ws;
    const bt = fmtBytes(m.tcpBytesEchoed);
    tcpVal.textContent = m.tcpEchoRunning
      ? `Listening ${fmtPort(m.tcpEchoPort, m.tcpEchoHost)} (${bt})`
      : `Idle (${bt})`;
  };

  const bus = connectChildSubAppBus({
    appId: HUD,
    scope: HUD,
    title: HUD_TITLE,
    onMessage: (m) => {
      if (m.type === 'SHELL_TELEMETRY') return renderTelemetry(m);
      if (m.type === 'HUD_COMMAND')
        return void (m.action === 'focus-hud' && safe(() => window.focus()));
      if ('appId' in m && m.appId === HUD) return;
      if (m.type === 'SUBAPP_HELLO' || m.type === 'SUBAPP_HEARTBEAT')
        openApps.set(m.instanceId || m.appId, {
          appId: m.appId,
          title: m.title || m.appId,
          ts: Date.now(),
        });
      else if (m.type === 'SUBAPP_CLOSED')
        openApps.delete(m.instanceId || m.appId);
      else if (m.type === 'CLOSE_SUBAPP') {
        if (m.targetInstanceId) openApps.delete(m.targetInstanceId);
        else
          for (const [k, v] of openApps)
            if (v.appId === m.appId) openApps.delete(k);
      } else return;
      syncSub();
    },
  });

  const ping = () => {
    syncSub();
    bus.post({ type: 'HUD_COMMAND', action: 'ping', ts: Date.now() });
  };
  let timer: number | undefined;
  const focusCls = 'btn btn-sm btn-subtle no-drag';
  const focusBtn = btn('hud-focus-shell-btn', 'Focus Shell', focusCls);
  focusBtn.title =
    'Focus Shell — bring the parent application window to the foreground';
  onClick(focusBtn, () => {
    safe(() => window.opener?.focus());
    bus.post({ type: 'HUD_COMMAND', action: 'focus-parent', ts: Date.now() });
  });

  const closeBtn = btn(
    'hud-close-btn',
    'Close',
    'btn btn-sm btn-danger no-drag',
  );
  closeBtn.title = 'Close unframed companion window';
  closeBtn.setAttribute('aria-label', 'Close companion window');
  onClick(closeBtn, () => {
    if (timer !== undefined) window.clearInterval(timer);
    let instanceId: string | undefined;
    safe(() => {
      instanceId = window.sessionStorage.getItem(INST_KEY) ?? undefined;
      window.sessionStorage.removeItem(INST_KEY);
    });
    const closedMsg: SubAppBusMessage = {
      type: 'SUBAPP_CLOSED',
      appId: HUD,
      scope: HUD,
      title: HUD_TITLE,
      instanceId,
      reason: 'close',
      ts: Date.now(),
    };
    bus.post(closedMsg);
    bus.close();
    themeCh?.close();
    window.close();
  });

  if (typeof window.matchMedia === 'function') {
    const sync = () => void (modeBadge.textContent = detectMode());
    for (const m of MODES.slice(0, 3))
      window
        .matchMedia(`(display-mode: ${m})`)
        .addEventListener('change', sync);
  }
  bus.post({ type: 'QUERY_OPEN_SUBAPPS', ts: Date.now() });
  ping();
  timer = window.setInterval(ping, 1000);
  window.addEventListener('pagehide', () => {
    if (timer !== undefined) window.clearInterval(timer);
    bus.close();
    themeCh?.close();
  });

  const brand = createBrandEmblemSvg(16, 'hud-brand-icon');
  const tEl = el('strong', 'hud-title', HUD_TITLE);
  const left = div('status-cluster hud-title-cluster', brand, tEl, modeBadge);
  const acts = div(
    'status-cluster hud-actions-cluster no-drag',
    focusBtn,
    closeBtn,
  );
  const bar = tid(
    el('header', 'hud-titlebar drag-region', left, acts),
    'hud-drag-region',
  );
  root.replaceChildren(
    div('hud-window', bar, el('main', 'workspace-body hud-body', summaryCard)),
  );
}

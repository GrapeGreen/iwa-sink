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

import './style.css';
import {
  isWorkspaceId,
  type ProtocolLaunchListener,
  type ShellContext,
  type WorkspaceDefinition,
  type WorkspaceId,
  type WorkspaceLiveStatus,
} from './shell/contracts';
import {
  applyDocumentTheme,
  createBrandEmblemSvg,
  createWorkspaceIconSvg,
  el,
  initChildThemeSync,
  registerAppServiceWorker,
  svg,
} from './lib/dom';
import {
  inspectProtocolPayload,
  type ProtocolInspectionResult,
} from './lib/protocol';
import { SubAppBus } from './lib/subapp-bus';
import * as mOv from './workspaces/overview';
import * as mTcp from './workspaces/tcp-terminal';
import * as mCf from './workspaces/controlled-frame-tls';
import * as mSso from './workspaces/sso-offloading';
import * as mSub from './workspaces/sub-apps';
import * as mWin from './workspaces/windowing-hud';
import * as mCap from './workspaces/screen-capture';
import * as mExt from './workspaces/extension-bridge';

const WORKSPACES = [mOv, mTcp, mCf, mSso, mSub, mWin, mCap, mExt].map(
  (m) =>
    Object.values(m).find((v): v is WorkspaceDefinition =>
      Boolean(v && typeof v === 'object' && 'mount' in v),
    )!,
);
const PROTO_KEYS = ['protocol', 'cf_protocol', 'params'] as const;
const SHELL_KEYS = new Set<string>([...PROTO_KEYS, 'workspace']);
const THEME_KEY = 'iwa-sink.theme';
const RAIL_KEY = 'iwa-sink.sidebar-collapsed';
const CF_RE = /^(web\+cf|cf):/i;
const CF_HEAD_RE = /^(web\+cf|cf):(\/\/)?/i;
const CF_BODY_RE = /^(web\+cf|cf):(\/\/)?(.*)$/is;

const tryOr = <T>(fn: () => T, fb: T): T => {
  try {
    return fn();
  } catch {
    return fb;
  }
};
const lsGet = (k: string) => tryOr(() => window.localStorage.getItem(k), null);
const lsSet = (k: string, v: string) =>
  void tryOr(() => window.localStorage.setItem(k, v), undefined);
const dec = (s: string) =>
  s.includes('%') ? tryOr(() => decodeURIComponent(s), s) : s;
const splitEq = (s: string): [string, string] => {
  const i = s.indexOf('=');
  return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
};

function mergeExtrasAndHash(p: string, ex: string[], outHash: string): string {
  if (!p.replace(CF_HEAD_RE, ''))
    return outHash && !p.includes('#') ? `${p}${outHash}` : p;
  const m = (ex.length > 0 || outHash) && CF_BODY_RE.exec(p);
  const norm =
    m && !/[/?#]/.test(m[3]) ? `${m[1]}:${m[2] ?? ''}${dec(m[3])}` : p;
  const hIdx = norm.indexOf('#');
  const base = hIdx >= 0 ? norm.slice(0, hIdx) : norm;
  const hash = (hIdx >= 0 ? norm.slice(hIdx) : '') || outHash || '';
  const sep = base.includes('?') ? '&' : '?';
  return ex.length ? `${base}${sep}${ex.join('&')}${hash}` : `${base}${hash}`;
}

function parseProtocolFromRawUrl(rawUrl: string): string {
  const t = rawUrl.replace(/^ +| +$/g, '');
  if (!t || CF_RE.test(t)) return t;
  if (/[\x00-\x1f\x7f]/.test(t)) {
    const m = /[?&](?:protocol|cf_protocol|params)=([^#]*)(#.*)?$/i.exec(t);
    const cand = m ? `${m[1]}${m[2] ?? ''}` : '';
    return /[\x00-\x1f\x7f]/.test(cand) ? cand : t;
  }
  return tryOr(() => {
    const u = new URL(t, window.location.origin);
    const key = PROTO_KEYS.find((k) => u.searchParams.has(k));
    if (!key) return t;
    const segs = u.search.replace(/^\?/, '').split('&').filter(Boolean);
    for (let i = 0; i < segs.length; i += 1) {
      const [rk, rv] = splitEq(segs[i]);
      if (dec(rk) !== key) continue;
      if (CF_RE.test(rv)) {
        const isExtra = (s: string) => !SHELL_KEYS.has(dec(splitEq(s)[0]));
        const lead = segs.slice(0, i).filter(isExtra);
        return mergeExtrasAndHash(rv, [...segs.slice(i + 1), ...lead], u.hash);
      }
      break;
    }
    const rawP = u.searchParams.get(key) ?? '';
    const isSpaceCf = /^web cf:/i.test(rawP) && /web\+cf:/i.test(u.search);
    const param = isSpaceCf ? rawP.replace(/^web cf:/i, 'web+cf:') : rawP;
    if (CF_RE.test(param)) {
      const ex: string[] = [];
      if (param.replace(CF_HEAD_RE, ''))
        for (const [k, v] of u.searchParams.entries())
          if (!SHELL_KEYS.has(k))
            ex.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      return mergeExtrasAndHash(param, ex, u.hash);
    }
    return u.hash && !param.includes('#') ? `${param}${u.hash}` : param;
  }, t);
}

function readShellWorkspaceParam(search: string): string | null {
  for (const seg of search.replace(/^\?/, '').split('&')) {
    if (!seg) continue;
    const [rk, v] = splitEq(seg);
    const k = dec(rk);
    const isCf = CF_RE.test(v) && Boolean(v.replace(CF_HEAD_RE, ''));
    if ((PROTO_KEYS as readonly string[]).includes(k) && isCf) break;
    if (k === 'workspace')
      return tryOr(() => decodeURIComponent(v.replace(/\+/g, ' ')), v)
        .trim()
        .toLowerCase();
  }
  return null;
}

const hasProtoParam = (p: URLSearchParams) => PROTO_KEYS.some((k) => p.has(k));

const parsePort = (text: string): number | null => {
  const t = text.trim();
  const m = /^\d+$/.test(t) ? [0, t] : t.match(/:(\d+)(?!.*:\d+)/);
  const n = m ? Number.parseInt(`${m[1]}`, 10) : 0;
  return n > 0 ? n : null;
};

function parseEchoHost(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const b = /\[([^\]]+)\](?::\d+)?/.exec(t);
  if (b) return b[1];
  if (/\b127\.0\.0\.1\b/.test(t)) return '127.0.0.1';
  if (/::1/.test(t)) return '::1';
  return /\b([a-zA-Z0-9.-]+):\d+\b/.exec(t)?.[1] ?? null;
}

function readTcpTelemetry(st?: WorkspaceLiveStatus) {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const badge = q('echo-status-badge');
  const pTxt = q('echo-bound-port')?.textContent ?? '';
  const lbl = st?.label ?? '';
  const bRaw = q('echo-bytes-counter')?.textContent ?? lbl;
  const bMatch = bRaw.match(/(\d[\d,]*)\s*B\b/)?.[1].replace(/,/g, '') ?? '0';
  const bNum = Number.parseInt(bMatch, 10);
  const bTxt = (badge?.textContent ?? '').trim();
  const on =
    st?.state === 'online' || badge?.getAttribute('data-state') === 'online';
  const host = parseEchoHost(bTxt) ?? parseEchoHost(lbl) ?? '127.0.0.1';
  const port = parsePort(pTxt) ?? parsePort(lbl) ?? parsePort(bTxt);
  return {
    tcpEchoRunning: on,
    tcpEchoHost: on ? host : null,
    tcpEchoPort: on ? port : null,
    tcpBytesEchoed: Number.isFinite(bNum) && bNum >= 0 ? bNum : 0,
  };
}

const fp = (d: string, o = '0.18') => ({
  attrs: { d, fill: 'currentColor', 'fill-opacity': o },
});
const SUN = [
  fp('M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', '0.2'),
  'M12 2.5v2M12 19.5v2M5.28 5.28l1.42 1.42M17.3 17.3l1.42 1.42M2.5 12h2M19.5 12h2M6.7 17.3l-1.42 1.42M18.72 5.28l-1.42 1.42',
];
const MOON = [fp('M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z')];
const RAIL_BOX = fp(
  'M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z',
  '0.14',
);

async function bootstrapShell(): Promise<void> {
  const docEl = document.documentElement;
  if (!docEl.getAttribute('data-theme'))
    docEl.setAttribute('data-theme', 'dark');
  const appRoot = document.getElementById('app');
  if (!appRoot) throw new Error('Missing #app root container');

  const isCrOS = /\bCrOS\b/i.test(navigator.userAgent);
  const enabled = WORKSPACES.filter((w) => w.id !== 'screen-capture' || isCrOS);
  const isSup = (v: string | null | undefined): v is WorkspaceId =>
    isWorkspaceId(v) && (v !== 'screen-capture' || isCrOS);

  let activeId: WorkspaceId = 'overview';
  let bootParsed: string | null = null;
  let bootRes: ProtocolInspectionResult | null = null;
  tryOr(() => {
    const reqWs = readShellWorkspaceParam(window.location.search);
    if (isSup(reqWs)) activeId = reqWs;
    if (hasProtoParam(new URLSearchParams(window.location.search))) {
      bootParsed = parseProtocolFromRawUrl(window.location.href);
      bootRes = inspectProtocolPayload(window.location.href, bootParsed);
      if (bootRes.valid && !isSup(reqWs)) activeId = 'controlled-frame-tls';
    }
  }, undefined);

  const navBtns = new Map<WorkspaceId, HTMLButtonElement>();
  const panels = new Map<WorkspaceId, HTMLElement>();
  const statuses = new Map<WorkspaceId, WorkspaceLiveStatus>();
  const protoListeners = new Set<ProtocolLaunchListener>();
  const pendingLaunches: string[] = [];
  let mounted = false;
  let cfNav: ((u: string, r?: ProtocolInspectionResult) => void) | undefined;
  const subAppBus = new SubAppBus();
  const curTheme = (): 'dark' | 'light' =>
    docEl.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const mkBtn = (cls: string, onClick: () => void, tid = cls) => {
    const b = el('button', cls);
    b.type = 'button';
    b.dataset.testid = tid;
    b.addEventListener('click', onClick);
    return b;
  };
  const emitTelemetry = (): void =>
    subAppBus.post({
      type: 'SHELL_TELEMETRY',
      activeWorkspace: activeId,
      ...readTcpTelemetry(statuses.get('tcp-terminal')),
      theme: curTheme(),
      ts: Date.now(),
    });

  const navList = el('nav', 'nav-list');
  navList.setAttribute('aria-label', 'Capability Workspaces');
  const stage = el('main', 'shell-stage');
  stage.id = 'workspace-stage';
  for (const ws of enabled) {
    statuses.set(ws.id, { state: 'probing', label: 'Idle' });
    const lbl = ws.navLabel;
    const cur = ws.id === activeId;
    const cls = `nav-item${cur ? ' is-active' : ''}`;
    const btn = mkBtn(cls, () => ctx.activateWorkspace(ws.id), `nav-${ws.id}`);
    btn.title = lbl;
    btn.setAttribute('aria-label', lbl);
    if (cur) btn.setAttribute('aria-current', 'page');
    const ico = createWorkspaceIconSvg(ws.id, 20, 'nav-item-icon');
    btn.appendChild(
      el('span', 'nav-item-left', ico, el('span', 'nav-item-label', lbl)),
    );
    navBtns.set(ws.id, btn);
    navList.appendChild(btn);
    const p = el(
      'section',
      `workspace-view ${cur ? 'is-active' : 'is-hidden'}`,
    );
    p.dataset.testid = `panel-${ws.id}`;
    p.dataset.workspaceId = ws.id;
    p.setAttribute('aria-hidden', `${!cur}`);
    panels.set(ws.id, p);
    stage.appendChild(p);
  }

  let themeCh: BroadcastChannel | null = null;
  const themeBtn = mkBtn('theme-toggle-btn', () => {
    const next = curTheme() === 'light' ? 'dark' : 'light';
    applyDocumentTheme(next);
    syncThemeBtn(next);
    lsSet(THEME_KEY, next);
    const msg = { type: 'THEME_CHANGE', theme: next };
    tryOr(() => themeCh?.postMessage(msg), undefined);
    emitTelemetry();
  });
  themeBtn.id = 'theme-toggle';
  function syncThemeBtn(next: 'dark' | 'light'): void {
    const dark = next === 'dark';
    const short = dark ? 'Light theme' : 'Dark theme';
    const full = `${short} — switch to Warm ${dark ? 'Light' : 'Dark'} theme`;
    themeBtn.title = full;
    themeBtn.setAttribute('aria-label', full);
    const iCls = 'sidebar-collapse-icon';
    const ico = svg(dark ? SUN : MOON, { size: 18, className: iCls });
    const inner = el(
      'span',
      'theme-toggle-content',
      ico,
      el('span', 'nav-item-label', short),
    );
    inner.dataset.testid = 'shell-theme-toggle';
    themeBtn.replaceChildren(inner);
  }
  themeCh = initChildThemeSync(syncThemeBtn);

  let collapsed = lsGet(RAIL_KEY) === '1';
  const collapseBtn = mkBtn('sidebar-collapse-btn', () =>
    applyCollapsed(!collapsed, true),
  );
  const mark = el(
    'div',
    'brand-mark',
    createBrandEmblemSvg(18, 'sidebar-collapse-icon'),
  );
  const bTitle = el('span', 'brand-title', 'IWA Sink');
  const brand = el('div', 'brand', mark, bTitle, collapseBtn);
  const footer = el('div', 'sidebar-footer', themeBtn);
  footer.dataset.testid = 'shell-status-bar';
  const sidebar = el(
    'aside',
    'shell-sidebar',
    el('div', 'sidebar-top', brand, navList),
    footer,
  );
  sidebar.dataset.testid = 'app-sidebar';
  const shellLayout = el(
    'div',
    'shell-layout',
    sidebar,
    el('div', 'shell-main', stage),
  );
  appRoot.replaceChildren(shellLayout);

  const applyCollapsed = (next: boolean, persist: boolean): void => {
    collapsed = next;
    for (const n of [shellLayout, sidebar]) {
      n.classList.toggle('is-sidebar-collapsed', next);
      n.setAttribute('data-sidebar-collapsed', `${next}`);
    }
    const lbl = next ? 'Expand sidebar' : 'Collapse sidebar';
    collapseBtn.title = `${lbl} (Ctrl+B)`;
    collapseBtn.setAttribute('aria-label', lbl);
    collapseBtn.setAttribute('aria-expanded', `${!next}`);
    const chev = next ? 'M13 9.5l2.5 2.5-2.5 2.5' : 'M15.5 9.5L13 12l2.5 2.5';
    const cCls = 'sidebar-collapse-icon';
    collapseBtn.replaceChildren(
      svg([RAIL_BOX, 'M9 4v16', chev], { size: 18, className: cCls }),
    );
    if (persist) lsSet(RAIL_KEY, next ? '1' : '0');
  };
  applyCollapsed(collapsed, false);

  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    const mod = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
    if (mod && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      applyCollapsed(!collapsed, true);
    }
  });

  const ctx: ShellContext = {
    activateWorkspace(id: WorkspaceId): void {
      const norm = typeof id === 'string' ? id.trim().toLowerCase() : '';
      const resId: WorkspaceId = isSup(norm) ? norm : 'overview';
      const target = panels.get(resId);
      const already =
        activeId === resId && target?.classList.contains('is-active');
      if (!target || already) return;
      activeId = resId;
      target.classList.add('is-active');
      target.classList.remove('is-hidden');
      target.setAttribute('aria-hidden', 'false');
      const ae = document.activeElement;
      for (const ws of enabled) {
        const cur = ws.id === resId;
        const btn = navBtns.get(ws.id);
        btn?.classList.toggle('is-active', cur);
        if (cur) btn?.setAttribute('aria-current', 'page');
        else btn?.removeAttribute('aria-current');
        const p = cur ? null : panels.get(ws.id);
        if (!p) continue;
        if (ae && ae !== document.body && p.contains(ae)) {
          navBtns.get(resId)?.focus({ preventScroll: true });
          if (p.contains(document.activeElement))
            (document.activeElement as HTMLElement | null)?.blur?.();
        }
        p.classList.remove('is-active');
        p.classList.add('is-hidden');
        p.setAttribute('aria-hidden', 'true');
      }
      emitTelemetry();
    },
    getActiveWorkspace: () => activeId,
    setWorkspaceStatus(id: WorkspaceId, status: WorkspaceLiveStatus): void {
      statuses.set(id, status);
      emitTelemetry();
    },
    onProtocolLaunch(listener: ProtocolLaunchListener): () => void {
      protoListeners.add(listener);
      return () => protoListeners.delete(listener);
    },
    dispatchProtocolLaunch(rawUrl: string): void {
      if (!mounted) return void pendingLaunches.push(rawUrl);
      const hit =
        bootParsed !== null && bootRes !== null && rawUrl === location.href;
      const parsed = hit ? bootParsed! : parseProtocolFromRawUrl(rawUrl);
      const res = hit ? bootRes! : inspectProtocolPayload(rawUrl, parsed);
      if (hit) bootParsed = bootRes = null;
      for (const fn of protoListeners)
        tryOr(() => fn(rawUrl, parsed, res), undefined);
      if (!res.valid) return;
      ctx.activateWorkspace('controlled-frame-tls');
      cfNav?.(res.httpTarget, res);
    },
    registerControlledFrameNavigator(fn): void {
      cfNav = fn;
    },
  };

  subAppBus.subscribe((msg) => {
    if (msg.type === 'HUD_COMMAND') {
      if (msg.action === 'focus-parent') window.focus();
      if (msg.action !== 'focus-hud') emitTelemetry();
    } else if (msg.type === 'SUBAPP_HELLO') emitTelemetry();
  });

  let coldProto: string | null = bootParsed;
  if (bootParsed !== null) {
    ctx.dispatchProtocolLaunch(window.location.href);
    window.setTimeout(() => (coldProto = null), 2000);
  }

  window.launchQueue?.setConsumer((params) => {
    if (!params?.targetURL) return;
    const raw = String(params.targetURL);
    const dispatch = (url: string): void => {
      const dup =
        coldProto !== null && parseProtocolFromRawUrl(url) === coldProto;
      coldProto = null;
      if (!dup) ctx.dispatchProtocolLaunch(url);
    };
    if (CF_RE.test(raw.trim()) || /^[\x00-\x20\x7f]+(web\+cf|cf):/i.test(raw))
      return dispatch(raw);
    try {
      const u = new URL(raw, window.location.origin);
      if (hasProtoParam(u.searchParams)) return dispatch(raw);
      coldProto = null;
      const wsP = u.searchParams.get('workspace');
      if (wsP !== null) ctx.activateWorkspace(wsP as WorkspaceId);
    } catch {
      if (/[?&](?:protocol|cf_protocol|params)=/i.test(raw)) dispatch(raw);
    }
  });

  await Promise.all(enabled.map((ws) => ws.mount(panels.get(ws.id)!, ctx)));
  mounted = true;
  for (const raw of pendingLaunches.splice(0)) ctx.dispatchProtocolLaunch(raw);
  void registerAppServiceWorker('/sw.js');
  emitTelemetry();
}

void bootstrapShell();

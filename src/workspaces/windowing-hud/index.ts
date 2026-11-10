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
  clearChildren,
  createCard,
  createLogConsole,
  createSegmentedTabs,
  createStatusPill,
  createWorkspaceHeader,
  el,
  formatLogTime,
  svg,
} from '../../lib/dom';
import { SubAppBus, type SubAppBusMessage } from '../../lib/subapp-bus';
import type { ShellContext, WorkspaceDefinition } from '../../shell/contracts';

type WinState = 'Normal' | 'Maximized' | 'Minimized';
type AwcKey = 'minimize' | 'maximize' | 'restore';
type AwcAction = `${AwcKey}()`;
type TabId = 'controls' | 'unframed';
type Shapes = Parameters<typeof svg>[0];
type Kids = Array<Node | string | null>;

const HUD = '/hud.html';
const HUD_IDLE = 'Window Ready · unframed';
const HUD_CLOSED_LOG = '[unframed] Companion window /hud.html closed.';
const AWC_FLAG = '#enable-desktop-pwas-additional-windowing-controls';
const SUB_CROS =
  'Control the desktop application window state or launch a borderless unframed companion window.';
const SUB_DESK =
  'Control the desktop application window state, resizability, and multi-display geometry via the Additional Windowing Controls API.';
const UNF_H3 = 'Custom Window Chrome without OS Titlebars';
const UNF_D1 =
  'Isolated Web Apps can declare "display_override": ["unframed"] in their Web App Manifest to open windows without the operating system’s default titlebar or borders.';
const UNF_D2 =
  'You define draggable regions in CSS using app-region: drag and mark interactive buttons with app-region: no-drag — ideal for floating tool palettes, mini-players, or status companions.';
const MODE_STR =
  'standalone|unframed|window-controls-overlay|fullscreen|minimal-ui|browser';
const MODES = MODE_STR.split('|');
const rect = (x: number, y: number, s: number) => ({
  tag: 'rect' as const,
  attrs: { x, y, width: s, height: s, rx: 2 },
});
const REST_D = 'M9 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2';
const AWC_SPECS: Array<[AwcKey, WinState, Shapes]> = [
  ['minimize', 'Minimized', ['M5 12h14']],
  ['maximize', 'Maximized', [rect(4, 4, 16)]],
  ['restore', 'Normal', [rect(5, 7, 12), REST_D]],
];
const RES_SHAPES = 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7'.split('|');
const AWC_KEYS = ['minimize', 'maximize', 'restore', 'setResizable'] as const;
const noop = () => {};
const div = (c: string | null, ...ch: Kids) => el('div', c, ...ch);
const span = (c: string | null, ...ch: Kids) => el('span', c, ...ch);
const errStr = (e: unknown) => (e instanceof Error ? e.message : String(e));
const onClick = (b: HTMLElement, fn: () => unknown) =>
  b.addEventListener('click', () => void fn());

function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
const btn = (id: string, cls: string, ...ch: Kids) =>
  Object.assign(tid(el('button', cls, ...ch), id), { type: 'button' as const });
function safe(fn: () => void) {
  try {
    fn();
  } catch {}
}
const vpDims = () =>
  `${window.innerWidth || 1440} × ${window.innerHeight || 900}`;
const fmtTime = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const mm = (m: string) =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.(`(display-mode: ${m})`).matches);
function isMax(): boolean {
  const s = typeof window !== 'undefined' ? window.screen : null;
  if (mm('fullscreen')) return true;
  if (!s || s.availWidth <= 0 || s.availHeight <= 0) return false;
  const [dw, dh] = [s.availWidth - 8, s.availHeight - 8];
  return window.outerWidth >= dw && window.outerHeight >= dh;
}

function detectMode(st: WinState = 'Normal') {
  const vp = typeof window !== 'undefined' ? `${vpDims()} px` : '1440 × 900 px';
  if (mm('unframed'))
    return { rawMode: 'unframed', label: `State: Unframed (${vp})` };
  const wco = mm('window-controls-overlay');
  const rawMode = wco
    ? 'window-controls-overlay'
    : (['standalone', 'minimal-ui'] as const).find(mm) ?? 'browser';
  return { rawMode, label: `State: ${st} · ${wco ? 'WCO' : rawMode} (${vp})` };
}

function fmtScreenLabel(raw: string | undefined, idx: number, int?: boolean) {
  const t = (raw ?? '').trim();
  const isHash = /^[A-Za-z0-9+/=_-]{28,}$/.test(t);
  const gen = !t || /^Display--?\d+$/i.test(t) || isHash;
  return gen ? `${int ? 'Built-in ' : ''}Display ${idx + 1}` : t;
}

function mkScreenChip(title: string, meta: string, cur: boolean) {
  const dot = span(`win-screen-dot${cur ? ' is-current' : ''}`);
  dot.setAttribute('aria-hidden', 'true');
  const tag = span('meta-tag mono tabular-nums', meta);
  const row = div('workspace-bar-left', dot, el('strong', null, title), tag);
  return div('data-card win-screen-card win-screen-chip', row);
}

function buildAwcBanner(hidden: boolean) {
  const c1 = el('code', 'mono', 'chrome://flags');
  const c2 = el('code', 'mono', AWC_FLAG);
  const pfx =
    'Additional Windowing Controls are disabled. In a regular Chrome tab, navigate to ';
  const sfx =
    ' (Desktop PWAs Additional Windowing Controls), and restart Chrome.';
  const copy = span('win-awc-unavailable-copy', pfx, c1, ', enable ', c2, sfx);
  const b = tid(
    div('win-awc-unavailable-banner', copy),
    'win-awc-unavailable-banner',
  );
  b.hidden = hidden;
  b.setAttribute('role', 'status');
  return b;
}

function mountWindowingHud(container: HTMLElement, ctx: ShellContext): void {
  const isCrOS = /\bCrOS\b/i.test(navigator.userAgent);
  let hudRef: Window | null = null;
  let [hudBusOn, hudSeenMs, hudMarkedOpen] = [false, 0, false];
  const hudIds = new Set<string>();
  const hudBus = isCrOS ? new SubAppBus() : null;
  const postHud = (m: SubAppBusMessage) => hudBus?.post(m);
  const clearHudBus = () => {
    [hudBusOn, hudSeenMs] = [false, 0];
  };
  let screenDetails: ScreenDetails | null = null;
  let [scrSeq, actSeq, resSeq, statSeq, inFlight] = [0, 0, 0, 0, 0];
  let [resizable, committedRes] = [true, true];
  const bootedMax = isMax();
  let winState: WinState = bootedMax ? 'Maximized' : 'Normal';
  let committedState: WinState = winState;
  let ipcQ: Promise<void> = Promise.resolve();

  const awcOk = () => AWC_KEYS.every((k) => typeof window[k] === 'function');
  const onOff = (v = resizable) => (v ? 'ON' : 'OFF');
  const tail = (v = resizable) => `State: ${winState} · Resizable: ${onOff(v)}`;
  const setWs = (label: string) =>
    ctx.setWorkspaceStatus('windowing-hud', { state: 'online', label });
  const initM = detectMode(winState);
  setWs(initM.rawMode);

  const initLine = `[${formatLogTime()}] [init] Windowing ready — State: ${winState} · ${initM.rawMode} (${vpDims()} px), AWC=${awcOk() ? 'available' : 'unavailable'}, Resizable=${onOff()}.`;
  const log = createLogConsole({
    title: 'Windowing Console Log',
    logTestId: 'win-console-log',
    clearBtnTestId: 'win-clear-log-btn',
    toggleTestId: 'win-toggle-console-btn',
    cardTestId: 'win-console-card',
    cardClassName: 'sso-log-card',
    bodyId: 'win-console-panel',
    ariaLabel: 'Windowing console log',
    maxLines: 160,
    initialLines: [initLine],
  });
  const L = (s: string) => log.append(s);

  const mTone = initM.rawMode === 'unframed' ? 'portal' : 'online';
  const modeBadge = createStatusPill(mTone, initM.label, 'win-display-mode');
  const mkHudPill = () =>
    createStatusPill('probing', HUD_IDLE, 'hud-state-badge');
  const hudBadge = isCrOS ? mkHudPill() : null;
  let closeHudBtn: HTMLButtonElement | null = null;
  const isHudOpen = () => Boolean((hudRef && !hudRef.closed) || hudBusOn);
  const syncCloseBtn = (on: boolean) => {
    if (closeHudBtn) closeHudBtn.disabled = !on;
  };

  const posText = () => `X: ${window.screenX ?? 0}, Y: ${window.screenY ?? 0}`;
  const geoKey = () =>
    `${window.innerWidth},${window.innerHeight},${posText()}`;
  const gValCls = 'win-geo-val mono tabular-nums';
  const [posVal, sizeVal] = [span(gValCls, posText()), span(gValCls, vpDims())];
  let [lastW, lastH] = [window.innerWidth, window.innerHeight];
  let lastGeo = geoKey();
  let [minTs, maxTs, restTs] = [0, bootedMax ? Date.now() : 0, 0];
  let [peakW, peakH] = [window.innerWidth, window.innerHeight];
  let preMinState: 'Normal' | 'Maximized' = bootedMax ? 'Maximized' : 'Normal';
  const bumpPeak = () => {
    peakW = Math.max(peakW, window.innerWidth);
    peakH = Math.max(peakH, window.innerHeight);
  };

  const awcBanner = buildAwcBanner(awcOk());
  const stCls = 'win-awc-status mono tabular-nums';
  const awcStatusEl = tid(
    div(stCls, `Last Event: Ready · ${tail()}`),
    'win-awc-status',
  );
  const setStat = (s: string) => void (awcStatusEl.textContent = s);

  const setTransition = (target: WinState, commit: boolean) => {
    if (target === 'Maximized') {
      winState = preMinState = 'Maximized';
      maxTs = Date.now();
      bumpPeak();
    } else if (target === 'Minimized') {
      if (winState !== 'Minimized') preMinState = winState;
      winState = 'Minimized';
      minTs = Date.now();
    } else {
      winState = preMinState = 'Normal';
      minTs = maxTs = 0;
      restTs = Date.now();
    }
    if (commit) committedState = target;
  };

  const mkIcon = (tone: string, s: Shapes) => {
    const box = div(`win-awc-icon-box ${tone}`, svg(s, { size: 20 }));
    box.setAttribute('aria-hidden', 'true');
    return box;
  };
  const actionBtns = AWC_SPECS.map(([key, tgt, shapes]) => {
    const [act, lbl] = [
      `${key}()` as AwcAction,
      `${key[0].toUpperCase()}${key.slice(1)}`,
    ];
    const icon = mkIcon('win-awc-tone-neutral', shapes);
    const tEl = span('win-awc-btn-title', lbl);
    const aEl = span('win-awc-btn-api mono', `window.${act}`);
    const b = btn(`win-${key}-btn`, 'win-awc-card-btn', icon, tEl, aEl);
    onClick(b, () => {
      const fn = window[key];
      return runAwc(
        act,
        tgt,
        typeof fn === 'function' ? () => fn.call(window) : undefined,
      );
    });
    return b;
  });
  const [minBtn, maxBtn, restBtn] = actionBtns;

  const resLbl = span('win-awc-btn-title tabular-nums', 'Resizable: ON');
  const apiCls = 'win-awc-btn-api mono tabular-nums';
  const resApi = span(apiCls, 'setResizable(true)');
  const resIcon = mkIcon('win-awc-tone-emerald', RES_SHAPES);
  const resCls = 'win-awc-card-btn win-awc-resizable-card active';
  const resBtn = btn('win-resizable-toggle', resCls, resIcon, resLbl, resApi);
  resBtn.setAttribute('role', 'switch');
  resBtn.setAttribute('aria-checked', 'true');
  onClick(resBtn, () => setResizable(!resizable));

  const syncAwcAvail = () => {
    const [ok, fs] = [awcOk(), mm('fullscreen')];
    awcBanner.hidden = ok;
    const tip = ok ? '' : `Requires ${AWC_FLAG} in chrome://flags`;
    for (const b of [minBtn, maxBtn, restBtn, resBtn]) b.title = tip;
    minBtn.disabled = !ok || winState === 'Minimized';
    maxBtn.disabled = !ok || !resizable || winState === 'Maximized' || fs;
    restBtn.disabled = !ok || (winState === 'Normal' && !fs);
    resBtn.disabled = !ok;
    resBtn.classList.toggle('is-disabled', !ok);
    resBtn.setAttribute('aria-disabled', `${!ok}`);
  };
  const syncResState = (v: boolean) => {
    resizable = v;
    resBtn.setAttribute('aria-checked', `${v}`);
    resBtn.classList.toggle('active', v);
    resIcon.classList.toggle('win-awc-tone-emerald', v);
    resIcon.classList.toggle('win-awc-tone-neutral', !v);
    resLbl.textContent = `Resizable: ${onOff(v)}`;
    resApi.textContent = `setResizable(${v})`;
    syncAwcAvail();
  };
  syncAwcAvail();

  const logTrans = (prev: WinState, via: string, st = winState) => {
    const m = detectMode(st).rawMode;
    L(
      `[transition] State changed: ${prev} -> ${st} · ${m} (${vpDims()} px) via ${via}`,
    );
  };
  const reconcileWin = (src: string) => {
    const [now, prev] = [Date.now(), winState];
    const [iw, ih] = [window.innerWidth, window.innerHeight];
    const vis = typeof document === 'undefined' || !document.hidden;
    if (winState === 'Minimized') {
      const foc = Boolean(document.hasFocus?.());
      const wake = now - minTs > 250 && (src === 'resize' || foc);
      if (src === 'focus' || (vis && (src === 'visibilitychange' || wake))) {
        ++actSeq;
        winState = committedState = preMinState;
        minTs = 0;
        if ((awcStatusEl.textContent || '').includes('minimize'))
          setStat(`OS window restored (${src} · ${fmtTime()}) · ${tail()}`);
        logTrans(prev, src);
      }
    } else if (winState === 'Maximized' && src === 'resize') {
      if (iw >= peakW && ih >= peakH) bumpPeak();
      else if (now - maxTs > 500 && (iw < peakW - 16 || ih < peakH - 16)) {
        winState = committedState = preMinState = 'Normal';
        logTrans(prev, src);
      }
    } else if (winState === 'Normal' && src === 'resize') {
      if (now - restTs > 600 && (iw > lastW || ih > lastH) && isMax()) {
        setTransition('Maximized', true);
        logTrans(prev, src);
      }
    }
  };

  const syncMainMode = () => {
    [lastW, lastH] = [window.innerWidth, window.innerHeight];
    lastGeo = geoKey();
    const next = detectMode(winState);
    const tone = next.rawMode === 'unframed' ? 'portal' : 'online';
    modeBadge.update(tone, next.label);
    posVal.textContent = posText();
    sizeVal.textContent = vpDims();
    syncAwcAvail();
    setWs(isHudOpen() ? `${next.rawMode} · Companion` : next.rawMode);
  };
  const markHudOpen = () => {
    hudMarkedOpen = true;
    syncCloseBtn(true);
    hudBadge?.update('online', 'Companion Active · unframed');
    syncMainMode();
  };
  const markHudClosed = (msg?: string) => {
    hudRef = null;
    hudMarkedOpen = false;
    clearHudBus();
    hudIds.clear();
    syncCloseBtn(false);
    hudBadge?.update('probing', HUD_IDLE);
    syncMainMode();
    if (msg) L(msg);
  };

  const reconcileHudClosed = () => {
    if (!isCrOS) return;
    const wasOpen = hudMarkedOpen || isHudOpen();
    const dead = Boolean(hudRef && hudRef.closed);
    const age = Date.now() - hudSeenMs;
    const stale = hudBusOn && !hudRef && hudSeenMs > 0 && age > 3200;
    if (dead || stale) {
      if (dead) hudRef = null;
      clearHudBus();
      hudIds.clear();
    }
    if (wasOpen && !isHudOpen()) {
      markHudClosed(HUD_CLOSED_LOG);
      if (dead) postHud({ type: 'QUERY_OPEN_SUBAPPS', ts: Date.now() });
    } else syncCloseBtn(isHudOpen());
  };

  const unsubHud = hudBus?.subscribe((m) => {
    const isHud = 'appId' in m && (m.appId === HUD || m.scope === HUD);
    const wasOpen = hudMarkedOpen || isHudOpen();
    const alive = m.type === 'SUBAPP_HELLO' || m.type === 'SUBAPP_HEARTBEAT';
    if (alive && isHud) {
      hudBusOn = true;
      hudSeenMs = Date.now();
      hudIds.add(m.instanceId || HUD);
      const msg =
        '[unframed] Companion window /hud.html connected via BroadcastChannel.';
      if (!wasOpen) L(msg);
      markHudOpen();
    } else if (m.type === 'HUD_COMMAND' && hudBusOn) {
      if (m.action !== 'focus-hud') hudSeenMs = Date.now();
    } else if (m.type === 'SUBAPP_CLOSED' && isHud) {
      hudIds.delete(m.instanceId || HUD);
      if (m.reason === 'close' || hudIds.size === 0) {
        clearHudBus();
        if (m.reason === 'close' || !hudRef || hudRef.closed)
          markHudClosed(wasOpen ? HUD_CLOSED_LOG : undefined);
      }
    }
  });
  postHud({ type: 'QUERY_OPEN_SUBAPPS', ts: Date.now() });

  const cleanups: Array<() => void> = [];
  const listen = (t: EventTarget, e: string, fn: EventListener) => {
    t.addEventListener(e, fn);
    cleanups.push(() => t.removeEventListener(e, fn));
  };
  const tick = (src: 'focus' | 'resize') => {
    reconcileHudClosed();
    reconcileWin(src);
    syncMainMode();
  };
  listen(window, 'resize', () => {
    const [pw, ph] = [lastW, lastH];
    tick('resize');
    const msg = `[resize] Viewport resized: ${pw} × ${ph} px -> ${vpDims()} px (State: ${winState})`;
    if (pw !== window.innerWidth || ph !== window.innerHeight) L(msg);
  });
  listen(window, 'focus', () => tick('focus'));
  listen(window, 'pageshow', () => tick('focus'));
  listen(document, 'visibilitychange', () => {
    reconcileHudClosed();
    const prev = winState;
    if (document.hidden) {
      if (Date.now() - minTs < 1500) {
        winState = committedState = 'Minimized';
        if (prev !== 'Minimized') logTrans(prev, 'visibilitychange');
      }
    } else reconcileWin('visibilitychange');
    syncMainMode();
  });
  const pollTimer = window.setInterval(() => {
    reconcileHudClosed();
    const prev = winState;
    reconcileWin('poll');
    if (prev !== winState || geoKey() !== lastGeo) syncMainMode();
  }, 350);
  if (typeof window.matchMedia === 'function') {
    for (const m of MODES) {
      const mql = window.matchMedia(`(display-mode: ${m})`);
      listen(mql, 'change', () => {
        reconcileWin('media');
        syncMainMode();
        if (mql.matches)
          L(`[display-mode] (${m}) → ${detectMode(winState).label}`);
      });
    }
  }

  let switchTab = (_t: TabId) => {};
  const spawnHud = () => {
    if (!isCrOS) return;
    switchTab('unframed');
    reconcileHudClosed();
    if (isHudOpen()) {
      if (hudRef && !hudRef.closed) safe(() => hudRef?.focus());
      postHud({ type: 'HUD_COMMAND', action: 'focus-hud', ts: Date.now() });
      markHudOpen();
      return L('[unframed] Focused existing companion window /hud.html');
    }
    const feat = 'popup=yes,width=440,height=300';
    hudRef = window.open(HUD, 'iwa-sink-hud', feat);
    if (hudRef) {
      L('[unframed] Launched companion window /hud.html (440 × 300 px)');
      markHudOpen();
    } else {
      syncCloseBtn(isHudOpen());
      hudBadge?.update('portal', 'Popup Blocked');
      const msg =
        '[unframed] Companion window /hud.html launch blocked by popup blocker.';
      L(msg);
    }
  };
  const closeHud = () => {
    if (!isCrOS) return;
    const had = isHudOpen();
    postHud({ type: 'CLOSE_SUBAPP', appId: HUD, scope: HUD, ts: Date.now() });
    if (hudRef && !hudRef.closed) safe(() => hudRef?.close());
    const msg = had
      ? HUD_CLOSED_LOG
      : '[unframed] Close requested — no active window.';
    markHudClosed(msg);
  };

  const runIpc = <T>(fn: () => Promise<T> | T): Promise<T> => {
    let task: Promise<T>;
    if (inFlight++ === 0) {
      try {
        task = Promise.resolve(fn());
      } catch (e) {
        inFlight -= 1;
        return Promise.reject(e);
      }
    } else task = ipcQ.then(fn);
    const tracked = task.finally(() => void (inFlight -= 1));
    ipcQ = tracked.then(noop, noop);
    return tracked;
  };

  const runAwc = async (act: AwcAction, tgt: WinState, fn?: () => unknown) => {
    if (isCrOS) switchTab('controls');
    const [myAct, myStat, prev] = [++actSeq, ++statSeq, winState];
    if (typeof fn !== 'function') {
      const s = `Last AWC action: ${act} · Skipped (API unavailable) · Resizable: ${onOff()}`;
      setStat(s);
      return L(`[awc] window.${act} skipped — API unavailable.`);
    }
    setTransition(tgt, false);
    syncMainMode();
    setStat(`AWC ${act}: invoking... · Resizable: ${onOff()}`);
    L(`[awc] Invoking window.${act} (prev state: ${prev})…`);
    try {
      await runIpc(fn);
      committedState = tgt;
      if (myAct === actSeq) {
        setTransition(tgt, false);
        syncMainMode();
        window.setTimeout(() => {
          if (myAct !== actSeq) return;
          if (act === 'maximize()') bumpPeak();
          syncMainMode();
        }, 120);
      }
      if (myStat === statSeq)
        setStat(`Last AWC action: ${act} · OK (${fmtTime()}) · ${tail()}`);
      const endSt = myAct === actSeq ? winState : committedState;
      logTrans(prev, `window.${act}`, endSt);
    } catch (err) {
      const msg = errStr(err);
      if (myAct === actSeq) {
        winState = committedState;
        if (committedState !== 'Minimized') preMinState = committedState;
        syncMainMode();
      }
      if (myStat === statSeq)
        setStat(`AWC ${act} notice: ${msg} · Resizable: ${onOff()}`);
      L(`[awc] window.${act} notice: ${msg}`);
    }
  };

  const setResizable = async (next: boolean) => {
    if (isCrOS) switchTab('controls');
    const [mySeq, myStat, fn] = [++resSeq, ++statSeq, window.setResizable];
    const tag = `setResizable(${next})`;
    if (typeof fn !== 'function') {
      syncResState(resizable);
      setStat(`Last AWC action: ${tag} · Skipped · Resizable: ${onOff()}`);
      return L(`[awc] window.${tag} skipped — API unavailable.`);
    }
    syncResState(next);
    setStat(`Last AWC action: ${tag} · applying...`);
    try {
      await runIpc(() => fn.call(window, next));
      committedRes = next;
      if (mySeq === resSeq) syncResState(next);
      const okSt = `Last AWC action: ${tag} · OK (${fmtTime()}) · ${tail(next)}`;
      if (myStat === statSeq) setStat(okSt);
      L(`[transition] Resizable=${onOff(next)} via window.${tag}`);
    } catch (err) {
      const msg = errStr(err);
      if (mySeq === resSeq) syncResState(committedRes);
      const errSt = `${tag} failed (${msg}) · Resizable: ${onOff(committedRes)}`;
      if (myStat === statSeq) setStat(errSt);
      L(`[awc] window.${tag} failed: ${msg}`);
    }
  };

  for (const [key, st] of AWC_SPECS) {
    const evt = `${key}d`;
    listen(window, evt, () => {
      const prev = winState;
      setTransition(st, true);
      syncMainMode();
      setStat(`OS window event: ${evt} (${fmtTime()}) · ${tail()}`);
      logTrans(prev, evt);
    });
  }

  const screensEl = tid(div('win-screens-drawer'), 'win-screens-list');
  const scrDims = () => [
    window.screen?.width || 1920,
    window.screen?.height || 1080,
    window.devicePixelRatio || 1,
  ];
  const fbSummary = () => {
    const [w, h, dpr] = scrDims();
    return `Detected Display: ${w}×${h} px (${dpr}x DPR)`;
  };
  const hudScrCls = 'win-unframed-desc mono tabular-nums';
  const hudScrP = el('p', hudScrCls, fbSummary());
  const hudScreensEl = isCrOS
    ? tid(hudScrP, 'win-unframed-screens-summary')
    : null;
  const renderFallback = (errSuffix?: string) => {
    const [w, h, dpr] = scrDims();
    if (hudScreensEl) hudScreensEl.textContent = fbSummary();
    const meta = `${w}x${h} px · ${dpr}x DPR${errSuffix ? ` (${errSuffix})` : ''}`;
    const fbLbl = 'Primary Display (window.screen fallback)';
    screensEl.replaceChildren(mkScreenChip(fbLbl, meta, true));
  };
  const renderScreens = (d: ScreenDetails) => {
    if (!d.screens.length) return renderFallback();
    clearChildren(screensEl);
    const parts = d.screens.map((s, i) => {
      const title = fmtScreenLabel(s.label, i, s.isInternal);
      const meta = `${s.width}x${s.height} px · ${s.devicePixelRatio}x DPR`;
      screensEl.appendChild(mkScreenChip(title, meta, s === d.currentScreen));
      return `${title} (${s.width}×${s.height} px · ${s.devicePixelRatio}x DPR)`;
    });
    const [joined, n] = [parts.join(' · '), d.screens.length];
    if (hudScreensEl)
      hudScreensEl.textContent = `Detected Displays (${n}): ${joined}`;
    L(`[screens] window.getScreenDetails() → ${n} display(s): ${joined}`);
  };
  const onScrChg = () => void (screenDetails && renderScreens(screenDetails));
  const scrEvts = ['screenschange', 'currentscreenchange'];
  const detachScreens = () => {
    if (screenDetails)
      for (const e of scrEvts) screenDetails.removeEventListener(e, onScrChg);
    screenDetails = null;
  };
  const inspectScreens = async (toControls = true) => {
    if (toControls && isCrOS) switchTab('controls');
    const [qSeq, [sw, sh, dpr]] = [++scrSeq, scrDims()];
    if (typeof window.getScreenDetails !== 'function') {
      detachScreens();
      renderFallback();
      if (toControls)
        L(
          `[screens] getScreenDetails() unavailable — fallback ${sw}×${sh} (${dpr}x).`,
        );
      return;
    }
    try {
      const d = await window.getScreenDetails();
      if (qSeq !== scrSeq) return;
      detachScreens();
      screenDetails = d;
      for (const e of scrEvts) d.addEventListener(e, onScrChg);
      renderScreens(d);
    } catch (err) {
      if (qSeq !== scrSeq) return;
      const msg = errStr(err);
      detachScreens();
      renderFallback(msg);
      L(`[screens] getScreenDetails() failed (${msg}) — fallback ${sw}×${sh}.`);
    }
  };

  const qCls = 'btn win-query-displays-btn';
  const queryBtn = btn('win-screen-details-btn', qCls, 'Query Displays');
  onClick(queryBtn, () => inspectScreens());
  window.addEventListener('pagehide', () => {
    window.clearInterval(pollTimer);
    for (const fn of cleanups) fn();
    detachScreens();
    unsubHud?.();
    hudBus?.close();
  });

  const geo = (l: string, v: HTMLElement) =>
    div('win-geo-item', span('win-geo-label', l), v);
  const gPos = geo('Screen Position:', posVal);
  const gSz = geo('Viewport Size:', sizeVal);
  const geoStats = div('win-geometry-stats', gPos, gSz, awcStatusEl);
  const geoBar = div('win-geometry-bar', geoStats, queryBtn);
  const awcGrid = div('win-awc-grid', ...actionBtns, resBtn);
  const mkPanel = (k: TabId, title: string, r: HTMLElement, body: Kids) => {
    const id = `win-panel-${k}`;
    const unf = k === 'unframed';
    const attrs = isCrOS
      ? {
          role: 'tabpanel',
          'aria-labelledby': `win-tab-${k}`,
          'aria-hidden': `${unf}`,
        }
      : undefined;
    const p = createCard({
      title,
      headerRight: r,
      id,
      testId: id,
      className: unf ? 'win-unframed-card is-hidden' : 'win-controls-card',
      headerClassName: 'win-card-header',
      bodyClassName: unf ? 'win-unframed-grid' : 'win-controls-body',
      attrs,
      body: body as HTMLElement[],
    }).root;
    if (unf) p.hidden = true;
    return p;
  };

  const ctrlTtl = 'Desktop Window Controls (Additional Windowing Controls API)';
  const ctrlBody = [awcBanner, awcGrid, geoBar, screensEl];
  const controlsPanel = mkPanel('controls', ctrlTtl, modeBadge.root, ctrlBody);
  let unframedPanel: HTMLElement | null = null;
  let tabsRoot: HTMLElement | null = null;

  if (isCrOS && hudBadge) {
    const arrow = span(null, '↗');
    arrow.setAttribute('aria-hidden', 'true');
    const uCls = 'btn win-unframed-btn';
    const sLbl = span(null, 'Open Unframed Window');
    const spawnBtn = btn(
      'win-spawn-hud-btn',
      `${uCls} btn-primary`,
      sLbl,
      arrow,
    );
    onClick(spawnBtn, spawnHud);
    closeHudBtn = btn('win-close-hud-btn', uCls, span(null, 'Close Window'));
    closeHudBtn.disabled = !isHudOpen();
    onClick(closeHudBtn, closeHud);

    const pDesc = (t: string) => el('p', 'win-unframed-desc', t);
    const h3 = el('h3', 'win-unframed-heading', UNF_H3);
    const copy = div(
      'win-unframed-copy',
      h3,
      pDesc(UNF_D1),
      pDesc(UNF_D2),
      hudScreensEl,
    );
    const uLeft = div(
      'win-unframed-left',
      copy,
      div('win-unframed-actions', spawnBtn, closeHudBtn),
    );
    const uTtl = 'Unframed Companion Window (display_override: ["unframed"])';
    unframedPanel = mkPanel('unframed', uTtl, hudBadge.root, [uLeft]);

    const setHide = (p: HTMLElement, hide: boolean) => {
      p.classList.toggle('is-hidden', hide);
      p.hidden = hide;
      p.setAttribute('aria-hidden', `${hide}`);
    };
    const mkTab = (id: TabId, label: string) => ({
      id,
      label,
      buttonId: `win-tab-${id}`,
      testId: `win-tab-${id}`,
      controlsId: `win-panel-${id}`,
    });
    const t1 = mkTab('controls', 'Window Controls');
    const t2 = mkTab('unframed', 'Unframed Window');
    const segTabs = createSegmentedTabs<TabId>({
      ariaLabel: 'Windowing View Mode',
      tabs: [t1, t2],
      initialTab: 'controls',
      onSelect: (t) => {
        setHide(controlsPanel, t !== 'controls');
        if (unframedPanel) setHide(unframedPanel, t === 'controls');
      },
    });
    tabsRoot = segTabs.root;
    switchTab = (t) => segTabs.setActive(t);
  }

  const hdr = createWorkspaceHeader({
    title: 'Windowing',
    subtitle: isCrOS ? SUB_CROS : SUB_DESK,
    className: 'win-header',
    right: tabsRoot,
  });
  const extra = unframedPanel ? [unframedPanel] : [];
  container.replaceChildren(hdr, controlsPanel, ...extra, log.root);
  void inspectScreens(false);
}

const isCrOSHost =
  typeof navigator !== 'undefined' && /\bCrOS\b/i.test(navigator.userAgent);
export const windowingHudWorkspace: WorkspaceDefinition = {
  id: 'windowing-hud',
  navLabel: 'Windowing',
  shortCode: 'Win',
  title: 'Windowing',
  subtitle: isCrOSHost ? SUB_CROS : SUB_DESK,
  mount: mountWindowingHud,
};
export const workspace = windowingHudWorkspace;
export default windowingHudWorkspace;

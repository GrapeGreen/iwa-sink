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
  createCopyIconButton,
  createLogConsole,
  createSegmentedTabs,
  createWorkspaceHeader,
  el,
  formatLogTime,
  svg,
} from '../../lib/dom';
import { SubAppBus, type SubAppBusMessage } from '../../lib/subapp-bus';
import type { ShellContext, WorkspaceDefinition } from '../../shell/contracts';

type WinState = 'Normal' | 'Maximized' | 'Minimized';
type StatusTone = 'ok' | 'amber' | 'muted';
type AwcKey = 'minimize' | 'maximize' | 'restore';
type AwcAction = `${AwcKey}()`;
type TabId = 'controls' | 'unframed';
type Shapes = Parameters<typeof svg>[0];
type Kids = Array<Node | string | null>;

interface PendingMinimize {
  sawOsMinimize: boolean;
  restored: boolean;
  releaseIpc: () => void;
}

interface NormalRect {
  w: number;
  h: number;
  x: number;
  y: number;
}

const HUD = '/hud.html';
const HUD_CLOSED_LOG = '[unframed] Companion window /hud.html closed.';
const DEFAULT_DISPLAYS_SUBTITLE =
  'Current display · query to detect all monitors';
const DECLINED_DISPLAYS_SUBTITLE =
  'Permission declined · showing current display';
const UNAVAIL_DISPLAYS_SUBTITLE =
  'Multi-display query unavailable · showing current display';
const AWC_FLAG_URL =
  'chrome://flags/#enable-desktop-pwas-additional-windowing-controls';
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
const MODE_LABELS: Record<string, string> = {
  standalone: 'Standalone',
  'window-controls-overlay': 'Window Controls Overlay',
  'minimal-ui': 'Minimal UI',
  fullscreen: 'Fullscreen',
  unframed: 'Unframed',
  browser: 'Browser tab',
};
const DISPLAY_STATES = [
  'minimized',
  'maximized',
  'fullscreen',
  'normal',
] as const;
const rect = (x: number, y: number, s: number) => ({
  tag: 'rect' as const,
  attrs: { x, y, width: s, height: s, rx: 2 },
});
const boxRect = (x: number, y: number, width: number, height: number) => ({
  tag: 'rect' as const,
  attrs: { x, y, width, height, rx: 2 },
});
const LAPTOP_ICON: Shapes = [boxRect(4, 5, 16, 11), 'M2 19h20'];
const MONITOR_ICON: Shapes = [boxRect(3, 4, 18, 12), 'M12 16v4', 'M8 20h8'];
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
const awcLabel = (act: AwcAction) =>
  act === 'minimize()'
    ? 'Minimize'
    : act === 'maximize()'
      ? 'Maximize'
      : 'Restore';
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
const mm = (m: string) =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.(`(display-mode: ${m})`).matches);
const mmState = (s: string) =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.(`(display-state: ${s})`).matches);
const CONTAINER_MODES = [
  'unframed',
  'window-controls-overlay',
  'standalone',
  'minimal-ui',
] as const;
const isFs = () => mm('fullscreen') || mmState('fullscreen');
const isMacHost = () =>
  typeof navigator !== 'undefined' &&
  /Mac/i.test(navigator.platform || navigator.userAgent || '');
function isMax(): boolean {
  if (isFs()) return true;
  const s = typeof window !== 'undefined' ? window.screen : null;
  if (isMacHost()) {
    if (!s || s.availWidth <= 0 || s.availHeight <= 0) return false;
    if (window.outerWidth > 0 && window.outerHeight > 0) {
      return (
        window.outerWidth >= s.availWidth && window.outerHeight >= s.availHeight
      );
    }
    return (
      window.innerWidth >= s.availWidth &&
      window.innerHeight >= s.availHeight - 160
    );
  }
  if (mmState('maximized')) {
    return !(s && s.availWidth > 0 && window.innerWidth < s.availWidth - 48);
  }
  if (!s || s.availWidth <= 0 || s.availHeight <= 0) return false;
  const [dw, dh] = [s.availWidth - 8, s.availHeight - 8];
  return window.outerWidth >= dw && window.outerHeight >= dh;
}

function detectRawMode(): string {
  if (mm('unframed')) return 'unframed';
  if (mm('window-controls-overlay')) return 'window-controls-overlay';
  if (mm('fullscreen')) return 'fullscreen';
  return (['standalone', 'minimal-ui'] as const).find(mm) ?? 'browser';
}

function formatScale(dpr: number): string {
  const v = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const n = Number.isInteger(v) ? `${v}` : `${Number(v.toFixed(2))}`;
  return `${n}× scale`;
}

function formatDisplaySpecs(w: number, h: number, dpr: number): string {
  return `${w} × ${h} px · ${formatScale(dpr)}`;
}

function fmtScreenLabel(raw: string | undefined, idx: number, int?: boolean) {
  const t = (raw ?? '').trim();
  const isHash = /^[A-Za-z0-9+/=_-]{28,}$/.test(t);
  const gen = !t || /^Display--?\d+$/i.test(t) || isHash;
  return gen ? `${int ? 'Built-in ' : ''}Display ${idx + 1}` : t;
}

function mkScreenRow(opts: {
  title: string;
  specs: string;
  isInternal: boolean;
  isCurrent: boolean;
  isPrimary?: boolean;
}) {
  const icon = svg(opts.isInternal ? LAPTOP_ICON : MONITOR_ICON, {
    size: 16,
    strokeWidth: 1.75,
    className: 'win-screen-icon',
  });
  const name = el('strong', 'win-screen-name', opts.title);
  const badge = opts.isCurrent
    ? span('win-screen-badge', 'Active')
    : opts.isPrimary
      ? span('win-screen-role', 'Primary')
      : null;
  const main = div('win-screen-main', icon, name, badge);
  const specsEl = span('win-screen-specs tabular-nums', opts.specs);
  return div(
    `win-screen-row${opts.isCurrent ? ' is-current' : ''}`,
    main,
    specsEl,
  );
}

function mkHudStatus() {
  const dot = span('win-status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const lbl = span('win-state-label', 'Closed');
  const root = tid(div('win-header-status', dot, lbl), 'hud-state-badge');
  const update = (tone: StatusTone, text: string) => {
    dot.dataset.tone = tone;
    lbl.textContent = text;
  };
  update('muted', 'Closed');
  return { root, update };
}

function buildAwcBanner(hidden: boolean) {
  const code = el('code', 'mono', AWC_FLAG_URL);
  const copyBtn = createCopyIconButton({
    getText: () => AWC_FLAG_URL,
    title: 'Copy flag URL',
    testId: 'win-awc-copy-flag-btn',
  });
  const copy = span(
    'win-awc-unavailable-copy',
    'Additional Windowing Controls are disabled. Navigate to ',
    code,
    copyBtn,
    ' and enable the feature, then restart Chrome.',
  );
  const b = tid(
    div('win-awc-unavailable-banner', copy),
    'win-awc-unavailable-banner',
  );
  b.id = 'win-awc-unavailable-banner';
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
  let permWatched = false;
  let [scrSeq, actSeq, resSeq, statSeq, inFlight, showStateOpen] = [
    0, 0, 0, 0, 0, 0,
  ];
  let [awcShowInFlight, interactiveScreenQuery] = [0, 0];
  let [resizable, committedRes] = [true, true];
  const bootMin = mmState('minimized');
  const bootMax = !bootMin && isMax();
  let winState: WinState = bootMin
    ? 'Minimized'
    : bootMax
      ? 'Maximized'
      : 'Normal';
  let preMinimizeState: WinState =
    winState === 'Minimized' ? 'Normal' : winState;
  let pendingMin: PendingMinimize | null = null;
  let [minimizedAt, awcCooldownUntil] = [bootMin ? performance.now() : 0, 0];
  let sawHiddenWhileMinimized =
    bootMin && typeof document !== 'undefined' && Boolean(document.hidden);
  let ipcQ: Promise<void> = Promise.resolve();
  let showStateQ: Promise<void> = Promise.resolve();

  const awcOk = () => AWC_KEYS.every((k) => typeof window[k] === 'function');
  const onOff = (v = resizable) => (v ? 'ON' : 'OFF');
  let lastContainerMode: string =
    CONTAINER_MODES.find(mm) ??
    (window.location.protocol === 'isolated-app:' ? 'standalone' : 'browser');
  const detectContainerMode = (): string => {
    const matched = CONTAINER_MODES.find(mm);
    if (matched) {
      lastContainerMode = matched;
      return matched;
    }
    if (mm('browser')) {
      lastContainerMode = 'browser';
      return 'browser';
    }
    return lastContainerMode;
  };
  const effectiveStateLabel = (): string =>
    winState !== 'Minimized' && isFs() ? 'Fullscreen' : winState;
  const setWs = (label: string) =>
    ctx.setWorkspaceStatus('windowing-hud', { state: 'online', label });
  const initContainerMode = detectContainerMode();
  const initRawMode = detectRawMode();
  setWs(initRawMode);

  const initLine = `[${formatLogTime()}] [init] Windowing ready — State: ${effectiveStateLabel()} · ${MODE_LABELS[initContainerMode] ?? initContainerMode} (${vpDims()} px), AWC=${awcOk() ? 'available' : 'unavailable'}, Resizable=${onOff()}.`;
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

  const statusDot = span('win-status-dot');
  statusDot.setAttribute('aria-hidden', 'true');
  const stateLabelEl = tid(
    span('win-state-label', effectiveStateLabel()),
    'win-awc-status',
  );
  const statusSepEl = span('win-status-sep', '·');
  statusSepEl.setAttribute('aria-hidden', 'true');
  const modeLabelEl = tid(
    span('win-mode-label', MODE_LABELS[initContainerMode] ?? 'Browser tab'),
    'win-display-mode',
  );
  const headerStatusEl = div(
    'win-header-status',
    statusDot,
    stateLabelEl,
    statusSepEl,
    modeLabelEl,
  );

  const hudBadge = isCrOS ? mkHudStatus() : null;
  let closeHudBtn: HTMLButtonElement | null = null;
  const isHudOpen = () => Boolean((hudRef && !hudRef.closed) || hudBusOn);
  const syncCloseBtn = (on: boolean) => {
    if (closeHudBtn) closeHudBtn.disabled = !on;
  };

  const posText = () => `${window.screenX ?? 0}, ${window.screenY ?? 0} px`;
  const vpText = () => `${vpDims()} px`;
  const geoKey = () =>
    `${window.innerWidth},${window.innerHeight},${window.screenX ?? 0},${window.screenY ?? 0}`;
  const gValCls = 'win-geo-val tabular-nums';
  const [posVal, sizeVal] = [span(gValCls, posText()), span(gValCls, vpText())];
  let [settledW, settledH] = [window.innerWidth, window.innerHeight];
  let [rafId, resizeTimer, restoreFbTimer] = [0, 0, 0];
  let [didSyncStaleZoom, syncingStaleZoom] = [false, false];
  let lastNormalRect: NormalRect | null = null;
  let lastGeo = geoKey();
  let [peakW, peakH] = [window.innerWidth, window.innerHeight];
  const resizeHooks = new Set<() => void>();
  const syncMaxDims = () => {
    [peakW, peakH] = [window.innerWidth, window.innerHeight];
  };
  const captureNormalRect = () => {
    if (!isMax() && window.outerWidth > 0 && window.outerHeight > 0) {
      lastNormalRect = {
        w: window.outerWidth,
        h: window.outerHeight,
        x: window.screenX ?? 0,
        y: window.screenY ?? 0,
      };
    }
  };
  const recordNormalRect = () => {
    if (winState === 'Normal') captureNormalRect();
  };
  recordNormalRect();

  const awcBanner = buildAwcBanner(awcOk());
  const awcNoticeEl = tid(span('win-awc-notice'), 'win-awc-notice');
  awcNoticeEl.hidden = true;
  const clearNotice = () => {
    awcNoticeEl.textContent = '';
    awcNoticeEl.hidden = true;
  };
  const showNotice = (msg: string) => {
    awcNoticeEl.textContent = msg;
    awcNoticeEl.hidden = false;
  };

  const applyWinState = (target: WinState) => {
    if (target === 'Minimized') {
      if (winState !== 'Minimized') preMinimizeState = winState;
      winState = 'Minimized';
      minimizedAt = performance.now();
    } else {
      winState = preMinimizeState = target;
      minimizedAt = 0;
      sawHiddenWhileMinimized = false;
      if (target === 'Maximized') {
        syncMaxDims();
        didSyncStaleZoom = false;
      } else {
        recordNormalRect();
      }
    }
  };

  const syncSettledViewport = () => {
    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
      resizeTimer = 0;
    }
    [settledW, settledH] = [window.innerWidth, window.innerHeight];
  };

  const waitForGeometrySettle = (): Promise<void> =>
    new Promise((resolve) => {
      let quietTimer = 0;
      let capTimer = 0;
      const done = () => {
        window.clearTimeout(quietTimer);
        window.clearTimeout(capTimer);
        resizeHooks.delete(onResize);
        resolve();
      };
      const onResize = () => {
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(done, 80);
      };
      resizeHooks.add(onResize);
      quietTimer = window.setTimeout(done, 80);
      capTimer = window.setTimeout(done, 220);
    });

  const screenWorkArea = () => {
    const s = window.screen as Screen & {
      availLeft?: number;
      availTop?: number;
    };
    return {
      aw: s?.availWidth || window.outerWidth || 1440,
      ah: s?.availHeight || window.outerHeight || 900,
      al: typeof s?.availLeft === 'number' ? s.availLeft : 0,
      at: typeof s?.availTop === 'number' ? s.availTop : 0,
    };
  };

  const computeMacRestoreRect = (): NormalRect => {
    const { aw, ah, al, at } = screenWorkArea();
    const useSaved =
      lastNormalRect !== null &&
      lastNormalRect.w > 0 &&
      lastNormalRect.h > 0 &&
      (lastNormalRect.w < aw || lastNormalRect.h < ah);
    const w = useSaved
      ? lastNormalRect!.w
      : Math.max(480, Math.round(aw * 0.8));
    const h = useSaved
      ? lastNormalRect!.h
      : Math.max(360, Math.round(ah * 0.82));
    const x = useSaved ? lastNormalRect!.x : al + Math.round((aw - w) / 2);
    const y = useSaved ? lastNormalRect!.y : at + Math.round((ah - h) / 2);
    return { w, h, x, y };
  };

  const waitForResizeTick = (
    prevOw: number,
    prevOh: number,
    capMs: number,
  ): Promise<void> => {
    if (
      prevOw > 0 &&
      prevOh > 0 &&
      (window.outerWidth !== prevOw || window.outerHeight !== prevOh)
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let capTimer = 0;
      const done = () => {
        window.clearTimeout(capTimer);
        resizeHooks.delete(onResize);
        resolve();
      };
      const onResize = () => {
        if (
          prevOw <= 0 ||
          prevOh <= 0 ||
          window.outerWidth !== prevOw ||
          window.outerHeight !== prevOh
        ) {
          done();
        }
      };
      resizeHooks.add(onResize);
      capTimer = window.setTimeout(done, capMs);
    });
  };

  const applyMacBounds = async (
    tw: number,
    th: number,
    tx: number,
    ty: number,
  ): Promise<void> => {
    const [prevOw, prevOh] = [window.outerWidth, window.outerHeight];
    safe(() => window.resizeTo(tw, th));
    if (tw !== prevOw || th !== prevOh) {
      await waitForResizeTick(prevOw, prevOh, 200);
    }
    safe(() => window.moveTo(tx, ty));
  };

  const isHeuristicSuppressed = () =>
    inFlight > 0 ||
    syncingStaleZoom ||
    performance.now() < awcCooldownUntil ||
    Boolean(pendingMin && !pendingMin.sawOsMinimize);

  const inferHeuristicState = (): 'Normal' | 'Maximized' =>
    isMax() ? 'Maximized' : 'Normal';

  const inferRestoredState = (): WinState => {
    if (isMax()) return 'Maximized';
    if (
      preMinimizeState === 'Maximized' &&
      peakW > 0 &&
      window.innerWidth >= peakW - 24
    ) {
      return 'Maximized';
    }
    return inferHeuristicState();
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

  const syncHeaderStatus = () => {
    const rawMode = detectRawMode();
    const containerMode = detectContainerMode();
    const busy = inFlight > 0 || Boolean(pendingMin && !pendingMin.restored);
    statusDot.dataset.tone = winState === 'Minimized' || busy ? 'amber' : 'ok';
    stateLabelEl.textContent = effectiveStateLabel();
    modeLabelEl.textContent = MODE_LABELS[containerMode] ?? 'Browser tab';
    return rawMode;
  };

  const syncAwcAvail = () => {
    const [ok, fs] = [awcOk(), isFs()];
    const ipcBusy = inFlight > 0;
    const busy = ipcBusy || Boolean(pendingMin && !pendingMin.restored);
    const resDis = !ok || ipcBusy;
    awcBanner.hidden = ok;
    const tip = ok ? '' : `Requires ${AWC_FLAG_URL}`;
    for (const b of [minBtn, maxBtn, restBtn, resBtn]) b.title = tip;
    minBtn.disabled = !ok || winState === 'Minimized' || busy;
    maxBtn.disabled =
      !ok || ipcBusy || !resizable || winState === 'Maximized' || fs;
    restBtn.disabled = !ok || ipcBusy || (winState === 'Normal' && !fs);
    resBtn.disabled = resDis;
    resBtn.classList.toggle('is-disabled', resDis);
    resBtn.setAttribute('aria-disabled', `${resDis}`);
    return syncHeaderStatus();
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
    const cm = detectContainerMode();
    L(
      `[transition] State changed: ${prev} -> ${st} · ${MODE_LABELS[cm] ?? cm} (${vpDims()} px) via ${via}`,
    );
  };

  const syncMainMode = () => {
    lastGeo = geoKey();
    posVal.textContent = posText();
    sizeVal.textContent = vpText();
    const rawMode = syncAwcAvail();
    setWs(isHudOpen() ? `${rawMode} · Companion` : rawMode);
  };

  const commitMinimized = (viaLabel = 'window.minimize()') => {
    const pm = pendingMin;
    if (pm) {
      pm.sawOsMinimize = true;
      pm.releaseIpc();
    }
    if (typeof document !== 'undefined' && document.hidden)
      sawHiddenWhileMinimized = true;
    minimizedAt = performance.now();
    awcCooldownUntil = performance.now() + 250;
    syncSettledViewport();
    if (winState === 'Minimized') return;
    const prev = winState;
    applyWinState('Minimized');
    if (!pm) ++statSeq;
    clearNotice();
    syncMainMode();
    logTrans(prev, viaLabel, 'Minimized');
  };

  const restoreFromMinimized = (explicitTarget?: 'Normal' | 'Maximized') => {
    if (winState !== 'Minimized' || awcShowInFlight > 0) return;
    if (pendingMin) {
      pendingMin.restored = true;
      pendingMin.releaseIpc();
      syncAwcAvail();
    }
    const prev = winState;
    const restored = explicitTarget ?? inferRestoredState();
    applyWinState(restored);
    awcCooldownUntil = performance.now() + 250;
    syncSettledViewport();
    ++actSeq;
    ++statSeq;
    clearNotice();
    syncMainMode();
    logTrans(prev, 'restore', restored);
  };

  const reconcileWin = (
    src: 'resize' | 'poll',
    prevW = settledW,
    prevH = settledH,
  ) => {
    if (isHeuristicSuppressed()) return;
    const vis = typeof document === 'undefined' || !document.hidden;
    if (winState === 'Minimized') {
      if (!vis) return;
      if (src === 'resize' || (src === 'poll' && sawHiddenWhileMinimized)) {
        restoreFromMinimized();
      }
      return;
    }
    if (src !== 'resize') return;
    const [iw, ih] = [window.innerWidth, window.innerHeight];
    if (winState === 'Maximized') {
      if (isMax()) {
        syncMaxDims();
      } else if (
        iw < peakW - 16 ||
        ih < peakH - 16 ||
        (isMacHost() && (iw < prevW || ih < prevH))
      ) {
        const prev = winState;
        applyWinState('Normal');
        ++statSeq;
        clearNotice();
        logTrans(prev, 'resize', 'Normal');
      }
    } else if (winState === 'Normal') {
      if ((iw > prevW || ih > prevH) && isMax()) {
        const prev = winState;
        applyWinState('Maximized');
        ++statSeq;
        clearNotice();
        logTrans(prev, 'resize', 'Maximized');
      }
    }
  };

  const markHudOpen = () => {
    hudMarkedOpen = true;
    syncCloseBtn(true);
    hudBadge?.update('ok', 'Open');
    syncMainMode();
  };
  const markHudClosed = (msg?: string) => {
    hudRef = null;
    hudMarkedOpen = false;
    clearHudBus();
    hudIds.clear();
    syncCloseBtn(false);
    hudBadge?.update('muted', 'Closed');
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

  const syncStaleMacZoom = async () => {
    const [ow, oh] = [window.outerWidth, window.outerHeight];
    if (ow <= 200 || oh <= 0 || syncingStaleZoom) return;
    syncingStaleZoom = true;
    try {
      safe(() => window.resizeTo(ow - 1, oh));
      await waitForResizeTick(ow, oh, 150);
      if (inFlight > 0 || winState !== 'Normal') return;
      const [midOw, midOh] = [window.outerWidth, window.outerHeight];
      safe(() => window.resizeTo(ow, oh));
      await waitForResizeTick(midOw, midOh, 150);
    } finally {
      if (inFlight === 0) {
        syncSettledViewport();
        recordNormalRect();
      }
      syncingStaleZoom = false;
      syncMainMode();
    }
  };

  const armResizeDebounce = () => {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      if (syncingStaleZoom) return;
      if (
        (typeof document !== 'undefined' && document.hidden) ||
        winState === 'Minimized'
      ) {
        syncSettledViewport();
        return;
      }
      if (inFlight > 0) {
        armResizeDebounce();
        return;
      }
      const [w, h] = [window.innerWidth, window.innerHeight];
      if (w === settledW && h === settledH) return;
      const [prevW, prevH] = [settledW, settledH];
      [settledW, settledH] = [w, h];
      reconcileHudClosed();
      if (!isHeuristicSuppressed()) reconcileWin('resize', prevW, prevH);
      recordNormalRect();
      syncMainMode();
      L(
        `[resize] Viewport resized: ${prevW} × ${prevH} px -> ${w} × ${h} px (State: ${winState})`,
      );
      if (
        !didSyncStaleZoom &&
        isMacHost() &&
        !isMax() &&
        mmState('maximized') &&
        resizable &&
        awcOk() &&
        detectRawMode() !== 'browser' &&
        window.outerWidth > 200 &&
        window.outerHeight > 0
      ) {
        didSyncStaleZoom = true;
        void syncStaleMacZoom();
      }
    }, 180);
  };

  listen(window, 'resize', () => {
    for (const fn of resizeHooks) fn();
    if (syncingStaleZoom) return;
    if (!rafId) {
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        syncMainMode();
      });
    }
    armResizeDebounce();
  });

  const onFocusWake = () => {
    reconcileHudClosed();
    const vis = typeof document === 'undefined' || !document.hidden;
    if (winState === 'Minimized' && vis) {
      if (sawHiddenWhileMinimized || performance.now() - minimizedAt > 250) {
        restoreFromMinimized();
      }
    }
    syncMainMode();
  };
  listen(window, 'focus', onFocusWake);
  listen(window, 'pageshow', onFocusWake);

  listen(document, 'visibilitychange', () => {
    reconcileHudClosed();
    if (document.hidden) {
      if (winState === 'Minimized') {
        sawHiddenWhileMinimized = true;
      } else if (pendingMin && !pendingMin.restored) {
        commitMinimized('window.minimize()');
      } else if (mmState('minimized')) {
        commitMinimized('display-state');
      } else if (detectRawMode() !== 'browser') {
        commitMinimized('visibilitychange');
      }
    } else if (winState === 'Minimized') {
      restoreFromMinimized();
    }
    syncMainMode();
  });

  const pollTimer = window.setInterval(() => {
    reconcileHudClosed();
    const prev = winState;
    reconcileWin('poll');
    if (prev !== winState || geoKey() !== lastGeo) {
      if (!isHeuristicSuppressed()) recordNormalRect();
      syncMainMode();
    }
  }, 350);

  if (typeof window.matchMedia === 'function') {
    for (const m of MODES) {
      const mql = window.matchMedia(`(display-mode: ${m})`);
      listen(mql, 'change', () => {
        syncMainMode();
        if (mql.matches) {
          const cm = detectContainerMode();
          L(
            `[display-mode] (${m}) → ${effectiveStateLabel()} · ${MODE_LABELS[cm] ?? cm} (${vpDims()} px)`,
          );
        }
      });
    }
    for (const ds of DISPLAY_STATES) {
      const mql = window.matchMedia(`(display-state: ${ds})`);
      listen(mql, 'change', () => {
        if (!mql.matches) return;
        if (ds === 'minimized') {
          commitMinimized(
            pendingMin && !pendingMin.restored
              ? 'window.minimize()'
              : 'display-state',
          );
          return;
        }
        const tgt: 'Normal' | 'Maximized' =
          ds === 'normal' ? 'Normal' : 'Maximized';
        if (winState === 'Minimized') {
          restoreFromMinimized(
            ds === 'maximized' && isMacHost() && !isMax() ? undefined : tgt,
          );
          return;
        }
        if (isHeuristicSuppressed() || winState === tgt) return;
        const seq = ++actSeq;
        void waitForGeometrySettle().then(() => {
          if (seq !== actSeq || !mql.matches || isHeuristicSuppressed()) return;
          if (ds === 'maximized' && isMacHost() && !isMax()) return;
          if (winState === tgt) return;
          const prev = winState;
          syncSettledViewport();
          applyWinState(tgt);
          awcCooldownUntil = performance.now() + 250;
          ++statSeq;
          clearNotice();
          syncMainMode();
          logTrans(prev, 'display-state', tgt);
        });
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
      hudBadge?.update('amber', 'Popup blocked');
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
    const prevFlight = inFlight++;
    syncAwcAvail();
    if (prevFlight === 0) {
      try {
        task = Promise.resolve(fn());
      } catch (e) {
        inFlight -= 1;
        syncAwcAvail();
        return Promise.reject(e);
      }
    } else task = ipcQ.then(fn);
    const tracked = task.finally(() => {
      inFlight -= 1;
      syncAwcAvail();
    });
    ipcQ = tracked.then(noop, noop);
    return tracked;
  };

  // Blink's WebFrameWidgetImpl shares one window_show_state_change_callback
  // across minimize/maximize/restore (distinct from setResizable), so native
  // show-state calls must wait for prior native promises even when heuristic
  // inFlight is released early upon OS minimize/restore.
  const runShowState = <T>(fn: () => Promise<T> | T): Promise<T> => {
    let raw: Promise<T>;
    if (showStateOpen++ === 0) {
      try {
        raw = Promise.resolve(fn());
      } catch (e) {
        showStateOpen -= 1;
        return Promise.reject(e);
      }
    } else raw = showStateQ.then(fn);
    const tracked = raw.finally(() => void (showStateOpen -= 1));
    showStateQ = tracked.then(noop, noop);
    return tracked;
  };

  // Chromium's BrowserView::GetWindowShowState() on macOS checks is_zoomed_
  // before is_miniaturized_, so minimizing a zoomed window can time out after
  // 5s even when macOS already minimized the window into the Dock.
  const runMinimize = async (fn: () => unknown) => {
    if (inFlight > 0 || (pendingMin && !pendingMin.restored)) return;
    const [myAct, myStat, prev] = [++actSeq, ++statSeq, winState];
    if (prev !== 'Minimized') preMinimizeState = prev;
    let releaseIpc = noop;
    const ipcGate = new Promise<void>((r) => {
      releaseIpc = r;
    });
    const myPending: PendingMinimize = {
      sawOsMinimize: false,
      restored: false,
      releaseIpc,
    };
    pendingMin = myPending;
    clearNotice();
    syncAwcAvail();
    L(`[awc] Invoking window.minimize() (prev state: ${prev})…`);
    await runIpc(() => {
      const raw = runShowState(() => (myPending.restored ? undefined : fn()));
      raw.then(
        () => {
          if (
            !myPending.sawOsMinimize &&
            !myPending.restored &&
            myAct === actSeq
          ) {
            commitMinimized('window.minimize()');
          } else if (myStat === statSeq) {
            clearNotice();
          }
          if (pendingMin === myPending) {
            pendingMin = null;
            syncAwcAvail();
          }
          releaseIpc();
        },
        (err) => {
          const wasOsMin = myPending.sawOsMinimize;
          if (pendingMin === myPending) {
            pendingMin = null;
            syncAwcAvail();
          }
          releaseIpc();
          if (wasOsMin) return;
          const msg = errStr(err);
          if (myAct === actSeq) syncMainMode();
          if (myStat === statSeq) showNotice('Minimize unavailable');
          L(`[awc] window.minimize() notice: ${msg}`);
        },
      );
      return ipcGate;
    });
  };

  const runAwc = async (act: AwcAction, tgt: WinState, fn?: () => unknown) => {
    if (isCrOS) switchTab('controls');
    if (typeof fn !== 'function') {
      ++statSeq;
      showNotice(`${awcLabel(act)} unavailable`);
      return L(`[awc] window.${act} skipped — API unavailable.`);
    }
    if (act === 'minimize()') return runMinimize(fn);
    if (inFlight > 0) return;
    if (pendingMin) {
      pendingMin.restored = true;
      pendingMin.releaseIpc();
      pendingMin = null;
      syncAwcAvail();
    }
    const [myAct, myStat, startState] = [++actSeq, ++statSeq, winState];
    clearNotice();
    L(`[awc] Invoking window.${act} (prev state: ${startState})…`);
    awcShowInFlight += 1;
    try {
      await runIpc(async () => {
        if (tgt === 'Maximized') recordNormalRect();
        await runShowState(async () => {
          const armMacRestoreFb =
            tgt === 'Normal' &&
            winState === 'Maximized' &&
            isMacHost() &&
            resizable &&
            detectRawMode() !== 'browser';
          const [startOw, startOh] = [window.outerWidth, window.outerHeight];
          let settled = false;
          let didFallback = false;
          let fbPromise: Promise<void> | null = null;
          if (restoreFbTimer) {
            window.clearTimeout(restoreFbTimer);
            restoreFbTimer = 0;
          }
          if (armMacRestoreFb) {
            restoreFbTimer = window.setTimeout(() => {
              restoreFbTimer = 0;
              if (settled || !isMax()) return;
              if (
                startOw > 0 &&
                startOh > 0 &&
                (window.outerWidth !== startOw ||
                  window.outerHeight !== startOh)
              ) {
                return;
              }
              didFallback = true;
              const r = computeMacRestoreRect();
              fbPromise = applyMacBounds(r.w, r.h, r.x, r.y);
            }, 450);
          }
          try {
            await fn();
          } finally {
            settled = true;
            if (restoreFbTimer) {
              window.clearTimeout(restoreFbTimer);
              restoreFbTimer = 0;
            }
          }
          const pendingFb = fbPromise as Promise<void> | null;
          if (pendingFb) {
            await pendingFb;
          } else if (armMacRestoreFb && !didFallback && isMax()) {
            const r = computeMacRestoreRect();
            await applyMacBounds(r.w, r.h, r.x, r.y);
          }
        });
        await waitForGeometrySettle();
        if (
          tgt === 'Maximized' &&
          isMacHost() &&
          resizable &&
          detectRawMode() !== 'browser' &&
          !isMax()
        ) {
          captureNormalRect();
          const { aw, ah, al, at } = screenWorkArea();
          if (aw > 0 && ah > 0) {
            await applyMacBounds(aw, ah, al, at);
            await waitForGeometrySettle();
          }
        }
        awcCooldownUntil = performance.now() + 250;
        syncSettledViewport();
        if (myAct === actSeq) {
          const curPrev = winState;
          applyWinState(tgt);
          syncMainMode();
          if (myStat === statSeq) clearNotice();
          if (curPrev !== tgt) logTrans(curPrev, `window.${act}`, tgt);
        } else if (myStat === statSeq) {
          clearNotice();
        }
      });
    } catch (err) {
      awcCooldownUntil = performance.now() + 250;
      const msg = errStr(err);
      if (myAct === actSeq) syncMainMode();
      if (myStat === statSeq) showNotice(`${awcLabel(act)} unavailable`);
      L(`[awc] window.${act} notice: ${msg}`);
    } finally {
      awcShowInFlight -= 1;
    }
  };

  const setResizable = async (next: boolean) => {
    if (isCrOS) switchTab('controls');
    if (inFlight > 0) return;
    const [mySeq, myStat, fn] = [++resSeq, ++statSeq, window.setResizable];
    const tag = `setResizable(${next})`;
    if (typeof fn !== 'function') {
      syncResState(resizable);
      showNotice('Resize lock unavailable');
      return L(`[awc] window.${tag} skipped — API unavailable.`);
    }
    clearNotice();
    syncResState(next);
    try {
      await runIpc(async () => {
        await fn.call(window, next);
        committedRes = next;
        if (mySeq === resSeq) syncResState(next);
        if (myStat === statSeq) clearNotice();
        L(`[transition] Resizable=${onOff(next)} via window.${tag}`);
      });
    } catch (err) {
      const msg = errStr(err);
      if (mySeq === resSeq) syncResState(committedRes);
      if (myStat === statSeq) showNotice('Resize lock unavailable');
      L(`[awc] window.${tag} failed: ${msg}`);
    }
  };

  const displaysSubtitleEl = tid(
    span('win-displays-subtitle', DEFAULT_DISPLAYS_SUBTITLE),
    'win-displays-subtitle',
  );
  const screensEl = tid(div('win-screens-list'), 'win-screens-list');
  const scrDims = () => [
    window.screen?.width || 1920,
    window.screen?.height || 1080,
    window.devicePixelRatio || 1,
  ];
  const fbSummary = () => {
    const [w, h, dpr] = scrDims();
    return `Detected Display: ${formatDisplaySpecs(w, h, dpr)}`;
  };
  const hudScrCls = 'win-unframed-desc tabular-nums';
  const hudScrP = el('p', hudScrCls, fbSummary());
  const hudScreensEl = isCrOS
    ? tid(hudScrP, 'win-unframed-screens-summary')
    : null;
  const renderFallback = (subtitleText = DEFAULT_DISPLAYS_SUBTITLE) => {
    const [w, h, dpr] = scrDims();
    const specs = formatDisplaySpecs(w, h, dpr);
    if (hudScreensEl) hudScreensEl.textContent = fbSummary();
    displaysSubtitleEl.textContent = subtitleText;
    screensEl.replaceChildren(
      mkScreenRow({
        title: 'Current Display',
        specs,
        isInternal: false,
        isCurrent: true,
      }),
    );
  };
  const renderScreens = (d: ScreenDetails) => {
    if (!d.screens.length) return renderFallback();
    clearChildren(screensEl);
    const n = d.screens.length;
    displaysSubtitleEl.textContent = n === 1 ? '1 display' : `${n} displays`;
    const parts = d.screens.map((s, i) => {
      const title = fmtScreenLabel(s.label, i, s.isInternal);
      const specs = formatDisplaySpecs(s.width, s.height, s.devicePixelRatio);
      const isCurrent = s === d.currentScreen || (!d.currentScreen && i === 0);
      screensEl.appendChild(
        mkScreenRow({
          title,
          specs,
          isInternal: Boolean(s.isInternal),
          isCurrent,
          isPrimary: Boolean(s.isPrimary),
        }),
      );
      return `${title} (${specs})`;
    });
    const joined = parts.join(' · ');
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
  const inspectScreens = async (userInitiated = true) => {
    if (userInitiated) interactiveScreenQuery += 1;
    try {
      if (userInitiated && isCrOS) switchTab('controls');
      const [qSeq, [sw, sh, dpr]] = [++scrSeq, scrDims()];
      if (typeof window.getScreenDetails !== 'function') {
        detachScreens();
        renderFallback(
          userInitiated ? UNAVAIL_DISPLAYS_SUBTITLE : DEFAULT_DISPLAYS_SUBTITLE,
        );
        if (userInitiated) {
          L(
            `[screens] getScreenDetails() unavailable — fallback ${sw}×${sh} (${formatScale(dpr)}).`,
          );
        }
        return;
      }
      if (!userInitiated) {
        if (typeof navigator.permissions?.query !== 'function') {
          if (!screenDetails) renderFallback();
          return;
        }
        let perm: PermissionStatus | null = null;
        try {
          perm = await navigator.permissions.query({
            name: 'window-management' as PermissionName,
          });
        } catch {
          if (qSeq === scrSeq && !screenDetails) renderFallback();
          return;
        }
        if (perm && !permWatched) {
          permWatched = true;
          listen(perm, 'change', () => {
            if (interactiveScreenQuery > 0) return;
            void inspectScreens(false);
          });
        }
        if (qSeq !== scrSeq) return;
        if (perm?.state !== 'granted') {
          if (screenDetails) detachScreens();
          renderFallback(
            perm?.state === 'denied'
              ? DECLINED_DISPLAYS_SUBTITLE
              : DEFAULT_DISPLAYS_SUBTITLE,
          );
          return;
        }
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
        detachScreens();
        if (!userInitiated) {
          renderFallback();
          return;
        }
        const msg = errStr(err);
        const errTag = `${(err as { name?: string })?.name ?? ''} ${msg}`;
        const isPerm = /NotAllowedError|denied|permission/i.test(errTag);
        renderFallback(
          isPerm ? DECLINED_DISPLAYS_SUBTITLE : UNAVAIL_DISPLAYS_SUBTITLE,
        );
        L(
          `[screens] getScreenDetails() failed (${msg}) — fallback ${sw}×${sh}.`,
        );
      }
    } finally {
      if (userInitiated) interactiveScreenQuery -= 1;
    }
  };

  const qCls = 'btn win-query-displays-btn';
  const queryBtn = btn('win-screen-details-btn', qCls, 'Query Displays');
  onClick(queryBtn, () => inspectScreens(true));
  window.addEventListener('pagehide', () => {
    window.clearInterval(pollTimer);
    if (rafId) window.cancelAnimationFrame(rafId);
    if (resizeTimer) window.clearTimeout(resizeTimer);
    if (restoreFbTimer) window.clearTimeout(restoreFbTimer);
    resizeHooks.clear();
    for (const fn of cleanups) fn();
    detachScreens();
    unsubHud?.();
    hudBus?.close();
  });

  const geo = (l: string, v: HTMLElement) =>
    div('win-geo-item', span('win-geo-label', l), v);
  const gPos = geo('Position', posVal);
  const gSz = geo('Viewport', sizeVal);
  const geoStats = div('win-geometry-stats', gPos, gSz);
  const geoBar = div('win-geometry-bar', geoStats, awcNoticeEl);
  const displaysSepEl = span('win-displays-sep', '·');
  displaysSepEl.setAttribute('aria-hidden', 'true');
  const displaysHeading = div(
    'win-displays-heading',
    el('h3', 'win-displays-title', 'Connected Displays'),
    displaysSepEl,
    displaysSubtitleEl,
  );
  const displaysHeader = div('win-displays-header', displaysHeading, queryBtn);
  const displaysSection = div(
    'win-displays-section',
    displaysHeader,
    screensEl,
  );
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

  const ctrlTtl = 'Desktop Window Controls';
  const ctrlBody = [awcBanner, awcGrid, geoBar, displaysSection];
  const controlsPanel = mkPanel('controls', ctrlTtl, headerStatusEl, ctrlBody);
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
  renderFallback();
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

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

import type { ShellContext, WorkspaceDefinition } from '../../shell/contracts';
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
  type SvgShapeSpec,
} from '../../lib/dom';
import {
  extractFileExtensionsFromHandlers as getFileExts,
  getDynamicSubAppPaths,
  normalizeDynamicSubAppSpec,
  sanitizeSubAppSlug,
} from '../../lib/dynamic-subapp-spec';
import { generateBadgePng512Sync, pngBytesToDataUrl } from '../../lib/png512';
import { SUBAPP_BUS_CHANNEL, SubAppBus } from '../../lib/subapp-bus';
import {
  BUNDLED_SUBAPPS_CATALOG,
  clearDynamicSpecsEverywhere,
  getKnownDynamicSpec,
  registerDynamicSpecEverywhere,
  sanitizeBadgeGlyphText,
  SubAppsAdapter,
  syncKnownDynamicSpecsFromBackend,
  toRootRelativePath,
  unregisterDynamicSpecEverywhere,
  type BundledSubAppCatalogEntry,
  type InstalledSubAppItem,
} from './subapps-adapter';

const ACCENTS = [
  ['Emerald', '#10b981', 'emerald'],
  ['Cobalt', '#6366f1', 'indigo'],
  ['Amber', '#f59e0b', 'amber'],
  ['Rose', '#e11d48', 'rose'],
] as const;

const dUrl = (s: string, q = '') => `/dynamic/${s}/index.html${q}`;
const pUrl = (s: string) => dUrl(s, '?protocol=%s');
const TXT_EXTS = { 'text/plain': ['.log', '.txt'] };
const POL_DEF = { 'direct-sockets': ['self'], 'controlled-frame': ['self'] };
const PRESETS: ReadonlyArray<[string, (s: string) => unknown]> = [
  ['protocol_handlers', (s) => [{ protocol: 'logviewer', url: pUrl(s) }]],
  ['file_handlers', (s) => [{ action: dUrl(s), accept: TXT_EXTS }]],
  ['display', () => 'standalone'],
  ['display_override', () => ['window-controls-overlay', 'standalone']],
  ['launch_handler', () => ({ client_mode: 'focus-existing' })],
  ['permissions_policy', () => POL_DEF],
  ['shortcuts', (s) => [{ name: 'Quick Open', url: dUrl(s, '?quick=1') }]],
];
const CUSTOM_KEY = '__custom__';
const [STALE_MS, FLASH_MS, SUPPRESS_MS] = [8000, 1800, 1500];
const [TOMB_MS, GRACE_MS] = [5000, 180];

type N = number;
type TabId = 'bundled' | 'builder';
type Rec = Record<string, unknown>;
type Shapes = Array<string | SvgShapeSpec>;
type Pred = (p: HTMLElement) => boolean;
type AppRef = { id: string; scope: string };
type BusEntry = AppRef & { appId: string; title: string; ts: N };
type WinCore = AppRef & { path: string; name: string };
type WinHandle = WinCore & { win: WindowProxy; inst?: string };
type RowCheck = { ok: boolean; key: string; value?: unknown; error?: string };
type FieldFn = { validate: () => RowCheck; focusErr: () => void };
type FieldState = {
  err: string;
  key: () => string;
  syncSlug: (s: string) => void;
};
type FieldRow = FieldFn & FieldState;
type S = string;
type RowMeta = [S, S, S, S, S | null];
type PanelIn = [TabId, S, S, HTMLElement, HTMLElement?];
type SubAppsHost = HTMLElement & { __subAppsCleanup?: () => void };

const sa = (n: Element, k: string, v: string) => n.setAttribute(k, v);
function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
const div = (c: string | null, ...ch: Array<Node | string | null>) =>
  el('div', c, ...ch);
const spn = (c: string | null, t?: string) => el('span', c, t ?? null);
const setHide = (n: HTMLElement, h: boolean) => {
  n.classList.toggle('is-hidden', h);
  n.hidden = h;
};
const safe = (fn: () => void) => {
  try {
    fn();
  } catch {}
};
const ttlHit = (m: Map<string, N>, k: string) => {
  const u = m.get(k);
  return u !== undefined && (Date.now() < u ? true : (m.delete(k), false));
};
const clearTimers = (m: Map<string, ReturnType<typeof setTimeout>>) => {
  for (const t of m.values()) clearTimeout(t);
  m.clear();
};
const isNonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && Boolean(v.trim());

function mkBtn(cls: string, id: string, lbl: string, onClick: () => void) {
  const b = el('button', cls, spn(null, lbl));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return tid(b, id);
}

function mkInput(cls: string, id: string, val: string, ph: string, a?: string) {
  const i = el('input', cls);
  i.type = 'text';
  i.value = i.defaultValue = val;
  i.placeholder = ph;
  i.autocomplete = 'off';
  if (a) sa(i, 'aria-label', a);
  return tid(i, id);
}

const mkField = (lbl: string, ctrl: HTMLElement) =>
  el('label', 'form-field', spn('form-label', lbl), ctrl);

function prepImg(img: HTMLImageElement, sz: N, alt: string, src?: string) {
  img.alt = alt;
  img.width = img.height = sz;
  img.loading = 'eager';
  img.decoding = 'sync';
  if (src) {
    img.src = src;
    void img.decode?.().catch(() => undefined);
  }
  return img;
}

const FILL = { fill: 'currentColor', 'fill-opacity': '0.16' };
const boxSpec = (x: N, y: N, w: N, h: N, rx: N): SvgShapeSpec => ({
  tag: 'rect',
  attrs: { x, y, width: w, height: h, rx, ...FILL },
});

function circleIcon(tone: 'indigo' | 'amber', s: Shapes, id?: string) {
  const ic = svg(s, { size: 26, className: 'subapp-circle-svg' });
  const d = div(`subapp-circle-icon subapp-circle-${tone}`, ic);
  sa(d, 'aria-hidden', 'true');
  return id ? tid(d, id) : d;
}

const BUNDLED_SHAPES: Shapes = [
  boxSpec(3, 4, 18, 16, 4),
  'M7.5 9.5L10.5 12L7.5 14.5',
  'M12.5 14.5H16.5',
];
const createBundledIcon = () => circleIcon('indigo', BUNDLED_SHAPES);

function createDynamicRowIcon(item: InstalledSubAppItem): HTMLElement {
  const s = item.slug ? getKnownDynamicSpec(item.slug) : undefined;
  const fb = sanitizeBadgeGlyphText('', item.appName || item.slug || 'APP');
  const badgeText = s?.badgeText ?? item.badgeText ?? fb;
  const accentColor = s?.accentColor ?? item.accentColor ?? ACCENTS[0][1];
  try {
    const png = generateBadgePng512Sync({ badgeText, accentColor });
    const src = pngBytesToDataUrl(png);
    if (src) {
      const elImg = el('img', 'subapp-row-icon-img');
      prepImg(elImg, 56, `${item.appName} badge icon`, src);
      return tid(elImg, 'subapp-row-icon');
    }
  } catch {}
  const amb = [boxSpec(3.5, 3.5, 17, 17, 4.5), 'M8.5 12h7', 'M12 8.5v7'];
  return circleIcon('amber', amb, 'subapp-row-icon');
}

const defScope = (p: string) =>
  p.endsWith('/index.html') ? p.slice(0, -10) : p;
const rwScopeStr = (s: string, slug: string) =>
  s.replace(/\/dynamic\/[^/"'\s]+\//gi, `/dynamic/${slug}/`);
const rwScopeVal = (v: unknown, slug: string): unknown => {
  if (typeof v === 'string') return rwScopeStr(v, slug);
  if (Array.isArray(v)) return v.map((x) => rwScopeVal(x, slug));
  if (v && typeof v === 'object') {
    const pairs = Object.entries(v as Rec);
    return Object.fromEntries(pairs.map(([k, x]) => [k, rwScopeVal(x, slug)]));
  }
  return v;
};

function getClientMode(item: InstalledSubAppItem): string {
  const s = item.slug ? getKnownDynamicSpec(item.slug) : undefined;
  const ov = s?.customManifestFields ?? item.customManifestFields;
  const lh = ov?.launch_handler;
  if (lh && typeof lh === 'object' && !Array.isArray(lh)) {
    const cm = (lh as Rec).client_mode;
    if (isNonEmpty(cm)) return cm.trim().toLowerCase();
    if (Array.isArray(cm)) {
      const f = cm.find(isNonEmpty);
      if (f) return f.trim().toLowerCase();
    }
  }
  return 'focus-existing';
}

function dynSig(item: InstalledSubAppItem): string {
  const s = item.slug ? getKnownDynamicSpec(item.slug) : undefined;
  const fb = sanitizeBadgeGlyphText('', item.appName || item.slug || 'APP');
  const b = s?.badgeText ?? item.badgeText ?? fb;
  return `${item.appName}|${b}|${s?.accentColor ?? item.accentColor ?? ACCENTS[0][1]}`;
}

function mountSubApps(container: HTMLElement, ctx: ShellContext): void {
  const hostEl = container as SubAppsHost;
  hostEl.__subAppsCleanup?.();

  const adapter = new SubAppsAdapter();
  const bus = new SubAppBus(SUBAPP_BUS_CHANNEL);
  const abort = new AbortController();

  let installedItems: InstalledSubAppItem[] = [];
  let [pongCount, slugEdited] = [0, false];
  let selectedAccent: string = ACCENTS[0][1];

  const handles: WinHandle[] = [];
  const busMap = new Map<string, BusEntry>();
  const numMap = () => new Map<string, N>();
  const [tombs, flashUntil, suppressing] = [numMap(), numMap(), numMap()];
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const byPath = new Map<string, InstalledSubAppItem>();

  const postClose = (appId: string, scope: string, instId?: string) => {
    const m = { type: 'CLOSE_SUBAPP' as const, appId, scope, ts: Date.now() };
    bus.post({ ...m, targetInstanceId: instId });
  };
  const cancelClose = (id: string) => {
    clearTimeout(closeTimers.get(id));
    closeTimers.delete(id);
  };
  const tomb = (id: string) => {
    cancelClose(id);
    tombs.set(id, Date.now() + TOMB_MS);
  };
  const isSuppressed = (cleanId: string) =>
    handles.some((h) => h.path === cleanId && h.win && !h.win.closed)
      ? (suppressing.delete(cleanId), false)
      : ttlHit(suppressing, cleanId);

  const addSuppressed = async (urls: readonly string[]) => {
    const norms = urls.map(toRootRelativePath);
    for (const n of norms) suppressing.set(n, Number.POSITIVE_INFINITY);
    try {
      return await adapter.add(urls);
    } finally {
      const until = Date.now() + SUPPRESS_MS;
      for (const n of norms)
        if (suppressing.get(n) === Number.POSITIVE_INFINITY)
          suppressing.set(n, until);
    }
  };

  let opChain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    const next = opChain.then(task, task);
    opChain = next.catch(() => undefined);
    return next;
  };

  const setStatus = (n: N) => {
    const ok = adapter.getProvider().available;
    const state = ok ? (n > 0 ? 'online' : 'probing') : 'portal';
    const label = ok ? `${n} installed` : 'API unavailable';
    ctx.setWorkspaceStatus('sub-apps', { state, label });
  };
  setStatus(0);

  const boot = `[${formatLogTime()}] SubAppBus listening on BroadcastChannel("${SUBAPP_BUS_CHANNEL}")`;
  const logConsole = createLogConsole({
    title: 'Sub-Apps Console Log',
    logTestId: 'subapps-bus-log',
    clearBtnTestId: 'subapps-clear-log-btn',
    toggleTestId: 'subapps-toggle-console-btn',
    cardTestId: 'subapps-console-card',
    cardClassName: 'sso-log-card',
    initialExpanded: false,
    maxLines: 100,
    initialLines: [boot],
  });
  const log = (msg: string) => logConsole.append(msg);

  const pruneWindows = () => {
    let changed = false;
    for (let i = handles.length - 1; i >= 0; i--) {
      const h = handles[i];
      if (!h.win || h.win.closed) {
        if (h.inst) busMap.delete(h.inst);
        handles.splice(i, 1);
        changed = true;
      }
    }
    const now = Date.now();
    for (const [id, e] of busMap) {
      const live = handles.some((h) => h.inst === id && h.win && !h.win.closed);
      if (!live && now - e.ts > STALE_MS) {
        busMap.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  const metaFor = (p: string, fbScope?: string, fbTitle?: string) => {
    const inst = installedItems.find((i) => i.installPath === p);
    const cat = BUNDLED_SUBAPPS_CATALOG.find((c) => c.startUrl === p);
    const scope = inst?.scope ?? cat?.scope ?? fbScope ?? defScope(p);
    return { scope, appName: inst?.appName ?? cat?.name ?? fbTitle ?? p };
  };

  const openSummary = () => {
    pruneWindows();
    const mk = (id: S, p: S, s?: S, t?: S) => ({
      instanceId: id,
      installPath: p,
      ...metaFor(p, s, t),
    });
    const out = [...busMap].map(([id, e]) => mk(id, e.appId, e.scope, e.title));
    for (const h of handles) {
      const hasBus = [...busMap.values()].some((b) => b.appId === h.path);
      if (!h.win.closed && (!h.inst || !busMap.has(h.inst)) && !hasBus)
        out.push(mk(h.id, h.path, h.scope, h.name));
    }
    return out;
  };

  const isOpen = (raw: string, sc?: string) => {
    const p = toRootRelativePath(raw);
    return openSummary().some(
      (e) => e.installPath === p || Boolean(sc && e.scope === sc),
    );
  };

  const listEl = tid(div('subapps-rows-list'), 'subapps-installed-list');
  const pill = createStatusPill('online', '', 'subapps-open-windows-count');
  const WL_ID = 'subapps-open-windows-list';
  const winListEl = tid(div(WL_ID), WL_ID);

  const evictHandles = (pred: (h: WinHandle) => boolean) => {
    let any = false;
    for (let i = handles.length - 1; i >= 0; i--) {
      const h = handles[i];
      if (!pred(h)) continue;
      if (h.inst) tomb(h.inst);
      tomb(h.id);
      handles.splice(i, 1);
      any = true;
      safe(() => h.win.close());
    }
    return any;
  };

  const closeInst = (id: string, raw: string, sc?: string, nm?: string) => {
    const p = toRootRelativePath(raw);
    tomb(id);
    postClose(p, sc ?? defScope(p), id);
    busMap.delete(id);
    evictHandles((h) => h.inst === id || h.id === id);
    log(`Closed sub-app window "${nm ?? p}" (${p}, instance=${id})`);
    renderAll();
  };

  const closePath = (raw: string, sc?: string, nm?: string, silent = false) => {
    const p = toRootRelativePath(raw);
    const s = sc ?? defScope(p);
    let any = false;
    for (const [id, e] of busMap)
      if (e.appId === p || Boolean(s && e.scope === s)) {
        tomb(id);
        busMap.delete(id);
        any = true;
      }
    if (evictHandles((h) => h.path === p || Boolean(s && h.scope === s)))
      any = true;
    if (any || !silent) {
      postClose(p, s);
      log(`Closed sub-app window "${nm ?? p}" (${p})`);
    }
    renderAll();
  };

  const closeAll = () => {
    const seen = new Set<string>();
    for (const e of openSummary())
      if (!seen.has(e.installPath)) {
        seen.add(e.installPath);
        closePath(e.installPath, e.scope, e.appName, false);
      }
    for (const [id, e] of busMap) {
      tomb(id);
      if (!seen.has(e.appId)) {
        seen.add(e.appId);
        postClose(e.appId, e.scope);
      }
    }
    busMap.clear();
    evictHandles(() => true);
    renderAll();
  };

  const tTitle = spn('subapps-ipc-title', 'Active Sub-App Windows');
  const tGrp = div('subapps-tracker-title-group', tTitle, pill.root);
  const tHdr = div('subapps-tracker-header', tGrp);
  const T_SEC = 'subapps-window-tracker is-hidden';
  const trackerEl = el('section', T_SEC, tHdr, winListEl);
  tid(trackerEl, 'subapps-window-tracker');
  trackerEl.hidden = true;
  sa(trackerEl, 'aria-label', 'Active Sub-App Windows');

  const TR_CLS = 'btn btn-subtle btn-sm subapp-tracker-close-btn';
  const TR_BTN_ID = 'subapp-tracker-close-btn';
  const TI = 'subapps-tracker-item';
  const renderTracker = () => {
    const list = openSummary();
    setHide(trackerEl, !list.length);
    if (!list.length) {
      clearChildren(winListEl);
      return pill.update('probing', '');
    }
    const n = list.length;
    pill.update('online', n === 1 ? '1 Window Open' : `${n} Windows Open`);
    const [totals, seen] = [numMap(), numMap()];
    for (const i of list)
      totals.set(i.installPath, (totals.get(i.installPath) ?? 0) + 1);
    const prev = new Map<string, HTMLElement>();
    const qTi = `[data-testid="${TI}"]`;
    for (const elItem of winListEl.querySelectorAll<HTMLElement>(qTi)) {
      const k = elItem.getAttribute('data-instance-id') ?? '';
      if (k) prev.set(k, elItem);
    }
    list.forEach((e, idx) => {
      const { instanceId: iid, installPath: p, scope, appName } = e;
      const seq = (seen.get(p) ?? 0) + 1;
      seen.set(p, seq);
      const title = (totals.get(p) ?? 1) > 1 ? `${appName} #${seq}` : appName;
      let row = prev.get(iid);
      if (row) {
        prev.delete(iid);
        sa(row, 'data-subapp-id', p);
        const nEl = row.querySelector('.subapps-tracker-name');
        if (nEl && nEl.textContent !== title) nEl.textContent = title;
        const sEl = row.querySelector('.subapp-scope-chip');
        if (sEl && sEl.textContent !== p) sEl.textContent = p;
      } else {
        const dot = spn('subapps-tracker-dot');
        sa(dot, 'aria-hidden', 'true');
        const chip = spn('subapp-scope-chip mono tabular-nums', p);
        const nmEl = spn('subapps-tracker-name', title);
        const info = div('subapps-tracker-item-info', dot, nmEl, chip);
        const fn = () => closeInst(iid, p, scope, appName);
        const cBtn = mkBtn(TR_CLS, TR_BTN_ID, 'Close Window', fn);
        row = tid(div(TI, info, cBtn), TI);
        for (const node of [cBtn, row]) {
          sa(node, 'data-subapp-id', p);
          sa(node, 'data-instance-id', iid);
        }
      }
      const cur = winListEl.children[idx] ?? null;
      if (cur !== row) winListEl.insertBefore(row, cur);
    });
    for (const stale of prev.values()) stale.remove();
  };

  const launchSubApp = (item: InstalledSubAppItem) => {
    const p = toRootRelativePath(item.installPath);
    const sc = item.scope;
    const pair = `"${item.appName}" -> ${item.installPath}`;
    suppressing.delete(p);
    const mode = getClientMode(item);
    if (mode !== 'navigate-new' && isOpen(p, sc)) {
      for (const h of handles) {
        const hit = h.path === p || Boolean(sc && h.scope === sc);
        if (!h.win.closed && hit) safe(() => h.win.focus());
      }
      bus.post({ type: 'FOCUS_SUBAPP', appId: p, scope: sc, ts: Date.now() });
      log(`Focused existing sub-app window ${pair}`);
      return renderAll();
    }
    const slugWin = `iwa_subapp_${p.replace(/[^a-z0-9]/gi, '_')}`;
    const tgt = mode === 'navigate-new' ? '_blank' : slugWin;
    const win = window.open(item.installPath, tgt);
    if (win && !handles.some((e) => e.win === win)) {
      const rnd = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const wid = `${item.installPath}#win-${rnd}`;
      const h = { id: wid, path: item.installPath, scope: sc };
      handles.push({ ...h, name: item.appName, win });
    }
    log(`Launched sub-app ${pair}`);
    renderAll();
  };

  const markFlash = (raw: string) => {
    const p = toRootRelativePath(raw);
    clearTimeout(flashTimers.get(p));
    flashUntil.set(p, Date.now() + FLASH_MS);
    const clear = () => {
      flashTimers.delete(p);
      flashUntil.delete(p);
      const q = '[data-just-installed="true"]';
      for (const r of listEl.querySelectorAll<HTMLElement>(q))
        if (r.dataset.subappId === p) {
          r.removeAttribute('data-just-installed');
          r.classList.remove('is-just-installed');
        }
    };
    flashTimers.set(p, setTimeout(clear, FLASH_MS));
  };

  const onRemoveAll = () =>
    void enqueue(async () => {
      const cur = await adapter.list().catch(() => installedItems);
      closeAll();
      for (const i of cur) closePath(i.installPath, i.scope, i.appName, true);
      const res = cur.length ? await adapter.remove(cur) : null;
      await clearDynamicSpecsEverywhere();
      closeAll();
      await refreshList();
      const fb = '[SUBAPPS REMOVE ALL] 0 sub-apps installed -> clean no-op.';
      log(res ? `[SUBAPPS REMOVE ALL] ${res.message}` : fb);
    });
  const RM_CLS = 'btn subapp-toolbar-btn is-hidden';
  const RM_ID = 'subapps-remove-all-btn';
  const removeAllBtn = mkBtn(RM_CLS, RM_ID, 'Remove All', onRemoveAll);
  removeAllBtn.hidden = removeAllBtn.disabled = true;

  const makeRow = (m: RowMeta, ic: HTMLElement, act: HTMLElement) => {
    const [id, p, kind, name, desc] = m;
    const h3 = el('h3', 'subapp-row-title', name);
    h3.title = name;
    const chip = spn('subapp-scope-chip mono tabular-nums', p);
    chip.title = p;
    const line = div('subapp-row-title-line', h3, chip);
    const dEl = desc ? el('p', 'subapp-row-desc', desc) : null;
    const left = div('subapp-row-left', ic, div('subapp-row-copy', line, dEl));
    const row = div('subapp-bundled-row data-card', left, act);
    sa(row, 'data-subapp-id', p);
    sa(row, 'data-subapp-kind', kind);
    sa(row, 'data-window-open', `${isOpen(p)}`);
    return tid(row, id);
  };

  const AB = 'subapp-action-btn';
  const makeActions = (getTgt: () => InstalledSubAppItem) => {
    const arrow = spn('subapp-launch-arrow', '↗');
    sa(arrow, 'aria-hidden', 'true');
    const onL = () => launchSubApp(getTgt());
    const lBtn = mkBtn(`btn ${AB}`, 'subapp-launch-btn', 'Launch', onL);
    lBtn.appendChild(arrow);
    const onRm = () =>
      void enqueue(async () => {
        const cur = getTgt();
        const u = cur.installPath;
        closePath(u, cur.scope, cur.appName, !isOpen(u));
        const res = await adapter.remove([cur]);
        if (cur.kind === 'dynamic' && cur.slug)
          await unregisterDynamicSpecEverywhere(cur.slug);
        closePath(u, cur.scope, cur.appName, true);
        await refreshList();
        log(`[SUBAPPS REMOVE] ${u} -> ${res.message}`);
      });
    const rCls = `btn btn-danger ${AB}`;
    const rBtn = mkBtn(rCls, 'subapp-remove-btn', 'Remove', onRm);
    return div('subapp-row-actions', lBtn, rBtn);
  };

  type CatEntry = BundledSubAppCatalogEntry;
  const buildBundledRow = (e: CatEntry, inst?: InstalledSubAppItem) => {
    const p = e.startUrl;
    let act: HTMLElement;
    if (inst) act = makeActions(() => byPath.get(p) ?? inst);
    else {
      const onAdd = () =>
        void enqueue(async () => {
          const res = await addSuppressed([p]);
          await refreshList();
          log(`[SUBAPPS ADD] ${p} -> ${res.message}`);
        });
      const iCls = `btn btn-primary ${AB}`;
      const addBtn = mkBtn(
        iCls,
        'subapp-install-btn',
        'Install Sub-App',
        onAdd,
      );
      sa(addBtn, 'data-catalog-id', p);
      act = div('subapp-row-actions', addBtn);
    }
    const id = inst ? 'subapp-item' : 'subapp-catalog-card';
    const meta: RowMeta = [id, p, 'bundled', e.name, e.description];
    return makeRow(meta, createBundledIcon(), act);
  };

  const buildDynamicRow = (item: InstalledSubAppItem) => {
    const p = item.installPath;
    const act = makeActions(() => byPath.get(p) ?? item);
    const meta: RowMeta = ['subapp-item', p, item.kind, item.appName, null];
    const row = makeRow(meta, createDynamicRowIcon(item), act);
    sa(row, 'data-subapp-sig', dynSig(item));
    if (ttlHit(flashUntil, p)) {
      row.classList.add('is-just-installed');
      sa(row, 'data-just-installed', 'true');
    }
    return row;
  };

  const syncRowAttrs = (row: HTMLElement, path: string) => {
    sa(row, 'data-window-open', `${isOpen(path)}`);
    const just = ttlHit(flashUntil, path);
    row.classList.toggle('is-just-installed', just);
    if (just) sa(row, 'data-just-installed', 'true');
    else row.removeAttribute('data-just-installed');
  };

  const renderList = () => {
    const showRm = installedItems.length >= 2;
    setHide(removeAllBtn, !showRm);
    removeAllBtn.disabled = !showRm;
    byPath.clear();
    for (const i of installedItems) byPath.set(i.installPath, i);
    const prevMap = new Map<string, HTMLElement>();
    for (const ch of [...listEl.children])
      if (ch instanceof HTMLElement && ch.dataset.subappId)
        prevMap.set(ch.dataset.subappId, ch);

    const desired: HTMLElement[] = [];
    const place = (u: string, ok: Pred, mk: () => HTMLElement) => {
      const prev = prevMap.get(u);
      prevMap.delete(u);
      if (prev && ok(prev)) {
        syncRowAttrs(prev, u);
        desired.push(prev);
      } else {
        prev?.remove();
        desired.push(mk());
      }
    };
    for (const entry of BUNDLED_SUBAPPS_CATALOG) {
      const u = entry.startUrl;
      const inst = byPath.get(u);
      const want = inst ? 'subapp-item' : 'subapp-catalog-card';
      const ok: Pred = (p) =>
        p.dataset.testid === want && p.dataset.subappKind === 'bundled';
      place(u, ok, () => buildBundledRow(entry, inst));
    }
    for (const item of installedItems) {
      const u = item.installPath;
      if (BUNDLED_SUBAPPS_CATALOG.some((c) => c.startUrl === u)) continue;
      const sig = dynSig(item);
      const ok: Pred = (p) =>
        p.dataset.testid === 'subapp-item' &&
        p.dataset.subappKind === item.kind &&
        p.dataset.subappSig === sig;
      place(u, ok, () => buildDynamicRow(item));
    }
    desired.forEach((row, idx) => {
      const cur = listEl.children[idx] ?? null;
      if (cur !== row) listEl.insertBefore(row, cur);
    });
    for (const stale of prevMap.values()) stale.remove();
  };

  const renderAll = () => {
    renderList();
    renderTracker();
  };
  const refreshList = async () => {
    installedItems = await adapter.list().catch(() => []);
    renderAll();
    setStatus(installedItems.length);
  };

  const [defName, defSlug] = ['Log Viewer Pro', 'log-viewer'];
  const previewImg = el('img', 'subapp-builder-preview-img');
  prepImg(previewImg, 96, '512x512 Maskable Sub-App Icon Preview');
  tid(previewImg, 'dyn-subapp-icon-preview');

  const IN_CLS = 'form-input input';
  const PH_N = 'e.g. Log Viewer Pro';
  const PH_S = 'e.g. log-viewer';
  const nameIn = mkInput(IN_CLS, 'dyn-subapp-name', defName, PH_N);
  const slugIn = mkInput(`${IN_CLS} mono`, 'dyn-subapp-slug', defSlug, PH_S);
  const scopePreview = spn('mono tabular-nums', dUrl(defSlug));
  scopePreview.title = dUrl(defSlug);
  const curSlug = () =>
    sanitizeSubAppSlug(slugIn.value.trim() || nameIn.value || defSlug);

  const fieldRows: FieldRow[] = [];
  const flCls = 'subapp-manifest-fields-list subapps-manifest-overrides-list';
  const fieldsListEl = tid(div(flCls), 'dyn-subapp-manifest-fields-list');
  const errDiv = div('subapp-builder-validation-error is-hidden');
  const errEl = tid(errDiv, 'dyn-subapp-builder-error');
  sa(errEl, 'role', 'alert');

  const syncErrBanner = () => {
    const err = fieldRows.find((r) => r.err.trim())?.err ?? '';
    errEl.textContent = err;
    errEl.classList.toggle('is-hidden', !err);
  };
  const defJson = (key: string) => {
    const f = PRESETS.find(([k]) => k === key);
    return f ? JSON.stringify(f[1](curSlug())) : '{}';
  };

  let switchTab = (_tab: TabId) => {};

  const addFieldRow = (initialKey?: string) => {
    switchTab('builder');
    const used = new Set(fieldRows.map((r) => r.key()));
    const chosen =
      initialKey ?? PRESETS.find(([k]) => !used.has(k))?.[0] ?? CUSTOM_KEY;
    const mkOpt = (k: string, lbl = k) =>
      Object.assign(el('option', null, lbl), { value: k });
    const opts = PRESETS.map(([k]) => mkOpt(k));
    opts.push(mkOpt(CUSTOM_KEY, 'Custom key…'));
    const selCls = 'form-select subapp-manifest-key-select mono';
    const sel = tid(
      el('select', selCls, ...opts),
      'dyn-subapp-field-key-select',
    );
    sa(sel, 'aria-label', 'Manifest field key');
    sel.value = chosen;

    const hideC = chosen === CUSTOM_KEY ? '' : ' is-hidden';
    const cCls = `${IN_CLS} mono subapp-manifest-custom-key-input${hideC}`;
    const CK_ID = 'dyn-subapp-field-custom-key';
    const cKey = mkInput(cCls, CK_ID, '', 'custom_manifest_key');
    sa(cKey, 'aria-label', 'Custom manifest key name');

    const initJ = defJson(chosen);
    const vCls = `${IN_CLS} mono subapp-manifest-val-input`;
    const val = tid(el('textarea', vCls, initJ), 'dyn-subapp-field-json-value');
    val.rows = 2;
    val.spellcheck = false;
    val.placeholder = 'Enter valid JSON value...';
    val.value = initJ;
    sa(val, 'aria-label', 'Manifest field JSON value');

    const rDiv = div('subapp-manifest-field-row');
    const root = tid(rDiv, 'dyn-subapp-manifest-field-row');
    const setErr = (msg: string, badK: boolean, badV: boolean) => {
      cKey.classList.toggle('is-invalid', badK);
      val.classList.toggle('is-invalid', badV);
      root.classList.toggle('is-invalid', Boolean(msg));
      rec.err = msg;
      syncErrBanner();
    };
    const key = () =>
      sel.value === CUSTOM_KEY ? cKey.value.trim() : sel.value;
    const validate = (): RowCheck => {
      const k = key().trim();
      if (!k) {
        const error = 'Custom manifest key cannot be empty.';
        setErr(error, true, false);
        return { ok: false, key: '', error };
      }
      try {
        const value: unknown = JSON.parse(val.value);
        setErr('', false, false);
        return { ok: true, key: k, value };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Invalid JSON';
        const error = `Invalid JSON for "${k}": ${msg}`;
        setErr(error, false, true);
        return { ok: false, key: k, error };
      }
    };

    sel.addEventListener('change', () => {
      const custom = sel.value === CUSTOM_KEY;
      cKey.classList.toggle('is-hidden', !custom);
      if (custom) {
        setErr('', false, false);
        val.value = '{}';
        cKey.focus();
      } else {
        val.value = defJson(sel.value);
        validate();
      }
    });
    cKey.addEventListener('input', validate);
    val.addEventListener('input', validate);

    const rmIc = svg(['M18 6L6 18', 'M6 6l12 12'], { size: 14 });
    const rmCls = 'btn btn-ghost subapp-manifest-remove-btn';
    const rmBtn = tid(el('button', rmCls, rmIc), 'dyn-subapp-field-remove-btn');
    rmBtn.type = 'button';
    rmBtn.title = 'Remove manifest field';
    sa(rmBtn, 'aria-label', 'Remove manifest field');
    const syncSlug = (slug: string) => {
      const next = rwScopeStr(val.value, slug);
      if (next !== val.value) {
        val.value = next;
        if (rec.err) validate();
      }
    };
    const focusErr = () => {
      root.scrollIntoView({ block: 'nearest' });
      (sel.value === CUSTOM_KEY && !cKey.value.trim() ? cKey : val).focus();
    };
    const rec: FieldRow = { err: '', key, syncSlug, validate, focusErr };
    rmBtn.addEventListener('click', () => {
      const idx = fieldRows.indexOf(rec);
      if (idx >= 0) fieldRows.splice(idx, 1);
      root.remove();
      syncErrBanner();
    });
    const kCol = div('subapp-manifest-key-col', sel, cKey);
    const vCol = div('subapp-manifest-val-col', val);
    root.appendChild(div('subapp-manifest-row-main', kCol, vCol, rmBtn));
    fieldRows.push(rec);
    fieldsListEl.appendChild(root);
  };

  const syncPreview = () => {
    const slug = curSlug();
    const { startUrl } = getDynamicSubAppPaths(slug);
    scopePreview.textContent = scopePreview.title = startUrl;
    for (const r of fieldRows) r.syncSlug(slug);
    const badgeText = sanitizeBadgeGlyphText('', nameIn.value || slug);
    const accentColor = selectedAccent;
    const url = pngBytesToDataUrl(
      generateBadgePng512Sync({ badgeText, accentColor }),
    );
    if (url) {
      previewImg.src = url;
      void previewImg.decode?.().catch(() => undefined);
    }
  };
  syncPreview();

  nameIn.addEventListener('input', () => {
    switchTab('builder');
    if (!slugEdited) slugIn.value = sanitizeSubAppSlug(nameIn.value || defSlug);
    syncPreview();
  });
  slugIn.addEventListener('input', () => {
    switchTab('builder');
    slugEdited = slugIn.value.trim().length > 0;
    syncPreview();
  });

  const swatchBtns: HTMLButtonElement[] = [];
  const swatchRow = div('subapp-swatch-row');
  sa(swatchRow, 'role', 'group');
  sa(swatchRow, 'aria-label', 'Icon Accent Swatches');
  for (const [label, hex, tone] of ACCENTS) {
    const init = hex === selectedAccent;
    const dot = spn('subapp-swatch-dot');
    sa(dot, 'aria-hidden', 'true');
    const cls = `subapp-swatch-btn subapp-swatch-${tone}${init ? ' is-selected' : ''}`;
    const b = tid(el('button', cls, dot), `subapps-swatch-${tone}`);
    b.type = 'button';
    b.title = `${label} Accent`;
    sa(b, 'aria-label', `${label} Accent`);
    sa(b, 'aria-pressed', `${init}`);
    b.addEventListener('click', () => {
      selectedAccent = hex;
      for (const o of swatchBtns) {
        o.classList.toggle('is-selected', o === b);
        sa(o, 'aria-pressed', `${o === b}`);
      }
      syncPreview();
    });
    swatchBtns.push(b);
    swatchRow.appendChild(b);
  }

  const onCreateInstall = () => {
    syncPreview();
    const name = nameIn.value.trim() || 'Custom IWA Tool';
    const slug = sanitizeSubAppSlug(slugIn.value.trim() || name);
    const custom: Rec = {};
    let bad: FieldRow | null = null;
    let firstErr = '';
    for (const r of fieldRows) {
      const res = r.validate();
      if (!res.ok) {
        if (!bad) {
          bad = r;
          firstErr = res.error ?? 'Invalid manifest field JSON';
        }
      } else custom[res.key] = rwScopeVal(res.value, slug);
    }
    if (bad) {
      bad.focusErr();
      errEl.textContent = firstErr;
      errEl.classList.remove('is-hidden');
      return log(`[DYNAMIC SW SUBAPP] Validation error: ${firstErr}`);
    }
    errEl.textContent = '';
    errEl.classList.add('is-hidden');

    const badgeText = sanitizeBadgeGlyphText('', name);
    const fileExtensions = getFileExts(custom.file_handlers);
    const hasOv = Object.keys(custom).length > 0;
    const ov = hasOv ? { customManifestFields: custom } : {};
    const baseSpec = { name, slug, badgeText, accentColor: selectedAccent };
    const sIn = { ...baseSpec, fileExtensions, ...ov, createdAt: Date.now() };
    const spec = normalizeDynamicSubAppSpec(sIn);
    syncPreview();

    void enqueue(async () => {
      const reg = await registerDynamicSpecEverywhere(spec);
      const paths = getDynamicSubAppPaths(reg.slug);
      const u = paths.startUrl;
      const prev = installedItems.find((i) => i.installPath === u);
      if (prev) {
        if (isOpen(u)) closePath(u, paths.scope, reg.name, true);
        suppressing.set(u, Number.POSITIVE_INFINITY);
        await adapter.remove([prev]).catch(() => undefined);
      }
      const addRes = await addSuppressed([u]);
      if (addRes.ok) markFlash(u);
      await refreshList();
      const ovKeys = Object.keys(reg.customManifestFields ?? {});
      const ovTxt = ovKeys.length ? `, overrides=[${ovKeys.join(', ')}]` : '';
      const exts = reg.fileExtensions.join(', ');
      const info = `badge="${reg.badgeText}", handlers=[${exts}]${ovTxt}`;
      log(`[DYNAMIC SW SUBAPP] Registered ${u} (${info}) -> ${addRes.message}`);
      if (addRes.ok) {
        switchTab('bundled');
        const qItem = '[data-testid="subapp-item"]';
        const rows = listEl.querySelectorAll<HTMLElement>(qItem);
        const hit = [...rows].find((r) => r.dataset.subappId === u);
        hit?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        errEl.textContent = addRes.message;
        errEl.classList.remove('is-hidden');
      }
    });
  };
  const C_CLS = 'btn btn-primary subapp-create-btn';
  const C_ID = 'dyn-subapp-create-install-btn';
  const C_LBL = '+ Create & Install Sub-App';
  const createBtn = mkBtn(C_CLS, C_ID, C_LBL, onCreateInstall);

  for (const inp of [nameIn, slugIn])
    inp.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        createBtn.click();
      }
    });

  const bindInst = (cleanId: string, instId: string) => {
    if (busMap.has(instId)) return;
    const h = handles.find(
      (x) => x.path === cleanId && !x.inst && x.win && !x.win.closed,
    );
    if (h) h.inst = instId;
  };

  const unsubBus = bus.subscribe((msg) => {
    if ('appId' in msg && msg.appId === '/hud.html') return;
    if (msg.type === 'SUBAPP_HELLO' || msg.type === 'SUBAPP_HEARTBEAT') {
      const cleanId = toRootRelativePath(msg.appId);
      const id = msg.instanceId || cleanId;
      if (ttlHit(tombs, id))
        return postClose(cleanId, msg.scope, msg.instanceId);
      const had = busMap.has(id);
      if ((msg.type === 'SUBAPP_HELLO' || !had) && isSuppressed(cleanId))
        return;
      cancelClose(id);
      bindInst(cleanId, id);
      const { scope, title } = msg;
      busMap.set(id, { id, appId: cleanId, scope, title, ts: Date.now() });
      if (msg.type === 'SUBAPP_HELLO') {
        const meta = `appId=${msg.appId} instanceId=${id} scope=${scope}`;
        log(`[RX SUBAPP_HELLO] ${meta} title="${title}"`);
        renderAll();
      } else if (!had) renderAll();
    } else if (msg.type === 'SUBAPP_CLOSED') {
      const cleanId = toRootRelativePath(msg.appId);
      const logClosed = (inst: string) => {
        const meta = `appId=${msg.appId} instanceId=${inst} scope=${msg.scope}`;
        log(`[RX SUBAPP_CLOSED] ${meta}`);
      };
      if (!msg.instanceId) {
        for (const [id, e] of busMap)
          if (e.appId === cleanId) {
            cancelClose(id);
            busMap.delete(id);
          }
        for (let i = handles.length - 1; i >= 0; i--)
          if (handles[i].path === cleanId) handles.splice(i, 1);
        logClosed(cleanId);
        return renderAll();
      }
      const id = msg.instanceId;
      const known = busMap.has(id) || handles.some((h) => h.inst === id);
      if (!known && isSuppressed(cleanId)) return;
      const evict = () => {
        cancelClose(id);
        const existed = busMap.delete(id);
        let rmH = false;
        for (let i = handles.length - 1; i >= 0; i--) {
          const h = handles[i];
          if (h.inst === id || !h.win || h.win.closed) {
            handles.splice(i, 1);
            rmH = true;
          }
        }
        if (existed || rmH) {
          logClosed(id);
          renderAll();
        }
      };
      if (ttlHit(tombs, id)) return evict();
      cancelClose(id);
      const fin = () => (closeTimers.delete(id), evict());
      closeTimers.set(id, setTimeout(fin, GRACE_MS));
      bus.post({ type: 'QUERY_OPEN_SUBAPPS', ts: Date.now() });
    } else if (msg.type === 'SUBAPP_PONG') {
      const pfx = `[RX SUBAPP_PONG #${++pongCount}] appId=${msg.appId} scope=${msg.scope}`;
      log(`${pfx} nonce=${msg.nonce} echo=${msg.echoPayload ?? ''}`);
    }
  });

  const pollTimer = setInterval(() => {
    if (!container.isConnected) return cleanup();
    if (pruneWindows()) renderAll();
  }, 500);

  let syncQueued = false;
  const autoSync = () => {
    if (!container.isConnected) return cleanup();
    if (syncQueued) return;
    syncQueued = true;
    void enqueue(async () => {
      syncQueued = false;
      if (!container.isConnected) return;
      await syncKnownDynamicSpecsFromBackend();
      await refreshList();
    });
  };

  const isVis = () =>
    !container.classList.contains('is-hidden') &&
    !container.hidden &&
    container.getAttribute('aria-hidden') !== 'true';
  const visObserver =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => isVis() && autoSync())
      : null;

  const cleanup = () => {
    abort.abort();
    visObserver?.disconnect();
    clearInterval(pollTimer);
    clearTimers(closeTimers);
    clearTimers(flashTimers);
    flashUntil.clear();
    unsubBus();
    bus.close();
    if (hostEl.__subAppsCleanup === cleanup) delete hostEl.__subAppsCleanup;
  };
  hostEl.__subAppsCleanup = cleanup;

  const obsCfg = {
    attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden'],
  };
  visObserver?.observe(container, obsCfg);
  const sig = { signal: abort.signal };
  window.addEventListener('focus', autoSync, sig);
  const onVis = () => document.visibilityState === 'visible' && autoSync();
  document.addEventListener('visibilitychange', onVis, sig);
  window.addEventListener('pagehide', cleanup, sig);

  renderAll();

  const mkPanel = ([id, className, title, ch, headerRight]: PanelIn) => {
    const [pid, by] = [`subapps-panel-${id}`, `subapps-tab-${id}`];
    const attrs: Record<string, string> = { role: 'tabpanel' };
    Object.assign(attrs, {
      'aria-labelledby': by,
      'aria-hidden': `${id === 'builder'}`,
    });
    const headerClassName = 'subapps-card-header';
    const base = { id: pid, testId: pid, className, headerClassName, title };
    return createCard({ ...base, headerRight, attrs, rawChildren: [ch] });
  };

  const hdrAct = div('subapps-card-header-actions', removeAllBtn);
  const CAT = 'Sub-App Catalog & Installed Apps';
  const B_CLS = 'subapps-bundled-card';
  const bundledCard = mkPanel(['bundled', B_CLS, CAT, listEl, hdrAct]);

  const sqDiv = div('subapp-builder-squircle', previewImg);
  const sq = tid(sqDiv, 'subapps-dyn-icon-preview');
  const cap = el(
    'p',
    'subapp-builder-caption',
    'Generated 512×512 maskable PNG',
  );
  const colLbl = spn('subapps-builder-col-label', 'App Icon Preview');
  const leftCol = div('subapps-builder-left-col', colLbl, sq, swatchRow, cap);
  const f1 = mkField('App Title', nameIn);
  const f2 = mkField('URL Slug (/dynamic/<slug>/)', slugIn);
  const fRow = div('subapps-builder-fields-row', f1, f2);
  const ADD_CLS = 'btn btn-subtle btn-sm subapp-add-manifest-field-btn';
  const ADD_ID = 'dyn-subapp-add-field-btn';
  const onAddFld = () => addFieldRow();
  const addFieldBtn = mkBtn(ADD_CLS, ADD_ID, '+ Add Manifest Field', onAddFld);
  const ovLbl = spn('form-label', 'Manifest Overrides / Capabilities');
  const ovHdr = div('subapps-manifest-overrides-header', ovLbl, addFieldBtn);
  const OV_CLS = 'subapps-manifest-overrides-section';
  const ovSec = tid(
    div(OV_CLS, ovHdr, fieldsListEl, errEl),
    'dyn-subapp-manifest-overrides',
  );
  const rTxt = spn(null, 'Manifest & HTML synthesized at ');
  const rNote = div('subapps-builder-route-note', rTxt, scopePreview);
  const ftr = div('subapps-builder-footer-row', rNote, createBtn);
  const rightCol = div('subapps-builder-right-col', fRow, ovSec, ftr);
  const grid = div('subapps-builder-grid', leftCol, rightCol);
  const BLD_CLS = 'subapps-builder-card is-hidden';
  const cSpec: PanelIn = ['builder', BLD_CLS, 'Create a Custom Sub-App', grid];
  const builderCard = mkPanel(cSpec);

  const syncPanels = (tab: TabId) => {
    const b = tab === 'bundled';
    bundledCard.root.hidden = builderCard.root.hidden = false;
    bundledCard.root.classList.toggle('is-hidden', !b);
    sa(bundledCard.root, 'aria-hidden', `${!b}`);
    builderCard.root.classList.toggle('is-hidden', b);
    sa(builderCard.root, 'aria-hidden', `${b}`);
  };

  const tSpec = (id: TabId, label: string) => {
    const [b, c] = [`subapps-tab-${id}`, `subapps-panel-${id}`];
    return { id, label, buttonId: b, testId: b, controlsId: c };
  };
  const [t1, t2] = [
    tSpec('bundled', 'Managed Sub-Apps'),
    tSpec('builder', 'Custom App Builder'),
  ];
  const tabs = createSegmentedTabs<TabId>({
    ariaLabel: 'Sub-Apps View Mode',
    tabs: [t1, t2],
    initialTab: 'bundled',
    onSelect: syncPanels,
  });

  switchTab = (target: TabId) => {
    const alt: TabId = target === 'bundled' ? 'builder' : 'bundled';
    const focus = document.activeElement === tabs.buttons.get(alt);
    tabs.setActive(target, { silent: true, focus });
    syncPanels(target);
  };
  syncPanels('bundled');

  const { title, subtitle } = workspace;
  const hCfg = {
    title,
    subtitle,
    className: 'subapps-header',
    right: tabs.root,
  };
  const header = createWorkspaceHeader(hCfg);
  const [bRoot, cRoot] = [bundledCard.root, builderCard.root];
  container.replaceChildren(header, bRoot, cRoot, trackerEl, logConsole.root);

  bus.post({ type: 'QUERY_OPEN_SUBAPPS', ts: Date.now() });
  void enqueue(async () => {
    await syncKnownDynamicSpecsFromBackend();
    await refreshList();
  });
}

export const workspace: WorkspaceDefinition = {
  id: 'sub-apps',
  navLabel: 'Sub-Apps',
  shortCode: 'Apps',
  title: 'Sub-Apps',
  subtitle:
    'Install the bundled Telnet terminal into the OS launcher or build custom sub-apps on the fly.',
  mount: mountSubApps,
};

export const subAppsWorkspace = workspace;
export default workspace;

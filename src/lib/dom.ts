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

import type { WorkspaceId, WorkspaceLiveStatus } from '../shell/contracts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const THEME_KEY = 'iwa-sink.theme';
const TT_KEY = '__IWA_SINK_SW_TT_POLICY__';
type DomChild = Node | string | number | null | undefined | false;
type Kids = DomChild | ReadonlyArray<DomChild>;
type AttrMap = Record<string, string | number | boolean | undefined>;
type StrOpt<K extends string> = Partial<Record<K, string>>;
type BoolOpt<K extends string> = Partial<Record<K, boolean>>;
type ClickFn = (ev: MouseEvent) => void;
type TagMap = HTMLElementTagNameMap;
type ElOpts<K extends keyof TagMap = keyof TagMap> = StrOpt<
  'className' | 'id'
> &
  StrOpt<'testId' | 'text' | 'title'> &
  BoolOpt<'hidden' | 'disabled'> & {
    attrs?: AttrMap;
    dataset?: Record<string, string | undefined>;
    style?: Partial<CSSStyleDeclaration>;
    onClick?: (ev: MouseEvent, target: TagMap[K]) => void;
  };

const cx = (a: string, b?: string): string => (b ? `${a} ${b}` : a);
const sa = (n: Element, k: string, v: string): void => n.setAttribute(k, v);
const tryOr = <T>(fn: () => T, fb: T): T => {
  try {
    return fn();
  } catch {
    return fb;
  }
};
const setAttrs = (n: Element, attrs?: AttrMap): void => {
  for (const [k, v] of Object.entries(attrs ?? {}))
    if (v !== undefined && v !== false) sa(n, k, v === true ? '' : `${v}`);
};
const setHide = (n: HTMLElement, hide: boolean): void => {
  n.classList.toggle('is-hidden', hide);
  n.hidden = hide;
};

export function el<K extends keyof TagMap>(
  tag: K,
  opts?: ElOpts<K> | string | null,
  ...kids: DomChild[]
): TagMap[K] {
  const n = document.createElement(tag);
  if (typeof opts === 'string') {
    if (opts) n.className = opts;
  } else if (opts) {
    for (const k of ['className', 'id', 'title'] as const)
      if (opts[k]) n[k] = opts[k];
    if (opts.testId) n.dataset.testid = opts.testId;
    if (opts.text !== undefined) n.textContent = opts.text;
    if (opts.hidden !== undefined) n.hidden = opts.hidden;
    if (opts.disabled !== undefined)
      (n as HTMLButtonElement).disabled = opts.disabled;
    for (const [k, v] of Object.entries(opts.dataset ?? {}))
      if (v !== undefined) n.dataset[k] = v;
    if (opts.style) Object.assign(n.style, opts.style);
    setAttrs(n, opts.attrs);
    const fn = opts.onClick;
    if (fn) (n as HTMLElement).addEventListener('click', (ev) => fn(ev, n));
  }
  for (const c of kids)
    if (c !== null && c !== undefined && c !== false)
      n.appendChild(c instanceof Node ? c : document.createTextNode(`${c}`));
  return n;
}
export const clearChildren = (p: Element): void => p.replaceChildren();
const mkBtn = (cls: string, tid?: string, fn?: ClickFn, txt?: string) => {
  const b = el('button', cls, txt);
  b.type = 'button';
  if (tid) b.dataset.testid = tid;
  if (fn) b.addEventListener('click', fn);
  return b;
};
export function updateLogTextStickToBottom(
  logEl: HTMLElement,
  nextText: string,
  allowAutoScroll = true,
): void {
  const { scrollTop, scrollLeft, scrollHeight, clientHeight } = logEl;
  const atEnd = scrollHeight - scrollTop - clientHeight <= 24;
  logEl.textContent = nextText;
  logEl.scrollTop = allowAutoScroll && atEnd ? logEl.scrollHeight : scrollTop;
  logEl.scrollLeft = scrollLeft;
}

export interface SvgShapeSpec {
  tag?: 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon';
  attrs: Record<string, string | number>;
}
type SvgOpts = StrOpt<'viewBox' | 'className'> & {
  size?: number;
  strokeWidth?: number | string;
};
export function svg(
  shapes: ReadonlyArray<string | SvgShapeSpec>,
  opts?: SvgOpts,
): SVGSVGElement {
  const sz = `${opts?.size ?? 16}`;
  const root = document.createElementNS(SVG_NS, 'svg');
  const base = `viewBox=${opts?.viewBox ?? '0 0 24 24'}|width=${sz}|height=${sz}|fill=none|stroke=currentColor|stroke-width=${opts?.strokeWidth ?? 2}|stroke-linecap=round|stroke-linejoin=round|aria-hidden=true`;
  for (const p of base.split('|')) {
    const i = p.indexOf('=');
    sa(root, p.slice(0, i), p.slice(i + 1));
  }
  if (opts?.className) sa(root, 'class', opts.className);
  for (const s of shapes) {
    const str = typeof s === 'string';
    const c = document.createElementNS(SVG_NS, str ? 'path' : s.tag ?? 'path');
    if (str) sa(c, 'd', s);
    else setAttrs(c, s.attrs);
    root.appendChild(c);
  }
  return root;
}
const sp = (spec: string): Array<string | SvgShapeSpec> =>
  spec.split('|').map((t) => {
    if (t[1] !== ':') return t;
    const [k, b] = [t[0], t.slice(2)];
    const [x, y, width, height, rx] = b.split(',');
    const op = k === 'F' ? '0.18' : '0.16';
    const f = { fill: 'currentColor', 'fill-opacity': op };
    if (k === 'f' || k === 'F') return { attrs: { d: b, ...f } };
    if (k === 'c') {
      const ca: AttrMap = { cx: x, cy: y, r: width, fill: f.fill };
      if (height) ca['fill-opacity'] = height;
      return { tag: 'circle', attrs: ca as Record<string, string> };
    }
    const ra = { x, y, width, height, rx };
    return { tag: 'rect', attrs: k === 'r' ? { ...ra, ...f } : ra };
  });
const BRAND_SPEC =
  'F:M4.5 13.5h15l-1.6 4.8a2 2 0 0 1-1.9 1.3H8a2 2 0 0 1-1.9-1.3L4.5 13.5z|M7 9.5V7a3.5 3.5 0 0 1 7 0v1.2|c:14,10.75,1.15|M8.5 16.5h7';
const WS_ICONS: Record<WorkspaceId, string> = {
  overview:
    'M3 10.5L12 3l9 7.5|f:M5 9.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5|M9 21v-6h6v6',
  'tcp-terminal':
    'r:3,4,18,16,3.5|M7.5 10h6M11 7.5L13.5 10 11 12.5M16.5 14h-6M13 11.5L10.5 14 13 16.5',
  'controlled-frame-tls':
    'r:3,4,18,16,3.5|M3 8.5h18|f:M12 10.5l3.5 1.3v2.3c0 2.1-1.5 3.6-3.5 4.2-2-.6-3.5-2.1-3.5-4.2v-2.3L12 10.5z',
  'sso-offloading':
    'c:8.5,12,4.5,0.16|M13 12h7M17.5 12v2.5M20 12v3|c:8.5,12,1.15',
  'sub-apps':
    'r:3.5,3.5,7,7,2|R:13.5,3.5,7,7,2|R:3.5,13.5,7,7,2|r:13.5,13.5,7,7,2',
  'windowing-hud': 'r:3,4,18,16,3.5|r:11,10.5,7.5,6.5,1.75|M6.5 7.5h3',
  'screen-capture': 'r:2,3,20,14,2.5|M8 21h8M12 17v4|c:12,10,2.5,0.16',
  'extension-bridge':
    'f:M19.4 12a2 2 0 0 1 0 4H18v3a1 1 0 0 1-1 1h-3.5v-1.2a2 2 0 1 0-4 0V20H6a1 1 0 0 1-1-1v-3.5h1.2a2 2 0 1 0 0-4H5V8a1 1 0 0 1 1-1h3v-1.2a2 2 0 1 1 4 0V7h4a1 1 0 0 1 1 1v4h1.4z',
};
const wsSvg = (d: string, size = 18, className?: string) =>
  svg(sp(d), { size, className, strokeWidth: 1.75 });
export const createBrandEmblemSvg = (s = 18, c?: string) =>
  wsSvg(BRAND_SPEC, s, c);
export const createWorkspaceIconSvg = (id: WorkspaceId, s = 18, c?: string) =>
  wsSvg(WS_ICONS[id] ?? WS_ICONS.overview, s, c);
export const createArrowRightSvg = (size = 14, className?: string) =>
  svg(['M5 12h14', 'M13 6l6 6-6 6'], { size, className, strokeWidth: 2 });

type HdrOpts = Record<'title' | 'subtitle', string> &
  StrOpt<'className' | 'subtitleClassName'> & { right?: DomChild };
export function createWorkspaceHeader(o: HdrOpts): HTMLElement {
  const h1 = el('h1', 'workspace-title', o.title);
  const sCls = cx('workspace-subtitle', o.subtitleClassName);
  const main = el('div', 'ws-header-main', h1, el('p', sCls, o.subtitle));
  return el('header', cx('ws-header', o.className), main, o.right);
}

type TabSpec<T extends string> = { id: T; buttonId?: string } & Record<
  'label' | 'testId' | 'controlsId',
  string
>;
export function createSegmentedTabs<T extends string>(o: {
  ariaLabel: string;
  tabs: ReadonlyArray<TabSpec<T>>;
  initialTab?: T;
  onSelect?: (id: T) => void;
}) {
  let activeId: T = o.initialTab ?? o.tabs[0].id;
  const buttons = new Map<T, HTMLButtonElement>();
  const syncBtn = (b: HTMLButtonElement, cur: boolean): void => {
    b.classList.toggle('is-active', cur);
    sa(b, 'aria-selected', `${cur}`);
    sa(b, 'tabindex', cur ? '0' : '-1');
  };
  const setActive = (id: T, opts?: BoolOpt<'focus' | 'silent'>): void => {
    if (!buttons.has(id)) return;
    activeId = id;
    for (const s of o.tabs) {
      const cur = s.id === id;
      const b = buttons.get(s.id);
      if (b) syncBtn(b, cur);
      const p = document.getElementById(s.controlsId);
      if (!p) continue;
      if (!cur && p.contains(document.activeElement)) {
        buttons.get(id)?.focus({ preventScroll: true });
        if (p.contains(document.activeElement))
          (document.activeElement as HTMLElement | null)?.blur?.();
      }
      setHide(p, !cur);
      sa(p, 'aria-hidden', `${!cur}`);
    }
    if (opts?.focus) buttons.get(id)?.focus({ preventScroll: true });
    if (!opts?.silent) o.onSelect?.(id);
  };
  for (const s of o.tabs) {
    const b = mkBtn('ws-seg-tab', s.testId, () => setActive(s.id));
    b.id = s.buttonId ?? s.testId;
    setAttrs(b, { role: 'tab', 'aria-controls': s.controlsId });
    b.appendChild(el('span', null, s.label));
    syncBtn(b, s.id === activeId);
    buttons.set(s.id, b);
  }
  const root = el('div', 'seg-tab-bar', ...buttons.values());
  setAttrs(root, { role: 'tablist', 'aria-label': o.ariaLabel });
  root.addEventListener('keydown', (ev: KeyboardEvent) => {
    const i = o.tabs.findIndex((t) => t.id === activeId);
    const n = o.tabs.length;
    const kIdx = ['Home', 'End', 'ArrowRight', 'ArrowLeft'].indexOf(ev.key);
    if (n && i >= 0 && kIdx >= 0) {
      ev.preventDefault();
      const nextIdx = [0, n - 1, i + 1, i + n - 1][kIdx] % n;
      setActive(o.tabs[nextIdx].id, { focus: true });
    }
  });
  return { root, buttons, setActive };
}

const toKids = (v?: Kids): ReadonlyArray<DomChild> =>
  v === undefined ? [] : Array.isArray(v) ? v : [v as DomChild];
type CardOpts = StrOpt<'title' | 'captionTag' | 'id' | 'testId'> &
  StrOpt<'className' | 'headerClassName' | 'bodyClassName'> & {
    headerRight?: Kids;
    banner?: HTMLElement | null;
    attrs?: AttrMap;
    body?: Kids;
    rawChildren?: ReadonlyArray<DomChild>;
  };
export function createCard(o: CardOpts) {
  const h2 = o.title !== undefined ? el('h2', 'ws-card-title', o.title) : null;
  const rArr = toKids(o.headerRight);
  const hasR = rArr.some((c) => c !== null && c !== undefined && c !== false);
  const tCls = 'workspace-tag mono';
  const tag = o.captionTag ? el('span', tCls, o.captionTag) : null;
  const left = tag ? el('div', 'workspace-bar-left', h2, tag) : h2;
  const right = hasR ? el('div', 'workspace-bar-right', ...rArr) : null;
  const hCls = cx('card-header', o.headerClassName);
  const hdr = left || right ? el('div', hCls, left, right) : null;
  const bCls = cx('ws-card-body', o.bodyClassName);
  const hasB = o.body !== undefined || Boolean(o.bodyClassName);
  const body = hasB ? el('div', bCls, ...toKids(o.body)) : null;
  const kids = [hdr, o.banner ?? null, body, ...(o.rawChildren ?? [])];
  const root = el('section', cx('card', o.className), ...kids);
  if (o.id) root.id = o.id;
  if (o.testId) root.dataset.testid = o.testId;
  setAttrs(root, o.attrs);
  return { root, titleEl: h2 };
}

type AlertOpts = StrOpt<'id' | 'testId' | 'className'> & {
  tone?: 'error' | 'warning';
  role?: 'alert' | 'status';
  inset?: boolean;
};
export function createAlertBanner(o?: AlertOpts) {
  const warn = o?.tone === 'warning';
  const role = o?.role ?? (warn ? 'status' : 'alert');
  const tCls = warn ? 'win-awc-unavailable-banner' : 'cf-url-error-banner';
  const base = `ws-alert ${tCls}${o?.inset ? ' ws-alert-inset' : ''}`;
  const root = el('div', `${cx(base, o?.className)} is-hidden`);
  root.hidden = true;
  if (o?.id) root.id = o.id;
  if (o?.testId) root.dataset.testid = o.testId;
  sa(root, 'role', role);
  sa(root, 'aria-live', role === 'alert' ? 'assertive' : 'polite');
  const clear = (): void => (setHide(root, true), void (root.textContent = ''));
  const show = (msg: string): void => {
    const m = msg.trim();
    if (!m) return clear();
    root.textContent = m;
    setHide(root, false);
  };
  const isVisible = () =>
    !root.hidden && !root.classList.contains('is-hidden') && !!root.textContent;
  return { root, clear, show, isVisible };
}

type MetaOpts = Record<'label' | 'valueTestId', string> &
  Record<'copyTestId' | 'copyTitle', string> &
  StrOpt<'initialText'> &
  BoolOpt<'mono' | 'bold' | 'resetCopyOnTextChange'> & {
    getCopyText?: () => string;
  };
export function createMetaBox(o: MetaOpts) {
  const init = o.initialText ?? '—';
  const vCls = `ws-meta-val${o.mono ? ' mono' : ''}${o.bold ? ' cf-tls-meta-value-bold' : ''}`;
  const valueEl = el('div', vCls, init);
  valueEl.dataset.testid = o.valueTestId;
  if (init !== '—') valueEl.title = init;
  const getTxt = o.getCopyText ?? (() => valueEl.textContent ?? '');
  const copyBtn = createCopyIconButton({
    getText: getTxt,
    title: o.copyTitle,
    testId: o.copyTestId,
    className: 'cf-meta-copy-btn',
    watchEl: valueEl,
    resetOnTextChange: o.resetCopyOnTextChange,
  });
  const lbl = el('div', 'ws-meta-label', o.label);
  const hdr = el('div', 'ws-meta-header', lbl, copyBtn);
  const root = el('div', 'ws-meta-box', hdr, valueEl);
  const setValue = (text: string): void => {
    valueEl.textContent = text;
    if (text && text !== '—') valueEl.title = text;
    else valueEl.removeAttribute('title');
    syncCopyButton(copyBtn);
  };
  return { root, valueEl, copyBtn, setValue };
}

type ColBase = StrOpt<'cardTestId' | 'cardClassName' | 'bodyId'> &
  BoolOpt<'initialExpanded'> & { title: string };
type ColOpts = ColBase &
  StrOpt<'bodyClassName'> & {
    toggleTestId: string;
    headerRight?: HTMLElement | null;
    children?: readonly DomChild[];
    onToggle?: (expanded: boolean) => void;
  };
export function createCollapsibleSection(o: ColOpts) {
  let expanded = o.initialExpanded ?? true;
  const bodyId = o.bodyId ?? `${o.toggleTestId}-panel`;
  const titleId = `${o.toggleTestId}-heading`;
  const titleSpan = el('span', 'ws-card-title', o.title);
  titleSpan.id = titleId;
  const btn = mkBtn('ws-collapsible-toggle', o.toggleTestId, (ev) => {
    ev.stopPropagation();
    apply(!expanded, true);
  });
  sa(btn, 'aria-controls', bodyId);
  const cCls = 'ws-collapse-chevron';
  btn.append(svg(['M6 9l6 6 6-6'], { size: 16, className: cCls }), titleSpan);
  o.headerRight?.classList.add('ws-collapsible-right');
  const bCls = cx('ws-card-body', o.bodyClassName);
  const body = el('div', bCls, ...(o.children ?? []));
  body.id = bodyId;
  const hdr = el('div', 'ws-collapsible-header', btn, o.headerRight ?? null);
  const rCls = cx('card ws-collapsible', o.cardClassName);
  const root = el('section', rCls, hdr, body);
  if (o.cardTestId) root.dataset.testid = o.cardTestId;
  sa(root, 'aria-labelledby', titleId);
  const apply = (next: boolean, notify: boolean): void => {
    expanded = next;
    sa(btn, 'aria-expanded', `${expanded}`);
    root.classList.toggle('is-collapsed', !expanded);
    setHide(body, !expanded);
    if (o.headerRight) setHide(o.headerRight, !expanded);
    if (notify) o.onToggle?.(expanded);
  };
  apply(expanded, false);
  const skip = '.ws-collapsible-right, .cf-clear-log-btn';
  hdr.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement | null)?.closest(skip))
      apply(!expanded, true);
  });
  return { root };
}
export function formatLogTime(d = new Date()): string {
  const p = (n: number, w = 2) => `${n}`.padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type LogOpts = ColBase &
  Record<'logTestId' | 'clearBtnTestId', string> &
  StrOpt<'ariaLabel' | 'toggleTestId'> & {
    maxLines?: number;
    initialLines?: ReadonlyArray<string>;
  };
export function createLogConsole(o: LogOpts) {
  const max = o.maxLines ?? 250;
  const lines: string[] = [...(o.initialLines ?? [])];
  const preEl = el('pre', 'terminal-surface cf-console-log mono tabular-nums');
  preEl.dataset.testid = o.logTestId;
  sa(preEl, 'role', 'log');
  sa(preEl, 'tabindex', '0');
  sa(preEl, 'aria-label', o.ariaLabel ?? o.title);
  const sync = (): void => {
    const txt = lines.join('\n');
    preEl.classList.toggle('is-empty', !txt);
    updateLogTextStickToBottom(preEl, txt);
  };
  const clear = (): void => ((lines.length = 0), sync());
  const onClr = (ev: MouseEvent): void => (ev.stopPropagation(), clear());
  const cBtn = mkBtn('btn cf-clear-log-btn', o.clearBtnTestId, onClr, 'Clear');
  sa(cBtn, 'aria-label', `Clear ${o.title}`);
  const col = createCollapsibleSection({
    ...o,
    toggleTestId: o.toggleTestId ?? `${o.logTestId}-toggle`,
    headerRight: cBtn,
    initialExpanded: o.initialExpanded ?? false,
    children: [preEl],
    onToggle: (exp) => void (exp && (preEl.scrollTop = preEl.scrollHeight)),
  });
  const append = (msg: string): void => {
    lines.push(`[${formatLogTime()}] ${msg}`);
    if (lines.length > max) lines.splice(0, lines.length - max);
    sync();
  };
  sync();
  return { root: col.root, append };
}

type PillState = WorkspaceLiveStatus['state'];
type PillOpts = string | StrOpt<'testId' | 'className'>;
export function createStatusPill(s: PillState, label: string, o?: PillOpts) {
  const cfg = typeof o === 'string' ? { testId: o } : o;
  const labelEl = el('span', 'status-pill-text', label);
  const root = el('span', cx('status-pill meta-tag', cfg?.className), labelEl);
  if (cfg?.testId) root.dataset.testid = cfg.testId;
  const update = (next: PillState, txt: string): void => {
    sa(root, 'data-state', next);
    root.classList.toggle('is-online', next === 'online');
    root.classList.toggle('is-error', next === 'offline');
    labelEl.textContent = txt;
  };
  update(s, label);
  return { root, labelEl, update };
}

const COPY_SHAPES = sp(
  'R:9,9,13,13,2|M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
);
const CHECK_SHAPES = ['M20 6L9 17l-5-5'];
const canCopyStr = (s: string): boolean =>
  Boolean(s.trim() && !/^[-—–]+$/.test(s.trim()));
function execCopyFallback(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const ae = document.activeElement;
  const prev = ae instanceof HTMLElement && ae !== document.body ? ae : null;
  const ta = el('textarea', { attrs: { 'aria-hidden': 'true', tabindex: -1 } });
  ta.readOnly = true;
  ta.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  ta.value = text;
  document.body.appendChild(ta);
  const ok = tryOr(() => {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand('copy');
  }, false);
  ta.remove();
  if (prev?.isConnected)
    tryOr(() => prev.focus({ preventScroll: true }), undefined);
  return ok;
}

type PolEntry = { allowsFeature?: (f: string) => boolean };
type PolDoc = { permissionsPolicy?: PolEntry; featurePolicy?: PolEntry };
type CopyOpts = StrOpt<'title' | 'testId' | 'className'> & {
  getText: () => string;
  size?: number;
  watchEl?: Element | null;
  resetOnTextChange?: boolean;
};
export function createCopyIconButton(o: CopyOpts): HTMLButtonElement {
  const sz = o.size ?? 14;
  const resetOnChg = o.resetOnTextChange !== false;
  const defTitle = o.title ?? 'Copy to clipboard';
  let [tPress, tReset, seq] = [0, 0, 0];
  let copiedVal: string | null = null;
  const slot = el('span', 'copy-icon-slot');
  const clr = () => (clearTimeout(tPress), clearTimeout(tReset));
  const setUI = (chk: boolean): void => {
    btn.classList.toggle('is-copied', chk);
    if (!chk) btn.classList.remove('is-pressed');
    const iCls = `copy-icon-svg${chk ? ' is-check' : ''}`;
    const shapes = chk ? CHECK_SHAPES : COPY_SHAPES;
    slot.replaceChildren(svg(shapes, { size: sz, className: iCls }));
    const lbl = chk ? 'Copied to clipboard' : defTitle;
    btn.title = lbl;
    sa(btn, 'aria-label', lbl);
  };
  const reset = (): void => {
    seq += 1;
    copiedVal = null;
    clr();
    if (btn.classList.contains('is-copied') || btn.title !== defTitle)
      setUI(false);
  };
  const markCopied = (op: number, val: string): void => {
    const cur = o.getText().trim();
    if (op !== seq || btn.disabled || btn.classList.contains('is-hidden'))
      return;
    if (!canCopyStr(cur) || (resetOnChg && cur !== val)) return;
    copiedVal = val;
    clr();
    btn.classList.add('is-pressed');
    setUI(true);
    tPress = window.setTimeout(() => btn.classList.remove('is-pressed'), 160);
    tReset = window.setTimeout(reset, 900);
  };
  const btn = mkBtn(cx('btn copy-icon-btn', o.className), o.testId, (ev) => {
    ev.stopPropagation();
    const raw = o.getText().trim();
    if (btn.disabled || !canCopyStr(raw)) return;
    const op = ++seq;
    copiedVal = raw;
    const pd = document as unknown as PolDoc;
    const pol = pd.permissionsPolicy ?? pd.featurePolicy;
    const okPol = pol?.allowsFeature?.('clipboard-write') !== false;
    const fb = (): void => {
      if (execCopyFallback(raw)) markCopied(op, raw);
      else if (op === seq) copiedVal = null;
    };
    const cb = navigator?.clipboard;
    if (!okPol || typeof cb?.writeText !== 'function') return fb();
    const p = tryOr(() => Promise.resolve(cb.writeText(raw)), null);
    if (p) p.then(() => markCopied(op, raw), fb);
    else fb();
  });
  btn.appendChild(slot);
  setUI(false);
  const sync = (): void => {
    const raw = o.getText();
    const ok = !btn.classList.contains('is-hidden') && canCopyStr(raw);
    btn.disabled = !ok;
    btn.classList.toggle('is-copy-disabled', !ok);
    sa(btn, 'aria-disabled', `${!ok}`);
    if (!ok || (resetOnChg && copiedVal !== null && raw.trim() !== copiedVal))
      reset();
  };
  btn.addEventListener('copy-sync', sync);
  if (o.watchEl) {
    for (const e of ['copy-sync', 'input', 'change'])
      o.watchEl.addEventListener(e, sync);
    const moCfg = { childList: true, characterData: true, subtree: true };
    if (typeof MutationObserver === 'function')
      new MutationObserver(sync).observe(o.watchEl, moCfg);
  }
  tryOr(sync, undefined);
  return btn;
}
export const syncCopyButton = (b: HTMLButtonElement | null | undefined): void =>
  void b?.dispatchEvent(new Event('copy-sync'));
export function wrapInputWithCopy(
  inputEl: HTMLInputElement,
  o?: StrOpt<'testId' | 'title'> & { alwaysShow?: boolean },
): HTMLDivElement {
  const getText = () => inputEl.value.trim();
  const copyBtn = createCopyIconButton({
    getText,
    title: o?.title ?? 'Copy value',
    testId: o?.testId,
    className: 'input-inline-copy-btn',
    watchEl: inputEl,
  });
  const sync = (): void => {
    const v = getText();
    const ok = inputEl.type !== 'password' && canCopyStr(v);
    const show = Boolean(v && ok && (o?.alwaysShow || v.length >= 22));
    inputEl.classList.toggle('has-inline-copy', show);
    setHide(copyBtn, !show);
    syncCopyButton(copyBtn);
  };
  for (const e of ['input', 'change']) inputEl.addEventListener(e, sync);
  sync();
  return el('div', 'input-copy-wrap', inputEl, copyBtn);
}

export function applyDocumentTheme(theme: 'dark' | 'light'): void {
  sa(document.documentElement, 'data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  const q = (n: string) => document.querySelector(`meta[name="${n}"]`);
  q('color-scheme')?.setAttribute('content', theme);
  q('theme-color')?.setAttribute(
    'content',
    theme === 'light' ? '#faf7f2' : '#24211e',
  );
}
const isTheme = (v: unknown): v is 'dark' | 'light' =>
  v === 'dark' || v === 'light';
export function initChildThemeSync(onTheme?: (t: 'dark' | 'light') => void) {
  const cur = document.documentElement.getAttribute('data-theme');
  const saved = tryOr(() => window.localStorage.getItem(THEME_KEY), null);
  const fb = cur === 'light' ? 'light' : 'dark';
  const apply = (next: 'dark' | 'light'): void => {
    applyDocumentTheme(next);
    onTheme?.(next);
  };
  apply(isTheme(saved) ? saved : fb);
  const hasBc = typeof BroadcastChannel === 'function';
  const ch = hasBc ? new BroadcastChannel('iwa-sink-theme') : null;
  ch?.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { type?: string; theme?: unknown } | null;
    if (d?.type === 'THEME_CHANGE' && isTheme(d.theme)) apply(d.theme);
  });
  window.addEventListener('storage', (ev: StorageEvent) => {
    if (ev.key === THEME_KEY && isTheme(ev.newValue)) apply(ev.newValue);
  });
  return ch;
}

function getSwPolicy(): TrustedTypePolicy | null {
  if (typeof window === 'undefined' || !window.trustedTypes) return null;
  const host = globalThis as Record<string, unknown>;
  if (host[TT_KEY]) return host[TT_KEY] as TrustedTypePolicy;
  return tryOr(() => {
    const p = window.trustedTypes!.createPolicy('iwa-sink-sw', {
      createScriptURL: (input: string) => {
        const u = new URL(input, window.location.origin);
        if (u.origin !== window.location.origin)
          throw new TypeError(`Blocked cross-origin SW URL: ${input}`);
        return u.pathname + u.search;
      },
    });
    host[TT_KEY] = p;
    return p;
  }, null);
}
const swPolicy: TrustedTypePolicy | null = getSwPolicy();
export const toTrustedScriptURL = (url: string): TrustedScriptURL | string =>
  (swPolicy ?? getSwPolicy())?.createScriptURL(url) ?? url;
export async function registerAppServiceWorker(scriptUrl = '/sw.js') {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return null;
  try {
    const trusted = toTrustedScriptURL(scriptUrl);
    if (import.meta.env.DEV) return null;
    const opts: RegistrationOptions = { scope: '/', type: 'module' };
    return await navigator.serviceWorker.register(trusted, opts);
  } catch {
    return null;
  }
}

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
  createAlertBanner,
  createCard,
  createLogConsole,
  createWorkspaceHeader,
  el,
  formatLogTime,
} from '../../lib/dom';
import type {
  ShellContext,
  WorkspaceDefinition,
  WorkspaceLiveStatus,
} from '../../shell/contracts';

interface MediaDevicesExt extends MediaDevices {
  getAllScreensMedia?: () => Promise<MediaStream[]>;
}
interface TileEntry {
  stream: MediaStream;
  videoEl: HTMLVideoElement;
  tileEl: HTMLElement;
}

const SUBTITLE =
  'Capture live video streams across all connected displays simultaneously on ChromeOS, or share an individual screen or window.';
const EMPTY_CAP =
  'No active display streams. Click "Capture All Screens" or "Capture Single Screen" above to start.';
const RAW_LBL_RE = /^(?:screen|window|web-contents-media-stream):\d+:\d+\s*/i;
const div = (c: string, ...ch: Array<Node | string>) => el('div', c, ...ch);
const span = (c: string | null, t: string) => el('span', c, t);
const fmtErr = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}` : `${e}`;
const onClick = (b: HTMLElement, fn: () => unknown) =>
  b.addEventListener('click', () => void fn());

function tid<T extends HTMLElement>(n: T, id: string): T {
  n.dataset.testid = id;
  return n;
}
function btn(id: string, txt: string, cls: string, wrap = false) {
  const b = tid(el('button', cls, wrap ? span(null, txt) : txt), id);
  b.type = 'button';
  return b;
}

function normalizeLabel(raw: string | undefined, idx: number): string {
  const c = (raw ?? '').replace(RAW_LBL_RE, '').trim();
  if (!c) return `Screen ${idx + 1}`;
  return /^(?:monitor|screen|display|default)$/i.test(c)
    ? `${c[0].toUpperCase()}${c.slice(1)}`
    : c;
}

function fmtMeta(track?: MediaStreamTrack, v?: HTMLVideoElement): string {
  const s = typeof track?.getSettings === 'function' ? track.getSettings() : {};
  const dim = (a?: number, b?: number) =>
    a && a > 0 ? a : typeof b === 'number' && b > 0 ? Math.round(b) : 0;
  const [w, h] = [dim(v?.videoWidth, s.width), dim(v?.videoHeight, s.height)];
  const r = s.frameRate;
  const okR = typeof r === 'number' && Number.isFinite(r) && r > 0;
  const fps = okR ? Math.round(r) : 0;
  const [dims, rate] = [w && h ? `${w} × ${h}` : '', fps ? `${fps} fps` : ''];
  return dims && rate ? `${dims} · ${rate}` : dims || rate || 'Live stream';
}

function stopTracks(s: MediaStream) {
  let n = 0;
  for (const t of s.getTracks()) {
    try {
      t.stop();
      n += 1;
    } catch {}
  }
  return n;
}

function mountScreenCapture(container: HTMLElement, ctx: ShellContext): void {
  const setStatus = (state: WorkspaceLiveStatus['state'], label: string) =>
    ctx.setWorkspaceStatus('screen-capture', { state, label });
  setStatus('probing', 'Idle');

  const getMd = () => navigator.mediaDevices as MediaDevicesExt | undefined;
  const canAll = () => typeof getMd()?.getAllScreensMedia === 'function';
  const canSingle = () => typeof getMd()?.getDisplayMedia === 'function';
  const avail = (ok: boolean) => (ok ? 'available' : 'unavailable');

  const initLine = `[${formatLogTime()}] [init] Screen Capture ready — getAllScreensMedia=${avail(canAll())}, getDisplayMedia=${avail(canSingle())}.`;
  const log = createLogConsole({
    title: 'Screen Capture Console Log',
    logTestId: 'screen-console-log',
    clearBtnTestId: 'screen-clear-log-btn',
    toggleTestId: 'screen-toggle-console-btn',
    cardTestId: 'screen-console-card',
    cardClassName: 'sso-log-card screen-log-card',
    bodyId: 'screen-console-panel',
    ariaLabel: 'Screen capture console log',
    initialLines: [initLine],
  });
  const L = (s: string) => log.append(s);
  const errBanner = createAlertBanner({
    testId: 'cap-error-banner',
    inset: true,
    className: 'cap-error-banner',
  });

  const tiles: TileEntry[] = [];
  let inFlight = false;
  const gridWrap = tid(div('screen-streams-body'), 'screen-streams-grid');
  const bCls = 'btn btn-sm screen-action-btn';
  const stopAllBtn = btn('screen-stop-all-btn', 'Stop All', bCls);
  stopAllBtn.disabled = true;
  const sId = 'screen-capture-single-btn';
  const singleBtn = btn(sId, 'Capture Single Screen', bCls);
  const allCls = 'btn btn-primary btn-sm screen-primary-btn';
  const allBtn = btn(
    'screen-capture-all-btn',
    'Capture All Screens',
    allCls,
    true,
  );
  onClick(stopAllBtn, () => stopAll(true));
  onClick(singleBtn, () => runCapture('single'));
  onClick(allBtn, () => runCapture('all'));

  const syncBtns = () => {
    singleBtn.disabled = inFlight || !canSingle();
    allBtn.disabled = inFlight || !canAll();
  };
  syncBtns();
  const syncStatus = () => {
    const n = tiles.length;
    stopAllBtn.disabled = n === 0;
    if (n > 0) setStatus('online', `${n} screen${n === 1 ? '' : 's'} live`);
    else if (errBanner.isVisible()) setStatus('offline', 'Capture error');
    else setStatus('probing', 'Idle');
  };
  const renderEmpty = () => {
    const b = span('screen-empty-badge mono', 'No Active Streams');
    const c = span('screen-empty-caption', EMPTY_CAP);
    gridWrap.replaceChildren(div('screen-empty-state', b, c));
    syncStatus();
  };
  const stopAll = (logIt: boolean) => {
    let n = 0;
    for (const e of tiles.splice(0, tiles.length)) {
      n += stopTracks(e.stream);
      e.videoEl.srcObject = null;
      e.tileEl.remove();
    }
    if (logIt) errBanner.clear();
    renderEmpty();
    const stopMsg = `[stop] Stopped ${n} active MediaStreamTrack(s).`;
    if (logIt) L(n > 0 ? stopMsg : '[stop] No active streams.');
  };

  const mountTile = (
    grid: HTMLElement,
    stream: MediaStream,
    idx: number,
    label: string,
  ) => {
    const vt = stream.getVideoTracks?.()[0];
    const st = typeof vt?.getSettings === 'function' ? vt.getSettings() : {};
    const surf =
      (st as { displaySurface?: string }).displaySurface ?? 'monitor';
    const videoEl = el('video', 'screen-tile-video');
    videoEl.autoplay = videoEl.muted = videoEl.playsInline = true;
    videoEl.setAttribute('aria-label', `Live preview for ${label}`);
    videoEl.srcObject = stream;

    const initMeta = fmtMeta(vt, videoEl);
    const metaEl = span('screen-tile-meta mono tabular-nums', initMeta);
    metaEl.title = initMeta;
    const syncMeta = () => {
      metaEl.textContent = metaEl.title = fmtMeta(vt, videoEl);
    };
    for (const ev of ['loadedmetadata', 'resize'])
      videoEl.addEventListener(ev, syncMeta);

    let cleaned = false;
    let entry: TileEntry | null = null;
    const getNodes = () =>
      Array.from(gridWrap.querySelectorAll<HTMLElement>('.screen-tile'));
    const cleanup = (reason: 'ended' | 'stopped') => {
      if (cleaned) return;
      cleaned = true;
      const domIdx = getNodes().indexOf(tile);
      const i = entry ? tiles.indexOf(entry) : -1;
      if (i !== -1) tiles.splice(i, 1);
      stopTracks(stream);
      videoEl.srcObject = null;
      tile.remove();
      getNodes().forEach((t, k) =>
        t.setAttribute('data-testid', `screen-tile-${k}`),
      );
      const endMsg = `[stream-${domIdx >= 0 ? domIdx : idx}] MediaStreamTrack ended: "${label}"`;
      const stopMsg = `[stop] Stopped MediaStreamTrack: "${label}"`;
      L(reason === 'stopped' ? stopMsg : endMsg);
      if (!tiles.length) renderEmpty();
      else syncStatus();
    };

    const stopCls = 'btn btn-xs screen-tile-stop-btn';
    const stopBtn = btn('screen-tile-stop-btn', 'Stop', stopCls);
    stopBtn.title = `Stop stream "${label}"`;
    stopBtn.setAttribute('aria-label', `Stop stream ${label}`);
    onClick(stopBtn, () => cleanup('stopped'));
    const titleEl = span('screen-tile-title', label);
    titleEl.title = label;
    const caption = div('screen-tile-caption mono', titleEl, metaEl, stopBtn);
    const tile = div('screen-tile', div('screen-tile-stage', videoEl), caption);
    tid(tile, `screen-tile-${idx}`);

    entry = { stream, videoEl, tileEl: tile };
    tiles.push(entry);
    grid.appendChild(tile);
    const okMsg = `[stream-${idx}] ✓ MediaStreamTrack active: "${label}" (${initMeta}, displaySurface="${surf}")`;
    L(okMsg);
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => cleanup('ended'));
      if (t.readyState === 'ended') cleanup('ended');
    }
  };

  const renderStreams = (streams: MediaStream[], api: string) => {
    stopAll(false);
    if (!Array.isArray(streams) || !streams.length) {
      errBanner.show(`${api} returned 0 active display streams.`);
      renderEmpty();
      return L(`[capture] ${api} returned 0 streams.`);
    }
    const live = streams.filter((s) => {
      const tracks = s?.getTracks?.() ?? [];
      const ok = tracks.some((t) => t.readyState !== 'ended');
      if (!ok) {
        stopTracks(s);
        L(`[capture] Skipped stream from ${api} with already-ended track(s).`);
      }
      return ok;
    });
    if (!live.length) {
      const m = `Display sharing ended immediately before stream preview could attach (${api}).`;
      errBanner.show(m);
      return renderEmpty();
    }
    errBanner.clear();
    clearChildren(gridWrap);
    const grid = div('screen-tiles-grid');
    const bases = live.map((s, i) =>
      normalizeLabel(s.getVideoTracks?.()[0]?.label, i),
    );
    const freq = new Map<string, number>();
    for (const b of bases) freq.set(b, (freq.get(b) ?? 0) + 1);
    live.forEach((s, i) => {
      const b = bases[i];
      const lbl = (freq.get(b) ?? 0) > 1 ? `Screen ${i + 1} — ${b}` : b;
      mountTile(grid, s, i, lbl);
    });
    if (tiles.length) {
      gridWrap.appendChild(grid);
      syncStatus();
    } else renderEmpty();
  };

  async function runCapture(mode: 'single' | 'all') {
    if (inFlight) return;
    const [md, isAll] = [getMd(), mode === 'all'];
    if ((!isAll && !canSingle()) || (isAll && !canAll())) {
      const u = isAll
        ? 'Multi-screen capture (getAllScreensMedia) requires ChromeOS with MultiScreenCaptureAllowedForUrls.'
        : 'Single-screen capture (getDisplayMedia) is unavailable in this browser context.';
      errBanner.show(u);
      syncStatus();
      return L(`[capture] ${u}`);
    }
    errBanner.clear();
    stopAll(false);
    inFlight = true;
    syncBtns();
    const api = isAll ? 'getAllScreensMedia()' : 'getDisplayMedia()';
    L(`[capture] navigator.mediaDevices.${api} invoked…`);
    try {
      const streams = isAll
        ? await md!.getAllScreensMedia!()
        : [await md!.getDisplayMedia({ video: true, audio: false })];
      renderStreams(streams, api);
    } catch (err) {
      const msg = fmtErr(err);
      const isDom = err instanceof DOMException;
      const domBlk =
        isDom &&
        (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const reBlk = /notallowed|permission|policy|denied/i.test(msg);
      const blocked = isAll && (domBlk || reBlk);
      const hint = `Multi-screen capture was blocked (${msg}). Configure ChromeOS policy MultiScreenCaptureAllowedForUrls for ${window.location.origin}, or use "Capture Single Screen".`;
      const fail = `${isAll ? 'Multi-screen' : 'Single-screen'} capture failed: ${msg}`;
      errBanner.show(blocked ? hint : fail);
      syncStatus();
      L(`[capture] ${api} failed: ${msg}`);
    } finally {
      inFlight = false;
      syncBtns();
    }
  }

  window.addEventListener('pagehide', () => stopAll(false));
  renderEmpty();
  const streamsCard = createCard({
    title: 'Display Streams',
    headerRight: div('screen-header-actions', stopAllBtn, singleBtn, allBtn),
    banner: errBanner.root,
    className: 'sso-creds-card screen-streams-card',
    headerClassName: 'sso-card-header screen-card-header',
    bodyClassName: 'sso-creds-body screen-streams-body-wrap',
    body: gridWrap,
  });
  const hdr = createWorkspaceHeader({
    title: 'Screen Capture',
    subtitle: SUBTITLE,
    className: 'screen-header',
  });
  container.replaceChildren(hdr, streamsCard.root, log.root);
}

export const screenCaptureWorkspace: WorkspaceDefinition = {
  id: 'screen-capture',
  navLabel: 'Screen Capture',
  shortCode: 'SCR',
  title: 'Screen Capture',
  subtitle: SUBTITLE,
  mount: mountScreenCapture,
};

export const workspace = screenCaptureWorkspace;
export default screenCaptureWorkspace;

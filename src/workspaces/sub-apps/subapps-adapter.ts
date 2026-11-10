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

import { toTrustedScriptURL } from '../../lib/dom';
import {
  DEV_DYNAMIC_SUBAPPS_ENDPOINT as DEV_EP,
  getDynamicSubAppPaths,
  normalizeDynamicSubAppSpec as normSpec,
  sanitizeSubAppSlug as cleanSlug,
  type DynamicSubAppSpec,
} from '../../lib/dynamic-subapp-spec';

const TELNET_DESC =
  'Telnet client for Star Wars ASCII (towel.blinkenlights.nl:23).';
export const BUNDLED_SUBAPPS_CATALOG = [
  {
    id: '/sub/telnet/index.html',
    startUrl: '/sub/telnet/index.html',
    scope: '/sub/telnet/',
    name: 'IWA Telnet Terminal',
    shortName: 'Telnet',
    description: TELNET_DESC,
    iconUrl: '/images/telnet-512.png',
    badgeText: 'TCP',
    fileExtensions: ['.telnet', '.log', '.txt'] as readonly string[],
  },
] as const;

export type BundledSubAppCatalogEntry =
  (typeof BUNDLED_SUBAPPS_CATALOG)[number];

export interface InstalledSubAppItem {
  readonly rawId: string;
  readonly installPath: string;
  readonly scope: string;
  readonly appName: string;
  readonly kind: 'bundled' | 'dynamic';
  readonly slug?: string;
  readonly badgeText?: string;
  readonly accentColor?: string;
  readonly fileExtensions?: readonly string[];
  readonly customManifestFields?: Record<string, unknown>;
}

type Src = 'window.subApps' | 'navigator.subApps' | 'unavailable';
type Outcome = { ok: boolean; count: number; message: string };
type SpecIn = Partial<DynamicSubAppSpec>;
type RmTarget = InstalledSubAppItem | string;
type Rec = Record<string, unknown>;

const SPECS_KEY = 'iwa-sink:dynamic-subapps-v1';
const SURR_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const knownSpecs = new Map<string, DynamicSubAppSpec>();
function out(ok: boolean, count: number, message: string): Outcome {
  return { ok, count, message };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safe = (fn: () => void) => {
  try {
    fn();
  } catch {}
};
const errStr = (e: unknown) => (e instanceof Error ? e.message : String(e));
const devGet = (qs: string) =>
  fetch(`${DEV_EP}?${qs}`, { cache: 'no-store' }).catch(() => undefined);
const persistSpecs = () =>
  safe(() => {
    const json = JSON.stringify([...knownSpecs.values()]);
    localStorage?.setItem(SPECS_KEY, json);
  });

safe(() => {
  const hasLs = typeof localStorage !== 'undefined';
  const raw = hasLs && localStorage.getItem(SPECS_KEY);
  const ls: unknown = raw ? JSON.parse(raw) : null;
  if (Array.isArray(ls))
    for (const e of ls)
      if (e && typeof e === 'object') {
        const s = normSpec(e as SpecIn);
        knownSpecs.set(s.slug, s);
      }
});

export function sanitizeBadgeGlyphText(raw: string, fb = 'APP'): string {
  const clean = (v: string) => v.replace(SURR_RE, '').replace(/\s+/g, '');
  let acc = '';
  for (const cp of [...(clean(raw) || clean(fb) || 'APP')].slice(0, 3)) {
    const up = cp.toUpperCase();
    if (acc.length + up.length > 3) break;
    acc += up;
  }
  return acc || 'APP';
}

export function toRootRelativePath(raw: string): string {
  const t = raw.trim();
  if (!t) return '/';
  try {
    const base = window?.location?.origin || 'isolated-app://iwa-sink';
    return new URL(t, base).pathname || '/';
  } catch {
    return t.startsWith('/') ? t : `/${t}`;
  }
}

function detectProvider() {
  const wApi = typeof window !== 'undefined' ? window.subApps : undefined;
  const nApi = typeof navigator !== 'undefined' ? navigator.subApps : undefined;
  const api = wApi ?? nApi ?? null;
  const s1: Src = nApi ? 'navigator.subApps' : 'unavailable';
  const source: Src = wApi ? 'window.subApps' : s1;
  const badgeLabel = api ? `${source} · Active` : 'subApps API · Unavailable';
  return { api, source, badgeLabel, available: Boolean(api) };
}

async function ensureSwReady(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return null;
  const sw = navigator.serviceWorker;
  let reg = await sw.getRegistration().catch(() => undefined);
  if (!reg && !import.meta.env.DEV) {
    const u = toTrustedScriptURL('/sw.js');
    reg = await sw
      .register(u, { type: 'module', scope: '/' })
      .catch(() => undefined);
  }
  if (!reg) return null;
  if (reg.active?.state === 'activated' && sw.controller) return reg;
  await Promise.race([sw.ready.catch(() => undefined), sleep(2500)]);
  const cur = (await sw.getRegistration().catch(() => undefined)) ?? reg;
  if (!sw.controller && cur.active) {
    const onCtrl = (r: () => void) =>
      sw.addEventListener('controllerchange', () => r(), { once: true });
    await Promise.race([new Promise<void>(onCtrl), sleep(600)]);
  }
  return cur;
}

async function postToSw(reg: ServiceWorkerRegistration | null, msg: Rec) {
  const sw = navigator?.serviceWorker;
  const tgt = sw?.controller ?? reg?.active ?? reg?.waiting ?? reg?.installing;
  if (!tgt) return null;
  return new Promise<Rec | null>((resolve) => {
    let done = false;
    const ch = new MessageChannel();
    const fin = (v: Rec | null) => {
      if (done) return;
      done = true;
      safe(() => ch.port1.close());
      resolve(v);
    };
    const t = setTimeout(() => fin(null), 1500);
    ch.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      clearTimeout(t);
      fin(data && typeof data === 'object' ? (data as Rec) : null);
    };
    try {
      tgt.postMessage(msg, [ch.port2]);
    } catch {
      clearTimeout(t);
      fin(null);
    }
  });
}

const sendSwMsg = async (msg: Rec) => {
  const reg = await ensureSwReady();
  if (reg || navigator.serviceWorker?.controller) await postToSw(reg, msg);
};

export const getKnownDynamicSpec = (slug: string) =>
  knownSpecs.get(cleanSlug(slug));

function applySyncedSpecs(specs: unknown[]): void {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(SPECS_KEY))
    knownSpecs.clear();
  for (const raw of specs)
    if (raw && typeof raw === 'object') {
      const s = normSpec(raw as SpecIn);
      knownSpecs.set(s.slug, s);
    }
  if (knownSpecs.size > 0) persistSpecs();
}

export async function syncKnownDynamicSpecsFromBackend(): Promise<void> {
  if (import.meta.env.DEV) {
    const r = await fetch(DEV_EP, { cache: 'no-store' }).catch(() => null);
    const j = r?.ok ? ((await r.json()) as { specs?: unknown[] }) : null;
    if (Array.isArray(j?.specs)) applySyncedSpecs(j.specs);
    return;
  }
  const cmd = { type: 'LIST_DYNAMIC_SUBAPPS' };
  const rep = await postToSw(await ensureSwReady(), cmd);
  if (Array.isArray(rep?.specs)) applySyncedSpecs(rep.specs);
}

export async function registerDynamicSpecEverywhere(inSpec: SpecIn) {
  const b = inSpec.badgeText;
  const ov =
    b !== undefined
      ? { badgeText: sanitizeBadgeGlyphText(b, inSpec.name ?? 'APP') }
      : null;
  const spec = normSpec(ov ? { ...inSpec, ...ov } : inSpec);
  knownSpecs.set(spec.slug, spec);
  persistSpecs();
  const enc = encodeURIComponent(JSON.stringify(spec));
  if (import.meta.env.DEV) await devGet(`action=upsert&spec=${enc}`);
  await sendSwMsg({ type: 'REGISTER_DYNAMIC_SUBAPP', spec });
  return spec;
}

export async function unregisterDynamicSpecEverywhere(slug: string) {
  const clean = cleanSlug(slug);
  knownSpecs.delete(clean);
  persistSpecs();
  const enc = encodeURIComponent(clean);
  if (import.meta.env.DEV) await devGet(`action=remove&slug=${enc}`);
  await sendSwMsg({ type: 'UNREGISTER_DYNAMIC_SUBAPP', slug: clean });
}

export async function clearDynamicSpecsEverywhere() {
  knownSpecs.clear();
  persistSpecs();
  if (import.meta.env.DEV) await devGet('action=clear');
  await sendSwMsg({ type: 'CLEAR_DYNAMIC_SUBAPPS' });
}

function buildItem(rawId: string, val?: unknown): InstalledSubAppItem {
  const p0 = toRootRelativePath(rawId);
  const dyn = /^\/dynamic\/([a-z0-9-]+)(?:\/|$)/i.exec(p0);
  let name = typeof val === 'string' ? val.trim() : '';
  if (!name && val && typeof val === 'object') {
    const r = val as Rec;
    const c = r.appName ?? r.app_name ?? r.name ?? r.shortName;
    if (typeof c === 'string') name = c.trim();
  }
  if (dyn) {
    const slug = cleanSlug(dyn[1]);
    const p = getDynamicSubAppPaths(slug);
    const k = knownSpecs.get(slug);
    const badgeText = k?.badgeText ?? sanitizeBadgeGlyphText('', slug || 'APP');
    const appName = k?.name || name || `Dynamic ${slug}`;
    const base = { rawId, installPath: p.startUrl, scope: p.scope, appName };
    const { accentColor, fileExtensions, customManifestFields } = k ?? {};
    const meta = { accentColor, fileExtensions, customManifestFields };
    return { ...base, kind: 'dynamic', slug, badgeText, ...meta };
  }
  const cat = BUNDLED_SUBAPPS_CATALOG.find(
    (c) => c.id === p0 || c.startUrl === p0 || p0.startsWith(c.scope),
  );
  const sc = cat?.scope ?? (p0.endsWith('/index.html') ? p0.slice(0, -10) : p0);
  const base = { rawId, installPath: cat?.startUrl ?? p0, scope: sc };
  const { badgeText, fileExtensions } = cat ?? {};
  const appName = name || cat?.name || p0;
  return { ...base, appName, kind: 'bundled', badgeText, fileExtensions };
}

const rank = (p: string) =>
  p === '/sub/telnet/index.html' ? 0 : p.startsWith('/sub/') ? 1 : 2;
const NO_API = 'SubApps API unavailable in this browser context.';

export class SubAppsAdapter {
  public getProvider() {
    return detectProvider();
  }

  public async list(): Promise<InstalledSubAppItem[]> {
    const { api } = this.getProvider();
    if (!api) return [];
    const raw: unknown = await api.list();
    const map = new Map<string, InstalledSubAppItem>();
    const put = (id: string, v?: unknown) => {
      const i = buildItem(id, v);
      map.set(i.installPath, i);
    };
    if (Array.isArray(raw)) {
      for (const el of raw as unknown[]) {
        if (typeof el === 'string' && el.trim()) put(el);
        else if (el && typeof el === 'object') {
          const r = el as Rec;
          const mId = r.manifestId ?? r.manifest_id ?? r.unhashedAppId;
          const id = mId ?? r.id ?? r.installURL;
          if (typeof id === 'string' && id.trim()) put(id, r);
        }
      }
    } else if (raw instanceof Map) {
      for (const [k, v] of raw)
        if (typeof k === 'string' && k.trim()) put(k, v);
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Rec)) if (k.trim()) put(k, v);
    }
    const cmp = (a: InstalledSubAppItem, b: InstalledSubAppItem) =>
      rank(a.installPath) - rank(b.installPath) ||
      a.installPath.localeCompare(b.installPath);
    return [...map.values()].sort(cmp);
  }

  public async add(urls: readonly string[]): Promise<Outcome> {
    const clean = urls.map((u) => u.trim()).filter(Boolean);
    const paths = [...new Set(clean.map(toRootRelativePath))];
    if (!paths.length) return out(true, 0, 'No sub-apps specified (no-op).');
    const { api, source } = this.getProvider();
    if (!api) return out(false, 0, NO_API);
    await ensureSwReady();
    const haveSet = async () =>
      new Set((await this.list().catch(() => [])).map((i) => i.installPath));
    const n = paths.length;
    try {
      let res: unknown;
      try {
        res = await api.add(paths);
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        const pairs = paths.map((p) => [p, { installURL: p }]);
        res = await api.add(Object.fromEntries(pairs));
      }
      const have = await haveSet();
      const okN = paths.filter((p) => have.has(p)).length;
      const fObj =
        res && typeof res === 'object' ? (res as Rec).failedApps : null;
      const failed = fObj && typeof fObj === 'object' ? Object.keys(fObj) : [];
      if (failed.length > 0 && okN < n) {
        const msg = `${source}.add reported failed entries: ${failed.join(', ')}`;
        return out(false, okN, msg);
      }
      const msg = `Installed ${n} sub-app(s) via ${source}.add().`;
      return out(true, okN || n, msg);
    } catch (err) {
      const have = await haveSet();
      if (paths.every((p) => have.has(p))) {
        const msg = `All ${n} sub-app(s) already installed (idempotent).`;
        return out(true, n, msg);
      }
      return out(false, 0, `${source}.add() failed: ${errStr(err)}`);
    }
  }

  public async remove(targets: readonly RmTarget[]): Promise<Outcome> {
    const [rawIds, paths]: [string[], string[]] = [[], []];
    const uniq = (a: string[], v: string) => v && !a.includes(v) && a.push(v);
    for (const t of targets) {
      if (typeof t === 'string') {
        const s = t.trim();
        if (s) uniq(rawIds, s), uniq(paths, toRootRelativePath(s));
      } else uniq(rawIds, t.rawId), uniq(paths, t.installPath);
    }
    if (!rawIds.length)
      return out(true, 0, '0 installed sub-apps to remove (clean no-op).');
    const { api, source } = this.getProvider();
    if (!api) return out(false, 0, NO_API);
    const callRm = async (ids: string[]) => {
      if (!ids.length) return;
      try {
        await api.remove(ids);
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        const fn = api.remove as unknown as (id: string) => Promise<unknown>;
        for (const id of ids) await fn.call(api, id);
      }
    };
    try {
      await callRm(rawIds);
      const curList = await this.list().catch(() => []);
      const rem = new Set(curList.map((r) => r.installPath));
      const alts: string[] = [];
      for (const p of paths.filter((x) => rem.has(x))) {
        if (!rawIds.includes(p)) alts.push(p);
        else if (window?.location?.origin) {
          const href = new URL(p, window.location.origin).href;
          if (!rawIds.includes(href)) alts.push(href);
        }
      }
      if (alts.length) await callRm(alts).catch(() => undefined);
      const n = rawIds.length;
      return out(true, n, `Removed ${n} sub-app(s) via ${source}.remove().`);
    } catch (err) {
      return out(false, 0, `${source}.remove() failed: ${errStr(err)}`);
    }
  }
}

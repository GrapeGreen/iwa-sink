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
  buildDynamicSubAppHtml,
  buildDynamicSubAppManifest,
  DEV_DYNAMIC_SUBAPPS_ENDPOINT,
  getDynamicSubAppPaths,
  matchDynamicSubAppRoute,
  normalizeDynamicSubAppSpec,
  sanitizeSubAppSlug,
  SW_IWA_HEADERS,
  type DynamicSubAppSpec,
} from './lib/dynamic-subapp-spec';
import { generateBadgePng512 } from './lib/png512';

type SpecPatch = Partial<DynamicSubAppSpec>;
type SwMsg = { type?: string; spec?: SpecPatch; slug?: string };
type StoreOp<T> = (s: IDBObjectStore) => T;

const sw = self as unknown as ServiceWorkerGlobalScopeLike;
const [IDB_NAME, IDB_STORE] = ['iwa-sink-dynamic-subapps', 'specs'];
const specsBySlug = new Map<string, DynamicSubAppSpec>();
const deletedSlugs = new Set<string>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!sw.indexedDB) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const fail = () => ((dbPromise = null), resolve(null));
    try {
      const req = sw.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE))
          req.result.createObjectStore(IDB_STORE, { keyPath: 'slug' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => (db.close(), (dbPromise = null));
        db.onclose = () => (dbPromise = null);
        resolve(db);
      };
      req.onerror = req.onblocked = fail;
    } catch {
      fail();
    }
  });
  return dbPromise;
}

async function idbTx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore, done: (v: T) => void) => void,
  fb: T,
): Promise<T> {
  const db = await openDb();
  if (!db) return fb;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, mode);
      run(tx.objectStore(IDB_STORE), resolve);
      if (mode === 'readwrite')
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve(fb);
    } catch {
      resolve(fb);
    }
  });
}

function idbGet<T>(op: StoreOp<IDBRequest>, map: (r: unknown) => T, fb: T) {
  return idbTx(
    'readonly',
    (s, done) => {
      const req = op(s);
      req.onsuccess = () => done(map(req.result));
      req.onerror = () => done(fb);
    },
    fb,
  );
}
const idbMut = (op: StoreOp<unknown>) =>
  idbTx('readwrite', (s) => void op(s), undefined);

const hydration = idbGet(
  (s) => s.getAll(),
  (r) => (Array.isArray(r) ? r : []),
  [],
).then((ls) => {
  for (const raw of ls)
    if (raw && typeof raw === 'object') {
      const s = normalizeDynamicSubAppSpec(raw as SpecPatch);
      if (!specsBySlug.has(s.slug) && !deletedSlugs.has(s.slug))
        specsBySlug.set(s.slug, s);
    }
});

const putSpec = async (raw: SpecPatch) => {
  const spec = normalizeDynamicSubAppSpec(raw);
  deletedSlugs.delete(spec.slug);
  specsBySlug.set(spec.slug, spec);
  await idbMut((s) => s.put(spec));
  return spec;
};
const removeSpec = async (slugInput: string) => {
  const slug = sanitizeSubAppSlug(slugInput);
  deletedSlugs.add(slug);
  specsBySlug.delete(slug);
  await idbMut((s) => s.delete(slug));
  return slug;
};
const clearSpecs = async () => {
  for (const k of specsBySlug.keys()) deletedSlugs.add(k);
  specsBySlug.clear();
  await idbMut((s) => s.clear());
};
const listSpecs = () => [...specsBySlug.values()];
const BASE_HDRS = { ...SW_IWA_HEADERS, 'Cache-Control': 'no-store' };
const swRes = (body: BodyInit, type: string, status = 200) => {
  const headers = { ...BASE_HDRS, 'Content-Type': type };
  return new Response(body, { status, headers });
};
const jsonRes = (status: number, data: unknown) =>
  swRes(
    JSON.stringify(data, null, 2),
    'application/json; charset=utf-8',
    status,
  );

sw.addEventListener('install', (ev) =>
  ev.waitUntil(Promise.all([sw.skipWaiting(), hydration])),
);
sw.addEventListener('activate', (ev) =>
  ev.waitUntil(Promise.all([sw.clients.claim(), hydration])),
);

sw.addEventListener('message', (ev) => {
  const p = ev.data as SwMsg | null;
  if (!p || typeof p !== 'object') return;
  const reply = (m: unknown) => ev.ports[0]?.postMessage(m);
  let job: Promise<unknown> | null = null;
  if (p.type === 'REGISTER_DYNAMIC_SUBAPP' && p.spec)
    job = putSpec(p.spec).then((spec) =>
      reply({ ok: true, spec, paths: getDynamicSubAppPaths(spec.slug) }),
    );
  else if (p.type === 'UNREGISTER_DYNAMIC_SUBAPP' && typeof p.slug === 'string')
    job = removeSpec(p.slug).then((slug) => reply({ ok: true, slug }));
  else if (p.type === 'CLEAR_DYNAMIC_SUBAPPS')
    job = clearSpecs().then(() => reply({ ok: true, specs: [] }));
  else if (p.type === 'LIST_DYNAMIC_SUBAPPS')
    job = hydration.then(() => reply({ ok: true, specs: listSpecs() }));
  if (job) ev.waitUntil(job);
});

async function respondDevControl(req: Request): Promise<Response> {
  await hydration;
  const sp = new URL(req.url).searchParams;
  const method = (req.method || 'GET').toUpperCase();
  const [qAct, qSpec] = [sp.get('action'), sp.get('spec')];
  if (method === 'GET' && !qAct && !qSpec && !sp.has('slug'))
    return jsonRes(200, { ok: true, specs: listSpecs() });
  try {
    const src = (method === 'POST' ? await req.text() : '') || qSpec;
    const p: Record<string, unknown> = src
      ? JSON.parse(src)
      : Object.fromEntries(sp.entries());
    const act = qAct ?? (typeof p.action === 'string' ? p.action : '');
    if (act === 'clear' || (method === 'DELETE' && !sp.get('slug'))) {
      await clearSpecs();
      return jsonRes(200, { ok: true, specs: [] });
    }
    if (method === 'DELETE' || act === 'remove' || act === 'delete') {
      const slug = sp.get('slug') ?? (typeof p.slug === 'string' ? p.slug : '');
      await (slug ? removeSpec(slug) : clearSpecs());
      return jsonRes(200, { ok: true, specs: listSpecs() });
    }
    const raw = (
      p.spec && typeof p.spec === 'object' ? p.spec : p
    ) as SpecPatch;
    const spec = await putSpec(raw);
    const paths = getDynamicSubAppPaths(spec.slug);
    return jsonRes(200, { ok: true, spec, paths });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return jsonRes(400, { ok: false, error });
  }
}

async function respondDynamic(req: Request): Promise<Response> {
  await hydration;
  const url = new URL(req.url);
  const m = matchDynamicSubAppRoute(url.pathname);
  if (!m) return fetch(req);
  let spec = specsBySlug.get(m.slug);
  if (!spec && !deletedSlugs.has(m.slug)) {
    const toSpec = (r: unknown) =>
      r && typeof r === 'object'
        ? normalizeDynamicSubAppSpec(r as SpecPatch)
        : undefined;
    spec = await idbGet(
      (s) => s.get(sanitizeSubAppSlug(m.slug)),
      toSpec,
      undefined,
    );
    if (spec) specsBySlug.set(spec.slug, spec);
  }
  const sp = url.searchParams;
  const fbBadge = [...m.slug].slice(0, 3).join('').toUpperCase();
  const defSpec = {
    slug: m.slug,
    name: sp.get('name') ?? `Dynamic ${m.slug}`,
    badgeText: sp.get('badge') ?? fbBadge,
    accentColor: sp.get('accent') ?? '#10b981',
  };
  const resolved = spec ?? normalizeDynamicSubAppSpec(defSpec);
  if (m.asset === 'index.html')
    return swRes(buildDynamicSubAppHtml(resolved), 'text/html; charset=utf-8');
  if (m.asset === 'manifest.webmanifest') {
    const body = JSON.stringify(buildDynamicSubAppManifest(resolved), null, 2);
    return swRes(body, 'application/manifest+json; charset=utf-8');
  }
  const { badgeText, accentColor } = resolved;
  const png = await generateBadgePng512({ badgeText, accentColor });
  return swRes(png as unknown as BodyInit, 'image/png');
}

sw.addEventListener('fetch', (ev) => {
  const { pathname } = new URL(ev.request.url);
  if (pathname === DEV_DYNAMIC_SUBAPPS_ENDPOINT)
    return ev.respondWith(respondDevControl(ev.request));
  if (matchDynamicSubAppRoute(pathname))
    return ev.respondWith(respondDynamic(ev.request));
  if (pathname === '/sub/telnet/index.html') {
    const headers = {
      ...SW_IWA_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    };
    const load = fetch('/sub/telnet/').then(async (r) => {
      const status = r.ok ? 200 : r.status;
      return new Response(await r.text(), { status, headers });
    });
    ev.respondWith(load);
  }
});

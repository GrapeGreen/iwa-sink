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

export const DEV_DYNAMIC_SUBAPPS_ENDPOINT = '/__dev_dynamic_subapps';

export interface DynamicSubAppSpec {
  slug: string;
  name: string;
  shortName: string;
  accentColor: string;
  badgeText: string;
  fileExtensions: string[];
  customManifestFields?: Record<string, unknown>;
  createdAt: number;
}

type SpecIn = Partial<DynamicSubAppSpec> & { accentHex?: string };
type DynamicAsset = 'index.html' | 'manifest.webmanifest' | 'icon-512.png';
type Rec = Record<string, unknown>;

const [DEF_BG, DEF_ACCENT] = ['#24211e', '#10b981'];
const MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SURR_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ROUTE_RE =
  /^\/dynamic\/([a-z0-9-]+)(?:\/(|index\.html|manifest\.webmanifest|icon-512\.png))?$/i;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
Object.assign(ESC, { '"': '&quot;', "'": '&#39;' });

const isObj = (v: unknown): v is Rec =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
const sliceCp = (s: string, n: number) =>
  [...s.replace(SURR_RE, '')].slice(0, Math.max(0, n)).join('');
const isNonEmptyStr = (x: unknown): x is string =>
  typeof x === 'string' && Boolean(x.trim());
const trimStrings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter(isNonEmptyStr).map((x) => x.trim());

export function sanitizeSubAppSlug(raw: string): string {
  const low = raw.trim().toLowerCase();
  const s = low.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 48) || 'custom-tool';
}

function parseExts(exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of exts) {
    if (typeof raw !== 'string') continue;
    for (const p of raw.split(/[,\s]+/)) {
      const t = p.trim().toLowerCase();
      const dot = t ? (t.startsWith('.') ? t : `.${t}`) : '';
      if (/^\.[a-z0-9_-]{1,16}$/.test(dot) && !out.includes(dot)) out.push(dot);
    }
  }
  return out;
}

export function extractFileExtensionsFromHandlers(fh: unknown): string[] {
  const list = Array.isArray(fh) ? fh : isObj(fh) ? [fh] : [];
  const raw: string[] = [];
  for (const item of list)
    if (isObj(item) && isObj(item.accept))
      for (const val of Object.values(item.accept))
        raw.push(...trimStrings(val));
  return parseExts(raw);
}

function rewriteScopeUrl(rawUrl: string, slug: string): string {
  const t = rawUrl.trim();
  const pfx = `/dynamic/${slug}/`;
  if (!t) return `${pfx}index.html`;
  if (/^\/dynamic\/[^/]+\//i.test(t))
    return t.replace(/^\/dynamic\/[^/]+\//i, pfx);
  if (t.startsWith('?') || t.startsWith('#')) return `${pfx}index.html${t}`;
  if (t.startsWith('./')) return `${pfx}${t.slice(2)}`;
  const rel = !t.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(t);
  return rel ? `${pfx}${t}` : t;
}

function normalizeScopedValue(k: string, val: unknown, slug?: string): unknown {
  if (!slug || !Array.isArray(val)) return val;
  const s = sanitizeSubAppSlug(slug);
  const { startUrl } = getDynamicSubAppPaths(s);
  if (k === 'protocol_handlers' || k === 'shortcuts') {
    const fb = k === 'protocol_handlers' ? `${startUrl}?protocol=%s` : startUrl;
    return val.map((e) =>
      !isObj(e)
        ? e
        : {
            ...e,
            url: typeof e.url === 'string' ? rewriteScopeUrl(e.url, s) : fb,
          },
    );
  }
  if (k !== 'file_handlers') return val;
  return val.map((e) => {
    if (!isObj(e)) return e;
    const act = typeof e.action === 'string' ? e.action.trim() : '';
    const rec: Rec = { ...e, action: act ? rewriteScopeUrl(act, s) : startUrl };
    if (isObj(e.accept)) {
      const acc: Record<string, string[]> = {};
      for (const [mime, ev] of Object.entries(e.accept)) {
        const norm = parseExts(trimStrings(ev));
        if (norm.length) acc[mime] = norm;
      }
      if (Object.keys(acc).length) rec.accept = acc;
    }
    return rec;
  });
}

function normalizeCustomFields(raw: unknown, slug?: string) {
  let cand = raw;
  if (typeof cand === 'string' && cand.trim()) {
    try {
      cand = JSON.parse(cand);
    } catch {
      return undefined;
    }
  }
  if (!isObj(cand)) return undefined;
  const out: Rec = {};
  for (const [k, v] of Object.entries(cand))
    if (k.trim()) out[k.trim()] = normalizeScopedValue(k.trim(), v, slug);
  return Object.keys(out).length ? out : undefined;
}

export function normalizeDynamicSubAppSpec(p: SpecIn): DynamicSubAppSpec {
  const rawName = (p.name ?? 'Custom IWA Tool').trim();
  const name = sliceCp(rawName, 128) || 'Custom IWA Tool';
  const slug = sanitizeSubAppSlug(p.slug || name);
  const shortName = sliceCp((p.shortName ?? name).trim(), 24) || 'Custom App';
  const c = p.accentColor ?? p.accentHex ?? '';
  const accentColor = /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : DEF_ACCENT;
  const rawBadge = (p.badgeText ?? sliceCp(shortName, 2)).trim().toUpperCase();
  const badgeText = sliceCp(rawBadge, 3) || 'APP';
  const custom = normalizeCustomFields(p.customManifestFields, slug);
  const hExts = extractFileExtensionsFromHandlers(custom?.file_handlers);
  const eExts = p.fileExtensions ? parseExts(p.fileExtensions) : [];
  const fileExtensions = hExts.length ? hExts : !custom ? eExts : [];
  const okTs = typeof p.createdAt === 'number' && Number.isFinite(p.createdAt);
  const createdAt = okTs ? (p.createdAt as number) : Date.now();
  const base = { slug, name, shortName, accentColor, badgeText, createdAt };
  const ov = custom ? { customManifestFields: custom } : {};
  return { ...base, fileExtensions, ...ov };
}

export function getDynamicSubAppPaths(slugInput: string) {
  const scope = `/dynamic/${sanitizeSubAppSlug(slugInput)}/`;
  const [startUrl, iconUrl] = [`${scope}index.html`, `${scope}icon-512.png`];
  const manifestUrl = `${scope}manifest.webmanifest`;
  return { scope, startUrl, manifestUrl, iconUrl };
}

export function buildDynamicSubAppManifest(specInput: DynamicSubAppSpec): Rec {
  const spec = normalizeDynamicSubAppSpec(specInput);
  const p = getDynamicSubAppPaths(spec.slug);
  const ic = { src: p.iconUrl, sizes: '512x512', type: 'image/png' };
  const icons = ['any', 'maskable'].map((purpose) => ({ ...ic, purpose }));
  const m: Rec = {
    id: p.startUrl,
    name: spec.name,
    short_name: spec.shortName,
  };
  Object.assign(m, { start_url: p.startUrl, scope: p.scope, icons });
  Object.assign(m, { display: 'standalone', isolated_storage: true });
  Object.assign(m, { background_color: DEF_BG, theme_color: DEF_BG });
  m.launch_handler = { client_mode: 'focus-existing' };
  const hasFh = spec.customManifestFields?.file_handlers !== undefined;
  if (spec.fileExtensions.length && !hasFh) {
    const accept = { 'text/plain': spec.fileExtensions };
    m.file_handlers = [{ action: p.startUrl, accept }];
  }
  if (spec.customManifestFields)
    for (const [k, v] of Object.entries(spec.customManifestFields))
      m[k] = normalizeScopedValue(k, v, spec.slug);
  return m;
}

function buildCapabilityPills(spec: DynamicSubAppSpec): string[] {
  const pills: string[] = [];
  const c = spec.customManifestFields;
  const pRaw = c?.protocol_handlers;
  const pList = Array.isArray(pRaw) ? pRaw : isObj(pRaw) ? [pRaw] : [];
  const protos = new Set(
    pList.flatMap((e) => (isObj(e) ? trimStrings(e.protocol) : [])),
  );
  if (protos.size) pills.push(`Protocol: ${[...protos].join(', ')}`);
  if (spec.fileExtensions.length)
    pills.push(`Files: ${spec.fileExtensions.join(', ')}`);
  if (isObj(c?.launch_handler)) {
    const modes = trimStrings(c.launch_handler.client_mode);
    if (modes.length) pills.push(`Launch: ${modes.join(', ')}`);
  }
  const doArr = Array.isArray(c?.display_override) ? c.display_override : [];
  const doModes = trimStrings(doArr);
  const disp = typeof c?.display === 'string' ? c.display.trim() : '';
  if (doModes.length) pills.push(`Display: ${doModes.join(', ')}`);
  else if (disp && disp !== 'standalone') pills.push(`Display: ${disp}`);
  if (Array.isArray(c?.shortcuts) && c.shortcuts.length)
    pills.push(`Shortcuts: ${c.shortcuts.length}`);
  if (isObj(c?.permissions_policy)) {
    const keys = Object.keys(c.permissions_policy).filter((k) => k.trim());
    if (keys.length) pills.push(`Permissions: ${keys.join(', ')}`);
  }
  return pills;
}

function getBadgeFgHex(accentHex: string): string {
  const s = accentHex.trim().replace(/^#/, '');
  const f = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  const [r, g, b] = /^[0-9a-fA-F]{6}$/.test(f)
    ? [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16))
    : [16, 185, 129];
  const lin = (v: number) =>
    v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return (lum + 0.05) / 0.0601 >= 1.05 / (lum + 0.05) ? '#1c1917' : '#ffffff';
}

const mkBanner = (px: string, b: string, l: string, i1: string, i2: string) =>
  `<div class="protocol-banner is-hidden" id="${px}-launch-banner" data-testid="${px}-launch-banner"><div class="protocol-banner-header"><span class="protocol-badge" data-testid="${px}-launch-badge">${b}</span><span class="protocol-label">${l}</span></div><div class="protocol-restored-url" id="${i1}" data-testid="${i1}"></div><div class="protocol-raw-target" id="${i2}" data-testid="${i2}"></div></div>`;

export function buildDynamicSubAppHtml(specInput: DynamicSubAppSpec): string {
  const spec = normalizeDynamicSubAppSpec(specInput);
  const p = getDynamicSubAppPaths(spec.slug);
  const [n, sl] = [esc(spec.name), esc(spec.slug)];
  const [ac, bg] = [esc(spec.accentColor), esc(spec.badgeText)];
  const fg = getBadgeFgHex(spec.accentColor);
  const exts = esc(spec.fileExtensions.join(', '));
  const pills = buildCapabilityPills(spec);
  const pHtml = pills
    .map((x) => `<span class="pill">${esc(x)}</span>`)
    .join('');
  const caps = pills.length
    ? `<div class="row" data-testid="dynamic-subapp-capabilities">${pHtml}</div>`
    : '';
  const b1 = mkBanner(
    'protocol',
    'PROTOCOL LAUNCH',
    'Restored Protocol Handler URL',
    'protocol-restored-url',
    'protocol-raw-target',
  );
  const b2 = mkBanner(
    'file',
    'FILE LAUNCH',
    'Opened File Handler Payload',
    'file-launch-names',
    'file-launch-preview',
  );
  const css = [
    `:root,[data-theme='dark']{color-scheme:dark;--bg-canvas:#24211e;--bg-surface:#2e2a27;--bg-elevated:#35302c;--bg-log:#1c1917;--text-log:#f5efe6;--border-subtle:rgba(245,235,220,.11);--text-primary:#f5efe6;--text-secondary:#b5ada2;--text-muted:#b5ada2;--accent:${ac};--accent-fg:${fg}}`,
    `[data-theme='light']{color-scheme:light;--bg-canvas:#faf7f2;--bg-surface:#fff;--bg-elevated:#f3efe8;--bg-log:#1c1917;--text-log:#f5efe6;--border-subtle:rgba(45,35,25,.12);--text-primary:#24211e;--text-secondary:#68625b;--text-muted:#68625b;--accent:${ac};--accent-fg:${fg}}`,
    `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg-canvas);color:var(--text-primary);font-family:'Roboto',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;padding:24px}`,
    `.card{max-width:680px;margin:0 auto;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden}.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle)}`,
    `.pill{font-family:${MONO};font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid var(--border-subtle);color:var(--text-secondary);font-variant-numeric:tabular-nums;min-width:0;max-width:100%;overflow-wrap:anywhere}.body{padding:16px;display:flex;flex-direction:column;gap:12px}`,
    `.log{margin:0;padding:12px;border-radius:8px;background:var(--bg-log);border:1px solid var(--border-subtle);font-family:${MONO};font-size:12px;color:var(--text-log);min-height:110px;max-height:220px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}`,
    `.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;max-width:100%}.bar .row>div{flex:1 1 140px;min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}.icon{width:44px;height:44px;flex-shrink:0;border-radius:8px;border:1px solid var(--border-subtle)}.is-hidden{display:none!important}`,
    `.protocol-banner{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:8px;border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--bg-elevated))}.protocol-banner-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}`,
    `.protocol-badge{font-family:${MONO};font-size:12px;font-weight:600;padding:4px 8px;border-radius:4px;background:var(--accent);color:var(--accent-fg)}.protocol-label{font-size:12px;font-weight:600;color:var(--text-primary)}`,
    `.protocol-restored-url{font-family:${MONO};font-size:14px;font-weight:600;color:var(--text-log);padding:8px 10px;border-radius:6px;background:var(--bg-log);border:1px solid var(--border-subtle);word-break:break-all}.protocol-raw-target{font-family:${MONO};font-size:12px;color:var(--text-muted);word-break:break-all}`,
    `@media(max-width:480px){body,.body,.bar{padding:12px}}`,
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><meta name="color-scheme" content="dark light"/><meta name="theme-color" content="${DEF_BG}"/><title>${n} — Dynamic Sub-App</title><link rel="manifest" href="${p.manifestUrl}"/><link rel="icon" type="image/png" href="${p.iconUrl}"/><style>${css}</style></head><body data-subapp-slug="${sl}" data-subapp-id="${p.startUrl}" data-subapp-scope="${p.scope}" data-subapp-name="${n}" data-subapp-accent="${ac}" data-subapp-badge="${bg}" data-subapp-exts="${exts}"><div class="card"><div class="bar"><div class="row"><img class="icon" src="${p.iconUrl}" alt="${bg}" width="44" height="44"/><div><div style="font-weight:600">${n}</div><div style="font-size:12px;color:var(--text-muted)">Scope: ${p.scope}</div></div></div></div><div class="body">${b1}${b2}${caps}<pre class="log" id="dynamic-subapp-log" data-testid="dynamic-subapp-log"></pre></div></div><script type="module" src="/subapp-dynamic-client.js"></script></body></html>`;
}

export function matchDynamicSubAppRoute(pathname: string) {
  const m = ROUTE_RE.exec(pathname);
  if (!m) return null;
  const slug = sanitizeSubAppSlug(m[1]);
  const raw = (m[2] ?? '').toLowerCase();
  const asset: DynamicAsset | null =
    !raw || raw === 'index.html'
      ? 'index.html'
      : raw === 'manifest.webmanifest' || raw === 'icon-512.png'
        ? raw
        : null;
  return asset ? { slug, asset } : null;
}

const IWA_CSP =
  "base-uri 'none'; default-src 'self'; object-src 'none'; frame-src 'self' https: blob: data:; connect-src 'self' https: wss: blob: data:; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https: blob: data:; media-src 'self' https: blob: data:; font-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'; frame-ancestors 'self';";

export const DYNAMIC_IWA_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });

export const SW_IWA_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...DYNAMIC_IWA_HEADERS,
  'Content-Security-Policy': IWA_CSP,
});

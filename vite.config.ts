/**
 * Copyright 2024 Google LLC
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import wbn from 'rollup-plugin-webbundle';
import * as wbnSign from 'wbn-sign';

import {
  buildDynamicSubAppHtml,
  buildDynamicSubAppManifest,
  DEV_DYNAMIC_SUBAPPS_ENDPOINT,
  DYNAMIC_IWA_HEADERS,
  getDynamicSubAppPaths,
  matchDynamicSubAppRoute,
  normalizeDynamicSubAppSpec,
  sanitizeSubAppSlug,
  type DynamicSubAppSpec,
} from './src/lib/dynamic-subapp-spec';
import { generateBadgePng512 } from './src/lib/png512';

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEV_KEY = path.resolve(ROOT, 'certs', 'dev-ed25519.pem');
const PORT = Number(process.env.PORT) || 5193;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) =>
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c),
    );
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', fail);
  });

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
) {
  const hdrs = {
    ...DYNAMIC_IWA_HEADERS,
    'Content-Type': type,
    'Cache-Control': 'no-store',
  };
  res.writeHead(status, hdrs);
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, data: unknown) =>
  send(
    res,
    status,
    'application/json; charset=utf-8',
    JSON.stringify(data, null, 2),
  );

function dynamicSubAppsDevPlugin(): Plugin {
  const specs = new Map<string, DynamicSubAppSpec>();
  const list = () => [...specs.values()];

  return {
    name: 'iwa-sink:dynamic-subapps-middleware',
    transform(code, id) {
      if (!id.includes('vite/dist/client/client.mjs')) return null;
      return code.replace(
        'const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${__HMR_BASE__}`;\nconst directSocketHost = __HMR_DIRECT_TARGET__;',
        'const directSocketHost = __HMR_DIRECT_TARGET__;\nconst socketHost = hmrPort ? `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${hmrPort}${__HMR_BASE__}` : directSocketHost;',
      );
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/subapp-dynamic-client.js') {
          req.url = '/src/lib/subapp-dynamic-client.ts';
          return next();
        }
        if (u.pathname === DEV_DYNAMIC_SUBAPPS_ENDPOINT) {
          const method = (req.method ?? 'GET').toUpperCase();
          const sp = u.searchParams;
          const qAct = sp.get('action');
          const qSpec = sp.get('spec');
          if (method === 'GET' && !qAct && !qSpec && !sp.has('slug'))
            return sendJson(res, 200, { ok: true, specs: list() });
          try {
            const body = method === 'POST' ? await readBody(req) : '';
            const p: Record<string, unknown> = body
              ? JSON.parse(body)
              : qSpec
                ? JSON.parse(qSpec)
                : Object.fromEntries(sp.entries());
            const act = qAct ?? (typeof p.action === 'string' ? p.action : '');
            if (act === 'clear' || (method === 'DELETE' && !sp.get('slug'))) {
              specs.clear();
              return sendJson(res, 200, { ok: true, specs: [] });
            }
            if (method === 'DELETE' || act === 'remove' || act === 'delete') {
              const slug =
                sp.get('slug') ?? (typeof p.slug === 'string' ? p.slug : '');
              if (slug) specs.delete(sanitizeSubAppSlug(slug));
              else specs.clear();
              return sendJson(res, 200, { ok: true, specs: list() });
            }
            const raw = (
              p.spec && typeof p.spec === 'object' ? p.spec : p
            ) as Partial<DynamicSubAppSpec>;
            const spec = normalizeDynamicSubAppSpec(raw);
            specs.set(spec.slug, spec);
            return sendJson(res, 200, {
              ok: true,
              spec,
              paths: getDynamicSubAppPaths(spec.slug),
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return sendJson(res, 400, { ok: false, error });
          }
        }
        const m = matchDynamicSubAppRoute(u.pathname);
        if (!m) return next();
        const sp = u.searchParams;
        const spec =
          specs.get(m.slug) ??
          normalizeDynamicSubAppSpec({
            slug: m.slug,
            name: sp.get('name') ?? `Dynamic ${m.slug}`,
            badgeText: sp.get('badge') ?? m.slug.slice(0, 3).toUpperCase(),
            accentColor: sp.get('accent') ?? '#10b981',
          });
        if (m.asset === 'index.html')
          return send(
            res,
            200,
            'text/html; charset=utf-8',
            buildDynamicSubAppHtml(spec),
          );
        if (m.asset === 'manifest.webmanifest') {
          const json = JSON.stringify(
            buildDynamicSubAppManifest(spec),
            null,
            2,
          );
          return send(
            res,
            200,
            'application/manifest+json; charset=utf-8',
            json,
          );
        }
        const png = await generateBadgePng512({
          badgeText: spec.badgeText,
          accentColor: spec.accentColor,
        });
        send(res, 200, 'image/png', Buffer.from(png));
      });
    },
  };
}

function bundledSubAppManifestsPlugin(): Plugin {
  const rel = 'sub/telnet/manifest.webmanifest';
  return {
    name: 'iwa-sink:bundled-subapp-manifests',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const html = bundle['sub/telnet/index.html'];
      if (html?.type === 'asset' && typeof html.source === 'string')
        html.source = html.source.replace(
          /<link\s+rel="manifest"[^>]*>/i,
          `<link rel="manifest" href="/${rel}" />`,
        );
      const abs = path.resolve(ROOT, rel);
      if (fs.existsSync(abs) && !bundle[rel])
        this.emitFile({
          type: 'asset',
          fileName: rel,
          source: fs.readFileSync(abs, 'utf-8'),
        });
    },
  };
}

async function resolveSigningKey(): Promise<crypto.KeyObject> {
  const envKey = (process.env.SIGNING_KEY || process.env.KEY || '').trim();
  const pass = process.env.KEY_PASSPHRASE || process.env.PRIVATE_KEY_PASSWORD;
  if (envKey) {
    const pem = envKey.includes('-----BEGIN')
      ? Buffer.from(envKey, 'utf-8')
      : fs.readFileSync(path.resolve(ROOT, envKey));
    return wbnSign.parsePemKey(pem, pass);
  }
  if (!fs.existsSync(DEV_KEY)) {
    fs.mkdirSync(path.dirname(DEV_KEY), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(DEV_KEY, privateKey, { encoding: 'utf-8', mode: 0o600 });
  }
  return wbnSign.parsePemKey(fs.readFileSync(DEV_KEY));
}

export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = [
    dynamicSubAppsDevPlugin(),
    bundledSubAppManifestsPlugin(),
  ];
  if (command === 'build') {
    const key = await resolveSigningKey();
    const baseURL = new wbnSign.WebBundleId(
      key,
    ).serializeWithIsolatedWebAppOrigin();
    const rawWbn = wbn({
      baseURL,
      static: { dir: 'public' },
      output: 'iwa-sink.swbn',
      headerOverride: (url: string) => {
        if (url.endsWith('.webmanifest'))
          return {
            ...DYNAMIC_IWA_HEADERS,
            'Content-Type': 'application/manifest+json; charset=utf-8',
          };
        if (url.endsWith('/sub/telnet/') || url.endsWith('/sub/telnet'))
          return {
            ...DYNAMIC_IWA_HEADERS,
            'Content-Type': 'text/html; charset=utf-8',
          };
        return { ...DYNAMIC_IWA_HEADERS };
      },
      integrityBlockSign: {
        isIwa: false,
        strategy: new wbnSign.NodeCryptoSigningStrategy(key),
      },
    }) as Plugin;

    plugins.push({
      ...rawWbn,
      name: 'iwa-sink:wbn-bundle-wrapper',
      enforce: 'post',
      async generateBundle(opts, bundle, isWrite) {
        const clone: typeof bundle = { ...bundle };
        const html = clone['sub/telnet/index.html'];
        if (html?.type === 'asset')
          clone['sub/telnet/'] = { ...html, fileName: 'sub/telnet/' };
        if (typeof rawWbn.generateBundle === 'function')
          await rawWbn.generateBundle.call(this, opts, clone, isWrite);
      },
    });
  }

  const entryNames: Record<string, string> = {
    sw: 'sw.js',
    'subapp-dynamic-client': 'subapp-dynamic-client.js',
  };

  return {
    plugins,
    server: {
      host: '127.0.0.1',
      port: PORT,
      strictPort: false,
      hmr: { protocol: 'ws', host: '127.0.0.1' },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(ROOT, 'index.html'),
          hud: resolve(ROOT, 'hud.html'),
          'sub-telnet': resolve(ROOT, 'sub/telnet/index.html'),
          sw: resolve(ROOT, 'src/sw.ts'),
          'subapp-dynamic-client': resolve(
            ROOT,
            'src/lib/subapp-dynamic-client.ts',
          ),
        },
        output: {
          entryFileNames: ({ name }: { name: string }) =>
            entryNames[name] ?? 'assets/[name]-[hash].js',
        },
      },
    },
  };
});

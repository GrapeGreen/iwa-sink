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
  applyDocumentTheme,
  initChildThemeSync,
  updateLogTextStickToBottom,
} from './dom';
import { connectChildSubAppBus, type SubAppBusMessage } from './subapp-bus';

type TgtMsg = { appId: string; scope?: string; targetInstanceId?: string };
const SCHEME_RE = /^[a-z][a-z0-9+.-]*(?::\/\/|%3a%2f%2f)/i;

function extractProto(raw: string) {
  const t = raw.trim();
  if (!t) return null;
  try {
    const base = window?.location?.origin || 'isolated-app://iwa-sink';
    const sp = new URL(t, base).searchParams;
    let cand = sp.get('protocol') ?? sp.get('url') ?? sp.get('params');
    if (!cand)
      for (const [, v] of sp.entries())
        if (SCHEME_RE.test(v.trim())) {
          cand = v;
          break;
        }
    if (!cand?.trim()) return null;
    let u = cand.trim();
    try {
      if (/%[0-9a-f]{2}/i.test(u)) u = decodeURIComponent(u);
    } catch {}
    return { restoredUrl: u, targetUrl: t };
  } catch {
    return null;
  }
}

function initDynamicSubAppClient(): void {
  const themeCh = initChildThemeSync();
  const ds = document.body?.dataset ?? {};
  const slug = ds.subappSlug ?? 'custom-tool';
  const appId = ds.subappId ?? `/dynamic/${slug}/index.html`;
  const scope = ds.subappScope ?? `/dynamic/${slug}/`;
  const title = ds.subappName ?? 'Dynamic Sub-App';
  const byId = (id: string) => document.getElementById(id);
  const setTxt = (id: string, txt: string) => {
    const n = byId(id);
    if (n) n.textContent = txt;
  };
  const logEl = byId('dynamic-subapp-log');
  const log = (line: string) => {
    if (!logEl) return;
    const ts = new Date().toISOString().slice(11, 23);
    const next = `${logEl.textContent ?? ''}[${ts}] ${line}\n`;
    updateLogTextStickToBottom(logEl, next);
  };
  log(`Mounted dynamic sub-app "${title}" (${appId})`);

  const bootUrls = new Set<string>();
  const onTargetUrl = (rawUrl: string, src: 'boot' | 'launchQueue') => {
    const t = rawUrl.trim();
    if (!t) return;
    let href = t;
    try {
      href = new URL(t, window.location.origin).href;
    } catch {}
    if (src === 'launchQueue' && (bootUrls.has(t) || bootUrls.has(href))) {
      bootUrls.delete(t);
      bootUrls.delete(href);
      return;
    }
    const info = extractProto(t);
    if (info) {
      if (src === 'boot') bootUrls.add(t).add(href);
      byId('protocol-launch-banner')?.classList.remove('is-hidden');
      setTxt('protocol-restored-url', info.restoredUrl);
      setTxt('protocol-raw-target', `targetURL: ${info.targetUrl}`);
      const r = info.restoredUrl;
      log(`[PROTOCOL LAUNCH] Restored URL: ${r} (targetURL: ${t})`);
    } else if (src === 'launchQueue') log(`LaunchQueue targetURL: ${t}`);
  };
  onTargetUrl(window.location.href, 'boot');

  let lastTel = '';
  const instKey = `iwa-sink.subapp.instanceId:${appId}`;
  const isSelf = (m: TgtMsg) => {
    if (!m.targetInstanceId)
      return m.appId === appId || Boolean(m.scope && m.scope === scope);
    try {
      return sessionStorage.getItem(instKey) === m.targetInstanceId;
    } catch {
      return false;
    }
  };

  const onMessage = (m: SubAppBusMessage) => {
    if (m.type === 'PARENT_PING')
      log(`Received PARENT_PING (nonce=${m.nonce}) -> replied SUBAPP_PONG`);
    else if (m.type === 'CLOSE_SUBAPP' && isSelf(m))
      log('Received CLOSE_SUBAPP from parent -> closing window');
    else if (m.type === 'FOCUS_SUBAPP' && isSelf(m)) {
      try {
        window.focus();
      } catch {}
      log('Received FOCUS_SUBAPP from parent -> focused window');
    } else if (m.type === 'SHELL_TELEMETRY') {
      if (m.theme === 'light' || m.theme === 'dark')
        applyDocumentTheme(m.theme);
      const k = `${m.activeWorkspace}|${m.tcpEchoRunning}|${m.tcpEchoPort}`;
      if (k !== lastTel) {
        lastTel = k;
        const echo = m.tcpEchoRunning ? m.tcpEchoPort : 'off';
        log(`Shell telemetry: workspace=${m.activeWorkspace}, tcpEcho=${echo}`);
      }
    }
  };
  const bus = connectChildSubAppBus({ appId, scope, title, onMessage });
  window.addEventListener('pagehide', () => (bus.close(), themeCh?.close()));

  window.launchQueue?.setConsumer(async (params) => {
    const files = params.files ?? [];
    if (!files.length) {
      if (params.targetURL) onTargetUrl(params.targetURL, 'launchQueue');
      return;
    }
    const names = files.map((f) => f.name).join(', ');
    log(`LaunchQueue received ${files.length} file(s): ${names}`);
    const snippets: string[] = [];
    for (const h of files) {
      if (!h) continue;
      try {
        const c = h as FileSystemFileHandle & { text?: () => Promise<string> };
        const src = c.getFile ? await c.getFile() : c;
        const txt = src.text ? await src.text() : '';
        const clean = txt.replace(/\s+/g, ' ').trim().slice(0, 160);
        const suf = clean ? `: ${clean}` : '';
        snippets.push(
          clean ? `${h.name}: ${clean}` : `${h.name} (${txt.length} chars)`,
        );
        log(`[FILE LAUNCH] ${h.name} (${txt.length} chars)${suf}`);
      } catch {
        snippets.push(h.name);
      }
    }
    byId('file-launch-banner')?.classList.remove('is-hidden');
    setTxt('file-launch-names', names);
    const fb = `${files.length} file(s) opened via File Handling API`;
    setTxt('file-launch-preview', snippets.join(' · ') || fb);
    if (params.targetURL && extractProto(params.targetURL))
      onTargetUrl(params.targetURL, 'launchQueue');
  });
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', initDynamicSubAppClient, {
    once: true,
  });
else initDynamicSubAppClient();

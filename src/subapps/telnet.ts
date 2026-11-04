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

import '../style.css';
import {
  applyDocumentTheme,
  createWorkspaceHeader,
  el,
  initChildThemeSync,
} from '../lib/dom';
import { connectChildSubAppBus } from '../lib/subapp-bus';
import {
  createTcpClientPanel,
  parseTcpTargetEndpoint,
} from '../workspaces/tcp-terminal/tcp-client-panel';

function extractProfileTarget(rawText: string) {
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const p = parseTcpTargetEndpoint(line);
    return p.ok && p.embeddedPort
      ? { host: p.host, port: p.embeddedPort }
      : null;
  }
  return null;
}

const themeCh = initChildThemeSync();
const root = document.getElementById('subapp-root');
if (root) {
  const panel = createTcpClientPanel({
    title: 'Standalone Telnet ANSI Terminal',
    captionTag: '/sub/telnet/',
    defaultHost: 'towel.blinkenlights.nl',
    defaultPort: '23',
  });
  const bus = connectChildSubAppBus({
    appId: '/sub/telnet/index.html',
    scope: '/sub/telnet/',
    title: 'IWA Telnet Terminal',
    onMessage: (m) => {
      const th = m.type === 'SHELL_TELEMETRY' ? m.theme : null;
      if (th === 'light' || th === 'dark') applyDocumentTheme(th);
    },
  });
  if (document.visibilityState === 'visible')
    bus.post({ type: 'HUD_COMMAND', action: 'ping', ts: Date.now() });
  window.launchQueue?.setConsumer(async (params) => {
    for (const h of params.files ?? []) {
      if (h.kind !== 'file') continue;
      try {
        const f = await (h as FileSystemFileHandle).getFile();
        const txt = await f.text();
        const t = extractProfileTarget(txt);
        if (t) panel.setHostPort(t.host, t.port);
        panel.loadTranscriptText(f.name, txt);
      } catch {}
    }
  });
  window.addEventListener('pagehide', () => {
    void panel.disconnect();
    bus.close();
    themeCh?.close();
  });
  const hdr = createWorkspaceHeader({
    title: 'IWA Telnet Terminal',
    subtitle:
      'Standalone Direct Sockets TCPSocket ANSI terminal pre-configured for towel.blinkenlights.nl:23 (Star Wars ASCII over Telnet) or custom TCP endpoints.',
    right: el('span', 'meta-tag mono', 'Sub-App · /sub/telnet/'),
  });
  root.replaceChildren(el('div', 'subapp-shell', hdr, panel.root));
}

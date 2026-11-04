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
  createArrowRightSvg,
  createCard,
  createWorkspaceHeader,
  createWorkspaceIconSvg,
  el,
} from '../../lib/dom';
import type {
  ShellContext,
  WorkspaceDefinition,
  WorkspaceId,
} from '../../shell/contracts';

const isCrOS = (): boolean =>
  typeof navigator !== 'undefined' && /\bCrOS\b/i.test(navigator.userAgent);

const leadCopy = (cros: boolean): string =>
  `An interactive reference app for Isolated Web Apps (IWAs) — showing how signed web bundles unlock raw TCP sockets, embedded guest sites, loopback OAuth sign-in, installable sub-apps, desktop window controls, ${cros ? 'unframed windows, multi-screen capture, ' : ''}and companion extension messaging.`;

const getRows = (cros: boolean): string[] => [
  'tcp-terminal|TCP Echo|emerald|Run a local loopback TCP echo server over IPv4 or IPv6 and exchange live messages from the built-in TCP client — or connect to any remote TCP host.',
  'controlled-frame-tls|Controlled Frame|indigo|Embed cross-origin web pages in an isolated partition, inspect live X.509 certificates, and inject scripts or styles.',
  'sso-offloading|SSO Loopback|amber|Sign in with Google OAuth 2.0 PKCE in the system browser and capture the redirect callback on a local TCP loopback listener.',
  'sub-apps|Sub-Apps|rose|Install and launch the bundled Telnet Terminal IWA or build custom sub-apps on the fly.',
  `windowing-hud|Windowing|teal|Minimize, maximize, or restore the app window, ${cros ? 'inspect live window bounds and connected displays, and open an unframed companion window.' : 'toggle window resizability, and inspect live window bounds and connected displays.'}`,
  ...(cros
    ? [
        'screen-capture|Screen Capture|indigo|Capture a single display with the system picker or stream all connected screens simultaneously into live video tiles.',
      ]
    : []),
  'extension-bridge|Extension|emerald|Exchange structured JSON messages with an installed companion Chrome extension and inspect live responses.',
];

export const overviewWorkspace: WorkspaceDefinition = {
  id: 'overview',
  navLabel: 'Overview',
  title: 'Welcome to IWA Sink',
  subtitle: leadCopy(isCrOS()),
  mount(container: HTMLElement, ctx: ShellContext): void {
    const cros = isCrOS();
    ctx.setWorkspaceStatus('overview', { state: 'online', label: 'Ready' });
    const header = createWorkspaceHeader({
      title: 'Welcome to IWA Sink',
      subtitle: leadCopy(cros),
      className: 'overview-header',
      subtitleClassName: 'overview-lead',
    });
    const listEl = el('div', {
      className: 'overview-directory-list',
      testId: 'overview-directory-list',
    });
    for (const spec of getRows(cros)) {
      const [id, title, tone, desc] = spec.split('|') as [
        WorkspaceId,
        string,
        string,
        string,
      ];
      const icon = el(
        'div',
        `overview-row-icon overview-tone-${tone}`,
        createWorkspaceIconSvg(id, 22, 'overview-row-icon-svg'),
      );
      icon.setAttribute('aria-hidden', 'true');
      const copy = el(
        'div',
        'subapp-row-copy',
        el('h3', 'overview-row-title', title),
        el('p', 'overview-row-desc', desc),
      );
      const btn = el(
        'button',
        'btn overview-open-btn',
        el('span', null, 'Open'),
        createArrowRightSvg(14, 'overview-open-arrow'),
      );
      btn.type = 'button';
      btn.dataset.testid = `overview-open-${id}`;
      btn.setAttribute('aria-label', `Open ${title}`);
      btn.addEventListener('click', () => ctx.activateWorkspace(id));
      const row = el(
        'div',
        'overview-directory-row',
        el('div', 'subapp-row-left', icon, copy),
        el('div', 'overview-row-action', btn),
      );
      row.dataset.testid = `overview-row-${id}`;
      listEl.appendChild(row);
    }
    const card = createCard({
      title: 'Interactive Capability Directory',
      className: 'overview-directory-card',
      headerClassName: 'overview-directory-card-header',
      testId: 'overview-directory-card',
      headerRight: el(
        'span',
        'ws-meta-label',
        'Select any capability below to try it live',
      ),
      rawChildren: [listEl],
    });
    container.replaceChildren(header, card.root);
  },
};

export const workspace: WorkspaceDefinition = overviewWorkspace;
export default overviewWorkspace;

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

import type { ProtocolInspectionResult } from '../lib/protocol';

const WORKSPACE_IDS = [
  'overview',
  'tcp-terminal',
  'controlled-frame-tls',
  'sso-offloading',
  'sub-apps',
  'windowing-hud',
  'screen-capture',
  'extension-bridge',
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export interface WorkspaceLiveStatus {
  state: 'online' | 'portal' | 'offline' | 'probing';
  label: string;
}

export type ProtocolLaunchListener = (
  rawUrl: string,
  parsedProtocolUrl: string,
  inspection: ProtocolInspectionResult,
) => void;

export interface ShellContext {
  activateWorkspace(id: WorkspaceId): void;
  getActiveWorkspace(): WorkspaceId;
  setWorkspaceStatus(id: WorkspaceId, status: WorkspaceLiveStatus): void;
  onProtocolLaunch(listener: ProtocolLaunchListener): () => void;
  dispatchProtocolLaunch(rawUrl: string): void;
  registerControlledFrameNavigator(
    fn: (url: string, inspection?: ProtocolInspectionResult) => void,
  ): void;
}

export interface WorkspaceDefinition {
  id: WorkspaceId;
  navLabel: string;
  shortCode?: string;
  title: string;
  subtitle: string;
  mount(container: HTMLElement, ctx: ShellContext): void | Promise<void>;
}

export function isWorkspaceId(v: string | null | undefined): v is WorkspaceId {
  return Boolean(v && (WORKSPACE_IDS as readonly string[]).includes(v));
}

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

interface ClearDataTypeSet {
  appcache?: boolean;
  webSQL?: boolean;
}
interface WebRequestInterceptorOptions {
  securityInfo?: boolean;
  securityInfoRawDer?: boolean;
}
interface WebRequestSecurityInfo {
  readonly state: 'secure' | 'broken' | 'insecure' | string;
  readonly certificates?: ReadonlyArray<{ readonly rawDER?: ArrayBuffer }>;
}
interface WebRequestHeadersReceivedEvent extends WebRequestEvent {
  readonly securityInfo?: WebRequestSecurityInfo;
}
type HdrsListener = (
  this: WebRequestInterceptor,
  ev: WebRequestHeadersReceivedEvent,
) => unknown;
interface WebRequestInterceptor {
  addEventListener(
    type: 'headersreceived',
    fn: HdrsListener,
    opts?: boolean | AddEventListenerOptions,
  ): void;
}
interface LoadStartEvent extends Event {
  readonly url?: string;
  readonly isTopLevel?: boolean;
  readonly loadInfo?: LoadInfo;
}
interface ExitEvent extends Event {
  readonly processId?: number;
  readonly reason?: string;
  readonly exitInfo?: { readonly processId?: number; readonly reason?: string };
}
interface NewWindowEvent extends Event {
  readonly targetUrl?: string;
  readonly window?: NewWindowController;
  readonly name?: string;
}
interface DialogEvent extends Event {
  readonly messageType?: DialogType | string;
  readonly messageText?: string;
  readonly dialog?: DialogController;
}
interface HTMLControlledFrameElementEventMap {
  loadstart: LoadStartEvent;
  exit: ExitEvent;
}
interface HTMLControlledFrameElement {
  getProcessId?(): number;
}
interface SubAppsEntry {
  appName?: string;
  manifestId?: string;
  [key: string]: unknown;
}
type SubAppsRes = Record<string, unknown> & {
  failedApps?: Record<string, unknown>;
};
interface SubAppsAPI {
  add(
    apps: string[] | Record<string, { installURL: string }>,
  ): Promise<SubAppsRes | Record<string, string>>;
  list(): Promise<Record<string, SubAppsEntry> | SubAppsEntry[]>;
  remove(apps: string[]): Promise<SubAppsRes | Record<string, string> | string>;
}
interface ScreenDetailed extends Screen {
  readonly left: number;
  readonly top: number;
  readonly isInternal: boolean;
  readonly devicePixelRatio: number;
  readonly label: string;
}
interface ScreenDetails extends EventTarget {
  readonly screens: readonly ScreenDetailed[];
  readonly currentScreen: ScreenDetailed;
}
interface LaunchQueue {
  setConsumer(
    fn: (p: {
      readonly targetURL?: string;
      readonly files: ReadonlyArray<FileSystemHandle>;
    }) => void | Promise<void>,
  ): void;
}
type TrustedScriptURL = string & { readonly __trustedScriptUrlBrand?: true };
interface TrustedTypePolicy {
  readonly name: string;
  createScriptURL(input: string, ...args: unknown[]): TrustedScriptURL;
}
interface Window {
  readonly subApps?: SubAppsAPI;
  readonly launchQueue?: LaunchQueue;
  readonly trustedTypes?: {
    createPolicy(
      name: string,
      opts?: { createScriptURL?: (input: string, ...a: unknown[]) => string },
    ): TrustedTypePolicy;
  };
  getScreenDetails?(): Promise<ScreenDetails>;
  minimize?(): Promise<void>;
  maximize?(): Promise<void>;
  restore?(): Promise<void>;
  setResizable?(resizable: boolean): Promise<void>;
}
interface Navigator {
  readonly subApps?: SubAppsAPI;
}
interface SwExtEv extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEv extends SwExtEv {
  readonly request: Request;
  readonly clientId: string;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwMsgEv extends SwExtEv {
  readonly data: unknown;
  readonly ports: ReadonlyArray<MessagePort>;
  readonly source: { postMessage(msg: unknown): void } | null;
}
interface SwClient {
  id: string;
  url: string;
  postMessage(msg: unknown): void;
}
interface ServiceWorkerGlobalScopeLike extends EventTarget {
  readonly clients: {
    claim(): Promise<void>;
    matchAll(opts?: {
      type?: 'window' | 'worker' | 'sharedworker' | 'all';
    }): Promise<SwClient[]>;
  };
  readonly caches: CacheStorage;
  readonly indexedDB: IDBFactory;
  readonly location: Location;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    fn: (ev: SwExtEv) => void,
  ): void;
  addEventListener(type: 'fetch', fn: (ev: SwFetchEv) => void): void;
  addEventListener(type: 'message', fn: (ev: SwMsgEv) => void): void;
}
declare module 'rollup-plugin-webbundle' {
  interface WebBundleOptions {
    baseURL?: string;
    static?: { dir: string; baseURL?: string };
    output?: string;
    headerOverride?:
      | Record<string, string>
      | ((url: string) => Record<string, string>);
    integrityBlockSign?: { isIwa?: boolean; strategy?: unknown };
  }
  export default function wbnOutputPlugin(opts: WebBundleOptions): unknown;
}

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

export const SUBAPP_BUS_CHANNEL = 'iwa-sink-subapps';

type BaseMsg = { appId: string; scope: string; ts: number };
type InstOpt = { title?: string; instanceId?: string };
type Beat<T> = BaseMsg & { type: T; title: string; instanceId?: string };
type CmdBase = { appId: string; scope?: string; targetInstanceId?: string };
type Cmd<T> = CmdBase & { type: T; ts: number };
type CloseReason = 'close' | 'pagehide';
type ClosedMsg = BaseMsg &
  InstOpt & { type: 'SUBAPP_CLOSED'; reason?: CloseReason };
type PongMsg = BaseMsg & {
  type: 'SUBAPP_PONG';
  nonce: string;
  echoPayload?: string;
};
type HudAct = 'focus-parent' | 'focus-hud' | 'ping';
type ShellTelMsg = {
  type: 'SHELL_TELEMETRY';
  activeWorkspace: string;
  tcpEchoRunning: boolean;
  tcpEchoHost?: string | null;
  tcpEchoPort: number | null;
  tcpBytesEchoed: number;
  mdnsServicesCount?: number;
  theme?: 'dark' | 'light';
  ts: number;
};

export type SubAppBusMessage =
  | Beat<'SUBAPP_HELLO'>
  | Beat<'SUBAPP_HEARTBEAT'>
  | ClosedMsg
  | Cmd<'CLOSE_SUBAPP'>
  | Cmd<'FOCUS_SUBAPP'>
  | { type: 'QUERY_OPEN_SUBAPPS'; ts: number }
  | { type: 'PARENT_PING'; nonce: string; payload?: string; ts: number }
  | PongMsg
  | ShellTelMsg
  | { type: 'HUD_COMMAND'; action: HudAct; ts: number };

type ChildHook = {
  respondToPing?: boolean;
  onMessage?: (msg: SubAppBusMessage) => void;
};
type ChildOpts = { appId: string; scope: string; title: string } & ChildHook;

const KINDS =
  'SUBAPP_HELLO|SUBAPP_HEARTBEAT|SUBAPP_CLOSED|CLOSE_SUBAPP|FOCUS_SUBAPP|' +
  'QUERY_OPEN_SUBAPPS|PARENT_PING|SUBAPP_PONG|SHELL_TELEMETRY|HUD_COMMAND';
const MSG_TYPES = new Set(KINDS.split('|'));
const isBusMsg = (v: unknown): v is SubAppBusMessage => {
  const t = v && typeof v === 'object' ? (v as { type?: unknown }).type : '';
  return MSG_TYPES.has(`${t}`);
};
const safe = (fn: () => void) => {
  try {
    fn();
  } catch {}
};

export class SubAppBus {
  private readonly ch: BroadcastChannel | null;
  private readonly subs = new Set<(msg: SubAppBusMessage) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(name = SUBAPP_BUS_CHANNEL) {
    const ok = typeof BroadcastChannel !== 'undefined';
    this.ch = ok ? new BroadcastChannel(name) : null;
    this.ch?.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (!isBusMsg(ev.data)) return;
      const m = ev.data;
      if (m.type === 'SUBAPP_HELLO' || m.type === 'SUBAPP_HEARTBEAT') {
        this.cancel(m.instanceId, m.appId);
      } else if (m.type === 'SUBAPP_CLOSED') {
        const k = m.instanceId || m.appId;
        this.cancel(m.instanceId, m.appId);
        if (m.reason === 'pagehide' && k) {
          const flush = () => (this.timers.delete(k), this.emit(m));
          this.timers.set(k, setTimeout(flush, 240));
          return;
        }
      }
      this.emit(m);
    });
  }

  private cancel(...keys: Array<string | undefined>): void {
    for (const k of keys) {
      const t = k ? this.timers.get(k) : undefined;
      if (t !== undefined && k) {
        clearTimeout(t);
        this.timers.delete(k);
      }
    }
  }

  private emit(msg: SubAppBusMessage): void {
    for (const fn of this.subs) fn(msg);
  }

  public post(m: SubAppBusMessage): void {
    if (m.type === 'CLOSE_SUBAPP') this.cancel(m.targetInstanceId, m.appId);
    this.ch?.postMessage(m);
  }

  public subscribe(fn: (msg: SubAppBusMessage) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  public close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.subs.clear();
    this.ch?.close();
  }
}

export function connectChildSubAppBus(opts: ChildOpts): SubAppBus {
  const bus = new SubAppBus();
  const PFX = 'iwa-sink.subapp.instanceId:';
  const keys = [PFX + opts.appId, PFX + opts.scope];
  let saved: string | null = null;
  safe(() => {
    saved = sessionStorage.getItem(keys[0]) || sessionStorage.getItem(keys[1]);
  });
  const hadSaved = Boolean(saved);
  const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const instanceId = saved || `${opts.appId}#${tag}`;
  const syncStore = (save: boolean) =>
    safe(() => {
      for (const k of keys)
        if (save) sessionStorage.setItem(k, instanceId);
        else sessionStorage.removeItem(k);
    });

  let [closed, announced] = [false, false];
  let hb: ReturnType<typeof setInterval> | null = null;
  const isVis = () =>
    typeof document === 'undefined' || document.visibilityState === 'visible';
  const { appId, scope, title } = opts;
  const base = { appId, scope, title, instanceId };

  const emitHello = () => {
    if (closed) return;
    announced = true;
    syncStore(true);
    bus.post({ type: 'SUBAPP_HELLO', ...base, ts: Date.now() });
  };
  const emitHb = () => {
    if (closed) return;
    if (!announced) return void ((isVis() || hadSaved) && emitHello());
    bus.post({ type: 'SUBAPP_HEARTBEAT', ...base, ts: Date.now() });
  };
  const startHb = () => {
    if (hb === null && typeof window !== 'undefined')
      hb = setInterval(emitHb, 1500);
  };
  const notifyClosed = (reason: CloseReason = 'pagehide') => {
    if (closed) return;
    closed = true;
    if (hb !== null) clearInterval(hb);
    hb = null;
    if (reason === 'close') syncStore(false);
    if (announced)
      bus.post({ type: 'SUBAPP_CLOSED', ...base, reason, ts: Date.now() });
  };
  const isTarget = (m: Cmd<'CLOSE_SUBAPP' | 'FOCUS_SUBAPP'>) =>
    m.targetInstanceId
      ? m.targetInstanceId === instanceId
      : m.appId === appId || Boolean(m.scope && m.scope === scope);

  bus.subscribe((m) => {
    const canReply = announced || hadSaved || isVis();
    if (m.type === 'PARENT_PING' && opts.respondToPing !== false) {
      const p = { type: 'SUBAPP_PONG' as const, appId, scope, nonce: m.nonce };
      bus.post({ ...p, echoPayload: m.payload, ts: Date.now() });
    } else if (m.type === 'QUERY_OPEN_SUBAPPS' && canReply) {
      emitHello();
      startHb();
    } else if (m.type === 'CLOSE_SUBAPP' && isTarget(m)) {
      opts.onMessage?.(m);
      notifyClosed('close');
      safe(() => window?.close?.());
      return;
    } else if (m.type === 'FOCUS_SUBAPP' && isTarget(m)) {
      safe(() => window?.focus?.());
    }
    opts.onMessage?.(m);
  });

  if (isVis() || hadSaved) emitHello(), startHb();
  if (typeof window !== 'undefined') {
    const wake = () => (!announced ? (emitHello(), startHb()) : emitHb());
    window.addEventListener('visibilitychange', () => isVis() && wake());
    window.addEventListener('focus', wake);
    window.addEventListener('beforeunload', () => notifyClosed('pagehide'));
    window.addEventListener('pagehide', () => notifyClosed('pagehide'));
  }
  const origClose = bus.close.bind(bus);
  bus.close = () => (notifyClosed('pagehide'), origClose());
  return bus;
}

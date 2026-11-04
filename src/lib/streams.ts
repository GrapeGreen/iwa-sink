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

const enc = new TextEncoder();
const quiet = (p: Promise<unknown> | undefined) => void p?.catch(() => {});
const safe = (fn: () => void) => {
  try {
    fn();
  } catch {}
};
const toBytes = (d: Uint8Array | string) =>
  typeof d === 'string' ? enc.encode(d) : d;

interface TcpConnectionHandlers {
  onChunk: (chunk: Uint8Array) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

export class ManagedTcpConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  public remoteAddress = '';
  public remotePort = 0;
  public localAddress = '';
  public localPort = 0;
  public bytesRead = 0;
  public bytesWritten = 0;

  constructor(public readonly socket: TCPSocket) {
    quiet(socket.opened);
    quiet(socket.closed);
  }
  public get isClosed(): boolean {
    return this.closed;
  }

  public async open(h: TcpConnectionHandlers, opts?: { signal?: AbortSignal }) {
    const sig = opts?.signal;
    const cancelErr = () =>
      sig?.reason ?? new DOMException('Connection cancelled.', 'AbortError');
    if (sig?.aborted) {
      await this.close();
      throw cancelErr();
    }
    let onAbort: (() => void) | null = null;
    const waitAbort = sig
      ? new Promise<never>((_, rej) => {
          onAbort = () => rej(cancelErr());
          sig.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    let info: TCPSocketOpenInfo;
    try {
      info = await (waitAbort
        ? Promise.race([this.socket.opened, waitAbort])
        : this.socket.opened);
    } catch (err) {
      if (sig?.aborted) await this.close();
      throw err;
    } finally {
      if (sig && onAbort) sig.removeEventListener('abort', onAbort);
    }
    if (this.closed || sig?.aborted) {
      await this.close();
      throw cancelErr();
    }
    this.remoteAddress = info.remoteAddress ?? '';
    this.remotePort = info.remotePort ?? 0;
    this.localAddress = info.localAddress ?? '';
    this.localPort = info.localPort ?? 0;
    this.reader = info.readable.getReader();
    this.writer = info.writable.getWriter();
    void this.pumpRead(h);
    return info;
  }

  private async releaseLocks(cancel: boolean): Promise<void> {
    const [r, w] = [this.reader, this.writer];
    this.reader = this.writer = null;
    if (r && cancel) await r.cancel().catch(() => {});
    safe(() => r?.releaseLock());
    safe(() => w?.releaseLock());
  }

  private async pumpRead(h: TcpConnectionHandlers): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.byteLength) {
          this.bytesRead += value.byteLength;
          h.onChunk(value);
        }
      }
    } catch (err) {
      if (!this.closed) h.onError?.(err);
    } finally {
      const wasClosed = this.closed;
      this.closed = true;
      await this.releaseLocks(false);
      if (!wasClosed) h.onClose?.();
    }
  }

  public async send(payload: Uint8Array | string): Promise<number> {
    if (this.closed || !this.writer)
      throw new Error('TCP connection is not open for writing.');
    const bytes = toBytes(payload);
    await this.writer.ready;
    await this.writer.write(bytes);
    this.bytesWritten += bytes.byteLength;
    return bytes.byteLength;
  }

  public close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const done = () => this.socket.close().catch(() => {});
    return (this.closing = this.releaseLocks(true).then(done));
  }
}

interface ManagedTcpServerStartOptions {
  host?: string;
  port?: number;
  dualStack?: boolean;
  backlog?: number;
  onClient: (c: ManagedTcpConnection, raw: TCPSocket) => void | Promise<void>;
  onStop?: () => void;
}

export class ManagedTcpServer {
  private server: TCPServerSocket | null = null;
  private acceptReader: ReadableStreamDefaultReader<TCPSocket> | null = null;
  private readonly activeConnections = new Set<ManagedTcpConnection>();
  private running = false;
  public localAddress = '';
  public localPort = 0;

  public isRunning(): boolean {
    return this.running;
  }
  public get activeClientCount(): number {
    return this.activeConnections.size;
  }
  public removeConnection(conn: ManagedTcpConnection): void {
    this.activeConnections.delete(conn);
  }

  public async broadcast(payload: Uint8Array | string) {
    const bytes = toBytes(payload);
    let [clientsSent, bytesSent] = [0, 0];
    for (const conn of [...this.activeConnections]) {
      if (conn.isClosed) continue;
      try {
        bytesSent += await conn.send(bytes);
        clientsSent += 1;
      } catch {}
    }
    return { clientsSent, bytesSent };
  }

  public async start(options: ManagedTcpServerStartOptions) {
    if (typeof TCPServerSocket === 'undefined')
      throw new Error(
        'Direct Sockets TCPServerSocket API is unavailable in this context.',
      );
    if (this.running) await this.stop();
    const bindAddr = options.host || '127.0.0.1';
    const sockOpts: TCPServerSocketOptions = {};
    if (options.port !== undefined && options.port > 0)
      sockOpts.localPort = options.port;
    if (options.backlog !== undefined) sockOpts.backlog = options.backlog;

    const srv = new TCPServerSocket(bindAddr, sockOpts);
    quiet(srv.opened);
    quiet(srv.closed);
    const info = await srv.opened;
    this.server = srv;
    this.running = true;
    this.localAddress = info.localAddress || bindAddr;
    this.localPort = info.localPort ?? options.port ?? 0;
    const reader = (this.acceptReader = info.readable.getReader());

    void (async () => {
      try {
        while (this.running && this.acceptReader === reader) {
          const { value: sock, done } = await reader.read();
          if (done || !sock) break;
          const conn = new ManagedTcpConnection(sock);
          this.activeConnections.add(conn);
          const drop = () => this.activeConnections.delete(conn);
          sock.closed.then(drop, drop);
          quiet(Promise.resolve(options.onClient(conn, sock)));
        }
      } catch {
      } finally {
        safe(() => reader.releaseLock());
        if (this.acceptReader === reader) this.acceptReader = null;
        if (this.server === srv) {
          const wasRunning = this.running;
          this.running = false;
          if (wasRunning) options.onStop?.();
        }
      }
    })();
    return { localAddress: this.localAddress, localPort: this.localPort };
  }

  public async stop(): Promise<void> {
    this.running = false;
    const conns = [...this.activeConnections];
    const [srv, reader] = [this.server, this.acceptReader];
    this.server = this.acceptReader = null;
    this.activeConnections.clear();
    await Promise.allSettled(conns.map((c) => c.close()));
    if (reader) {
      await reader.cancel().catch(() => {});
      safe(() => reader.releaseLock());
    }
    if (srv) await srv.close().catch(() => {});
    this.localPort = 0;
  }
}

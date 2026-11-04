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

import { clearChildren, el } from '../../lib/dom';

interface SgrStyle {
  fg: string | null;
  bg: string | null;
  b: number;
}
interface TermCell {
  ch: string;
  styleKey: string;
  style: SgrStyle;
}
interface AnsiTerminalOptions {
  testId?: string;
  onInput?: (data: string) => void;
}
type ParserState = 'NORMAL' | 'ESC' | 'ESC_INT' | 'CSI' | 'STR' | 'STR_ESC';

const [MAX_LINES, MAX_COLS, MAX_BUF] = [500, 16_384, 256];
const [DEF_FG, DEF_BG] = ['#f5efe6', '#1c1917'];
const STD_HEX = '#f87171,#34d399,#fbbf24,#60a5fa,#c084fc,#22d3ee,#e4e4e7';
const BRI_HEX = '#fca5a5,#6ee7b7,#fde68a,#93c5fd,#d8b4fe,#67e8f9,#ffffff';
const FG_STD = ['#94949e', ...STD_HEX.split(',')];
const BG_STD = ['#27272a', ...STD_HEX.split(',')];
const FG_BRI = ['#b0b0ba', ...BRI_HEX.split(',')];
const BG_BRI = ['#52525b', ...BRI_HEX.split(',')];
const CUBE = [0, 95, 135, 175, 215, 255];
const CLR_BIT: Record<number, number> = { 21: 3, 22: 3, 23: 4, 24: 8, 27: 16 };
const KEY_MAP: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};
const mkStyle = (): SgrStyle => ({ fg: null, bg: null, b: 0 });
const DEF_STYLE: SgrStyle = Object.freeze(mkStyle());
const BLANK: TermCell = { ch: ' ', styleKey: '', style: DEF_STYLE };
const styleKeyOf = (s: SgrStyle) =>
  !s.fg && !s.bg && !s.b ? '' : `${s.fg ?? ''}|${s.bg ?? ''}|${s.b}`;
const clamp255 = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(255, n === 0 ? 0 : n | 0)) : 0;

function xterm256(idx: number, fg: boolean): string | null {
  if (!Number.isFinite(idx) || idx < 0 || idx > 255) return null;
  const i = idx | 0;
  if (i < 8) return (fg ? FG_STD : BG_STD)[i];
  if (i < 16) return (fg ? FG_BRI : BG_BRI)[i - 8];
  if (i < 232) {
    const c = i - 16;
    return `rgb(${CUBE[(c / 36) | 0]}, ${CUBE[((c % 36) / 6) | 0]}, ${CUBE[c % 6]})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g}, ${g}, ${g})`;
}

export class AnsiTerminalSurface {
  public readonly root: HTMLDivElement;
  private dec = new TextDecoder('utf-8', { fatal: false });
  private state: ParserState = 'NORMAL';
  private csi = '';
  private strLen = 0;
  private lines: TermCell[][] = [[]];
  private row = 0;
  private col = 0;
  private sRow = 0;
  private sCol = 0;
  private sty: SgrStyle = mkStyle();
  private styKey = '';

  constructor(opts?: AnsiTerminalOptions) {
    const root = el('div', 'terminal-surface');
    root.dataset.testid = opts?.testId ?? 'tcp-terminal-screen';
    root.tabIndex = 0;
    root.setAttribute('role', 'log');
    root.setAttribute('aria-label', 'ANSI TCP Terminal Screen');
    const setBdr = (v: string) => () => void (root.style.borderColor = v);
    root.addEventListener('focus', setBdr('var(--border-focus)'));
    root.addEventListener('blur', setBdr(''));
    this.root = root;
    const emit = opts?.onInput;
    if (!emit) return;
    const send = (ev: Event, s: string) => {
      ev.preventDefault();
      emit(s);
    };
    root.addEventListener('keydown', (ev: KeyboardEvent) => {
      const k = ev.key;
      const isPaste = ev.ctrlKey && (k === 'v' || k === 'V');
      if (k === 'Tab' || k === 'Escape' || ev.metaKey || isPaste) return;
      if (ev.ctrlKey && k.length === 1) {
        const u = k.toUpperCase().charCodeAt(0);
        if (u >= 64 && u <= 95) {
          if (u === 67 && window.getSelection()?.toString()) return;
          return send(ev, String.fromCharCode(u - 64));
        }
      }
      if (KEY_MAP[k] !== undefined) return send(ev, KEY_MAP[k]);
      if ((k.length === 1 || [...k].length === 1) && !ev.altKey) send(ev, k);
    });
    root.addEventListener('paste', (ev: ClipboardEvent) => {
      const txt = ev.clipboardData?.getData('text/plain');
      if (txt) send(ev, txt);
    });
  }

  public isAtCleanLineStart(): boolean {
    return this.col === 0 && this.state === 'NORMAL' && this.styKey === '';
  }
  public writeBytes(c: Uint8Array): void {
    const txt = c.byteLength ? this.dec.decode(c, { stream: true }) : '';
    if (txt) this.writeString(txt);
  }
  private go(st: ParserState): void {
    this.state = st;
    this.csi = '';
    if (st !== 'STR_ESC') this.strLen = 0;
  }
  private home(clear = false): void {
    if (clear) this.lines = [[]];
    this.row = this.col = 0;
  }
  private resetParser(): void {
    this.go('NORMAL');
    this.sty = mkStyle();
    this.styKey = '';
  }
  public flushDecoder(): void {
    const tail = this.dec.decode();
    if (tail) this.writeString(tail);
    this.dec = new TextDecoder('utf-8', { fatal: false });
    this.resetParser();
  }
  public writeString(input: string): void {
    for (const ch of input) this.step(ch, ch.codePointAt(0)!);
    this.trim();
    this.render();
  }
  public writeLocalEcho(input: string): void {
    if (input) this.writeIsolated(input);
  }
  public writeSystemBanner(msg: string, _tone?: 'info' | 'ok' | 'err'): void {
    const c = msg.replace(/[\x1b\x9b]/g, '');
    const ts = new Date().toISOString().slice(11, 23);
    const body = /^\[\d{2}:\d{2}:\d{2}/.test(c) ? c : `[${ts}] ${c}`;
    this.writeIsolated(`${this.col > 0 ? '\r\n' : ''}${body}\r\n`);
  }
  private writeIsolated(input: string): void {
    const [st, csi, sl, sr] = [this.state, this.csi, this.strLen, this.sRow];
    const [sc, sk, sty] = [this.sCol, this.styKey, { ...this.sty }];
    this.resetParser();
    [this.sRow, this.sCol] = [this.row, this.col];
    let cut = 0;
    try {
      for (const ch of input) this.step(ch, ch.codePointAt(0)!);
      cut = this.trim();
      this.render();
    } finally {
      [this.state, this.csi, this.strLen] = [st, csi, sl];
      [this.sty, this.styKey, this.sCol] = [sty, sk, sc];
      this.sRow = Math.min(MAX_LINES - 1, Math.max(0, sr - cut));
    }
  }
  public clear(): void {
    this.dec = new TextDecoder('utf-8', { fatal: false });
    this.resetParser();
    this.home(true);
    this.sRow = this.sCol = 0;
    clearChildren(this.root);
  }
  public getPlainText(): string {
    const rows = this.lines.slice(0, this.lastRow() + 1);
    return rows.map((r) => r.map((c) => c.ch).join('')).join('\n');
  }
  private restorePos(): void {
    [this.row, this.col] = [this.sRow, this.sCol];
    this.ensure(this.row);
  }
  private step(ch: string, code: number): void {
    switch (this.state) {
      case 'NORMAL':
        if (code === 0x1b) this.go('ESC');
        else if (code === 0x9b) this.go('CSI');
        else if (!this.c0(code) && code >= 0x20 && code !== 0x7f) this.put(ch);
        return;
      case 'ESC':
        if (ch === '[') return this.go('CSI');
        if (']PX^_'.includes(ch)) return this.go('STR');
        if (code >= 0x20 && code <= 0x2f) return this.go('ESC_INT');
        if (code === 0x1b) return;
        if (ch === 'c') {
          this.home(true);
          return this.resetParser();
        }
        if (ch === '7') [this.sRow, this.sCol] = [this.row, this.col];
        else if (ch === '8') this.restorePos();
        else if (ch === 'D' || ch === 'E') {
          if (ch === 'E') this.col = 0;
          this.ensure(++this.row);
        } else if (ch === 'M') this.row = Math.max(0, this.row - 1);
        return this.go('NORMAL');
      case 'ESC_INT':
        if (code === 0x1b) this.go('ESC');
        else if (code < 0x20 || code > 0x2f) this.go('NORMAL');
        return;
      case 'CSI': {
        if (code === 0x1b) return this.go('ESC');
        if (code < 0x20 || code === 0x7f) return void this.c0(code);
        if (code <= 0x3f)
          return this.csi.length < MAX_BUF
            ? void (this.csi += ch)
            : this.go('NORMAL');
        const raw = this.csi;
        this.go('NORMAL');
        if (code >= 0x40 && code <= 0x7e) this.execCsi(raw, ch);
        return;
      }
      case 'STR':
        if (code === 0x07 || code === 0x9c || ++this.strLen > MAX_BUF * 4)
          this.go('NORMAL');
        else if (code === 0x1b) this.go('STR_ESC');
        return;
      case 'STR_ESC':
        if (ch === '\\') this.go('NORMAL');
        else {
          this.go('ESC');
          this.step(ch, code);
        }
    }
  }
  private c0(code: number): boolean {
    if (code === 0x0d || (code >= 0x0a && code <= 0x0c)) {
      this.col = 0;
      if (code !== 0x0d) this.ensure(++this.row);
      return true;
    }
    if (code === 0x08) {
      this.col = Math.max(0, this.col - 1);
      return true;
    }
    if (code !== 0x09) return false;
    const stop = Math.min(MAX_COLS, (((this.col / 8) | 0) + 1) * 8);
    while (this.col < stop) this.put(' ');
    return true;
  }
  private put(ch: string): void {
    if (this.col >= MAX_COLS) [this.row, this.col] = [this.row + 1, 0];
    const line = this.ensure(this.row);
    while (line.length < this.col) line.push(BLANK);
    const style = this.styKey ? { ...this.sty } : DEF_STYLE;
    line[this.col++] = { ch, styleKey: this.styKey, style };
  }
  private ensure(r: number): TermCell[] {
    const idx = Math.max(0, r);
    while (this.lines.length <= idx) this.lines.push([]);
    return this.lines[idx];
  }
  private execCsi(raw: string, fin: string): void {
    if (raw.startsWith('?') && fin !== 'm') return;
    const body = raw.replace(/^[?>=!]+/, '').trim();
    const parseN = (p: string) => Math.max(0, Number.parseInt(p, 10) || 0);
    const ps = body ? body.split(/[;:]/).map(parseN) : [];
    const [d, m] = [Math.max(1, ps[0] || 1), ps[0] ?? 0];
    if (fin === 'm') return this.applySgr(ps.length ? ps : [0]);
    if (fin === 'J' || fin === 'K') {
      if (fin === 'J' && (m === 2 || m === 3)) return this.home(true);
      const cur = this.ensure(this.row);
      if (fin === 'K' && m === 2) cur.length = 0;
      else if (m === 0) {
        cur.length = Math.min(cur.length, this.col);
        if (fin === 'J') this.lines.splice(this.row + 1);
      } else if (m === 1) {
        if (fin === 'J') for (let r = 0; r < this.row; r++) this.lines[r] = [];
        cur.fill(BLANK, 0, Math.min(cur.length, this.col + 1));
      }
    } else if (fin === 'A') this.row = Math.max(0, this.row - d);
    else if (fin === 'B')
      this.ensure((this.row = Math.min(MAX_LINES - 1, this.row + d)));
    else if (fin === 'C') this.col = Math.min(MAX_COLS, this.col + d);
    else if (fin === 'D') this.col = Math.max(0, this.col - d);
    else if (fin === 'G') this.col = Math.min(MAX_COLS, d - 1);
    else if (fin === 'H' || fin === 'f') {
      this.row = Math.min(MAX_LINES - 1, d - 1);
      this.col = Math.min(MAX_COLS, Math.max(1, ps[1] || 1) - 1);
      this.ensure(this.row);
    } else if (fin === 's') [this.sRow, this.sCol] = [this.row, this.col];
    else if (fin === 'u') this.restorePos();
  }
  private applySgr(codes: number[]): void {
    const s = this.sty;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      const setBit = c >= 1 && c <= 4 ? 1 << (c - 1) : c === 7 ? 16 : 0;
      if (c === 0) [s.fg, s.bg, s.b] = [null, null, 0];
      else if (setBit) s.b |= setBit;
      else if (CLR_BIT[c]) s.b &= ~CLR_BIT[c];
      else if (c === 39) s.fg = null;
      else if (c === 49) s.bg = null;
      else if (c >= 30 && c <= 37) s.fg = FG_STD[c - 30];
      else if (c >= 40 && c <= 47) s.bg = BG_STD[c - 40];
      else if (c >= 90 && c <= 97) s.fg = FG_BRI[c - 90];
      else if (c >= 100 && c <= 107) s.bg = BG_BRI[c - 100];
      else if (c === 38 || c === 48) {
        const [fg, m] = [c === 38, codes[i + 1]];
        if (m === 5 && i + 2 < codes.length) {
          s[fg ? 'fg' : 'bg'] = xterm256(codes[i + 2], fg);
          i += 2;
        } else if (m === 2 && i + 4 < codes.length) {
          const [r, g, b] = codes.slice(i + 2, i + 5).map(clamp255);
          s[fg ? 'fg' : 'bg'] = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        }
      }
    }
    this.styKey = styleKeyOf(s);
  }
  private trim(): number {
    if (this.lines.length <= MAX_LINES) return 0;
    const cut = this.lines.length - MAX_LINES;
    this.lines.splice(0, cut);
    this.row = Math.max(0, this.row - cut);
    this.sRow = Math.max(0, this.sRow - cut);
    return cut;
  }
  private lastRow(): number {
    for (let r = this.lines.length - 1; r >= 0; r--)
      if (this.lines[r].length) return r;
    return -1;
  }
  private render(): void {
    const last = this.lastRow();
    if (last < 0) {
      clearChildren(this.root);
      this.root.scrollTop = this.root.scrollLeft = 0;
      return;
    }
    const { scrollTop, scrollLeft, scrollHeight, clientHeight } = this.root;
    const stick = scrollHeight - scrollTop - clientHeight <= 24;
    const frag = document.createDocumentFragment();
    for (let r = 0; r <= last; r++) {
      if (r > 0) frag.appendChild(document.createTextNode('\n'));
      const row = this.lines[r];
      if (!row?.length) continue;
      let [txt, key, sty] = [row[0].ch, row[0].styleKey, row[0].style];
      for (let c = 1; c < row.length; c++) {
        const cell = row[c];
        if (cell.styleKey === key) txt += cell.ch;
        else {
          frag.appendChild(this.mkSpan(txt, key, sty));
          [txt, key, sty] = [cell.ch, cell.styleKey, cell.style];
        }
      }
      frag.appendChild(this.mkSpan(txt, key, sty));
    }
    this.root.replaceChildren(frag);
    this.root.scrollTop = stick ? this.root.scrollHeight : scrollTop;
    this.root.scrollLeft = scrollLeft;
  }
  private mkSpan(txt: string, key: string, s: SgrStyle): Node {
    if (!key) return document.createTextNode(txt);
    const sp = el('span', 'ansi-run', txt);
    const inv = Boolean(s.b & 16);
    const [fg, bg] = [inv ? s.bg ?? DEF_BG : s.fg, inv ? s.fg ?? DEF_FG : s.bg];
    if (fg) sp.style.color = fg;
    if (bg)
      Object.assign(sp.style, { backgroundColor: bg, borderRadius: '2px' });
    if (s.b & 1) sp.style.fontWeight = '600';
    if (s.b & 2) sp.style.opacity = '0.68';
    if (s.b & 4) sp.style.fontStyle = 'italic';
    if (s.b & 8) sp.style.textDecoration = 'underline';
    return sp;
  }
}

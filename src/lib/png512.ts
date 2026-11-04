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

interface BadgeIconOptions {
  badgeText: string;
  accentColor: string;
  backgroundColor?: string;
}
type Rgb = [number, number, number];
type N = number;
type NodeBuf = { from(b: Uint8Array): { toString(e: string): string } };

const { abs, ceil, floor, hypot, max, min, round } = Math;
const CRC = new Uint32Array(256).map((_, c) => {
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array): N => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const adler32 = (buf: Uint8Array): N => {
  let [a, b] = [1, 0];
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};
const parseHex = (hex: string | undefined, fb: Rgb): Rgb => {
  const s = (hex ?? '').trim().replace(/^#/, '');
  const f = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) return fb;
  const n = Number.parseInt(f, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc, false);
  return out;
};

const GP =
  'Aehhvhhh Buhhuhhu Cfgggggf Duhhhhhu Evgguggv Fvgguggg Gfggjhhe Hhhhvhhh ' +
  'Ie44444e J7222iic Khiokikh Lggggggv Mhrllhhh Nhpljhhh Oehhhhhe Puhhuggg ' +
  'Qehhhlid Ruhhukih Sfgge11u Tv444444 Uhhhhhhe Vhhhhha4 Whhhllrh Xhha4ahh ' +
  'Yhha4444 Zv1248gv 0ehjlphe 14c4444e 2eh168gv 3u11e11u 426aiv22 5vgu11he ' +
  '6egguhhe 7v124888 8ehhehhe 9ehhf11e +044v440 -000v000 #avaava0 >g84248g ' +
  ':0440440 /12448g0 *0level0';
const toRows = (s: string) => [...s].map((c) => Number.parseInt(c, 36));
const GLYPHS = Object.fromEntries(
  GP.split(' ').map((g) => [g[0], toRows(g.slice(1))]),
);
const c01 = (v: N) => max(0, min(1, v));
const sdf = (dx: N, dy: N, hw: N, r: N, hh = hw) => {
  const [qx, qy] = [abs(dx) - (hw - r), abs(dy) - (hh - r)];
  return hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r;
};

export function generateBadgePng512Sync(o: BadgeIconOptions): Uint8Array {
  const W = 512;
  const bg = parseHex(o.backgroundColor, [18, 19, 22]);
  const ac = parseHex(o.accentColor, [16, 185, 129]);
  const up = [...(o.badgeText || '').trim().toUpperCase()];
  const ch =
    up
      .filter((c) => c in GLYPHS)
      .slice(0, 3)
      .join('') || 'IWA';
  const stride = 1 + W * 4;
  const raw = new Uint8Array(W * stride);

  const paint = (cx: N, cy: N, hw: N, hh: N, r: N, col: Rgb) => {
    const [x0, x1] = [
      max(104, floor(cx - hw - 2)),
      min(407, ceil(cx + hw + 2)),
    ];
    const [y0, y1] = [
      max(104, floor(cy - hh - 2)),
      min(407, ceil(cy + hh + 2)),
    ];
    for (let py = y0; py <= y1; py++) {
      const ro = py * stride + 1;
      for (let px = x0; px <= x1; px++) {
        const d = sdf(px + 0.5 - cx, py + 0.5 - cy, hw, r, hh);
        if (d >= 0.75) continue;
        const a = c01(0.5 - d);
        const p = ro + px * 4;
        for (let i = 0; i < 3; i++)
          raw[p + i] = round(raw[p + i] * (1 - a) + col[i] * a);
      }
    }
  };

  for (let y = 0; y < W; y++) {
    const ro = y * stride + 1;
    const inY = y >= 104 && y < 408;
    const vg = inY ? (408 - y) / 304 : 0;
    const base = [22 + vg * 6, 25 + vg * 7, 31 + vg * 8];
    for (let x = 0; x < W; x++) {
      const p = ro + x * 4;
      const c: Rgb = [bg[0], bg[1], bg[2]];
      if (inY && x >= 104 && x < 408) {
        const d = sdf(x - 255.5, y - 255.5, 152, 68);
        if (d <= 0.5) {
          const [ia, t, rd] = [
            c01(0.5 - d),
            0.07 + vg * 0.05,
            abs(d + 3) - 2.5,
          ];
          const ra = rd < 1 ? c01(0.65 - rd) * 0.9 : 0;
          for (let i = 0; i < 3; i++) {
            const v = c[i] * (1 - ia) + (base[i] + ac[i] * t) * ia;
            c[i] = ra > 0 ? v * (1 - ra) + ac[i] * ra : v;
          }
        }
      }
      for (let i = 0; i < 3; i++) raw[p + i] = min(255, max(0, round(c[i])));
      raw[p + 3] = 255;
    }
  }

  const cs = ch.length === 1 ? 20 : ch.length === 2 ? 16 : 13;
  const [gap, gw, hw, cr] = [
    round(cs * 1.15),
    5 * cs,
    cs * 0.52,
    max(2, cs * 0.28),
  ];
  const sx = round(256 - (ch.length * gw + (ch.length - 1) * gap) / 2);
  const sy = round(256 - (7 * cs) / 2 - 10);
  const fg: Rgb = [243, 244, 246];
  for (let ci = 0; ci < ch.length; ci++) {
    const rows = GLYPHS[ch[ci]] ?? GLYPHS.I;
    const gx0 = sx + ci * (gw + gap);
    for (let r = 0; r < 7; r++)
      for (let col = 0; col < 5; col++)
        if ((rows[r] >>> (4 - col)) & 1)
          paint(gx0 + (col + 0.5) * cs, sy + (r + 0.5) * cs, hw, hw, cr, fg);
  }
  paint(256, 338, 42, 5, 5, ac);

  const [maxB, nB] = [65535, ceil(raw.length / 65535)];
  const zOut = new Uint8Array(2 + raw.length + nB * 5 + 4);
  zOut.set([0x78, 0x01], 0);
  let zp = 2;
  for (let i = 0; i < nB; i++) {
    const sl = raw.subarray(i * maxB, min((i + 1) * maxB, raw.length));
    const [len, nl, b0] = [
      sl.length,
      ~sl.length & 0xffff,
      i === nB - 1 ? 1 : 0,
    ];
    zOut.set([b0, len & 255, len >>> 8, nl & 255, nl >>> 8], zp);
    zOut.set(sl, zp + 5);
    zp += 5 + len;
  }
  new DataView(zOut.buffer).setUint32(zp, adler32(raw), false);

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, W, false);
  idv.setUint32(4, W, false);
  ihdr.set([8, 6], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const empty = new Uint8Array(0);
  const parts = [
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', zOut),
    makeChunk('IEND', empty),
  ];
  const png = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

export const generateBadgePng512 = async (o: BadgeIconOptions) =>
  generateBadgePng512Sync(o);

export function pngBytesToDataUrl(b: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000)
      bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(bin)}`;
  }
  const buf = (globalThis as { Buffer?: NodeBuf }).Buffer;
  return buf ? `data:image/png;base64,${buf.from(b).toString('base64')}` : '';
}

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

const utf8Dec = new TextDecoder();
const utf8FatalDec = new TextDecoder('utf-8', { fatal: true });
const utf16BeDec = new TextDecoder('utf-16be');
const latin1Dec = new TextDecoder('iso-8859-1');
const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new Uint8Array(bytes).buffer;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

interface DerTlv {
  tag: number;
  len: number;
  v: Uint8Array;
}
interface ParsedX509Identity {
  issuerOrganization: string | null;
  issuerCommonName: string | null;
  subjectOrganization: string | null;
  subjectCommonName: string | null;
  firstDnsSan: string | null;
  validityNotAfter: string | null;
  publicKeyAlgorithmLabel: string;
  dnsNames: string[];
}

const err = (msg: string): never => {
  throw new Error(msg);
};
const stripCtrl = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '').trim();
const STR_TAGS = new Set([0x0c, 0x13, 0x14, 0x16, 0x1a, 0x1c, 0x1e]);
const OID_LABELS: Record<string, string> = {
  '2a8648ce3d030107': 'ECDSA P-256',
  '2b81040022': 'ECDSA P-384',
  '2b81040023': 'ECDSA P-521',
  '2a864886f70d01010a': 'RSA-PSS',
  '2b6570': 'Ed25519',
  '2b6571': 'Ed448',
};

function readDerTlv(buf: Uint8Array, off: number): DerTlv {
  if (off < 0 || off + 2 > buf.length) err('Truncated ASN.1 DER header');
  let [tag, pos] = [buf[off], off + 1];
  if ((tag & 0x1f) === 0x1f) {
    let [num, bytes, done] = [0, 0, false];
    while (pos < buf.length) {
      const b = buf[pos++];
      if (++bytes === 1 && b === 0x80) err('Invalid DER high-tag leading zero');
      if (bytes > 6) err('ASN.1 DER high-tag-number overflow');
      num = num * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) {
        done = true;
        break;
      }
    }
    if (!done || pos >= buf.length) err('Truncated ASN.1 DER high-tag-number');
    tag = 0x100 + num;
  }
  const fb = buf[pos++];
  let vLen = fb;
  if ((fb & 0x80) !== 0) {
    vLen = 0;
    const n = fb & 0x7f;
    if (n === 0 || n > 4 || pos + n > buf.length)
      err('Invalid ASN.1 DER length encoding');
    if (buf[pos] === 0) err('Non-minimal ASN.1 DER length leading zero');
    for (let i = 0; i < n; i++) vLen = vLen * 256 + buf[pos + i];
    if (n === 1 && vLen < 128) err('Non-minimal ASN.1 DER long-form length');
    pos += n;
  }
  const hLen = pos - off;
  const len = hLen + vLen;
  if (vLen < 0 || hLen <= 0 || len < hLen || off + len > buf.length)
    err('ASN.1 DER element exceeds buffer bounds');
  return { tag, len, v: buf.subarray(off + hLen, off + len) };
}

function forEachDer(buf: Uint8Array, fn: (t: DerTlv) => void, cur = 0): void {
  while (cur < buf.length) {
    const t = readDerTlv(buf, cur);
    cur += t.len;
    fn(t);
  }
}

function decodeAsn1String(t: DerTlv): string {
  if (!STR_TAGS.has(t.tag)) return '';
  const b = t.v;
  if (t.tag === 0x1e)
    return stripCtrl(utf16BeDec.decode(b.subarray(0, b.length & ~1)));
  if (t.tag === 0x1c) {
    let out = '';
    for (let i = 0; i + 3 < b.length; i += 4) {
      const cp =
        b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
      if (cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff))
        out += String.fromCodePoint(cp);
    }
    return stripCtrl(out);
  }
  if (t.tag === 0x14) {
    try {
      return stripCtrl(utf8FatalDec.decode(b));
    } catch {
      return stripCtrl(latin1Dec.decode(b));
    }
  }
  return stripCtrl(utf8Dec.decode(b));
}

function parseNameAttrs(s: Uint8Array): {
  org: string | null;
  cn: string | null;
} {
  let [org, cn]: [string | null, string | null] = [null, null];
  forEachDer(s, (rdn) => {
    if (rdn.tag !== 0x31) return;
    forEachDer(rdn.v, (atv) => {
      if (atv.tag !== 0x30) return;
      const oid = readDerTlv(atv.v, 0);
      if (oid.tag !== 0x06 || oid.len >= atv.v.length) return;
      if (oid.v.length === 3 && oid.v[0] === 0x55 && oid.v[1] === 0x04) {
        const txt = decodeAsn1String(readDerTlv(atv.v, oid.len));
        if (oid.v[2] === 0x0a && txt) org = txt;
        else if (oid.v[2] === 0x03 && txt) cn = txt;
      }
    });
  });
  return { org, cn };
}

const UTC_RE = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;
const GEN_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d*[1-9])?Z$/;

function parseAsn1Time(t: DerTlv): string | null {
  const len = t.v.length;
  if ((t.tag !== 0x17 && t.tag !== 0x18) || len < 13 || len > 64) return null;
  if (t.v.some((b) => b < 0x21 || b > 0x7e)) return null;
  const m = (t.tag === 0x17 ? UTC_RE : GEN_RE).exec(utf8Dec.decode(t.v));
  if (!m) return null;
  const y0 = +m[1];
  const yr = t.tag === 0x17 ? (y0 >= 50 ? 1900 + y0 : 2000 + y0) : y0;
  const [mo, d, hh, mm, ss] = m.slice(2, 7).map(Number);
  const leap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  const maxD = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    mo - 1
  ];
  const bad =
    yr < 1 ||
    yr > 9999 ||
    !maxD ||
    d < 1 ||
    d > maxD ||
    hh > 23 ||
    mm > 59 ||
    ss > 59;
  return bad ? null : `${String(yr).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

function extractRsaBits(spki: Uint8Array, algLen: number): number | null {
  try {
    if (algLen >= spki.length) return null;
    const bs = readDerTlv(spki, algLen);
    if (bs.tag !== 0x03 || bs.v.length < 2 || bs.v[0] !== 0) return null;
    if (algLen + bs.len !== spki.length) return null;
    const seq = readDerTlv(bs.v, 1);
    if (seq.tag !== 0x30 || 1 + seq.len !== bs.v.length) return null;
    const mod = readDerTlv(seq.v, 0);
    if (mod.tag !== 0x02 || !mod.v.length) return null;
    let mb = mod.v;
    while (mb.length > 1 && mb[0] === 0) mb = mb.subarray(1);
    return mb[0] === 0 ? null : mb.length * 8 - (Math.clz32(mb[0]) - 24);
  } catch {
    return null;
  }
}

function detectSpkiAlg(spki: Uint8Array, alg: DerTlv): string {
  try {
    const oid = readDerTlv(alg.v, 0);
    const hex = toHex(oid.v);
    if (hex === '2a8648ce3d0201') {
      const p =
        oid.len < alg.v.length ? toHex(readDerTlv(alg.v, oid.len).v) : '';
      return OID_LABELS[p] ?? 'ECDSA';
    }
    if (hex === '2a864886f70d010101') {
      const bits = extractRsaBits(spki, alg.len);
      return bits ? `RSA-${bits}` : 'RSA';
    }
    if (OID_LABELS[hex]) return OID_LABELS[hex];
  } catch {}
  return 'X.509 SPKI';
}

function formatDerIp(b: Uint8Array): string | null {
  if (b.length === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  if (b.length !== 16) return null;
  const g = Array.from({ length: 8 }, (_, i) => (b[i * 2] << 8) | b[i * 2 + 1]);
  let [bs, bl] = [-1, 0];
  for (let i = 0, cs = -1, cl = 0; i < 8; i++) {
    if (g[i] === 0) {
      if (cs < 0) cs = i;
      if (++cl >= 2 && cl > bl) [bs, bl] = [cs, cl];
    } else [cs, cl] = [-1, 0];
  }
  const fmt = (a: number[]) => a.map((x) => x.toString(16)).join(':');
  return bs < 0 ? fmt(g) : `${fmt(g.slice(0, bs))}::${fmt(g.slice(bs + bl))}`;
}

function scanSanExt(ext: DerTlv, dns: string[], onDns: (d: string) => void) {
  if (ext.tag !== 0x30) return;
  const oid = readDerTlv(ext.v, 0);
  if (oid.tag !== 0x06 || oid.len >= ext.v.length) return;
  let ic = oid.len;
  let val = readDerTlv(ext.v, ic);
  if (val.tag === 0x01) {
    ic += val.len;
    if (ic >= ext.v.length) return;
    val = readDerTlv(ext.v, ic);
  }
  const ov = oid.v;
  if (val.tag !== 0x04 || !val.v.length || ov.length !== 3) return;
  if (ov[0] !== 0x55 || ov[1] !== 0x1d || ov[2] !== 0x11) return;
  const gnSeq = readDerTlv(val.v, 0);
  if (gnSeq.tag !== 0x30) return;
  forEachDer(gnSeq.v, (gn) => {
    if (gn.tag === 0x82) {
      const d = stripCtrl(utf8Dec.decode(gn.v)).toLowerCase();
      if (d) onDns(d);
    } else if (gn.tag === 0x87) {
      const ip = formatDerIp(gn.v);
      if (ip && !dns.includes(ip)) dns.push(ip);
    }
  });
}

export function parseX509IdentityFromDer(
  certDer: Uint8Array,
): ParsedX509Identity {
  const top = readDerTlv(certDer, 0);
  if (top.tag !== 0x30 || top.len !== certDer.length)
    err('Invalid X.509 certificate outer SEQUENCE');
  const tbs = readDerTlv(top.v, 0);
  const sigAlg = readDerTlv(top.v, tbs.len);
  const sigOff = tbs.len + sigAlg.len;
  const sig = readDerTlv(top.v, sigOff);
  const badSig =
    !sig.v.length || sig.v[0] > 7 || (sig.v.length === 1 && sig.v[0] !== 0);
  if (
    tbs.tag !== 0x30 ||
    sigAlg.tag !== 0x30 ||
    sig.tag !== 0x03 ||
    badSig ||
    sigOff + sig.len !== top.v.length
  )
    err('Invalid X.509 certificate structure');

  const body = tbs.v;
  let cur = 0;
  const next = () => {
    const t = readDerTlv(body, cur);
    cur += t.len;
    return t;
  };
  const f0 = readDerTlv(body, 0);
  if (f0.tag === 0xa0) cur += f0.len;
  next(), next();
  const [issuer, validity, subject, spki] = [next(), next(), next(), next()];
  if ([issuer, validity, subject, spki].some((x) => x.tag !== 0x30))
    err('Invalid X.509 TBSCertificate SEQUENCE field');

  let validityNotAfter: string | null = null;
  try {
    const nb = readDerTlv(validity.v, 0);
    const na = readDerTlv(validity.v, nb.len);
    if (nb.len + na.len === validity.v.length)
      validityNotAfter = parseAsn1Time(na);
  } catch {}

  const dnsNames: string[] = [];
  let firstDnsSan: string | null = null;
  const onDns = (d: string) => {
    if (firstDnsSan === null) firstDnsSan = d;
    if (!dnsNames.includes(d)) dnsNames.push(d);
  };
  forEachDer(
    body,
    (f) => {
      if (f.tag !== 0xa3 || !f.v.length) return;
      const exts = readDerTlv(f.v, 0);
      if (exts.tag === 0x30)
        forEachDer(exts.v, (ext) => scanSanExt(ext, dnsNames, onDns));
    },
    cur,
  );

  const iss = parseNameAttrs(issuer.v);
  const sub = parseNameAttrs(subject.v);
  if (!dnsNames.length && sub.cn) dnsNames.push(sub.cn.toLowerCase());
  const publicKeyAlgorithmLabel = detectSpkiAlg(spki.v, readDerTlv(spki.v, 0));
  return {
    issuerOrganization: iss.org,
    issuerCommonName: iss.cn,
    subjectOrganization: sub.org,
    subjectCommonName: sub.cn,
    firstDnsSan,
    validityNotAfter,
    publicKeyAlgorithmLabel,
    dnsNames,
  };
}

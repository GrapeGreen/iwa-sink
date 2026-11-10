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
const rand = (n: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(n));
const b64u = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

export const randomHex = (byteCount = 16): string =>
  Array.from(rand(byteCount), (b) => b.toString(16).padStart(2, '0')).join('');

interface PkceMaterial {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
}

export async function generatePkceMaterial(): Promise<PkceMaterial> {
  const codeVerifier = b64u(rand(32));
  const buf = new Uint8Array(enc.encode(codeVerifier)).buffer;
  const codeChallenge = b64u(
    new Uint8Array(await crypto.subtle.digest('SHA-256', buf)),
  );
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state: b64u(rand(18)),
  };
}

/**
 * Copyright 2024 Google LLC
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

import fs from 'fs';

let version = process.env?.VERSION;

if (version) {
  version = version.replace('v', '');
} else {
  throw new Error('No version found');
}

const manifest = JSON.parse(
  fs.readFileSync('./public/.well-known/manifest.webmanifest', 'utf-8'),
);

manifest.version = version;

fs.writeFileSync(
  './public/.well-known/manifest.webmanifest',
  JSON.stringify(manifest, null, 2),
);

let versions;

try {
  versions = JSON.parse(process.env.TAGS).map((tag) => {
    const v = tag.ref.replace('refs/tags/v', '');
    return {
      version: v,
      src: `https://github.com/chromeos/iwa-sink/releases/download/v${v}/iwa-sink.swbn`,
    };
  });
} catch (e) {
  throw new Error('No tags');
}

const updateManifest = {
  versions,
};

fs.writeFileSync('./update.json', JSON.stringify(updateManifest));

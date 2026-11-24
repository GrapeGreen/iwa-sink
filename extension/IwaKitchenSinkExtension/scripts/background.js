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

console.log('IWA Kitchen Sink Extension');
console.log('Extension id:', chrome.runtime.id);

const STATUS_OK = 'OK';
const STATUS_ERROR = 'Error';

const REQUEST_VERSION_CHECK = 'version';

// Process messages from the IWA
chrome.runtime.onMessageExternal.addListener(mainExternalMessageListener);

console.log('Extension started.');

function mainExternalMessageListener(request, sender, sendResponse) {
  console.log('Message from external app received.');
  console.log(
    'Sender ID:',
    sender.id,
    'URL:',
    sender.url,
    'Origin:',
    sender.origin,
  );
  console.log('Request:', JSON.stringify(request));

  // Reply to "extension enabled" check
  if (request === REQUEST_VERSION_CHECK) {
    return processVersionCheck(sendResponse);
  }

  // chrome.identity.getProfileUserInfo
  if (
    request &&
    typeof request === 'object' &&
    request.api === 'chrome.identity.getProfileUserInfo'
  ) {
    getProfileUserInfo(request, sendResponse);
    return true;
  }

  return processCustomMessage(request, sender, sendResponse);
}

function processVersionCheck(sendResponse) {
  console.log('Process version check');
  const manifest = chrome.runtime.getManifest();
  sendResponse({
    status: STATUS_OK,
    version: manifest.version,
  });
  return true;
}

function createApiResponse(apiName, status, output) {
  return {
    apiName: apiName,
    status: status,
    output: output,
  };
}

function processCustomMessage(request, sender, sendResponse) {
  console.log('Process custom message:', JSON.stringify(request));
  sendResponse({
    status: STATUS_OK,
    echoed: request,
    senderOrigin: (sender && (sender.origin || sender.url)) || 'isolated-app',
    extensionId: chrome.runtime.id,
  });
  return true;
}

// chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })
async function getProfileUserInfo(request, sendResponse) {
  try {
    const accountStatus =
      (request &&
        typeof request.accountStatus === 'string' &&
        request.accountStatus) ||
      'ANY';
    const userProfileInfo = await chrome.identity.getProfileUserInfo({
      accountStatus: accountStatus,
    });
    console.log(
      'Calling chrome.identity.getProfileUserInfo():',
      JSON.stringify(userProfileInfo),
    );
    sendResponse(
      createApiResponse(
        'chrome.identity.getProfileUserInfo',
        STATUS_OK,
        JSON.stringify(userProfileInfo),
      ),
    );
  } catch (err) {
    sendResponse(
      createApiResponse(
        'chrome.identity.getProfileUserInfo',
        STATUS_ERROR,
        String(err && err.message ? err.message : err),
      ),
    );
  }
}

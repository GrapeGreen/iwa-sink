# IWA Kitchen Sink

A demo showing off [Isolated Web Apps](https://github.com/WICG/isolated-web-apps/) and related APIs.

## APIs Demonstrated

- [Direct Sockets](https://github.com/WICG/direct-sockets)
- [Controlled Frame](https://github.com/WICG/controlled-frame)
- [Borderless display mode](https://github.com/WICG/manifest-incubations/blob/gh-pages/borderless-explainer.md)

## Installation

**Requirements**

- Chrome or ChromeOS v122 or greater
- NodeJS v18 or higher
- pnpm v8.9 or higher

After downloading this repository and installing its dependencies, you'll need to install you'll need to set up a local development root certificate authority in Chrome to have a verified HTTPS certificate to use with the local dev server, as well as enable a few Chrome flags:

1. Generate a valid root certificate for the Vite project.

- I used [`mkcert`](https://github.com/FiloSottile/mkcert?tab=readme-ov-file) to generate a root cert on my computer, but use whatever is most accessible for you. Take note of where the `rootCA.pem` file gets generated. If you're using `mkcert`, you can add `export CAROOT=”$HOME/certs` or your `.bashrc` file to direct where the file will be generated when running `mkcert -install`
- Install the cert by going to `chrome://settings/certificates` and under the `Authorities` tab, import `rootCA.pem`

2. In the root of the project, create a `certs` folder, then generate certs for your project there. If using `mkcert`, you can run `mkcert localhost`
3. Check to make sure that the certs being imported in the `server.https` config in `vite.config.js` match the filenames generated in the previous step
4. On the latest Chrome or ChromeOS v122 or greater, enable the `chrome://flags/#enable-isolated-web-apps` and `chrome://flags/#enable-isolated-web-app-dev-mode/` flags, then go to `chrome://web-app-internals` and install `https://localhost:5193` via the Dev Mode Proxy. This will install this codebase as an IWA app to your device, but use the proxied development server instead of requiring you to bundle and install your app.

---

If you wanted to do this for your own Vite project, follow the steps above, and make sure to include the `server` configuration (reproduced below) in your `vite.config.js` file. This locks Vite into using a specific port, ensures you're using your verified certificates for HTTPS, and ensures your hot module reload server points to the correct place once proxied.

```js
 server: {
    port: 5193,
    strictPort: true,
    https: {
      key: fs.readFileSync('./certs/localhost-key.pem'),
      cert: fs.readFileSync('./certs/localhost.pem'),
    },
    hmr: {
      protocol: 'wss',
      host: 'localhost',
      clientPort: 5193,
    }
  },
```

You'll also need to ensure you have a valid `manifest.webmanifest` file (named exactly that) available from the root of your url (so it'd be available at `https://localhost:5193/manifest.webmanifest`) and that it includes a `version` field set to a SEMVER string and at least one valid icon. Putting it directly into the root of your `pubic` folder should be good enough. An example one may look like this:

```json
{
  "id": "/",
  "short_name": "Test IWA",
  "name": "Test IWA",
  "version": "0.0.1",
  "icons": [
    {
      "src": "images/icon.png",
      "type": "image/png",
      "sizes": "512x512",
      "purpose": "any maskable"
    }
  ],
  "start_url": "/",
  "display": "standalone",
  "scope": "/",
  "isolated_storage": true,
  "permissions_policy": {
    "cross-origin-isolated": ["self"]
  }
}
```

## Running and updating

To run the app, first from within the project's folder, run `pnpm dev` to run the dev server, then open up the installed app (if the server isn't running, the installed app won't load). While the app can be opened in a browser tab, none of the IWA-specific functionality will work.

Any code changes can be done as if you were developing normally, and the app will automatically updated with the latest changes through Vite's built-in HMR capabilities. If, however, you want to make a change to the `manifest.webmanifest` (for instance, to change permissions), you'll need to bump the `version` field, close your app, go to `chrome://web-app-internals`, find your app in the **Dev Mode App Updates** section, and click the "Perform update now" button, then relaunch your app.
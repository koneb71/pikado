# Pikado desktop app

The web build in an Electron window, for macOS, Windows and Linux. It is a
package of its own so that nobody working on the web app, and no Docker build,
downloads Electron.

```
main.cjs                    the main process: window, app:// protocol, files,
                            menus, quit prompt, updates
preload.cjs                 the bridge the page sees as window.pikadoDesktop
lib/protocol.cjs            app://pikado/ → the bundled web build
lib/files.cjs               file access by token, atomic writes
lib/menu.cjs                the macOS menu bar, from the page's menus
lib/updater.cjs             updates from GitHub Releases
lib/window-state.cjs        the window's size and position
electron-builder.config.cjs packaging and signing
scripts/dev.mjs             run against the Vite dev server, or run the suite
test/                       unit tests (node --test)
```

The page's side is `src/io/desktop.js`. See *Desktop app* in
[ARCHITECTURE.md](../ARCHITECTURE.md) for how the two fit together.

## Developing

From the repository root:

```bash
npm install                 # the web app
npm run desktop:install     # once: Electron and electron-builder, into desktop/
npm run desktop:dev         # the app, against the Vite dev server
npm run desktop             # the production build, as the installed app serves it
```

`desktop:dev` starts Vite itself and points Electron at whatever port it got;
page edits reload as in a browser, main-process edits need a restart. Add
`-- --devtools` to open the developer tools.

## Testing

```bash
npm run desktop:unit                            # the main process: protocol, tokens, menus, packaging
npm run desktop:test                            # the whole browser suite, inside the desktop app
npm run desktop:test -- "grep=desktop&webgpu=off"   # a query string, as /tests/ takes it
```

`desktop:test` prints the result and exits non-zero on any failure. A packaged
app can check itself too: run its executable with `--pikado-smoke`, and it
starts, waits for Pikado to boot, prints what it found and exits.

## Building

```bash
npm run desktop:build       # installers for this machine, in desktop/release/
```

Without signing secrets the result is unsigned (on macOS, ad-hoc signed so it
runs on Apple Silicon). macOS then asks the user to confirm the first launch
(Control-click → Open), and Windows SmartScreen warns once.

## Releasing

The version is the one in the root `package.json`. To release:

1. Raise `version` in the root `package.json`, commit, and push.
2. Tag that commit `v<version>` and push the tag.
3. The *Desktop release* workflow (`.github/workflows/desktop-release.yml`)
   builds macOS (arm64 and x64), Windows (x64 and arm64) and Linux (AppImage and
   deb), and uploads them to a **draft** release. It refuses a tag that does not
   match `package.json`.
4. Check the draft, then publish it. Installed apps see the update only once it
   is published.

*Run workflow* on the Actions page builds the same installers without
publishing, and keeps them as workflow artifacts — use it to try a branch.

## Signing

Each platform signs once its secrets are in the repository (*Settings > Secrets
and variables > Actions*); until then its build is unsigned and the workflow
still succeeds.

**macOS** — signing and notarization:

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | A *Developer ID Application* certificate with its private key, exported from Keychain Access as `.p12`, then base64 encoded (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | The password you gave that `.p12` |
| `APPLE_API_KEY_BASE64` | An App Store Connect API key (*Users and Access > Integrations > App Store Connect API*, role Developer), the `.p8` file base64 encoded |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys |

A Developer ID certificate needs a paid Apple Developer Program membership.
Only a signed Mac app can install its own updates; an unsigned one checks, and
offers the release page.

**Windows** — either Azure Trusted Signing:

| Secret | What |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An app registration with the *Trusted Signing Certificate Profile Signer* role on the account |
| `AZURE_SIGN_ENDPOINT` | The account's endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGN_ACCOUNT` | The Trusted Signing account name |
| `AZURE_SIGN_PROFILE` | The certificate profile name |
| `AZURE_SIGN_PUBLISHER` | The publisher name on the certificate |

or a code-signing certificate as a file:

| Secret | What |
|---|---|
| `WIN_CSC_LINK` | The `.pfx`, base64 encoded |
| `WIN_CSC_KEY_PASSWORD` | Its password |

**Linux** has nothing to sign.

The app id is `io.github.koneb71.pikado`. Installed apps find their updates and
their file associations by it, so it must not change after the first release.

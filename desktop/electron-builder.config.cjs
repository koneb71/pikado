'use strict';

/**
 * Packaging (electron-builder). JavaScript rather than JSON so signing follows
 * the environment: each kind turns on only when its secrets are set, and a
 * build without any is still a working, unsigned app. desktop/README.md says
 * where each secret comes from.
 *
 *   macOS    CSC_LINK + CSC_KEY_PASSWORD     a Developer ID Application .p12
 *            APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
 *                                            notarization (App Store Connect key)
 *            neither: ad-hoc signed, so it runs on Apple Silicon; Gatekeeper
 *            asks the user to confirm the first launch, and the app cannot
 *            install its own updates (see lib/updater.cjs)
 *   Windows  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus
 *            AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE,
 *            AZURE_SIGN_PUBLISHER            Azure Trusted Signing
 *            WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD
 *                                            or a .pfx certificate
 *            neither: unsigned; SmartScreen warns on first run
 *   Linux    nothing to sign
 *
 * The version is the root package.json's: the web app and the desktop app are
 * one product with one version, and the release tag must match it.
 */

const root = require('../package.json');

const env = process.env;
const has = (...names) => names.every((n) => typeof env[n] === 'string' && env[n].length > 0);

const macSigned = has('CSC_LINK') || has('CSC_NAME');
const macNotarized = macSigned && has('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER');
const winAzure = has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER');

const ICON = '../public/icon-512.png';

module.exports = {
  appId: 'io.github.koneb71.pikado',
  productName: 'Pikado',
  copyright: 'Copyright © Neiell Care L. Paradiang',
  directories: { output: 'release', buildResources: 'build' },
  extraMetadata: {
    version: root.version,
    // Read by main.cjs: only a signed Mac app can install its own updates.
    pikadoSigned: macSigned,
  },
  files: [
    'main.cjs',
    'preload.cjs',
    'lib/**',
    'package.json',
    { from: '../dist', to: 'renderer', filter: ['**/*'] },
  ],
  asar: true,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  fileAssociations: [
    {
      ext: 'pkd', name: 'Pikado Document', description: 'Pikado document',
      mimeType: 'application/x-pikado', role: 'Editor', rank: 'Owner',
    },
    {
      // Alternate: offered under Open With, never taking over Photoshop's files.
      ext: ['psd', 'psb'], name: 'Photoshop Document', description: 'Photoshop document',
      mimeType: 'image/vnd.adobe.photoshop', role: 'Editor', rank: 'Alternate',
    },
  ],
  // Drafts: nothing reaches users until the release is published by hand.
  publish: [{ provider: 'github', owner: 'koneb71', repo: 'pikado', releaseType: 'draft' }],

  mac: {
    category: 'public.app-category.graphics-design',
    icon: ICON,
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The zip is what the updater downloads.
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    ...(macSigned
      ? {
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
        notarize: macNotarized,
      }
      : { identity: '-', hardenedRuntime: false, notarize: false }),
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },

  win: {
    icon: ICON,
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    ...(winAzure
      ? {
        azureSignOptions: {
          endpoint: env.AZURE_SIGN_ENDPOINT,
          codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
          certificateProfileName: env.AZURE_SIGN_PROFILE,
          publisherName: env.AZURE_SIGN_PUBLISHER,
        },
      }
      : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
  },

  linux: {
    icon: ICON,
    category: 'Graphics',
    synopsis: 'Layers, masks, PSD files, filters and adjustments',
    target: ['AppImage', 'deb'],
    maintainer: 'Neiell Care L. Paradiang',
  },
  appImage: { artifactName: '${productName}-${version}-${arch}.${ext}' },
  deb: { artifactName: '${productName}-${version}-${arch}.${ext}' },
};

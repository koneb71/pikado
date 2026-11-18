'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CONFIG = path.join(__dirname, '..', 'electron-builder.config.cjs');
const SECRETS = [
  'CSC_LINK', 'CSC_NAME', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER',
];
const AZURE = {
  AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
  AZURE_SIGN_ENDPOINT: 'https://eus.codesigning.azure.net', AZURE_SIGN_ACCOUNT: 'acct',
  AZURE_SIGN_PROFILE: 'profile', AZURE_SIGN_PUBLISHER: 'Pikado',
};

/** The config as electron-builder would load it with exactly these variables set. */
function configWith(env = {}) {
  const saved = Object.fromEntries(SECRETS.map((k) => [k, process.env[k]]));
  for (const k of SECRETS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    delete require.cache[require.resolve(CONFIG)];
    return require(CONFIG);
  } finally {
    for (const k of SECRETS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('with no secrets: an ad-hoc signed Mac app that knows it cannot update itself', () => {
  const c = configWith();
  assert.equal(c.mac.identity, '-');
  assert.equal(c.mac.notarize, false);
  assert.equal(c.mac.hardenedRuntime, false);
  assert.equal(c.extraMetadata.pikadoSigned, false);
  assert.equal(c.win.azureSignOptions, undefined);
});

test('a certificate signs, and the App Store Connect key notarizes', () => {
  // Verified to fail with pikadoSigned hard-coded false: a signed build would
  // have refused to install its own updates.
  const signed = configWith({ CSC_LINK: 'cert.p12' });
  assert.equal(signed.mac.identity, undefined, 'electron-builder finds the identity in the certificate');
  assert.equal(signed.mac.hardenedRuntime, true);
  assert.equal(signed.mac.notarize, false, 'not without the API key');
  assert.equal(signed.extraMetadata.pikadoSigned, true);

  const notarized = configWith({ CSC_LINK: 'cert.p12', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' });
  assert.equal(notarized.mac.notarize, true);
  const keyOnly = configWith({ APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' });
  assert.equal(keyOnly.mac.notarize, false, 'an unsigned app cannot be notarized');
});

test('Azure Trusted Signing only with every one of its settings', () => {
  const c = configWith(AZURE);
  assert.deepEqual(c.win.azureSignOptions, {
    endpoint: AZURE.AZURE_SIGN_ENDPOINT, codeSigningAccountName: 'acct', certificateProfileName: 'profile', publisherName: 'Pikado',
  });
  const partial = configWith({ ...AZURE, AZURE_SIGN_PROFILE: '' });
  assert.equal(partial.win.azureSignOptions, undefined, 'an empty secret is a missing one');
});

test('one version, one app id, draft releases', () => {
  const c = configWith();
  assert.equal(c.extraMetadata.version, require('../../package.json').version);
  assert.equal(c.appId, 'io.github.koneb71.pikado');
  assert.deepEqual(c.publish, [{ provider: 'github', owner: 'koneb71', repo: 'pikado', releaseType: 'draft' }]);
  assert.ok(c.files.some((f) => f && f.from === '../dist' && f.to === 'renderer'), 'the web build ships as renderer/');
  const pkd = c.fileAssociations.find((a) => a.ext === 'pkd');
  const psd = c.fileAssociations.find((a) => Array.isArray(a.ext) && a.ext.includes('psd'));
  assert.equal(pkd.rank, 'Owner');
  assert.equal(psd.rank, 'Alternate', 'never takes over Photoshop files');
  assert.equal(c.electronFuses.runAsNode, false);
  assert.equal(c.electronFuses.onlyLoadAppFromAsar, true);
});

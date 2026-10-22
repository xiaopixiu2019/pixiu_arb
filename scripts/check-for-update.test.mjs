import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkForUpdate, compareVersions, parseVersion } from './check-for-update.mjs';

const currentVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

test('parses supported release versions', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { core: [1n, 2n, 3n], prerelease: [] });
  assert.deepEqual(parseVersion('1.2.3-rc.4+build.5'), { core: [1n, 2n, 3n], prerelease: ['rc', '4'] });
  assert.equal(parseVersion('release-1.2.3'), null);
  assert.equal(parseVersion('1.2'), null);
});

test('compares semantic versions without treating build metadata as an update', () => {
  assert.equal(compareVersions('v0.2.0', '0.1.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0+local'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('not-a-version', '1.0.0'), null);
});

test('reports a newer published release using the configured GitHub repository', async () => {
  let requestedUrl = '';
  const update = await checkForUpdate({
    environment: {},
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ tag_name: 'v999.0.0' }) };
    },
    savedSource: null,
  });
  assert.equal(requestedUrl, 'https://api.github.com/repos/xiaopixiu2019/pixiu_arb/releases/latest');
  assert.deepEqual(update, { currentVersion, latestTag: 'v999.0.0' });
});

test('does not report the installed release as an update', async () => {
  const update = await checkForUpdate({
    environment: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: `v${currentVersion}` }) }),
    savedSource: null,
  });
  assert.equal(update, null);
});

test('skips update checks for a pinned bootstrap source ref', async () => {
  let requested = false;
  const update = await checkForUpdate({
    environment: {},
    fetchImpl: async () => {
      requested = true;
      return { ok: true, json: async () => ({ tag_name: 'v999.0.0' }) };
    },
    savedSource: { ref: 'v0.1.2', repository: 'custom-owner/custom-terminal' },
  });
  assert.equal(requested, false);
  assert.equal(update, null);
});

test('migrates legacy saved repository and ref before checking public updates', async () => {
  let requestedUrl;
  await checkForUpdate({ environment: {}, savedSource: { repository: 'your-quantguy/gate-crossex', ref: 'v0.2.2' },
    fetchImpl: async (url) => { requestedUrl = url; return { ok: false }; } });
  assert.equal(requestedUrl, 'https://api.github.com/repos/xiaopixiu2019/pixiu_arb/releases/latest');
});

test('explicit custom repositories remain supported and unavailable public releases never fall back', async () => {
  const requests = [];
  assert.equal(await checkForUpdate({ environment: { GCT_REPO_SLUG: 'custom-owner/custom-terminal' }, savedSource: null,
    fetchImpl: async (url) => { requests.push(url); return { ok: false }; } }), null);
  assert.deepEqual(requests, ['https://api.github.com/repos/custom-owner/custom-terminal/releases/latest']);
});

test('respects an explicit new pin during legacy repository migration', async () => {
  let requested = false;
  const result = await checkForUpdate({ environment: { GCT_SOURCE_REF: 'v1.0.2' },
    savedSource: { repository: 'your-quantguy/gate-crossex', ref: 'v0.2.2' },
    fetchImpl: async () => { requested = true; return { ok: false }; } });
  assert.equal(requested, false);
  assert.equal(result, null);
});

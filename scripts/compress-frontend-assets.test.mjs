import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { compressFrontendAssets } from './compress-frontend-assets.mjs';

test('built public variants preserve bytes and negotiate identity, gzip and brotli', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixiu-public-assets-'));
  const app = Fastify();
  const original = Buffer.from('export const message = "market data";\n'.repeat(400));
  try {
    await writeFile(join(directory, 'app.js'), original);
    await writeFile(join(directory, 'private.json'), original);
    await writeFile(join(directory, 'tiny.js'), 'export default 1');
    await compressFrontendAssets(directory);
    assert.deepEqual(gunzipSync(await readFile(join(directory, 'app.js.gz'))), original);
    assert.deepEqual(brotliDecompressSync(await readFile(join(directory, 'app.js.br'))), original);
    await assert.rejects(readFile(join(directory, 'private.json.gz')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, 'tiny.js.gz')), { code: 'ENOENT' });
    await app.register(fastifyStatic, { root: directory, prefix: '/assets/', preCompressed: true });
    for (const [encoding, decode] of [['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
      const response = await app.inject({ url: '/assets/app.js', headers: { 'accept-encoding': encoding } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-encoding'], encoding);
      assert.match(response.headers.vary, /Accept-Encoding/i);
      assert.deepEqual(decode(response.rawPayload), original);
      assert.ok(response.rawPayload.length < original.length / 5);
    }
    const identity = await app.inject({ url: '/assets/app.js', headers: { 'accept-encoding': 'gzip;q=0, br;q=0' } });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(identity.rawPayload, original);
    assert.match(identity.headers.vary, /Accept-Encoding/i);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

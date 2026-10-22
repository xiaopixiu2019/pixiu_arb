import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyPaths, eventRange, checkDocumentation } from './ci-scope.mjs';
import { assertReleaseContext, readRepository } from './release-guard.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pixiu-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function put(root, path, text) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

test('only user documentation selects the lightweight gate', () => {
  assert.equal(classifyPaths(['README.md', 'docs/guide.md']), false);
  for (const path of ['skills/foo/SKILL.md', '.github/workflows/ci.yml', 'docs/example.ts',
    'package-lock.json', 'migrations/0030.sql', 'apps/frontend/src/app.tsx', 'AGENTS.md']) {
    assert.equal(classifyPaths(['README.md', path]), true, path);
  }
  assert.equal(classifyPaths([]), true);
  assert.equal(classifyPaths(['docs/../scripts/file.md']), true);
});

test('event ranges cover all pushed/PR commits and manual/queue checks stay full', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  assert.deepEqual(eventRange('push', { before: base, after: head }, head), { base, head });
  assert.deepEqual(eventRange('pull_request', { pull_request: { base: { sha: base } } }, head), { base, head });
  assert.equal(eventRange('push', { before: '0'.repeat(40), after: head }, head), null);
  assert.equal(eventRange('push', { before: base, after: base }, head), null);
  assert.equal(eventRange('workflow_dispatch', {}, head), null);
  assert.equal(eventRange('merge_group', {}, head), null);
  assert.equal(eventRange('pull_request', {}, head), null);
  assert.equal(eventRange('pull_request', null, head), null);
});

test('documentation validates local links and ignores URLs, code samples and titles', t => {
  const root = fixture(t);
  put(root, 'docs/guide.md', '# Guide\n');
  put(root, 'README.md', '[guide](docs/guide.md#guide "Guide")\n[web](https://example.com)\n'
    + '```md\n[example](missing.md)\n```\n`[inline](missing.md)`\n');
  assert.doesNotThrow(() => checkDocumentation(root, ['README.md']));
  put(root, 'README.md', '[broken](docs/missing.md)\n');
  assert.throws(() => checkDocumentation(root, ['README.md']), /missing local link/);
  put(root, 'README.md', '[escape](../outside.md)\n');
  assert.throws(() => checkDocumentation(root, ['README.md']), /outside repository/);
});

test('deleting documentation checks unchanged tracked documents referencing it', t => {
  const root = fixture(t);
  put(root, 'README.md', '[guide](docs/guide.md)\n');
  put(root, 'docs/guide.md', '# Guide\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  rmSync(join(root, 'docs/guide.md'));
  assert.throws(() => checkDocumentation(root, ['docs/guide.md']), /missing local link/);
});

test('documentation accepts repository root aliases without allowing links outside the real root', t => {
  const container = fixture(t), root = join(container, 'actual'), alias = join(container, 'alias');
  put(root, 'README.md', '[guide](docs/guide.md)\n');
  put(root, 'docs/guide.md', '# Guide\n');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotThrow(() => checkDocumentation(alias, ['README.md']));
  execFileSync('git', ['-C', root, 'add', '.']);
  rmSync(join(root, 'docs/guide.md'));
  assert.throws(() => checkDocumentation(alias, ['docs/guide.md']), /missing local link/);
  put(root, 'docs/guide.md', '# Guide\n');
  put(container, 'outside/secret.md', '# Outside\n');
  symlinkSync(join(container, 'outside'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  put(root, 'README.md', '[escape](linked/secret.md)\n');
  assert.throws(() => checkDocumentation(alias, ['README.md']), /outside repository/);
  assert.throws(() => checkDocumentation(alias, ['linked/secret.md']), /documentation must be a repository file/);
});

const context = { repository: 'xiaopixiu2019/pixiu_arb', event: 'push',
  ref: 'refs/tags/v1.0.2', sha: 'a'.repeat(40), head: 'a'.repeat(40), version: '1.0.2',
  remote: { node_id: 'R_kgDOVDFKgw', private: false, default_branch: 'main' }, inMain: true };

test('public release requires actual identity, matching version/commit and main ancestry', () => {
  assert.equal(assertReleaseContext(context), true);
  for (const change of [{ repository: 'another-owner/another-repository' },
    { remote: { ...context.remote, private: true } }, { remote: { ...context.remote, node_id: 'wrong' } },
    { ref: 'refs/tags/v9.9.9' }, { head: 'b'.repeat(40) }, { inMain: false },
    { event: 'pull_request' }, { sha: '' }, { remote: null }]) {
    assert.throws(() => assertReleaseContext({ ...context, ...change }));
  }
});

test('manual public branch preview cannot authorize publication', () => {
  assert.equal(assertReleaseContext({ ...context, event: 'workflow_dispatch', ref: 'refs/heads/main' }), false);
  assert.throws(() => assertReleaseContext({ ...context, ref: 'refs/heads/main' }));
});

test('repository API failures never grant release eligibility', async () => {
  await assert.rejects(readRepository('synthetic-test-token', async () => ({ ok: false, status: 403 })), /HTTP 403/);
  const remote = await readRepository('synthetic-test-token', async url => {
    assert.equal(url, 'https://api.github.com/repos/xiaopixiu2019/pixiu_arb');
    return { ok: true, json: async () => context.remote };
  });
  assert.deepEqual(remote, context.remote);
});

function commit(root) {
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid',
    'commit', '-qm', 'test: fixture']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function runScope(root, event, sha) {
  const eventPath = join(root, '.git', 'event.json');
  const outputPath = join(root, '.git', 'output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  return execFileSync(process.execPath, [fileURLToPath(new URL('./ci-scope.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: sha, GITHUB_OUTPUT: outputPath }, encoding: 'utf8',
  });
}

test('scope CLI detects code anywhere in a multi-commit push', t => {
  const root = fixture(t);
  put(root, 'README.md', '# Before\n');
  const base = commit(root);
  put(root, 'app.js', 'export const changed = true;\n');
  commit(root);
  put(root, 'README.md', '# After\n');
  const head = commit(root);
  assert.match(runScope(root, { before: base, after: head }, head), /CI scope: full/);
  assert.equal(readFileSync(join(root, '.git', 'output.txt'), 'utf8'), 'full=true\n');
});

test('scope CLI accepts valid docs and explicitly fails broken links', t => {
  const root = fixture(t);
  put(root, 'README.md', '# Before\n');
  const base = commit(root);
  put(root, 'README.md', '# After\n');
  const head = commit(root);
  assert.match(runScope(root, { before: base, after: head }, head), /CI scope: documentation/);
  assert.equal(readFileSync(join(root, '.git', 'output.txt'), 'utf8'), 'full=false\n');
  put(root, 'README.md', '[broken](missing.md)\n');
  const brokenHead = commit(root);
  assert.throws(() => runScope(root, { before: head, after: brokenHead }, brokenHead), /Command failed/);
  assert.equal(readFileSync(join(root, '.git', 'output.txt'), 'utf8'), '');
});

test('workflow keeps required names, complete gates and bounded public publishing', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const job of ['quality', 'platform', 'e2e', 'dependencies']) assert.match(ci, new RegExp(`  ${job}:`));
  assert.match(ci, /branches: \[main\]/);
  assert.match(ci, /merge_group:/);
  assert.match(ci, /CI_SCOPE_RESULT/);
  assert.match(ci, /npm audit --audit-level=high/);
  assert.match(ci, /npm run test:ci/);
  assert.equal((release.match(/node scripts\/ci\/release-guard.mjs/g) ?? []).length, 2);
  assert.match(release, /cancel-in-progress: false/);
  assert.match(release, /--title "PIXIU ARB/);
  assert.match(release, /^ {2}source:\s*$/m);
  assert.match(release, /needs: verify/);
  assert.match(release, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(release, /git archive --format=tar\.gz[^\n]+"\$GITHUB_SHA"/);
  assert.match(release, /sha256sum[^\n]+> SHA256SUMS/);
  assert.doesNotMatch(release, /build-macos:|build-windows:|release:bundle:|download-artifact/);
});

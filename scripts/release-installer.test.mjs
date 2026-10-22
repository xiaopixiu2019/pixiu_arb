import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsPowerShell = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.GCT_TEST_POWERSHELL;
const deepReleaseEntry = join('app/node_modules', 'nested-'.repeat(13), 'nested-'.repeat(13), 'payload.txt');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonicalPath(path) {
  const canonical = realpathSync.native(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function assertSamePath(actual, expected) {
  assert.equal(canonicalPath(actual), canonicalPath(expected));
}

function makeFixture(directory, version, commitCharacter) {
  const bundle = join(directory, `fixture-${version}`, 'gate-crossex');
  const node = join(bundle, 'runtime/bin/node');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, '#!/bin/sh\nexit 0\n');
  chmodSync(node, 0o755);
  const backend = join(bundle, 'app/apps/backend/dist/server.js');
  const frontend = join(bundle, 'app/apps/frontend/dist/index.html');
  mkdirSync(dirname(backend), { recursive: true });
  mkdirSync(dirname(frontend), { recursive: true });
  mkdirSync(join(bundle, 'app/migrations'), { recursive: true });
  writeFileSync(backend, '/* fixture */\n');
  writeFileSync(frontend, '<div id="root"></div>\n');
  writeFileSync(join(bundle, 'app/migrations/0001_fixture.sql'), 'SELECT 1;\n');
  const uninstaller = join(bundle, 'app/uninstall.sh');
  writeFileSync(uninstaller, '#!/bin/bash\nexit 0\n');
  chmodSync(uninstaller, 0o755);
  writeFileSync(join(bundle, 'release.json'), `${JSON.stringify({
    schema: 1,
    product: 'Gate CrossEx Local Trading Terminal',
    version,
    commit: commitCharacter.repeat(40),
    nodeVersion: '24.18.0',
    platform: 'darwin',
    arch: process.arch,
    builtAt: '2026-08-02T00:00:00.000Z',
  }, null, 2)}\n`);
  const archive = join(directory, `gate-crossex-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(bundle), 'gate-crossex']);
  return { archive, checksum: sha256(archive), releaseId: `${version}-${commitCharacter.repeat(12)}` };
}

function testEnvironment(installationRoot) {
  return {
    ...process.env,
    GCT_INSTALL_ROOT: installationRoot,
    GCT_LAUNCH_AGENT_PATH: join(installationRoot, 'test-launch-agent', 'com.xiaopixiu.pixiu-arb.plist'),
    GCT_LAUNCHER_APP_PATH: join(installationRoot, 'test-launcher', 'Gate CrossEx.app'),
    GCT_SKIP_SERVICE: '1',
  };
}

function installerEnvironment(installationRoot, fixture) {
  return {
    ...testEnvironment(installationRoot),
    GCT_ARCHIVE: fixture.archive,
    GCT_SHA256: fixture.checksum,
  };
}

function withoutInheritedPowerShellModulePath(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
}

function windowsTestEnvironment(installationRoot) {
  const portableEnvironment = process.platform === 'win32' ? {} : {
    OS: 'Windows_NT',
    LOCALAPPDATA: dirname(installationRoot),
    APPDATA: join(dirname(installationRoot), 'AppData'),
    USERPROFILE: dirname(installationRoot),
  };
  return {
    // Actions launches Node from pwsh. Its PSModulePath hides Windows PowerShell's
    // built-in modules when inherited by powershell.exe, so let the child rebuild it.
    ...withoutInheritedPowerShellModulePath(process.env),
    ...portableEnvironment,
    GCT_INSTALL_ROOT: installationRoot,
    GCT_TASK_NAME: 'Gate CrossEx Installer Test',
    GCT_SHORTCUT_PATH: join(installationRoot, 'test-shortcut', 'Gate CrossEx.lnk'),
    GCT_SKIP_SERVICE: '1',
    GCT_OPEN_BROWSER: '0',
  };
}

test('Windows installer environment does not inherit a foreign PowerShell module path', () => {
  assert.deepEqual(withoutInheritedPowerShellModulePath({
    Path: 'system-bin',
    PSModulePath: 'pwsh-modules',
    pSmOdUlEpAtH: 'duplicate-module-path',
  }), { Path: 'system-bin' });
});

test('Windows scripts hash files without PowerShell utility module auto-loading', () => {
  for (const relativePath of [
    'bootstrap.ps1',
    'install.ps1',
    'run.ps1',
    'scripts/test-windows-release-install.ps1',
  ]) {
    const contents = readFileSync(join(root, relativePath), 'utf8');
    assert.doesNotMatch(contents, /\bGet-FileHash\b/, relativePath);
    assert.match(contents, /\[Security\.Cryptography\.SHA256\]::Create\(\)/, relativePath);
  }
});

test('Windows source launcher resolves relative hash paths through PowerShell', () => {
  const contents = readFileSync(join(root, 'run.ps1'), 'utf8');
  assert.match(contents, /GetUnresolvedProviderPathFromPSPath\(\$FilePath\)/);
  assert.match(contents, /\[IO\.File\]::OpenRead\(\$ResolvedPath\)/);
  assert.doesNotMatch(contents, /\[IO\.File\]::OpenRead\(\$FilePath\)/);
});

test('Windows source launcher invokes npm through Node instead of spawning npm.cmd', {
  skip: process.platform !== 'win32' ? 'Windows child-process behavior' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-launcher-test-'));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.toLowerCase() !== 'path'));
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts/launcher.mjs'), 'doctor'], {
      cwd: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      env: {
        ...environment,
        Path: dirname(process.execPath),
        GCT_DATA_DIR: join(directory, 'data'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^npm=\d+\.\d+\.\d+$/m);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /spawn(?:Sync)? npm\.cmd EINVAL/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production launcher records the backend node process instead of an npm wrapper', () => {
  const contents = readFileSync(join(root, 'scripts/launcher.mjs'), 'utf8');
  assert.match(contents, /spawn\(process\.execPath, \[join\(root, 'apps', 'backend', 'dist', 'server\.js'\)\]/);
  assert.doesNotMatch(contents, /\['run', backendScript, '-w', 'apps\/backend'\]/);
  assert.match(contents, /removeExitedBackendLock\(runtime\.backendPid\)/);
});

test('Windows release bundler invokes npm through Node instead of a batch file', () => {
  const contents = readFileSync(join(root, 'scripts/build-release-bundle-windows.mjs'), 'utf8');
  assert.doesNotMatch(contents, /run\(['"]npm\.cmd['"]/);
  assert.match(contents, /process\.env\.npm_execpath/);
  assert.match(contents, /run\(process\.execPath, \[npmCliPath\(\)/);
});

test('release lockfile includes native keyring packages for every release target', () => {
  const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  for (const target of [
    '@napi-rs/keyring-darwin-arm64',
    '@napi-rs/keyring-darwin-x64',
    '@napi-rs/keyring-win32-arm64-msvc',
    '@napi-rs/keyring-win32-x64-msvc',
  ]) {
    const dependency = lockfile.packages[`node_modules/${target}`];
    assert.equal(dependency?.version, '1.3.0', target);
    assert.equal(dependency?.optional, true, target);
  }
});

test('Windows release installer uses long-path-capable archive extraction', () => {
  const contents = readFileSync(join(root, 'install.ps1'), 'utf8');
  assert.doesNotMatch(contents, /^\s*Expand-Archive\b/m);
  assert.match(contents, /Get-Command tar\.exe/);
  assert.match(contents, /& \$Tar -xf \$ArchivePath -C \$Destination/);
});

function makeWindowsFixture(directory, version, commitCharacter) {
  const bundle = join(directory, `windows-fixture-${version}`, 'gate-crossex');
  const node = join(bundle, 'runtime/node.exe');
  mkdirSync(dirname(node), { recursive: true });
  mkdirSync(dirname(join(bundle, deepReleaseEntry)), { recursive: true });
  writeFileSync(join(bundle, deepReleaseEntry), `release-${version}`);
  copyFileSync(process.execPath, node);
  const backend = join(bundle, 'app/apps/backend/dist/server.js');
  const frontend = join(bundle, 'app/apps/frontend/dist/index.html');
  mkdirSync(dirname(backend), { recursive: true });
  mkdirSync(dirname(frontend), { recursive: true });
  mkdirSync(join(bundle, 'app/migrations'), { recursive: true });
  writeFileSync(backend, '/* fixture */\n');
  writeFileSync(frontend, '<div id="root"></div>\n');
  writeFileSync(join(bundle, 'app/migrations/0001_fixture.sql'), 'SELECT 1;\n');
  for (const dependency of ['better-sqlite3', '@napi-rs/keyring']) {
    const dependencyRoot = join(bundle, 'app/node_modules', dependency);
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, 'package.json'), `${JSON.stringify({ name: dependency, version: '1.0.0', main: 'index.js' })}\n`);
    writeFileSync(join(dependencyRoot, 'index.js'), 'module.exports = {};\n');
  }
  copyFileSync(join(root, 'uninstall.ps1'), join(bundle, 'app/uninstall.ps1'));
  mkdirSync(join(bundle, 'app/packaging'), { recursive: true });
  cpSync(join(root, 'packaging/windows'), join(bundle, 'app/packaging/windows'), { recursive: true });
  writeFileSync(join(bundle, 'release.json'), `${JSON.stringify({
    schema: 1,
    product: 'Gate CrossEx Local Trading Terminal',
    version,
    commit: commitCharacter.repeat(40),
    nodeVersion: process.version.slice(1),
    platform: 'win32',
    arch: process.arch,
    builtAt: '2026-08-02T00:00:00.000Z',
  }, null, 2)}\n`);
  const archive = join(directory, `gate-crossex-windows-${version}.zip`);
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tar, ['-a', '-cf', archive, '-C', dirname(bundle), 'gate-crossex']);
  return { archive, checksum: sha256(archive), releaseId: `${version}-${commitCharacter.repeat(12)}` };
}

test('macOS bootstrap installer verifies, updates, preserves data, and purges only explicitly', {
  skip: process.platform !== 'darwin' ? 'macOS installer test' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-installer-test-'));
  const installationRoot = join(directory, "Install Root with spaces and ' quote");
  try {
    const first = makeFixture(directory, '0.1.0', 'a');
    const second = makeFixture(directory, '0.1.1', 'b');
    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, first),
      stdio: 'pipe',
    });
    assert.equal(lstatSync(join(installationRoot, 'current')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', first.releaseId));
    assert.equal(readFileSync(join(installationRoot, 'versions', first.releaseId, '.archive-sha256'), 'utf8').trim(), first.checksum);
    assert.equal(readFileSync(join(installationRoot, 'uninstall.sh'), 'utf8'), '#!/bin/bash\nexit 0\n');

    // Reinstalling an identical verified release is idempotent.
    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, first),
      stdio: 'pipe',
    });

    const rejected = spawnSync('/bin/bash', [join(root, 'install.sh')], {
      env: { ...installerEnvironment(installationRoot, first), GCT_SHA256: '0'.repeat(64) },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /checksum verification failed/);
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', first.releaseId));

    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, second),
      stdio: 'pipe',
    });
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', second.releaseId));
    assert.equal(existsSync(join(installationRoot, 'versions', first.releaseId)), true);

    writeFileSync(join(installationRoot, 'data', 'preserved.txt'), 'keep\n');
    execFileSync('/bin/bash', [join(root, 'uninstall.sh')], {
      env: testEnvironment(installationRoot),
      stdio: 'pipe',
    });
    assert.equal(existsSync(join(installationRoot, 'versions')), false);
    assert.equal(existsSync(join(installationRoot, 'uninstall.sh')), true);
    assert.equal(readFileSync(join(installationRoot, 'data', 'preserved.txt'), 'utf8'), 'keep\n');

    execFileSync('/bin/bash', [join(root, 'uninstall.sh'), '--purge'], {
      env: testEnvironment(installationRoot),
      stdio: 'pipe',
    });
    assert.equal(existsSync(installationRoot), false);

    const unrelatedRoot = join(directory, 'unrelated-directory');
    mkdirSync(unrelatedRoot);
    writeFileSync(join(unrelatedRoot, 'keep.txt'), 'keep\n');
    const unsafePurge = spawnSync('/bin/bash', [join(root, 'uninstall.sh'), '--purge'], {
      env: testEnvironment(unrelatedRoot),
      encoding: 'utf8',
    });
    assert.notEqual(unsafePurge.status, 0);
    assert.match(unsafePurge.stderr, /refusing to purge an unrecognized installation root/);
    assert.equal(readFileSync(join(unrelatedRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release shell scripts are syntactically valid', {
  skip: process.platform === 'win32' ? 'bash is not required on Windows' : false,
}, () => {
  execFileSync('bash', ['-n', join(root, 'install.sh')]);
  execFileSync('bash', ['-n', join(root, 'uninstall.sh')]);
});

test('Windows bootstrap installer verifies, updates, preserves data, and purges only explicitly', {
  skip: !windowsPowerShell ? 'Windows or portable PowerShell is required' : false,
  timeout: 120_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-windows-installer-test-'));
  const installationRoot = join(directory, "Install Root with spaces and ' quote");
  try {
    const first = makeWindowsFixture(directory, '0.1.0', 'c');
    const second = makeWindowsFixture(directory, '0.1.1', 'd');
    const mark = '[ZoneTransfer]\r\nZoneId=3\r\n';
    if (process.platform === 'win32') writeFileSync(`${first.archive}:Zone.Identifier`, mark);
    const runInstaller = (fixture, extraEnvironment = {}) => execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'install.ps1'),
    ], {
      env: {
        ...windowsTestEnvironment(installationRoot),
        GCT_ARCHIVE: fixture.archive,
        GCT_SHA256: fixture.checksum,
        ...extraEnvironment,
      },
      stdio: 'pipe',
    });

    runInstaller(first);
    const installedDeepFile = join(installationRoot, 'versions', first.releaseId, deepReleaseEntry);
    assert.ok(installedDeepFile.length > 260);
    assert.equal(readFileSync(installedDeepFile, 'utf8'), 'release-0.1.0');
    if (process.platform === 'win32') {
      assert.equal(readFileSync(`${first.archive}:Zone.Identifier`, 'utf8'), mark);
      assert.equal(existsSync(`${installedDeepFile}:Zone.Identifier`), false);
    }
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));
    assert.equal(readFileSync(join(installationRoot, 'versions', first.releaseId, '.archive-sha256'), 'utf8').trim(), first.checksum);
    assert.equal(existsSync(join(installationRoot, 'uninstall.ps1')), true);

    runInstaller(first);
    const rejected = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'install.ps1'),
    ], {
      env: {
        ...windowsTestEnvironment(installationRoot),
        GCT_ARCHIVE: first.archive,
        GCT_SHA256: '0'.repeat(64),
      },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /checksum verification failed/i);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));

    const noTar = join(directory, 'no-tar');
    mkdirSync(noTar);
    assert.throws(() => runInstaller(second, { Path: noTar, PATH: noTar }), /tar\.exe/);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));
    const damagedArchive = join(directory, 'damaged-release.zip');
    const damagedBytes = readFileSync(second.archive); damagedBytes.fill(0, 0, 4);
    writeFileSync(damagedArchive, damagedBytes);
    assert.throws(() => runInstaller({ ...second, archive: damagedArchive, checksum: sha256(damagedArchive) }), /Release archive extraction failed/);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));
    runInstaller(second);
    assert.equal(readdirSync(join(installationRoot, 'versions')).some(name => name.startsWith('.staging-')), false);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', second.releaseId));
    assert.equal(existsSync(join(installationRoot, 'versions', first.releaseId)), true);

    writeFileSync(join(installationRoot, 'data', 'preserved.txt'), 'keep\n');
    const unavailableInstaller = join(directory, 'unavailable-install.ps1');
    const requestedUrls = join(directory, 'requested-urls.txt');
    const mockDownload = `
function Invoke-Download([string]$Uri, [string]$Destination) {
    [IO.File]::AppendAllText($env:GCT_TEST_REQUESTS, $Uri + [Environment]::NewLine)
    throw 'Fixture: release not found'
}
`;
    const actualInstaller = readFileSync(join(root, 'install.ps1'), 'utf8');
    writeFileSync(unavailableInstaller, actualInstaller.replace(/\r?\ntry \{\r?\n {4}Install-GateCrossEx\r?\n/, `${mockDownload}\ntry {\n    Install-GateCrossEx\n`));
    const unavailable = spawnSync(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unavailableInstaller], {
      env: { ...windowsTestEnvironment(installationRoot), GCT_ARCHIVE: '', GCT_TEST_REQUESTS: requestedUrls }, encoding: 'utf8',
    });
    assert.notEqual(unavailable.status, 0);
    assert.match(`${unavailable.stdout}\n${unavailable.stderr}`, /stable PIXIU ARB release is available/);
    assert.match(readFileSync(requestedUrls, 'utf8'), /^https:\/\/github\.com\/xiaopixiu2019\/pixiu_arb\/releases\/latest\/download\/gate-crossex-win32-(?:x64|arm64)\.zip\r?\n$/);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', second.releaseId));
    assert.equal(readFileSync(join(installationRoot, 'data', 'preserved.txt'), 'utf8'), 'keep\n');
    execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(installationRoot, 'uninstall.ps1'),
    ], { env: windowsTestEnvironment(installationRoot), stdio: 'pipe' });
    assert.equal(existsSync(join(installationRoot, 'versions')), false);
    assert.equal(existsSync(join(installationRoot, 'uninstall.ps1')), true);
    assert.equal(readFileSync(join(installationRoot, 'data', 'preserved.txt'), 'utf8'), 'keep\n');

    execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(installationRoot, 'uninstall.ps1'),
      '-Purge',
    ], { env: windowsTestEnvironment(installationRoot), stdio: 'pipe' });
    assert.equal(existsSync(installationRoot), false);

    const unrelatedRoot = join(directory, 'unrelated-directory');
    mkdirSync(unrelatedRoot);
    writeFileSync(join(unrelatedRoot, 'keep.txt'), 'keep\n');
    const unsafePurge = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'uninstall.ps1'),
      '-Purge',
    ], { env: windowsTestEnvironment(unrelatedRoot), encoding: 'utf8' });
    assert.notEqual(unsafePurge.status, 0);
    assert.match(`${unsafePurge.stdout}\n${unsafePurge.stderr}`, /refusing to uninstall an unrecognized installation root/i);
    assert.equal(readFileSync(join(unrelatedRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Windows PowerShell release scripts are syntactically valid', {
  skip: !windowsPowerShell ? 'Windows or portable PowerShell is required' : false,
}, () => {
  const scripts = [
    'bootstrap.ps1',
    'install.ps1',
    'run.ps1',
    'uninstall.ps1',
    'packaging/windows/service.ps1',
    'packaging/windows/gate-crossex.ps1',
    'scripts/test-windows-release-install.ps1',
    'scripts/test-powershell-syntax.ps1',
  ].map((script) => join(root, script));
  execFileSync(windowsPowerShell, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'scripts/test-powershell-syntax.ps1'),
    ...scripts,
  ]);
});

test('Windows source commands propagate database and Git failures before reporting success or updating', {
  skip: process.platform !== 'win32' ? 'Windows native exit behavior' : false, timeout: 60_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-source-failure-'));
  try {
    for (const folder of ['.runtime/node_modules/npm/bin', '.local-data', 'node_modules/.bin', 'scripts'])
      mkdirSync(join(directory, folder), { recursive: true });
    copyFileSync(process.execPath, join(directory, '.runtime/node.exe'));
    copyFileSync(join(root, 'run.ps1'), join(directory, 'run.ps1'));
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, 'package-lock.json'), '{}');
    writeFileSync(join(directory, '.local-data/dependencies.sha256'), sha256(join(directory, 'package-lock.json')));
    writeFileSync(join(directory, 'node_modules/.bin/tsx.cmd'), '@echo off\r\n');
    writeFileSync(join(directory, '.local-data/gate-crossex.sqlite'), 'preserve synthetic state');
    const fixture = (name) => `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.GCT_TEST_TRACE, '${name}\\n');
if (process.env.GCT_TEST_FAIL === '${name}') process.exit(23);
`;
    for (const name of ['launcher', 'backup-database', 'restore-database', 'maintain-database'])
      writeFileSync(join(directory, 'scripts', `${name}.mjs`), fixture(name));
    writeFileSync(join(directory, '.runtime/node_modules/npm/bin/npm-cli.js'),
      `require('node:fs').appendFileSync(process.env.GCT_TEST_TRACE, 'npm ' + process.argv.slice(2).join(' ') + '\\n');`);
    writeFileSync(join(directory, 'fake-git.mjs'), fixture('git'));
    writeFileSync(join(directory, 'git.cmd'), `@echo off\r\n@"${join(directory, '.runtime/node.exe')}" "${join(directory, 'fake-git.mjs')}" %*\r\n`);
    const tracePath = join(directory, 'trace.txt');
    const cases = [['backup', 'backup-database'], ['restore', 'restore-database'], ['maintenance', 'maintain-database'],
      ['update', 'backup-database'], ['update', 'git'], ['backup', ''], ['restore', ''], ['maintenance', ''], ['update', '']];
    for (const [command, failure] of cases) {
      writeFileSync(tracePath, '');
      const result = spawnSync(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        join(directory, 'run.ps1'), command, join(directory, 'synthetic-backup.sqlite')], {
        env: { ...process.env, PATH: `${directory};${process.env.PATH ?? process.env.Path}`, GCT_TEST_FAIL: failure, GCT_TEST_TRACE: tracePath },
        input: 'RESTORE\n', encoding: 'utf8', timeout: 10_000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      const trace = readFileSync(tracePath, 'utf8').trim().split(/\r?\n/);
      if (failure) {
        assert.notEqual(result.status, 0, `${command}/${failure} falsely reported success`);
        assert.equal(trace.at(-1), failure, 'Execution continued after the failing native command');
        assert.ok(!trace.some(line => line.startsWith('npm ')), 'Dependencies/build must not run after failure');
        if (failure !== 'git') assert.doesNotMatch(result.stdout, /(?:Verified|Consistent) database backup created/i);
      } else {
        assert.equal(result.status, 0, result.stderr);
        if (command === 'backup') assert.match(result.stdout, /Verified database backup created/);
        if (command === 'update') assert.deepEqual(trace, ['launcher', 'backup-database', 'git', 'npm ci --cache .local-data/npm-cache --no-audit --no-fund', 'npm run build']);
      }
      assert.equal(readFileSync(join(directory, '.local-data/gate-crossex.sqlite'), 'utf8'), 'preserve synthetic state');
    }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Windows scheduled-task wrapper enables graceful child shutdown', () => {
  const service = readFileSync(join(root, 'packaging/windows/service.ps1'), 'utf8');
  const server = readFileSync(join(root, 'apps/backend/src/server.ts'), 'utf8');
  assert.match(service, /GCT_WINDOWS_SERVICE_PARENT_PID\s*=\s*\[string\]\$PID/);
  assert.match(server, /monitorWindowsServiceParent/);
});

test('Windows ZIP validation rejects links and traversal, and deep cleanup preserves junction targets', {
  skip: process.platform !== 'win32' ? 'Windows archive and filesystem behavior' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-archive-safety-'));
  try {
    const outside = join(directory, 'keep-target');
    mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
    for (const script of ['bootstrap', 'install', 'uninstall']) {
      const owned = join(directory, script);
      mkdirSync(dirname(join(owned, deepReleaseEntry)), { recursive: true });
      writeFileSync(join(owned, deepReleaseEntry), 'owned');
      symlinkSync(outside, join(owned, 'junction'), 'junction');
    }
    const probe = join(directory, 'probe.ps1');
    writeFileSync(probe, String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($script in 'bootstrap','install','uninstall') {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $env:GCT_TEST_SOURCE ($script+'.ps1')),[ref]$tokens,[ref]$errors)
  $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ExtendedPath'},$true)
  Invoke-Expression $function.Extent.Text
  $owned=[IO.Path]::GetFullPath((Join-Path $env:GCT_TEST_DIRECTORY $script))
  if (-not $owned.StartsWith([IO.Path]::GetFullPath($env:GCT_TEST_DIRECTORY)+'\')) { throw 'outside test root' }
  Remove-Item -LiteralPath (Get-ExtendedPath $owned) -Recurse -Force
  if (-not [IO.File]::Exists((Join-Path $env:GCT_TEST_DIRECTORY 'keep-target\sentinel'))) { throw 'junction target removed' }
  if ($script -eq 'uninstall') { continue }
  $validator=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-SafeZip'},$true)
  Invoke-Expression $validator.Extent.Text
  foreach ($case in @(@('gate-crossex/link',-1610612736),@('gate-crossex/fifo',268435456),@('gate-crossex/../outside',0),@('/outside',0),@('gate-crossex/file:stream',0))) {
    $zip=Join-Path $env:GCT_TEST_DIRECTORY ([Guid]::NewGuid().ToString('N')+'.zip')
    $archive=[IO.Compression.ZipFile]::Open($zip,'Create')
    try {
      [void]$archive.CreateEntry('gate-crossex/release.json')
      $entry=$archive.CreateEntry([string]$case[0]); $entry.ExternalAttributes=[int]$case[1]
    } finally { $archive.Dispose() }
    $rejected=$false
    try { Assert-SafeZip $zip 'test archive' | Out-Null } catch {
      if ($_.Exception.Message -notmatch 'unsupported entry type|unsafe path') { throw }
      $rejected=$true
    }
    if (-not $rejected) { throw ('unsafe archive accepted: '+$case[0]) }
  }
}
'archive and cleanup safety passed'
`);
    const result = execFileSync(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], {
      env: { ...process.env, GCT_TEST_SOURCE: root, GCT_TEST_DIRECTORY: directory }, encoding: 'utf8', windowsHide: true,
    });
    assert.match(result, /archive and cleanup safety passed/);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('macOS service migration verifies owned paths before stopping legacy services', {
  skip: process.platform === 'win32' && !existsSync('C:/Program Files/Git/bin/bash.exe') ? 'bash unavailable' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-launchd-test-'));
  try {
    mkdirSync(join(directory, 'config')); mkdirSync(join(directory, 'data'));
    writeFileSync(join(directory, '.gate-crossex-install-root'), 'Gate CrossEx install root v1\n');
    writeFileSync(join(directory, 'legacy.plist'), 'fixture');
    const installer = readFileSync(join(root, 'install.sh'), 'utf8').replace(/main "\$@"\s*$/, '');
    const code = `${installer}\nROOT="$GCT_TEST_ROOT"; if command -v cygpath >/dev/null; then ROOT="$(cygpath -u "$ROOT")"; fi; PLIST="$ROOT/new.plist"; LEGACY_PLIST="$ROOT/legacy.plist"; MARKER="$ROOT/.gate-crossex-install-root"; SKIP_SERVICE=0
launchctl() {
 case "$1" in
 print) case "$2" in *com.yourquantguy*) printf 'program = %s/current/runtime/bin/node\\n' "\${GCT_TEST_RUNTIME_ROOT:-$ROOT}" ;; *) return 1 ;; esac ;;
 bootout) printf '%s\\n' "$2" >> "$ROOT/stopped" ;;
 esac
}
plutil() { case "$2" in
 Label) printf '%s\\n' "$LEGACY_LABEL" ;;
 WorkingDirectory) printf '%s/current/app\\n' "$ROOT" ;;
 ProgramArguments.0) printf '%s/current/runtime/bin/node\\n' "$ROOT" ;;
 ProgramArguments.1) printf '%s/current/app/apps/backend/dist/server.js\\n' "\${GCT_TEST_FOREIGN_ROOT:-$ROOT}" ;;
 EnvironmentVariables.GCT_DATA_DIR) printf '%s/data\\n' "$ROOT" ;;
 esac; }
stop_service
retire_legacy_plist
`;
    const env = { ...process.env, GCT_TEST_ROOT: directory };
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const script = join(directory, 'launchd-contract.sh');
    writeFileSync(script, code.replaceAll('\r\n', '\n'));
    const rejected = spawnSync(bash, [script], { env: { ...env, GCT_TEST_FOREIGN_ROOT: '/unrelated' }, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(existsSync(join(directory, 'stopped')), false);
    const runtimeRejected = spawnSync(bash, [script], { env: { ...env, GCT_TEST_RUNTIME_ROOT: '/unrelated' }, encoding: 'utf8' });
    assert.notEqual(runtimeRejected.status, 0);
    assert.equal(existsSync(join(directory, 'stopped')), false);
    execFileSync(bash, [script], { env });
    assert.match(readFileSync(join(directory, 'stopped'), 'utf8'), /com\.yourquantguy\.gate-crossex/);
    assert.equal(existsSync(join(directory, 'legacy.plist')), false);
    assert.equal(readFileSync(join(directory, 'config/legacy-launchagent.plist.disabled'), 'utf8'), 'fixture');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('macOS uninstall rejects custom unverified plist overrides before any stop or removal', {
  skip: process.platform === 'win32' && !existsSync('C:/Program Files/Git/bin/bash.exe') ? 'bash unavailable' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-uninstall-ownership-test-'));
  try {
    writeFileSync(join(directory, '.gate-crossex-install-root'), 'Gate CrossEx install root v1\n');
    const customPlist = join(directory, 'custom-name.plist');
    writeFileSync(customPlist, 'unrelated plist');
    const wrapper = join(directory, 'uninstall-contract.sh');
    writeFileSync(wrapper, `
uname() { echo Darwin; }
id() { echo 501; }
if command -v cygpath >/dev/null; then
 export GCT_INSTALL_ROOT="$(cygpath -u "$GCT_INSTALL_ROOT")"
 export GCT_LAUNCH_AGENT_PATH="$(cygpath -u "$GCT_LAUNCH_AGENT_PATH")"
 export GCT_LAUNCHER_APP_PATH="$(cygpath -u "$GCT_LAUNCHER_APP_PATH")"
fi
launchctl() { printf '%s\\n' "$*" > "$GCT_INSTALL_ROOT/service-touched"; return 1; }
${readFileSync(join(root, 'uninstall.sh'), 'utf8').replaceAll('\r\n', '\n')}`);
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const rejected = spawnSync(bash, [wrapper], { encoding: 'utf8', env: {
      ...process.env, GCT_INSTALL_ROOT: directory, GCT_LAUNCH_AGENT_PATH: customPlist,
      GCT_LAUNCHER_APP_PATH: join(directory, 'Fixture.app'), GCT_SKIP_SERVICE: '0',
    } });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /LaunchAgent filename must be/);
    assert.equal(readFileSync(customPlist, 'utf8'), 'unrelated plist');
    assert.equal(existsSync(join(directory, 'service-touched')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

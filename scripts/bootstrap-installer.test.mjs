import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsPowerShell = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.GCT_TEST_POWERSHELL;
const deepArchiveEntry = join('archive-path-test', 'nested-'.repeat(13), 'nested-'.repeat(13), 'payload.txt');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeSourceArchive(directory, label) {
  const source = join(directory, `source-${label}`, `gate-crossex-${label}`);
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'gate-crossex-terminal',
    private: true,
    version: '0.1.0',
  })}\n`);
  writeFileSync(join(source, 'package-lock.json'), `${JSON.stringify({ name: 'gate-crossex-terminal', lockfileVersion: 3 })}\n`);
  writeFileSync(join(source, 'bootstrap.sh'), '#!/bin/bash\nexit 0\n');
  writeExecutable(join(source, 'run'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(source, 'scripts/launcher.mjs'), '/* fixture */\n');
  copyFileSync(join(root, 'scripts/check-for-update.mjs'), join(source, 'scripts/check-for-update.mjs'));
  writeFileSync(join(source, 'fixture-version.txt'), `${label}\n`);
  const archive = join(directory, `source-${label}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(source), source.split('/').at(-1)]);
  return archive;
}

function makeNodeArchive(directory, version) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const assetRoot = `node-v${version}-${platform}-${architecture}`;
  const runtime = join(directory, 'runtime-fixture', assetRoot);
  writeExecutable(join(runtime, 'bin/node'), `#!/bin/bash
set -e
case "\${1:-}" in
  --version) echo "v${version}" ;;
  *npm-cli.js)
    if [ "\${2:-}" = "ci" ]; then
      mkdir -p node_modules/.bin node_modules/better-sqlite3 node_modules/@napi-rs/keyring
      touch node_modules/.bin/tsx
      chmod 700 node_modules/.bin/tsx
    fi
    ;;
  -e) ;;
esac
`);
  const npmCli = join(runtime, 'lib/node_modules/npm/bin/npm-cli.js');
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, '/* fixture */\n');
  const archive = join(directory, `${assetRoot}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(runtime), assetRoot]);
  return archive;
}

function makeWindowsSourceArchive(directory, label) {
  const source = join(directory, `windows-source-${label}`, `gate-crossex-${label}`);
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'gate-crossex-terminal',
    private: true,
    version: '0.1.0',
    workspaces: ['packages/*'],
  })}\n`);
  writeFileSync(join(source, 'package-lock.json'), `${JSON.stringify({ name: 'gate-crossex-terminal', lockfileVersion: 3 })}\n`);
  writeFileSync(join(source, 'bootstrap.ps1'), 'exit 0\n');
  copyFileSync(join(root, 'run.ps1'), join(source, 'run.ps1'));
  writeFileSync(join(source, 'scripts/launcher.mjs'), `
import fixtureVersion from '@gate-crossex/bootstrap-fixture';
if (fixtureVersion !== '${label}') throw new Error('workspace link resolved the wrong fixture');
`);
  copyFileSync(join(root, 'scripts/check-for-update.mjs'), join(source, 'scripts/check-for-update.mjs'));
  mkdirSync(join(source, 'packages/bootstrap-fixture'), { recursive: true });
  writeFileSync(join(source, 'packages/bootstrap-fixture/package.json'), `${JSON.stringify({
    name: '@gate-crossex/bootstrap-fixture',
    version: '0.1.0',
    type: 'module',
    main: 'index.js',
  })}\n`);
  writeFileSync(join(source, 'packages/bootstrap-fixture/index.js'), `export default '${label}';\n`);
  writeFileSync(join(source, 'fixture-version.txt'), `${label}\n`);
  const archive = join(directory, `windows-source-${label}.zip`);
  mkdirSync(dirname(join(source, deepArchiveEntry)), { recursive: true });
  writeFileSync(join(source, deepArchiveEntry), `source-${label}`);
  execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(source), basename(source)]);
  return archive;
}

function makeWindowsNodeArchive(directory, version) {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const assetRoot = `node-v${version}-win-${architecture}`;
  const runtime = join(directory, 'windows-runtime-fixture', assetRoot);
  mkdirSync(runtime, { recursive: true });
  mkdirSync(dirname(join(runtime, deepArchiveEntry)), { recursive: true });
  writeFileSync(join(runtime, deepArchiveEntry), 'node-runtime-content');
  copyFileSync(process.execPath, join(runtime, 'node.exe'));
  const npmCli = join(runtime, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, `
const { mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
if (process.argv[2] === 'ci') {
  mkdirSync('node_modules/.bin', { recursive: true });
  writeFileSync('node_modules/.bin/tsx.cmd', '@exit /b 0\\r\\n');
  for (const name of ['better-sqlite3', '@napi-rs/keyring']) {
    const directory = join('node_modules', ...name.split('/'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(directory, 'index.js'), 'module.exports = {}\\n');
  }
  const workspaceLink = resolve('node_modules/@gate-crossex/bootstrap-fixture');
  mkdirSync(dirname(workspaceLink), { recursive: true });
  rmSync(workspaceLink, { recursive: true, force: true });
  if (process.env.GCT_TEST_NONLINK_WORKSPACE === '1') mkdirSync(workspaceLink);
  else symlinkSync(resolve('packages/bootstrap-fixture'), workspaceLink, 'junction');
}
`);
  const archive = join(directory, `${assetRoot}.zip`);
  execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(runtime), assetRoot]);
  return archive;
}

function assertWindowsWorkspaceResolution(installRoot, label) {
  assert.equal(
    readFileSync(join(installRoot, 'node_modules/@gate-crossex/bootstrap-fixture/index.js'), 'utf8'),
    `export default '${label}';\n`,
  );
}

test('Windows source activation tolerates a released lock and preserves uncertain or occupied paths', {
  skip: !windowsPowerShell ? 'Windows PowerShell is required' : false, timeout: 30_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-rename-test-'));
  const script = join(directory, 'rename-test.ps1');
  writeFileSync(script, String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:GCT_TEST_BOOTSTRAP, [ref]$tokens, [ref]$errors)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Move-InstallationDirectory' }, $true)
if ($null -eq $function) { throw 'atomic activation helper missing' }
Invoke-Expression $function.Extent.Text
$root = $env:GCT_RENAME_TEST_ROOT
$source = Join-Path $root 'source'; $target = Join-Path $root 'target'
New-Item -ItemType Directory -Path $source | Out-Null
$file = Join-Path $source 'test-file'; [IO.File]::WriteAllText($file, 'preserve me')
$held = [IO.File]::Open($file, 'Open', 'Read', 'Read')
try {
  $rejected = $false; $timer = [Diagnostics.Stopwatch]::StartNew()
  try { Move-InstallationDirectory $source $target $root 500 } catch { $rejected = $true }
  if (-not $rejected -or $timer.ElapsedMilliseconds -gt 3000) { throw 'persistent lock not bounded' }
  if (-not [IO.Directory]::Exists($source) -or [IO.Directory]::Exists($target)) { throw 'persistent lock changed paths' }
} finally { $held.Dispose() }
$ready = Join-Path $root 'ready'
$job = Start-Job -ScriptBlock {
  param($file, $ready)
  $stream = [IO.File]::Open($file, 'Open', 'Read', 'Read')
  try { [IO.File]::WriteAllText($ready, 'ready'); Start-Sleep -Milliseconds 1000 } finally { $stream.Dispose() }
} -ArgumentList $file,$ready
try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($ready)) { if ($timer.ElapsedMilliseconds -gt 10000) { throw 'lock fixture unavailable' }; Start-Sleep -Milliseconds 20 }
  Move-InstallationDirectory $source $target $root
  if ([IO.File]::ReadAllText((Join-Path $target 'test-file')) -ne 'preserve me') { throw 'rename lost contents' }
} finally { Wait-Job $job -Timeout 10 | Out-Null; Remove-Job $job -Force }
New-Item -ItemType Directory -Path $source | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'other'), 'keep source')
$rejected = $false
try { Move-InstallationDirectory $source $target $root } catch { $rejected = $true }
if (-not $rejected -or -not [IO.File]::Exists((Join-Path $source 'other'))) { throw 'occupied target overwritten' }
$rejected = $false
try { Move-InstallationDirectory $source (Join-Path (Split-Path $root -Parent) 'outside') $root } catch { $rejected = $true }
if (-not $rejected) { throw 'outside path accepted' }
$repair = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Repair-WorkspaceLinks' }, $true)
Invoke-Expression $repair.Extent.Text
$invalidSource = Join-Path $root 'invalid-workspace'
$workspace = Join-Path $invalidSource 'packages\test'
$nonlink = Join-Path $invalidSource 'node_modules\@gate-crossex\test'
New-Item -ItemType Directory -Path $workspace,$nonlink -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $invalidSource 'package.json'), '{"workspaces":["packages/*"]}')
[IO.File]::WriteAllText((Join-Path $workspace 'package.json'), '{"name":"@gate-crossex/test"}')
$validationError = $null
try { Repair-WorkspaceLinks $invalidSource } catch { $validationError = $_.Exception.Message }
if ($validationError -notlike 'Refusing to replace a non-link workspace path:*') { throw 'expected actual workspace validation failure' }
Move-InstallationDirectory $invalidSource (Join-Path $root 'failed-workspace') $root 0
'rename scenarios passed'
`);
  try {
    const output = execFileSync(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, GCT_TEST_BOOTSTRAP: join(root, 'bootstrap.ps1'), GCT_RENAME_TEST_ROOT: directory }, encoding: 'utf8',
    });
    assert.match(output, /rename scenarios passed/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    assert.ok(basename(directory).startsWith('gate-crossex-rename-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Unix bootstrap installs atomically, updates, and preserves local state', {
  skip: process.platform === 'win32' ? 'Unix bootstrap test' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-bootstrap-test-'));
  const installRoot = join(directory, 'Gate CrossEx Source');
  const nodeVersion = '24.18.0';
  const nodeArchive = makeNodeArchive(directory, nodeVersion);
  const baseEnvironment = {
    ...process.env,
    GCT_INSTALL_DIR: installRoot,
    GCT_NODE_VERSION: nodeVersion,
    GCT_NODE_ARCHIVE: nodeArchive,
    GCT_NODE_SHA256: sha256(nodeArchive),
  };
  try {
    const firstSource = makeSourceArchive(directory, 'first');
    execFileSync('/bin/bash', [join(root, 'bootstrap.sh')], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: firstSource },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(installRoot, '.gate-crossex-source-install'), 'utf8').trim(), 'Gate CrossEx source install v1');
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    assert.equal(existsSync(join(installRoot, '.runtime/bin/node')), true);
    assert.equal(existsSync(join(installRoot, 'node_modules/.bin/tsx')), true);
    const metadataPath = join(installRoot, '.gate-crossex-source.json');
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).repository, 'xiaopixiu2019/pixiu_arb');
    writeFileSync(metadataPath, JSON.stringify({ repository: 'your-quantguy/gate-crossex', ref: 'v0.2.2' }, null, 2));
    assert.equal(
      readFileSync(join(installRoot, '.local-data/dependencies.sha256'), 'utf8').trim(),
      sha256(join(installRoot, 'package-lock.json')),
    );

    writeFileSync(join(installRoot, '.local-data/preserved.txt'), 'local state\n');
    writeFileSync(join(installRoot, '.env'), 'SECRET=preserved\n');
    writeFileSync(join(installRoot, 'logs/preserved.log'), 'log\n');
    const secondSource = makeSourceArchive(directory, 'second');
    execFileSync('/bin/bash', [join(root, 'bootstrap.sh'), '--update'], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: secondSource },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');
    assert.equal(readFileSync(join(installRoot, 'logs/preserved.log'), 'utf8').trim(), 'log');

    const unsafeRoot = join(directory, 'unrelated');
    mkdirSync(unsafeRoot);
    writeFileSync(join(unsafeRoot, 'keep.txt'), 'keep\n');
    const rejected = spawnSync('/bin/bash', [join(root, 'bootstrap.sh')], {
      env: { ...baseEnvironment, GCT_INSTALL_DIR: unsafeRoot, GCT_SOURCE_ARCHIVE: firstSource },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /refusing to replace a non-empty directory/);
    assert.equal(readFileSync(join(unsafeRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bootstrap shell scripts are syntactically valid', {
  skip: process.platform === 'win32' ? 'bash is not required on Windows' : false,
}, () => {
  execFileSync('bash', ['-n', join(root, 'bootstrap.sh')]);
  execFileSync('bash', ['-n', join(root, 'run')]);
});

test('Windows bootstrap installs, updates, and preserves local state', {
  skip: !windowsPowerShell ? 'Windows PowerShell is required' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-windows-bootstrap-test-'));
  const installRoot = join(directory, 'Gate CrossEx Source');
  const nodeVersion = process.version.slice(1);
  try {
    const nodeArchive = makeWindowsNodeArchive(directory, nodeVersion);
    const baseEnvironment = {
      ...process.env,
      GCT_INSTALL_DIR: installRoot,
      GCT_NODE_VERSION: nodeVersion,
      GCT_NODE_ARCHIVE: nodeArchive,
      GCT_NODE_SHA256: sha256(nodeArchive),
    };
    const runBootstrap = (sourceArchive, extraEnvironment = {}) => execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'bootstrap.ps1'),
    ], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: sourceArchive, ...extraEnvironment },
      stdio: 'pipe',
    });

    const firstSource = makeWindowsSourceArchive(directory, 'first');
    const mark = '[ZoneTransfer]\r\nZoneId=3\r\n';
    writeFileSync(`${firstSource}:Zone.Identifier`, mark);
    writeFileSync(`${nodeArchive}:Zone.Identifier`, mark);
    runBootstrap(firstSource);
    assert.ok(join(installRoot, deepArchiveEntry).length > 260);
    assert.equal(readFileSync(join(installRoot, deepArchiveEntry), 'utf8'), 'source-first');
    assert.equal(readFileSync(join(installRoot, '.runtime', deepArchiveEntry), 'utf8'), 'node-runtime-content');
    assert.equal(readFileSync(`${firstSource}:Zone.Identifier`, 'utf8'), mark);
    assert.equal(readFileSync(`${nodeArchive}:Zone.Identifier`, 'utf8'), mark);
    assert.equal(existsSync(`${join(installRoot, deepArchiveEntry)}:Zone.Identifier`), false);
    assert.equal(readFileSync(join(installRoot, '.gate-crossex-source-install'), 'utf8').trim(), 'Gate CrossEx source install v1');
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    assert.equal(existsSync(join(installRoot, '.runtime/node.exe')), true);
    assert.equal(existsSync(join(installRoot, 'node_modules/.bin/tsx.cmd')), true);
    assertWindowsWorkspaceResolution(installRoot, 'first');

    const metadataPath = join(installRoot, '.gate-crossex-source.json');
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).repository, 'xiaopixiu2019/pixiu_arb');
    writeFileSync(metadataPath, JSON.stringify({ repository: 'your-quantguy/gate-crossex', ref: 'v0.2.2' }));

    writeFileSync(join(installRoot, '.local-data/preserved.txt'), 'local state\n');
    writeFileSync(join(installRoot, '.env'), 'SECRET=preserved\n');
    writeFileSync(join(installRoot, 'logs/preserved.log'), 'log\n');
    const secondSource = makeWindowsSourceArchive(directory, 'second');
    const noTar = join(directory, 'no-tar');
    mkdirSync(noTar);
    assert.throws(() => runBootstrap(secondSource, { Path: noTar, PATH: noTar }), /tar\.exe/);
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    const damagedArchive = join(directory, 'damaged-source.zip');
    const damagedBytes = readFileSync(secondSource); damagedBytes.fill(0, 0, 4);
    writeFileSync(damagedArchive, damagedBytes);
    assert.throws(() => runBootstrap(damagedArchive, { GCT_SOURCE_SHA256: sha256(damagedArchive) }), /Archive extraction failed/);
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    runBootstrap(secondSource);
    assert.equal(readFileSync(join(installRoot, deepArchiveEntry), 'utf8'), 'source-second');
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');
    assert.equal(readFileSync(join(installRoot, 'logs/preserved.log'), 'utf8').trim(), 'log');
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).repository, 'xiaopixiu2019/pixiu_arb');
    assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).ref, 'main');
    assertWindowsWorkspaceResolution(installRoot, 'second');
    const migratedSource = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(migratedSource.repository, 'xiaopixiu2019/pixiu_arb');
    assert.equal(migratedSource.ref, 'main');
    runBootstrap(secondSource, { GCT_REPO_SLUG: 'custom-owner/custom-terminal', GCT_SOURCE_REF: 'v8.0.0' });
    const customSource = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(customSource.repository, 'custom-owner/custom-terminal');
    assert.equal(customSource.ref, 'v8.0.0');

    // An empty public repository must not replace a working installation.
    const emptyPublicRoot = join(directory, 'empty-public', 'pixiu_arb-main');
    mkdirSync(emptyPublicRoot, { recursive: true });
    writeFileSync(join(emptyPublicRoot, 'README.md'), 'Stable terminal is being prepared.\n');
    const emptyPublicArchive = join(directory, 'empty-public.zip');
    execFileSync('tar.exe', ['-a', '-cf', emptyPublicArchive, '-C', dirname(emptyPublicRoot), basename(emptyPublicRoot)]);
    assert.throws(() => runBootstrap(emptyPublicArchive), /does not contain an installable PIXIU ARB/);
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');

    // Fail only after activation, when the installer verifies workspace links.
    const brokenSource = makeWindowsSourceArchive(directory, 'broken');
    assert.throws(() => runBootstrap(brokenSource, { GCT_TEST_NONLINK_WORKSPACE: '1' }), /previous installation was restored/);
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');
    assertWindowsWorkspaceResolution(installRoot, 'second');

    // Windows PowerShell can keep the process working directory even after
    // run.ps1 calls Set-Location. Relative .NET file access must still use the
    // installed source root rather than System32. The fixture launcher imports
    // a workspace package, so this also catches staging-directory junctions
    // left behind by an atomic update. Run this after the update so a slow
    // node.exe shutdown cannot race the root swap.
    execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(installRoot, 'run.ps1'),
    ], {
      cwd: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      env: baseEnvironment,
      stdio: 'pipe',
    });

    const unsafeRoot = join(directory, 'unrelated');
    mkdirSync(unsafeRoot);
    writeFileSync(join(unsafeRoot, 'keep.txt'), 'keep\n');
    const rejected = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'bootstrap.ps1'),
    ], {
      env: { ...baseEnvironment, GCT_INSTALL_DIR: unsafeRoot, GCT_SOURCE_ARCHIVE: firstSource },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /refusing to replace a non-empty directory/i);
    assert.equal(readFileSync(join(unsafeRoot, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(readdirSync(directory).some(name => name.startsWith('gate-crossex-bootstrap-')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

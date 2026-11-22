import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertOwnedPayload, cleanCompiledOutputs, copyReviewedNotices, copyTrackedDirectory, isolatedRuntimeEnvironment } from './release-bundle-contract.mjs';

test('Windows refuses another installation task before stopping it', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-task-owner-'));
  try {
    const probe = join(directory, 'probe.ps1');
    writeFileSync(probe, String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $env:TEST_SOURCE 'install.ps1'),[ref]$tokens,[ref]$errors)
foreach ($name in @('Assert-OwnedTask','Stop-InstalledService')) {
  $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if ($f) { Invoke-Expression $f.Extent.Text }
}
$root=Join-Path $env:TEST_ROOT 'one'
$other=Join-Path $env:TEST_ROOT 'two'
$script:touched=$false
function Write-Step($message) {}
function Get-OwnedBackendProcessId($InstallRoot) { return $null }
function Stop-ScheduledTask { $script:touched=$true }
function Get-ScheduledTask { return [pscustomobject]@{
  TaskPath='\'; Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
  Actions=@([pscustomobject]@{Execute=(Get-Command powershell.exe).Source;WorkingDirectory=$other;Arguments=('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $other 'bin\service.ps1')+'"')})
} }
$rejected=$false
try { Stop-InstalledService $root 'Shared task' $false } catch {
  if ($_.Exception.Message -notmatch 'belongs to another installation') { throw }
  $rejected=$true
}
if (-not $rejected -or $script:touched) { throw 'Foreign task was not rejected before mutation' }
`);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, TEST_SOURCE: process.cwd(), TEST_ROOT: directory },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('desktop bundles retain source notices and license texts', () => {
  const root = mkdtempSync(join(tmpdir(), 'pixiu-notices-'));
  try {
    const input = join(root, 'input'), output = join(root, 'output'); mkdirSync(input);
    const files = ['LICENSE', 'SOURCE_NOTICES.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'SECURITY.md',
      'LICENSES/third-party.txt', 'apps/frontend/src/assets/fonts/OFL.txt',
      'apps/frontend/src/assets/exchanges/README.md', 'docs/desktop-installation.md'];
    for (const name of files) { mkdirSync(dirname(join(input, name)), { recursive: true }); writeFileSync(join(input, name), `reviewed:${name}\n`); }
    const git = args => execFileSync('git', args, { cwd: input, stdio: 'pipe' });
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: reviewed legal inputs']);
    writeFileSync(join(input, 'LICENSE'), 'not reviewed');
    copyReviewedNotices(input, output);
    for (const name of files) {
      const target = name === 'docs/desktop-installation.md' ? 'README.md' : name;
      assert.deepEqual(readFileSync(join(output, target)), git(['show', `HEAD:${name}`]));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tracked migrations use exact Git bytes instead of Windows checkout line endings', () => {
  const root = mkdtempSync(join(tmpdir(), 'pixiu-migrations-'));
  try {
    const source = join(root, 'migrations/0001.sql'), output = join(root, 'output');
    mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, 'SELECT 1;\n');
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: migration bytes']);
    writeFileSync(source, 'SELECT 1;\r\n');
    copyTrackedDirectory(root, 'migrations', output);
    assert.deepEqual(readFileSync(join(output, '0001.sql')), git(['show', 'HEAD:migrations/0001.sql']));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean build refuses escaping directories and removes stale owned outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixiu-build-input-'));
  try {
    const source = join(directory, 'source'); mkdirSync(join(source, 'apps/backend'), { recursive: true });
    const outside = join(directory, 'keep'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
    symlinkSync(outside, join(source, 'apps/backend/dist'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanCompiledOutputs(source), /escapes/);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
    rmSync(join(source, 'apps/backend/dist'));
    mkdirSync(join(source, 'apps/backend/dist')); writeFileSync(join(source, 'apps/backend/dist/account.sqlite'), 'stale');
    cleanCompiledOutputs(source); assert.equal(existsSync(join(source, 'apps/backend/dist')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('nested runtime files and missing notices cannot enter the owned package payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'pixiu-payload-'));
  try {
    assert.throws(() => assertOwnedPayload(root), /Missing license/);
    for (const file of ['SOURCE_NOTICES.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) writeFileSync(join(root, file), 'notice');
    mkdirSync(join(root, 'LICENSES'));
    mkdirSync(join(root, 'apps/backend/dist'), { recursive: true });
    assertOwnedPayload(root);
    for (const file of ['account.sqlite', '.env', 'backend.log']) {
      const path = join(root, 'apps/backend/dist', file); writeFileSync(path, 'private');
      assert.throws(() => assertOwnedPayload(root), /Runtime\/private/); rmSync(path);
    }
    assert.deepEqual(isolatedRuntimeEnvironment({ GATE_API_KEY: 'synthetic', GCT_DATA_DIR: '/unrelated', NODE_OPTIONS: '--require unsafe', PATH: 'keep' }), { PATH: 'keep' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('post-switch macOS preparation failures enter rollback before cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'pixiu-rollback-control-'));
  try {
    const original = readFileSync(new URL('../install.sh', import.meta.url), 'utf8').replace(/main "\$@"\s*$/, '');
    for (const phase of ['write_plist', 'write_cli', 'make_launcher']) {
      const script = join(root, `${phase}.sh`);
      const body = `${original}\nROOT="$TEST_ROOT"; if command -v cygpath >/dev/null; then ROOT="$(cygpath -u "$ROOT")"; fi
TMP="$ROOT/tmp-${phase}"; mkdir -p "$TMP" "$ROOT/versions/new/app"; RELEASE_DIR="$ROOT/versions/new"
printf 'fixture' > "$RELEASE_DIR/app/uninstall.sh"
stop_service() { :; }; backup_database() { :; }; port_available() { :; }; save_activation() { :; }
write_plist() { :; }; write_cli() { :; }; make_launcher() { :; }
${phase}() { return 73; }
ln() { :; }
rollback_activation() { printf 'rollback' > "$ROOT/${phase}-restored"; }
activate_release
`;
      writeFileSync(script, body.replaceAll('\r\n', '\n'));
      const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
      const result = spawnSync(bash, [script], { env: { ...process.env, TEST_ROOT: root }, encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.equal(readFileSync(join(root, `${phase}-restored`), 'utf8'), 'rollback');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

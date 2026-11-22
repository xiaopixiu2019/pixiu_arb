import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshInstalledApp, isolatedRuntimeEnvironment } from './release-bundle-contract.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = resolve(process.argv[2] ?? 'missing-archive');
const windows = process.platform === 'win32';
assert(['win32', 'darwin'].includes(process.platform), 'Native desktop runner required');
assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Only isolated hosted runners');
assert(existsSync(archive));
const directory = mkdtempSync(join(process.env.RUNNER_TEMP, 'pixiu-desktop-'));
const root = join(directory, 'Installed Application'), id = randomUUID();
const task = `PIXIU Acceptance ${id}`, shortcut = join(directory, 'PIXIU ARB.lnk');
const plist = join(directory, 'LaunchAgents/com.xiaopixiu.pixiu-arb.plist');
const launcher = join(directory, 'PIXIU ARB.app');
const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(join(directory, '.desktop-acceptance-root'), id);
const env = { ...isolatedRuntimeEnvironment(), GCT_INSTALL_ROOT: root, GCT_TASK_NAME: task,
  GCT_SHORTCUT_PATH: shortcut, GCT_LAUNCH_AGENT_PATH: plist, GCT_LAUNCHER_APP_PATH: launcher,
  GCT_OPEN_BROWSER: '0', PIXIU_DESKTOP_TEST_ROOT: directory };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repository, env, encoding: 'utf8', windowsHide: true,
    timeout: 150_000, maxBuffer: 2_000_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function power(script, args = [], environment = env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env: environment });
}
function install(path, environment = env) {
  const selected = { ...environment, GCT_ARCHIVE: path, GCT_SHA256: digest(path) };
  if (windows) power(join(repository, 'install.ps1'), [], selected);
  else run('/bin/bash', [join(repository, 'install.sh')], { env: selected });
}
function cli(command) {
  return windows ? power(join(root, 'bin/gate-crossex.ps1'), [command]) : run(join(root, 'bin/gate-crossex'), [command]);
}
function active() {
  return windows ? readFileSync(join(root, 'current-release.txt'), 'utf8').replace(/^\uFEFF/, '').trim() : realpathSync(join(root, 'current'));
}
function nodeAt(release) { return join(release, windows ? 'runtime/node.exe' : 'runtime/bin/node'); }
function dbSnapshot(release, path = join(root, 'data/gate-crossex.sqlite')) {
  const code = `const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});
    const names=['schema_migrations','user_preferences','execution_strategies','execution_orders','execution_fills','managed_positions','managed_position_claims','managed_risk_lock','margin_cost_reservations','paired_entry_reservations'];
    if(d.pragma('quick_check',{simple:true})!=='ok')throw Error('integrity');
    const fs=require('fs'),p=require('path'),c=require('crypto');const ledger=d.prepare('SELECT id,checksum FROM schema_migrations ORDER BY id').all();
    if(JSON.stringify(ledger.map(r=>r.id))!==JSON.stringify(fs.readdirSync('migrations').filter(n=>/^[0-9].*\\.sql$/.test(n)).sort()))throw Error('migration set');
    for(const r of ledger)if(r.checksum!==c.createHash('sha256').update(fs.readFileSync(p.join('migrations',r.id))).digest('hex'))throw Error('migration checksum');
    process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n=>[n,d.prepare('SELECT * FROM '+n+' ORDER BY 1').all()]))));d.close();`;
  return run(nodeAt(release), ['-e', code, path], { cwd: join(release, 'app') });
}
function assertRetained(beforeText, afterText) {
  const before = JSON.parse(beforeText), after = JSON.parse(afterText);
  assert.equal(after.managed_positions.length, before.managed_positions.length);
  for (const [index, row] of after.managed_positions.entries()) {
    const prior = before.managed_positions[index];
    const changedAt = Date.parse(row.updated_at);
    assert(Number.isFinite(changedAt) && changedAt >= Date.parse(prior.updated_at) && changedAt <= Date.now());
    after.managed_positions[index] = { ...row, updated_at: prior.updated_at };
  }
  assert.deepEqual(after, before, 'Only the managed-state observation timestamp may advance at startup');
}
function repack(source, label, change) {
  const stage = join(directory, label); mkdirSync(stage);
  const bundle = join(stage, 'gate-crossex'); cpSync(source, bundle, { recursive: true, dereference: false });
  change(bundle);
  const output = join(directory, `${label}.${windows ? 'zip' : 'tar.gz'}`);
  run(windows ? 'tar.exe' : 'tar', windows ? ['-a', '-cf', output, '-C', stage, 'gate-crossex'] : ['-czf', output, '-C', stage, 'gate-crossex']);
  return output;
}
function priorFixture(extracted) {
  return repack(extracted, 'synthetic-prior', bundle => {
    const manifest = JSON.parse(readFileSync(join(bundle, 'release.json'), 'utf8'));
    manifest.version = '0.0.0-acceptance'; manifest.commit = 'a'.repeat(40);
    writeFileSync(join(bundle, 'release.json'), JSON.stringify(manifest, null, 2));
    for (const path of ['', 'apps/backend', 'apps/frontend', 'packages/domain', 'packages/shared-types', 'packages/public-data']) {
      const file = join(bundle, 'app', path, 'package.json'), value = JSON.parse(readFileSync(file, 'utf8'));
      value.version = manifest.version; writeFileSync(file, JSON.stringify(value));
    }
  });
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function assertSafe(versionExpected) {
  await assertFreshInstalledApp(`http://127.0.0.1:${env.GCT_PORT}`, versionExpected);
  const response = await fetch(`http://127.0.0.1:${env.GCT_PORT}/api/onboarding/connection`);
  assert.equal((await response.json()).profiles.length, 0);
  cli('status');
}
async function stop() {
  cli('stop');
  const deadline = Date.now() + 45_000;
  while (existsSync(join(root, 'data/backend.lock'))) {
    assert(Date.now() < deadline, 'Backend safety shutdown did not release its data lock');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function seedAndRestart() {
  await stop(); const release = active();
  for (const mode of ['seed', 'reserve32']) run(nodeAt(release), [join(repository, 'scripts/desktop-safety-fixture.mjs'), join(release, 'app'), join(root, 'data/gate-crossex.sqlite'), mode]);
  const snapshot = dbSnapshot(release);
  cli('start'); await assertSafe('0.0.0-acceptance');
  assertRetained(snapshot, dbSnapshot(release)); return dbSnapshot(release);
}
async function ownershipProof() {
  const other = join(directory, 'Other installation'), otherEnv = { ...env, GCT_INSTALL_ROOT: other };
  assert.throws(() => install(archive, otherEnv), /another installation|ownership|belongs/);
  if (windows) {
    assert.throws(() => power(join(repository, 'uninstall.ps1'), ['-Purge'], otherEnv), /another installation/);
  }
  await assertSafe('0.0.0-acceptance');
}
async function restoreProof(release, snapshot) {
  await stop();
  const beforeBackup = dbSnapshot(release); assertRetained(snapshot, beforeBackup);
  const database = join(root, 'data/gate-crossex.sqlite'), backup = join(directory, 'verified-backup.sqlite');
  run(nodeAt(release), [join(release, 'app/scripts/backup-database.mjs'), database, backup]);
  run(nodeAt(release), ['-e', "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare('UPDATE paired_entry_reservations SET config_hash=?').run('changed');d.close()", database], { cwd: join(release, 'app') });
  assert.notEqual(dbSnapshot(release), beforeBackup);
  run(nodeAt(release), [join(release, 'app/scripts/restore-database.mjs'), backup, database]);
  assert.equal(dbSnapshot(release), beforeBackup);
  cli('start'); await assertSafe(version);
  assertRetained(beforeBackup, dbSnapshot(release));
}
async function failureProof(release, snapshot) {
  const bad = repack(release, 'bad-activation', bundle => {
    const manifest = JSON.parse(readFileSync(join(bundle, 'release.json'), 'utf8'));
    manifest.commit = 'b'.repeat(40); writeFileSync(join(bundle, 'release.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(bundle, 'app/apps/backend/dist/server.js'), 'process.exit(73);\n');
  });
  assert.throws(() => install(bad), /restored|previous activation state/);
  assert.equal(active(), release); await assertSafe(version); assertRetained(snapshot, dbSnapshot(release));
  if (!windows) {
    const bin = join(directory, 'failure-bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'osacompile'), '#!/bin/sh\nexit 77\n'); chmodSync(join(bin, 'osacompile'), 0o755);
    assert.throws(() => install(archive, { ...env, PATH: `${bin}:${env.PATH}` }), /previous activation state/);
    assert.equal(active(), release); await assertSafe(version); assertRetained(snapshot, dbSnapshot(release));
  } else {
    const badHelper = repack(release, 'bad-service-helper', bundle => {
      const manifest = JSON.parse(readFileSync(join(bundle, 'release.json'), 'utf8'));
      manifest.commit = 'c'.repeat(40); writeFileSync(join(bundle, 'release.json'), JSON.stringify(manifest, null, 2));
      writeFileSync(join(bundle, 'app/packaging/windows/service.ps1'), "throw 'Synthetic service failure'\n");
    });
    const originalHelper = digest(join(root, 'bin/service.ps1'));
    assert.throws(() => install(badHelper), /restored/);
    assert.equal(digest(join(root, 'bin/service.ps1')), originalHelper);
    assert.equal(active(), release); await assertSafe(version); assertRetained(snapshot, dbSnapshot(release));
  }
}
function uninstall(purge = false) {
  if (windows) power(join(root, 'uninstall.ps1'), purge ? ['-Purge'] : []);
  else run('/bin/bash', [join(root, 'uninstall.sh'), ...(purge ? ['--purge'] : [])]);
}

try {
  env.GCT_PORT = String(await freePort());
  if (!windows) {
    const existing = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.xiaopixiu.pixiu-arb`]);
    assert.notEqual(existing.status, 0, 'Existing application service must not be touched');
  } else {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'if (Get-ScheduledTask -TaskName $env:GCT_TASK_NAME -ErrorAction SilentlyContinue) { throw "Existing test task" }']);
  }
  const extracted = join(directory, 'input'); mkdirSync(extracted);
  run(windows ? 'tar.exe' : 'tar', ['-xf', archive, '-C', extracted]);
  const bundle = join(extracted, 'gate-crossex');
  const manifest = JSON.parse(readFileSync(join(bundle, 'release.json'), 'utf8'));
  assert.equal(manifest.commit, commit); assert.equal(manifest.version, version);
  assert.equal(manifest.arch, process.arch); assert.equal(manifest.platform, process.platform);
  const runtime = JSON.parse(run(nodeAt(bundle), ['-p', 'JSON.stringify({version:process.version,arch:process.arch,abi:process.versions.modules})']));
  assert.equal(runtime.arch, process.arch); assert.equal(runtime.version, `v${manifest.nodeVersion}`);
  install(priorFixture(bundle)); await assertSafe('0.0.0-acceptance'); await ownershipProof();
  const snapshot = await seedAndRestart();
  install(archive); await assertSafe(version);
  const release = active(); assertRetained(snapshot, dbSnapshot(release));
  assert(readdirSync(join(root, 'backups')).some(name => name.endsWith('.sqlite')));
  await restoreProof(release, snapshot); await failureProof(release, snapshot);
  const beforeUninstall = dbSnapshot(release);
  uninstall(); assert(existsSync(join(root, 'data/gate-crossex.sqlite')));
  assert.equal(dbSnapshot(bundle), beforeUninstall); assert(existsSync(join(root, 'uninstall.' + (windows ? 'ps1' : 'sh'))));
  uninstall(true); assert(!existsSync(root));
  const result = { version, commit, platform: process.platform, arch: process.arch, runtime,
    archive: basename(archive), sha256: digest(archive), initialInstall: true, safeRestart: true,
    syntheticPriorUpgrade: true, backupRestore: true, failedActivationRollback: true, foreignInstallationRejected: true,
    preservedResponsibility: true, normalUninstallPreservesData: true, explicitPurge: true, signed: false };
  writeFileSync(join(repository, 'release', `acceptance-${process.platform}-${process.arch}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  if (existsSync(join(root, 'uninstall.' + (windows ? 'ps1' : 'sh')))) uninstall(true);
  assert(readFileSync(join(directory, '.desktop-acceptance-root'), 'utf8') === id);
  assert(!relative(realpathSync(process.env.RUNNER_TEMP), realpathSync(directory)).startsWith('..'));
  rmSync(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[2] ?? join(root, 'release'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(commit, process.env.GITHUB_SHA, 'Publication must use the checked-out workflow commit');
const result = [];
for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
  const name = `gate-crossex-${platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const receipt = JSON.parse(readFileSync(join(directory, `acceptance-${platform}-${arch}.json`), 'utf8'));
  for (const [key, value] of Object.entries({ version, commit, platform, arch, archive: name, signed: false })) assert.equal(receipt[key], value, key);
  for (const key of ['initialInstall', 'safeRestart', 'syntheticPriorUpgrade', 'backupRestore',
    'failedActivationRollback', 'foreignInstallationRejected', 'preservedResponsibility',
    'normalUninstallPreservesData', 'explicitPurge']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.runtime.arch, arch);
  assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'));
  const audit = JSON.parse(execFileSync('python3', [join(root, 'scripts/audit-desktop-archive.py'), join(directory, name)], { encoding: 'utf8' }));
  for (const [key, value] of Object.entries({ version, commit, platform, arch })) assert.equal(audit.manifest[key], value, key);
  assert.equal(receipt.runtime.version, `v${audit.manifest.nodeVersion}`);
  result.push({ ...receipt, archiveAudit: audit });
}
writeFileSync(join(directory, 'desktop-acceptance.json'), JSON.stringify({ version, commit, signed: false, targets: result }, null, 2));
process.stdout.write('All four native archives, installation receipts and identities verified.\n');

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const compiledDirectories = ['apps/backend/dist', 'apps/frontend/dist',
  'packages/domain/dist', 'packages/public-data/dist', 'packages/shared-types/dist'];

export function copyReviewedNotices(root, appRoot) {
  const files = ['LICENSE', 'SOURCE_NOTICES.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'SECURITY.md',
    'apps/frontend/src/assets/fonts/OFL.txt', 'apps/frontend/src/assets/exchanges/README.md'];
  const licenseFiles = execFileSync('git', ['ls-tree', '-rz', '--name-only', 'HEAD', '--', 'LICENSES'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const source of [...files, ...licenseFiles, 'docs/desktop-installation.md']) {
    const destination = join(appRoot, source === 'docs/desktop-installation.md' ? 'README.md' : source);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('git', ['show', `HEAD:${source}`], { cwd: root }), { mode: 0o644 });
  }
}

export function copyTrackedDirectory(root, relativeDirectory, destination) {
  const prefix = `${relativeDirectory.replaceAll('\\', '/')}/`;
  const files = execFileSync('git', ['ls-tree', '-rz', '--name-only', 'HEAD', '--', relativeDirectory], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean);
  if (!files.length || files.some(path => !path.startsWith(prefix) || path.includes('/../'))) {
    throw new Error(`Tracked release directory is missing or invalid: ${relativeDirectory}`);
  }
  for (const source of files) {
    const target = join(destination, source.slice(prefix.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `HEAD:${source}`], { cwd: root }), { mode: 0o644 });
  }
}

function contained(root, path) {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export function cleanCompiledOutputs(root) {
  const realRoot = realpathSync(root);
  for (const directory of compiledDirectories) {
    const path = resolve(root, directory);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink() || !contained(realRoot, realpathSync(path))) {
      throw new Error(`Build directory escapes the repository: ${directory}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
}

export function isolatedRuntimeEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(GCT_|GATE_|BROKER_|PIXIU_)/i.test(name) && !/^(NODE_OPTIONS|NODE_PATH)$/i.test(name)));
}

export function assertOwnedPayload(appRoot) {
  for (const required of ['SOURCE_NOTICES.md', 'LICENSE', 'LICENSES', 'THIRD_PARTY_NOTICES.md']) {
    if (!existsSync(join(appRoot, required))) throw new Error(`Missing license input: ${required}`);
  }
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      if (directory === appRoot && name === 'node_modules') continue;
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Unexpected link in application payload: ${relative(appRoot, path)}`);
      if (/^(?:\.git|\.env(?:\..*)?|\.local-data|logs|data)$|\.(?:sqlite(?:-wal|-shm)?|db|log)$/i.test(name)) {
        throw new Error(`Runtime/private file in application payload: ${relative(appRoot, path)}`);
      }
      if (info.isDirectory()) walk(path);
      else if (!info.isFile()) throw new Error(`Special file in application payload: ${name}`);
    }
  };
  // Production dependencies have their own upstream layouts; inspect only our explicit inputs.
  walk(appRoot);
}

export async function assertFreshInstalledApp(baseUrl, version) {
  const read = async path => {
    const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`Installed API failed: ${path} (${response.status})`);
    return response.json();
  };
  const [health, discovery, mode, connection] = await Promise.all([
    read('/health'), read('/api/system/discovery'), read('/api/trading-mode'), read('/api/onboarding/connection'),
  ]);
  if (health.version !== version || discovery.product !== 'Gate CrossEx Local Trading Terminal'
    || mode.mode !== 'unset' || connection.configured !== false || connection.profiles?.length !== 0) {
    throw new Error('Installed runtime identity, version or safe initial state mismatch');
  }
}

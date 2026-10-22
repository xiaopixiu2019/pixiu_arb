import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_DOCS = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'SOURCE_NOTICES.md', 'THIRD_PARTY_NOTICES.md']);
const SHA = /^[a-f0-9]{40}$/;

export function classifyPaths(paths) {
  return paths.length === 0 || paths.some(path => path.split('/').includes('..')
    || !(ROOT_DOCS.has(path) || /^docs\/[^\r\n\\]+\.md$/.test(path)));
}

export function eventRange(name, event, sha) {
  if (!SHA.test(sha ?? '') || /^0+$/.test(sha)) return null;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const base = name === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  if (!['pull_request', 'push'].includes(name) || !SHA.test(base ?? '') || /^0+$/.test(base)) return null;
  if (name === 'push' && event.after !== sha) return null;
  return { base, head: sha };
}

function git(root, args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function markdownLinks(text) {
  const visible = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/(`+)[^\n]*?\1/g, '');
  return [...visible.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)]
    .map(match => match[1] ?? match[2]);
}

function localTarget(root, source, href) {
  if (/^(?:https?:\/\/|mailto:|#)/i.test(href)) return null;
  const path = decodeURIComponent(href.split(/[?#]/)[0]);
  const target = resolve(dirname(resolve(root, source)), path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || /^(?:[A-Za-z]:|\/)/.test(rel)) {
    throw new Error(`${source}: local link outside repository`);
  }
  return target;
}

function linksFor(root, path) {
  const file = resolve(root, path);
  if (lstatSync(file).isSymbolicLink() || relative(root, realpathSync(file)).startsWith('..')) {
    throw new Error(`${path}: documentation must be a repository file`);
  }
  return markdownLinks(readFileSync(file, 'utf8')).map(href => localTarget(root, path, href)).filter(Boolean);
}

export function checkDocumentation(root, paths) {
  const deleted = new Set(paths.filter(path => !existsSync(resolve(root, path))).map(path => resolve(root, path)));
  const changed = paths.filter(path => existsSync(resolve(root, path)));
  const tracked = deleted.size ? git(root, ['ls-files', '-z']).split('\0').filter(path => path.endsWith('.md')) : [];
  const referencing = tracked.filter(path => existsSync(resolve(root, path))
    && linksFor(root, path).some(target => deleted.has(target)));
  for (const path of new Set([...changed, ...referencing])) {
    for (const target of linksFor(root, path)) {
      if (!existsSync(target)) throw new Error(`${path}: missing local link ${relative(root, target)}`);
      if (relative(root, realpathSync(target)).startsWith('..')) throw new Error(`${path}: local link outside repository`);
    }
  }
}

function readScope(root, name, event, sha) {
  const range = eventRange(name, event, sha);
  if (!range) return { full: true, reason: 'manual, queue or unavailable event range' };
  let paths;
  try {
    if (git(root, ['rev-parse', 'HEAD']).trim() !== range.head) throw new Error('checkout differs from event');
    paths = git(root, ['diff', '--name-only', '-z', range.base, range.head]).split('\0').filter(Boolean);
  } catch {
    return { full: true, reason: 'commit history unavailable or checkout mismatch' };
  }
  if (classifyPaths(paths)) return { full: true, reason: 'code, tooling, skills or unclassified changes' };
  checkDocumentation(root, paths);
  return { full: false, reason: 'user documentation and local links verified' };
}

function main() {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const scope = readScope(process.cwd(), process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA);
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${scope.full}\n`);
    process.stdout.write(`CI scope: ${scope.full ? 'full' : 'documentation'} (${scope.reason})\n`);
  } catch (error) {
    process.stderr.write(`CI scope failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

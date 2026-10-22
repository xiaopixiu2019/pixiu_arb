import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBLIC = 'xiaopixiu2019/pixiu_arb';
const ID = 'R_kgDOVDFKgw';

export function assertReleaseContext(context) {
  if (context.repository !== PUBLIC || context.remote?.node_id !== ID || context.remote?.private !== false
    || context.remote?.default_branch !== 'main') throw new Error('Public release repository identity mismatch');
  if (!['push', 'workflow_dispatch'].includes(context.event)) throw new Error('Unsupported release event');
  if (!/^[a-f0-9]{40}$/.test(context.sha ?? '') || context.head !== context.sha) {
    throw new Error('Release checkout does not match event commit');
  }
  const tag = context.ref.startsWith('refs/tags/');
  if (tag && (context.ref !== `refs/tags/v${context.version}` || !context.inMain)) {
    throw new Error('Release tag/version mismatch or commit outside public main history');
  }
  if (!tag && (context.event !== 'workflow_dispatch' || !context.ref.startsWith('refs/heads/'))) {
    throw new Error('Branch builds require explicit manual preview');
  }
  return tag;
}

export async function readRepository(token, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${PUBLIC}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Repository identity read failed (HTTP ${response.status})`);
  return response.json();
}

async function main() {
  try {
    if (process.env.GITHUB_REPOSITORY !== PUBLIC) throw new Error('Release workflow is for the public repository only');
    if (!process.env.GH_TOKEN) throw new Error('Repository identity read needs the workflow token');
    const root = process.cwd();
    const head = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const ancestry = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', head,
      'refs/remotes/origin/main'], { encoding: 'utf8' });
    const publish = assertReleaseContext({ repository: process.env.GITHUB_REPOSITORY,
      remote: await readRepository(process.env.GH_TOKEN), event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF ?? '', sha: process.env.GITHUB_SHA, head,
      version: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, inMain: ancestry.status === 0 });
    process.stdout.write(`Release guard passed: ${publish ? 'matching public tag' : 'manual public preview'}\n`);
  } catch (error) {
    process.stderr.write(`Release guard failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

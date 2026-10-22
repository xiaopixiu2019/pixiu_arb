import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Shared browser-test contract: execute only the two fixed pure frontend modules.
export async function closeExpectations(baseline, repository = fileURLToPath(new URL('../../', import.meta.url))) {
  const require = createRequire(path.join(repository, 'package.json')), ts = require('typescript');
  const shared = await import(pathToFileURL(path.join(repository, 'packages/shared-types/dist/index.js')).href);
  function contract(name) {
    const filename = path.join(repository, 'apps/frontend/src', name);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const scope = { exports: {}, require: name => {
      if (name !== '@gate-crossex/shared-types') throw new Error('unexpected_ui_contract_dependency');
      return shared;
    } };
    vm.runInNewContext(source, scope, { filename, timeout: 1000 });
    return scope.exports;
  }
  const { positionGroupKey } = contract('position-grouping.ts');
  const { matchManagedCloseTarget } = contract('managed-close-target.ts');
  const groups = new Map();
  for (const [symbol, , quantity] of baseline.positions ?? []) {
    const [venue, , asset] = symbol.split('_'), number = Number(quantity);
    if (!Number.isFinite(number) || number === 0) continue;
    const key = positionGroupKey(asset, venue), rows = groups.get(key) ?? [];
    rows.push({ symbol, asset, venue, quantity: number, side: number > 0 ? 'Long' : 'Short' }); groups.set(key, rows);
  }
  const targets = baseline.tasks.filter(t => ['RUNNING', 'STOPPED'].includes(t.status)
    && !['EXITING', 'STOPPING', 'RISK_PAUSED', 'COMPLETED'].includes(t.phase)).map(strategy => ({ strategy,
    scope: { accountProfileId: baseline.accountId, legs: baseline.claims.filter(r => r[0] === strategy.id).map(([, symbol]) => ({ symbol,
      side: Number(baseline.positions.find(r => r[0] === symbol)?.[2]) > 0 ? 'BUY' : 'SELL' })) } }));
  return baseline.mode === 'live' ? [...groups.values()].map(rows => matchManagedCloseTarget(rows, targets, baseline.accountId))
    .filter(Boolean).map(t => t.strategy.id) : [];
}

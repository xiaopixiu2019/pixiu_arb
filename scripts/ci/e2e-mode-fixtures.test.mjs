import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('protect-only browser fixtures bind both HTTP and WebSocket mode truth', () => {
  const root = resolve('e2e');
  const offenders = readdirSync(root).filter(name => name.endsWith('.ts')).filter(name => {
    const source = readFileSync(resolve(root, name), 'utf8');
    const mocksProtectOnly = source.includes('/api/trading-mode') && /mode:\s*['"]protect_only['"]/.test(source);
    if (!mocksProtectOnly) return false;
    return !source.includes("type: 'mode.update'") || !source.includes("payload: { mode: 'protect_only' }");
  });
  assert.deepEqual(offenders, [], `protect_only fixtures missing matching mode.update: ${offenders.join(', ')}`);
});

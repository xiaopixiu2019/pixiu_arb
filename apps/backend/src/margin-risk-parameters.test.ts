import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { MarginRiskParametersSchema, marginParameterReader, marginParametersId } from './margin-risk-parameters.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('gate-margin-parameters-')) throw new Error('Unsafe test cleanup');
  rmSync(target, { recursive: true, force: true });
} });
const raw = () => ({ version: 1, profileId: 'synthetic', userId: 'synthetic', sourceUrl: 'https://www.gate.com/zh/help/crossex/functional/49325',
  checkedAt: Date.now(), validUntil: Date.now() + 60000,
  pools: [{ key: 'CROSSEX:USDT', fxLow: '1', fxHigh: '1', debtTiers: [{ min: '0', max: '100', initialRate: '0.2', initialOffset: '0', maintenanceRate: '0.1', maintenanceOffset: '0' }],
    collateralTiers: [{ min: '0', max: '1000', rate: '1', offset: '0' }] }], fees: [{ symbol: 'GATE_FUTURE_TEST_USDT', pool: 'CROSSEX:USDT' }] });
describe('read-only risk parameter input', () => {
  it('does not create defaults and never rewrites an approved input', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-margin-parameters-')); roots.push(root);
    const file = join(root, 'margin-risk-parameters.json'), reader = marginParameterReader(root);
    expect(reader()).toBeNull(); expect(existsSync(file)).toBe(false);
    const text = JSON.stringify(raw()); writeFileSync(file, text);
    expect(reader()?.profileId).toBe('synthetic'); expect(readFileSync(file, 'utf8')).toBe(text);
  });
  it('rejects malformed, oversized and unrelated sources without returning their contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-margin-parameters-')); roots.push(root);
    const file = join(root, 'margin-risk-parameters.json'), reader = marginParameterReader(root);
    for (const value of ['{', 'x'.repeat(131073), JSON.stringify({ ...raw(), sourceUrl: 'https://example.com/rules' })]) {
      writeFileSync(file, value); expect(reader()).toBeNull();
    }
  });
  it('requires finite scoped values, bounded leases and unique identifiers', () => {
    const r = raw(); expect(MarginRiskParametersSchema.safeParse(r).success).toBe(true);
    expect(MarginRiskParametersSchema.safeParse({ ...r, pools: [...r.pools, ...r.pools] }).success).toBe(false);
    expect(MarginRiskParametersSchema.safeParse({ ...r, validUntil: r.checkedAt + 86400001 }).success).toBe(false);
    expect(MarginRiskParametersSchema.safeParse({ ...r, pools: [{ ...r.pools[0], fxLow: 'NaN' }] }).success).toBe(false);
  });
  it('identifies economic rule changes separately from a renewed validity lease', () => {
    const p = MarginRiskParametersSchema.parse(raw()), id = marginParametersId(p);
    expect(marginParametersId({ ...p, checkedAt: p.checkedAt + 1000, validUntil: p.validUntil + 1000 })).toBe(id);
    expect(marginParametersId({ ...p, pools: p.pools.map(r => ({ ...r, fxHigh: '1.01' })) })).not.toBe(id);
  });
});

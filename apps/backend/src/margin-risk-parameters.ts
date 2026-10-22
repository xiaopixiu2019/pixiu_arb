import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync, openSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

const numeric = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(80).refine(v => new Decimal(v).isFinite());
const positive = numeric.refine(v => new Decimal(v).gt(0));
const nonnegative = numeric.refine(v => new Decimal(v).gte(0));
const key = z.string().regex(/^[A-Z]+:(USDT|USDC|USD)$/);
const range = { min: nonnegative, max: positive };
export const MarginRiskParametersSchema = z.object({
  version: z.literal(1), profileId: z.string().min(1).max(120), userId: z.string().min(1).max(120),
  sourceUrl: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' &&
    ['www.gate.com', 'gate.com'].includes(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443'); }),
  checkedAt: z.number().int().nonnegative(), validUntil: z.number().int().nonnegative(),
  pools: z.array(z.object({ key, fxLow: positive, fxHigh: positive,
    debtTiers: z.array(z.object({ ...range, initialRate: nonnegative, initialOffset: numeric,
      maintenanceRate: nonnegative, maintenanceOffset: numeric }).strict()).min(1).max(32),
    collateralTiers: z.array(z.object({ ...range, rate: nonnegative.refine(v => new Decimal(v).lte(1)), offset: numeric }).strict()).min(1).max(32),
  }).strict()).min(1).max(32), fees: z.array(z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/), pool: key,
    bookVenue: z.string().regex(/^[A-Z]+$/).optional() }).strict()).min(1).max(200),
}).strict().refine(v => v.validUntil > v.checkedAt && v.validUntil - v.checkedAt <= 86400000, 'Invalid parameter lease')
  .refine(v => new Set(v.pools.map(p => p.key)).size === v.pools.length && new Set(v.fees.map(f => f.symbol)).size === v.fees.length, 'Duplicate rule scope');
export type MarginRiskParameters = z.infer<typeof MarginRiskParametersSchema>;
export const marginParametersId = (p: MarginRiskParameters): string => {
  const rules = { version: p.version, profileId: p.profileId, userId: p.userId,
    sourceUrl: p.sourceUrl, pools: p.pools, fees: p.fees };
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
};

/** Operator-reviewed public risk rules; no defaults, writes, credentials or network calls. */
export function marginParameterReader(dataDir: string): () => MarginRiskParameters | null {
  const path = join(dataDir, 'margin-risk-parameters.json');
  return () => {
    let fd: number | null = null;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 131072) return null;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size > 131072) return null;
      return MarginRiskParametersSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } catch { return null; } finally { if (fd !== null) closeSync(fd); }
  };
}

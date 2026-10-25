import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { TaskPerformanceSchema, TaskTradingResultSchema, TaskPnlComponentSchema, type TaskPnlComponent } from '@gate-crossex/shared-types';
import type { LegacyStage } from './task-performance-legacy-stage.js';
import type { TradingStage } from './task-performance-trading-stage.js';
import type { GroupScope } from './task-performance-projection-scope.js';
import { pnlComponent } from './task-performance-model.js';
const amount = z.string().refine(v => { try { return new Decimal(v).isFinite(); } catch { return false; } });
const time = z.union([z.number(), z.nan(), z.null()]).transform(n => n ?? NaN);
const components = z.object({ price: TaskPnlComponentSchema, funding: TaskPnlComponentSchema, fees: TaskPnlComponentSchema, other: TaskPnlComponentSchema });
const legacy = z.object({ base: TaskPerformanceSchema, before: z.array(z.string()), after: z.array(z.string()), feeValid: z.boolean(),
  from: time, to: time, closed: z.boolean(), estimate: TaskPerformanceSchema.shape.estimate, estimatedAmount: amount.nullable().optional() });
const trading = z.object({ base: TaskTradingResultSchema, tail: z.string(), from: time, to: time, closed: z.boolean(),
  quantities: z.record(z.string(), z.string()), latestFillAt: time, baseline: amount.nullable(), fundingNotBooked: z.boolean(),
  cash: z.object({ confirmed: amount.nullable(), subtotal: amount.nullable(), adjustment: amount, estimated: z.boolean(), components,
    provisionalCashflows: amount, provisional: z.boolean(), error: amount.nullable(), issues: z.array(z.string()) }).nullable() });
const group = z.object({ id: z.string(), taskIds: z.array(z.string()), symbols: z.array(z.string()), orders: z.array(z.string()), from: z.number(), to: z.number() });
export const GroupStageSchema = z.object({ schema: z.literal(1), group, legacy: z.array(legacy), trading });
export interface GroupStage { schema: 1; group: GroupScope; legacy: LegacyStage[]; trading: TradingStage }
const valuedRow = z.object({ at: z.number(), id: z.string(), value: z.object({ id: z.string(), kind: z.enum(['price','funding','fees','other']),
  coin: z.string(), change: z.string(), rate: z.string().nullable(), conflict: z.boolean() }) });
export const PoolStageSchema = z.object({ symbol: z.string(), unallocated: TaskPnlComponentSchema,
  accountCosts: TaskPnlComponentSchema, unresolvedCashflows: TaskPnlComponentSchema,
  entries: z.object({ unallocated: z.array(valuedRow), accountCosts: z.array(valuedRow), unresolvedCashflows: z.array(valuedRow) }) });
export type PoolStage = z.infer<typeof PoolStageSchema>;
export interface FxDependency { coin: string; at: number; rate: string | null }
export interface ProjectionWork { groups: GroupStage[]; pools: PoolStage[]; dependencies: FxDependency[] }
export function poolTotals(pools: PoolStage[]): { unallocated: TaskPnlComponent; accountCosts: TaskPnlComponent; unresolvedCashflows: TaskPnlComponent } {
  const sum = (kind: keyof PoolStage['entries']) => pnlComponent(pools.flatMap(p => p.entries[kind])
    .sort((a,b) => a.at-b.at || Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).map(r => r.value));
  return { unallocated: sum('unallocated'), accountCosts: sum('accountCosts'), unresolvedCashflows: sum('unresolvedCashflows') };
}

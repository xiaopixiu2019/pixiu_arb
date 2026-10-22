import { z } from 'zod';
const money = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const FeeMetricSchema = z.object({
  amount: money.nullable(), status: z.enum(['ready', 'partial', 'unavailable']), pending: z.number().int().nonnegative(), reason: z.string().nullable(),
});
export const FeeTaskSummarySchema = z.object({ taskId: z.string(), metric: FeeMetricSchema, count: z.number().int().nonnegative() });
export const FeeSummarySchema = z.object({
  profileId: z.string().nullable(), currency: z.literal('USDT'), since: z.number().nullable(), checkedAt: z.number().nullable(),
  total: FeeMetricSchema, today: FeeMetricSchema, yesterday: FeeMetricSchema, assigned: FeeMetricSchema, unassigned: FeeMetricSchema,
  tasks: z.array(FeeTaskSummarySchema),
});
export const FeeEvidenceSchema = z.object({
  id: z.string(), at: z.number(), venue: z.string(), orderId: z.string(), taskId: z.string().nullable(),
  coin: z.string(), native: money, converted: money.nullable(), rate: money.nullable(),
  phase: z.enum(['entry', 'exit', 'adjustment', 'unknown']), reason: z.string().nullable(),
});
export const FeeFillSchema = z.object({ id: z.string(), at: z.number(), orderId: z.string(), venue: z.string(), symbol: z.string(), quantity: z.string(),
  fee: z.string(), coin: z.string(), role: z.string(), phase: z.enum(['entry', 'exit', 'adjustment', 'unknown']) });
export const FeeDetailSchema = z.object({
  profileId: z.string().nullable(), taskId: z.string().nullable(), since: z.number().nullable(), checkedAt: z.number().nullable(), metric: FeeMetricSchema,
  entry: money.nullable(), exit: money.nullable(), adjustment: money.nullable(), unknown: money.nullable(), rebates: money.nullable(),
  venues: z.array(z.object({ venue: z.string(), coin: z.string(), native: money.nullable(), converted: money.nullable(), count: z.number(), pending: z.number() })),
  entries: z.array(FeeEvidenceSchema), fills: z.array(FeeFillSchema), totalEntries: z.number().int(), totalFills: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
});
export type FeeMetric = z.infer<typeof FeeMetricSchema>;
export type FeeSummary = z.infer<typeof FeeSummarySchema>;
export type FeeDetail = z.infer<typeof FeeDetailSchema>;
export type FeeEvidence = z.infer<typeof FeeEvidenceSchema>;
export type FeeFill = z.infer<typeof FeeFillSchema>;

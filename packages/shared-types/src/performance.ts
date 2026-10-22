import { z } from 'zod';

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const PerformanceMetricSchema = z.object({
  value: decimal.nullable(), status: z.enum(['ready', 'partial', 'unavailable']), reason: z.string().nullable(),
  from: z.string().nullable(), to: z.string().nullable(),
});
export const PerformanceRangeSchema = z.enum(['24h', '7d', '30d', 'all']);
export const PerformancePointSchema = z.object({ at: z.number().int(), equity: decimal.nullable(), returnPct: decimal.nullable(), reason: z.string().nullable() });
export const AccountPerformanceSchema = z.object({
  profileId: z.string().nullable(), checkedAt: z.string().nullable(), baselineAt: z.string().nullable(),
  currency: z.literal('USDT'), timezone: z.literal('Asia/Shanghai'),
  totalEquity: PerformanceMetricSchema, availableBalance: PerformanceMetricSchema,
  cumulativeProfit: PerformanceMetricSchema, cumulativeReturn: PerformanceMetricSchema,
  todayProfit: PerformanceMetricSchema, yesterdayProfit: PerformanceMetricSchema,
  points: z.array(PerformancePointSchema),
});
export type AccountPerformance = z.infer<typeof AccountPerformanceSchema>;
export type PerformanceMetric = z.infer<typeof PerformanceMetricSchema>;
export type PerformanceRange = z.infer<typeof PerformanceRangeSchema>;

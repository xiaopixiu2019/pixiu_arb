import { z } from 'zod';

const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const TaskPnlComponentSchema = z.object({
  amount: amount.nullable(), native: z.record(z.string(), amount), count: z.number().int().nonnegative(),
});
export const TaskTradingResultSchema = z.object({
  amount: amount.nullable(), confirmed: amount.nullable(), unrealized: amount.nullable(),
  status: z.enum(['confirmed', 'estimated', 'partial', 'unavailable', 'transferred']),
  scope: z.enum(['task', 'group', 'since_adoption', 'execution']), groupId: z.string(), members: z.array(z.string()),
  provisionalCashflows: amount.optional(), adoptionBaseline: amount.nullable().optional(),
  components: z.object({ price: TaskPnlComponentSchema, funding: TaskPnlComponentSchema, fees: TaskPnlComponentSchema, other: TaskPnlComponentSchema }).optional(),
  transferredTo: z.string().optional(), reasons: z.array(z.string()),
  checkedAt: z.number().nullable(), ledgerThrough: z.number().nullable(), valuationAt: z.number().nullable(),
  stale: z.boolean(), adjustment: amount, maxError: amount.nullable(), maxErrorPct: amount.nullable(),
});
export type TaskTradingResult = z.infer<typeof TaskTradingResultSchema>;
export const TaskPerformanceSchema = z.object({
  trading: TaskTradingResultSchema.optional(),
  taskId: z.string(), amount: amount.nullable(), status: z.enum(['settled', 'estimated', 'pending', 'open']),
  estimate: z.object({ adjustment: amount, maxError: amount, maxErrorPct: amount, tolerancePct: amount }).optional(),
  reasons: z.array(z.string()), checkedAt: z.number().nullable(), currency: z.literal('USDT'),
  price: TaskPnlComponentSchema, funding: TaskPnlComponentSchema, fees: TaskPnlComponentSchema,
  other: TaskPnlComponentSchema, native: z.record(z.string(), amount),
});
export const TaskPerformanceSummarySchema = z.object({
  contextToken: z.string().optional(), stale: z.boolean().optional(),
  accountCosts: TaskPnlComponentSchema.optional(),
  unresolvedCashflows: TaskPnlComponentSchema.optional(),
  profileId: z.string().nullable(), checkedAt: z.number().nullable(), reason: z.string().nullable(),
  tasks: z.array(TaskPerformanceSchema), unallocated: TaskPnlComponentSchema,
});
export type TaskPerformance = z.infer<typeof TaskPerformanceSchema>;
export type TaskPerformanceSummary = z.infer<typeof TaskPerformanceSummarySchema>;
export type TaskPnlComponent = z.infer<typeof TaskPnlComponentSchema>;

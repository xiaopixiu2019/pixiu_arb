import { z } from 'zod';

const percent = z.number().finite().gt(100).max(1000000);
export const MarginThresholdSchema = z.object({ warn: percent, reduce: percent, recover: percent })
  .refine((v) => v.reduce < v.warn && v.warn < v.recover, 'Require 100 < reduce < warn < recover');
export const MarginPolicySchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  initial: MarginThresholdSchema.default({ warn: 110, reduce: 105, recover: 115 }),
  maintenance: MarginThresholdSchema.default({ warn: 200, reduce: 150, recover: 220 }),
  protectedGroupIds: z.array(z.string().min(1).max(120)).max(100).default([]),
  notificationsEnabled: z.boolean().default(true),
  reminderMinutes: z.number().int().min(1).max(1440).default(10),
});
export type MarginPolicy = z.infer<typeof MarginPolicySchema>;
export const DEFAULT_MARGIN_POLICY: MarginPolicy = MarginPolicySchema.parse({});
export const MarginMetricsSchema = z.object({
  initialPct: z.string().nullable(), maintenancePct: z.string().nullable(),
  marginBalance: z.string(), initialMargin: z.string(), maintenanceMargin: z.string(), availableMargin: z.string(),
  initialHeadroom: z.string(), maintenanceHeadroom: z.string(),
  accountMode: z.string(), exchangeType: z.string(), remoteUpdatedAt: z.string(),
  assets: z.array(z.object({ venue: z.string(), coin: z.string(), equity: z.string(), liability: z.string(),
    borrowingInitialMargin: z.string(), borrowingMaintenanceMargin: z.string(),
    futuresInitialMargin: z.string().optional(), futuresMaintenanceMargin: z.string().optional(), balance: z.string().optional() })),
});
export type MarginMetrics = z.infer<typeof MarginMetricsSchema>;
export const MarginRiskEventSchema = z.object({ id: z.number(), at: z.number(), kind: z.string(), detail: z.string(), revision: z.number(),
  evidence: z.object({ metrics: MarginMetricsSchema.nullable(), policy: MarginPolicySchema, effectivePolicy: MarginPolicySchema }).nullable().optional() });
export type MarginRiskEvent = z.infer<typeof MarginRiskEventSchema>;
export const MarginSnapshotSchema = z.object({
  accountId: z.string().nullable(), accountLabel: z.string(), sampledAt: z.number().nullable(), ageMs: z.number().nullable(),
  status: z.enum(['unavailable', 'clear', 'warning', 'reducing', 'recovered', 'blocked']), reason: z.string().nullable(),
  fresh: z.boolean(), entryBlocked: z.boolean(), metrics: MarginMetricsSchema.nullable(),
  policy: MarginPolicySchema, effectivePolicy: MarginPolicySchema,
  liveEnabled: z.boolean(), incidentId: z.string().nullable(),
  costAccounting: z.object({ pendingBatches: z.number().int().nonnegative(), reserved: z.string() }).optional(),
  groups: z.array(z.object({ id: z.string(), strategyId: z.string(), asset: z.string(), phase: z.string(),
    eligible: z.boolean(), authorized: z.boolean(), reason: z.string().nullable(),
    readiness: z.object({ status: z.enum(['ready', 'blocked', 'unknown']), reason: z.string().nullable(),
      maxBatchQuantity: z.string().nullable(), approximate: z.boolean().optional(), checkedAt: z.number() }).optional() })),
  uncoveredSymbols: z.array(z.string()),
  units: z.array(z.object({ exchangeType: z.string(), metrics: MarginMetricsSchema.nullable() })).optional(),
  valuation: z.object({ rates: z.record(z.string(), z.string()), checkedAt: z.number(), profileId: z.string().nullable() }).nullable().optional(),
  protection: z.object({ cause: z.enum(['IMR', 'MMR']), stage: z.string(), confirmations: z.number(),
    batchId: z.string().nullable(), strategyId: z.string().nullable(), plannedQuantity: z.string().nullable(),
    targetQuantity: z.string().nullable(), apr: z.string().nullable(), fallback: z.boolean(), reason: z.string().nullable() }).nullable().optional(),
});
export type MarginSnapshot = z.infer<typeof MarginSnapshotSchema>;
export const MarginHistorySchema = z.object({ points: z.array(z.object({ at: z.number(),
  initialPct: z.string().nullable(), maintenancePct: z.string().nullable(),
  initialMin: z.string().nullable(), initialMax: z.string().nullable(),
  maintenanceMin: z.string().nullable(), maintenanceMax: z.string().nullable(),
  marginBalance: z.string().nullable(), initialMargin: z.string().nullable(), maintenanceMargin: z.string().nullable(),
  availableMargin: z.string().nullable(), valid: z.boolean(),
  hasGap: z.boolean().default(false), gapBefore: z.boolean().default(false), lastSampleAt: z.number().optional(),
})), startedAt: z.number().nullable(), stepMs: z.number().default(60000) });
export type MarginHistory = z.infer<typeof MarginHistorySchema>;
export const TelegramStatusSchema = z.object({ configured: z.boolean(), botName: z.string().nullable(),
  chatId: z.string().nullable(), testedAt: z.string().nullable(), lastSentAt: z.string().nullable(),
  lastError: z.string().nullable(), retryAt: z.string().nullable(), storage: z.string() });
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>;

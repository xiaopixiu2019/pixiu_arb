import { z } from 'zod';

const signed = z.string().max(32).regex(/^-?\d+(?:\.\d+)?$/).refine((v) => Number.isFinite(Number(v)));
const positive = signed.refine((v) => Number(v) > 0);
export const PositionManagementConfigSchema = z.object({
  adoptExisting: z.boolean().optional(),
  spreadBps: signed.default('-20'),
  fundingAprPct: signed.default('-100'),
  condition: z.enum(['AND', 'OR']).default('AND'),
  durationSeconds: z.number().int().min(1).max(86400).default(60),
  perOrderQuantity: positive,
  makerLeg: z.enum(['left', 'right']).default('left'),
  intervalSeconds: z.number().int().min(0).max(3600).default(2),
  makerWaitSeconds: z.number().int().min(5).max(3600).default(30),
  marketFallback: z.boolean().default(false),
});
export type PositionManagementConfig = z.infer<typeof PositionManagementConfigSchema>;

export const ManagedPositionViewSchema = z.object({
  phase: z.enum(['OPENING', 'VERIFYING', 'MONITORING', 'BALANCING', 'EXITING', 'RISK_PAUSED', 'COMPLETED', 'STOPPING', 'STOPPED', 'TRANSFERRED']),
  groupId: z.string().optional(),
  adoptedLeft: z.string().optional(), adoptedRight: z.string().optional(),
  adoptedAt: z.string().optional(),
  stopIntent: z.enum(['KEEP', 'EXIT']).nullable().optional(),
  resumeAction: z.enum(['OPENING', 'MONITORING', 'EXITING']).optional(),
  transferredTo: z.string().optional(),
  leftQuantity: z.string().nullable(), rightQuantity: z.string().nullable(),
  checkedAt: z.string().nullable(), spreadBps: z.string().nullable(), fundingAprPct: z.string().nullable(),
  fundingCheckedAt: z.string().nullable(), conditionSince: z.number().nullable(),
  exitRequested: z.boolean(), reason: z.string().nullable(),
  signalReason: z.string().nullable().optional(),
  signalMissingSince: z.number().nullable().optional(),
  pendingOrderIds: z.array(z.string()).default([]),
});
export type ManagedPositionView = z.infer<typeof ManagedPositionViewSchema>;

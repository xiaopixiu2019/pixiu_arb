import { PositionManagementConfigSchema, type PositionManagementConfig } from '@gate-crossex/shared-types';

export interface ManagementDraft {
  enabled: boolean; adoptExisting?: boolean; spreadBps: string; fundingAprPct: string; condition: 'AND' | 'OR';
  durationSeconds: string; quantity: string; intervalSeconds: string; makerWaitSeconds: string;
  makerLeg: 'left' | 'right' | 'entry'; marketFallback: boolean;
}
export const defaultManagementDraft: ManagementDraft = {
  enabled: true, adoptExisting: true, spreadBps: '-90', fundingAprPct: '-150', condition: 'OR', durationSeconds: '3000',
  quantity: '', intervalSeconds: '2', makerWaitSeconds: '30', makerLeg: 'entry', marketFallback: false,
};
export function managementConfig(draft: ManagementDraft, entryQuantity: string, makerLeg: 'left' | 'right'): PositionManagementConfig | null {
  const parsed = PositionManagementConfigSchema.safeParse({ ...draft, perOrderQuantity: draft.quantity || entryQuantity,
    durationSeconds: Number(draft.durationSeconds), intervalSeconds: Number(draft.intervalSeconds),
    makerWaitSeconds: Number(draft.makerWaitSeconds), makerLeg: draft.makerLeg === 'entry' ? makerLeg : draft.makerLeg });
  return parsed.success ? parsed.data : null;
}
export function managementSummary(config: PositionManagementConfig, language: string): string {
  return `${config.spreadBps} bps ${config.condition === 'AND' ? (language === 'zh' ? '且' : 'AND') : (language === 'zh' ? '或' : 'OR')} ${config.fundingAprPct}% APR · ${config.durationSeconds}s · Maker–Taker · ${config.perOrderQuantity}/${config.intervalSeconds}s · ${config.makerWaitSeconds}s ${config.marketFallback ? (language === 'zh' ? '后市价回退' : 'market fallback') : (language === 'zh' ? '后重新挂单' : 'requote')}`;
}

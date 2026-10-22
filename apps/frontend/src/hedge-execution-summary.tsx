import { useId, type ReactNode } from 'react';
import { FieldHelp } from './field-help.js';
import { PositionManagementConfigSchema } from '@gate-crossex/shared-types';
import type { ManagementDraft } from './position-management-config.js';

export function HedgeExecutionSummary({ entry, quantity, leverage, method, reduceOnly, zh }: {
  entry: string; quantity: string; leverage: string; method: string; reduceOnly: string; zh: boolean;
}) {
  const rows = [[zh ? '入场' : 'Entry', entry], [zh ? '每笔订单' : 'Per order', quantity],
    [zh ? '杠杆' : 'Leverage', leverage], [zh ? '方式' : 'Method', method], [zh ? '只减仓' : 'Reduce only', reduceOnly]];
  return <dl className="hedge-execution-summary">{rows.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{value}</dd>
  </div>)}</dl>;
}

const exitFields = PositionManagementConfigSchema.pick({ perOrderQuantity: true, intervalSeconds: true, makerWaitSeconds: true });

export function ManagementExitDetails({ value, zh, children }: { value: ManagementDraft; zh: boolean; children: ReactNode }) {
  const headingId = useId();
  // Blank exit quantity inherits the entry field, whose existing validation remains authoritative.
  const invalid = !exitFields.safeParse({ perOrderQuantity: value.quantity || '1',
    intervalSeconds: Number(value.intervalSeconds), makerWaitSeconds: Number(value.makerWaitSeconds) }).success;
  const leg = value.makerLeg === 'entry' ? (zh ? '沿用建仓挂单腿' : 'Entry maker leg') : value.makerLeg === 'left' ? 'A' : 'B';
  const summary = [value.quantity || (zh ? '沿用建仓每笔数量' : 'Entry clip size'), leg,
    `${zh ? '间隔' : 'Interval'} ${value.intervalSeconds}s`, `${zh ? '等待' : 'Wait'} ${value.makerWaitSeconds}s`,
    zh ? `市价回退${value.marketFallback ? '开启' : '关闭'}` : `Market fallback ${value.marketFallback ? 'on' : 'off'}`].join(' · ');
  return <section className="management-exit-details" aria-labelledby={headingId}>
    <div className="management-exit-heading"><h3 id={headingId}>{zh ? '分批退出设置 · 5 项' : 'Exit settings · 5 fields'}</h3>
      <FieldHelp label={zh ? '分批退出说明' : 'Exit settings help'}>
        <p className="management-exit-summary">{summary}</p>
        <p>{zh ? '退出一旦触发，将持续到清仓，不重新建仓。数据缺失不触发收益条件；订单未知或保护失败暂停并要求人工复核。'
          : 'Once triggered, exit remains active until flat. Missing data cannot trigger an economic exit; unknown orders or failed protection pause for review.'}</p>
      </FieldHelp>
    </div>
    {invalid && <p role="alert" className="exit-settings-error">{zh ? '请核对退出每批数量、批次间隔和挂单等待。' : 'Check exit clip quantity, interval and maker wait.'}</p>}
    {children}
  </section>;
}

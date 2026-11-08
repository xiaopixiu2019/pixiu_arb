import type { MarginSnapshot } from '@gate-crossex/shared-types';
import type { RiskPolicyEditor } from './use-risk-policy-editor.js';
import { riskLevels, policyScenario, thresholdLabels } from './risk-policy-draft.js';

function label(key: string, zh: boolean, snapshot: MarginSnapshot): string {
  if (key.startsWith('add:') || key.startsWith('remove:')) {
    const id = key.slice(key.indexOf(':') + 1), group = snapshot.groups.find(g => g.id === id);
    return `${key.startsWith('add:') ? (zh ? '新增授权' : 'Authorize') : (zh ? '撤销授权' : 'Revoke')} ${group?.asset ?? ''} ${id}`;
  }
  if (key === 'notificationsEnabled') return zh ? 'Telegram提醒' : 'Telegram alerts';
  if (key === 'reminderMinutes') return zh ? '重复提醒间隔（分钟）' : 'Reminder interval (minutes)';
  const [kind, level] = key.split('.');
  return `${kind === 'initial' ? 'IMR' : 'MMR'} · ${thresholdLabels(zh)[riskLevels.indexOf(level as typeof riskLevels[number])]}`;
}
function impact(snapshot: MarginSnapshot, model: RiskPolicyEditor, zh: boolean): string {
  const policy = model.valid;
  const scenario = policy ? policyScenario(snapshot, policy) : 'unknown';
  if (scenario === 'unknown') return zh ? '部分风险单元数据不可用，无法完整判断草稿条件。' : 'Some risk units are unavailable; draft conditions cannot be fully assessed.';
  if (scenario === 'reduce') return zh ? '假设采用草稿规则，存在风险单元满足减仓条件；分所模式仅监控，实际执行仍需授权和有效证据。' : 'Under the draft rules, a risk unit meets reduction conditions. Split-exchange mode is monitoring only; execution still requires authority and evidence.';
  if (scenario === 'warn') return zh ? '假设采用草稿规则，将满足预警并阻止增仓的条件；不是当前事件已改用新规则。' : 'Under the draft rules, warning and entry-block conditions would be met; this does not change the active incident.';
  return zh ? '假设采用草稿规则，当前数据未触及新阈值；这是条件预览，不是执行承诺。' : 'Under the draft rules, current data does not cross thresholds; this is not an execution promise.';
}
export function RiskPolicyPreview({ snapshot, model, zh }: { snapshot: MarginSnapshot; model: RiskPolicyEditor; zh: boolean }) {
  return <section className="risk-policy-preview" aria-label={zh ? '修改预览' : 'Change preview'}>
    <h3>{zh ? '确认本次修改' : 'Review these changes'}</h3>
    <dl>{model.changes.map(change => <div key={change.key}><dt>{label(change.key, zh, snapshot)}</dt>
      <dd>{change.before === 'true' ? (zh ? '开启' : 'On') : change.before === 'false' ? (zh ? '关闭' : 'Off') : change.before} → {change.after === 'true' ? (zh ? '开启' : 'On') : change.after === 'false' ? (zh ? '关闭' : 'Off') : change.after}</dd></div>)}</dl>
    <p>{impact(snapshot, model, zh)}</p>
    <p>{zh ? '已在处理的事件保留原阈值和范围；取消授权会阻止后续新批次，已成交责任仍须核对。保存不解除风险锁，也不自动恢复策略。' : 'Active incidents retain their rules and scope. Revocation blocks new batches; filled responsibility still reconciles. Saving does not clear risk locks or resume strategies.'}</p>
  </section>;
}

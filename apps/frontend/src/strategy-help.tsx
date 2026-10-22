import { FieldHelp } from './field-help.js';
import { useLanguage } from './i18n.js';

const explanations: Record<string, [string, string]> = {
  'Contract': ['选择可在两交易所执行的实际合约；币种相同不代表结算币或合约规格相同。', 'Select the actual contracts available on both venues; settlement currency and specifications may differ.'],
  'Exchange A': ['第一执行腿的交易所，沿用实际支持的市场与账户限制。', 'Venue for the first leg, using the existing market and account restrictions.'],
  'Exchange B': ['第二执行腿的交易所，不能与 A 形成无效选择。', 'Venue for the second leg; invalid combinations remain disabled.'],
  'Choose maker leg': ['选择先挂单的交易所；另一腿按实际成交量主动对冲。', 'Choose the posting venue; the other leg hedges the actual fills.'],
  'Per-order quantity': ['每次提交的基础币数量；两腿都必须满足交易所的最小数量和精度要求。', 'Base-asset quantity per order; both venues must satisfy their minimum and precision rules.'],
  'Total amount': ['本次执行的数量上限。接管旧仓时表示本次新增量，不包含已接管数量。', 'Target for this execution. When adopting holdings, this is additional quantity, excluding adopted holdings.'],
  'Entry threshold': ['价差达到或超过此值才开始建仓。1 bps = 0.01%；方向切换后沿用实际买卖方向计算。', 'Entry waits until the spread reaches this threshold. 1 bps = 0.01%; the selected buy/sell direction determines the spread.'],
  'Position handling': ['只减仓仅减少所选腿的已有仓位，不增加风险敞口；现有杠杆和管理设置限制保持生效。', 'Reduce-only decreases existing holdings. The existing leverage and management restrictions still apply.'],
  'Execution method': ['吃单–吃单双腿主动成交。挂单–吃单先在所选挂单腿挂单，按实际成交量对冲另一腿。', 'Taker–Taker crosses both books. Maker–Taker posts on the chosen maker leg and hedges its actual fills.'],
  'Switch direction': ['交换所选市场的买卖方向，不会自动提交订单；价差和资金费率优势随方向重新计算。', 'Switches buy/sell direction without submitting orders; spread and funding advantage are recalculated.'],
  'Price difference': ['参考入场价差：用卖出腿买一减买入腿卖一，再除以买入腿卖一，换算为 bps。未扣手续费和滑点；缺失、过期或仅供参考的报价不能判定交易就绪。', 'Reference entry spread: (sell bid - buy ask) / buy ask in bps, before fees and slippage. Missing, stale or reference-only quotes do not establish trading readiness.'],
  'Best price': ['当前所选买卖方向的最优买卖盘参考价，不保证成交。REST 或行情重连期间的参考报价不会解除实际下单的实时行情与风险检查。', 'Best bid/ask reference for the selected side, not a guaranteed fill. REST or reconnecting-feed references never relax live quote and risk checks.'],
  'Current funding APR (unleveraged)': ['两腿当前 8 小时资金费率差 × 3 × 365，不乘杠杆，不含价差收益，未扣交易手续费与滑点；不是实际或未来收益保证。', 'Current eight-hour funding difference × 3 × 365, without leverage, price PnL, trading fees or slippage; not a promise of realized or future returns.'],
  'Funding rate': ['所选卖出腿与买入腿按8小时归一化的资金费率差，用于比较两腿；不是单个交易所费率，也不保证未来收益。', 'The selected short-minus-long funding difference normalized to eight hours, not a single venue rate or a promise of future returns.'],
  'Funding / 8h': ['按 8 小时归一化的当前资金费率，用于比较，不代表未来费率不变。', 'Current funding normalized to eight hours for comparison; future rates can change.'],
  'Exchange A leverage': ['保留交易所实际杠杆、最高杠杆和风险档位校验。应用杠杆仍走原确认及权限流程。', 'Uses exchange leverage and risk tiers. Applying leverage keeps the existing authorization flow.'],
  'Exchange B leverage': ['保留交易所实际杠杆、最高杠杆和风险档位校验。应用杠杆仍走原确认及权限流程。', 'Uses exchange leverage and risk tiers. Applying leverage keeps the existing authorization flow.'],
};
export function StrategyHelp({ name }: { name: string }) {
  const { language, t } = useLanguage();
  const text = explanations[name] ?? ['按当前所选两腿的真实数据计算。缺失数据不按零处理，费用和实际收益请在执行详情核对。', 'Uses actual selected-leg data. Missing data is not zero; review fees and realized results separately.'];
  return <FieldHelp label={t(name)}>{text[language === 'zh' ? 0 : 1]}</FieldHelp>;
}

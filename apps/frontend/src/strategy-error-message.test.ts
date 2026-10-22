import { describe, expect, it } from 'vitest';
import { strategyErrorMessage, managedReasonMessage } from './strategy-error-message.js';

describe('actionable strategy rejection messages', () => {
  it('explains Hyperliquid validation and preserves the meaning of an existing maker hard pause', () => {
    expect(strategyErrorMessage({ code: 'hyperliquid_limit_price_invalid' }, 'zh')).toContain('未自动修改价格');
    expect(strategyErrorMessage({ code: 'hyperliquid_price_rules_unavailable' }, 'en')).toContain('order was blocked');
    expect(managedReasonMessage('Five consecutive maker quotes were rejected; check credentials, balances, and venue status', 'zh')).toContain('具体拒绝原因');
  });
  const symbol = 'KRAKEN_FUTURE_CRO_USD';
  it('explains missing quotes for the correct leg without blaming quantity', () => {
    const text = strategyErrorMessage({ code: 'strategy_market_data_unavailable', label: symbol }, 'zh');
    expect(text).toContain('Kraken CRO'); expect(text).toContain('实时行情尚未就绪');
    expect(text).not.toContain('managed'); expect(text).not.toContain('批量太小');
  });
  it.each([
    ['managed_order_below_minimum_size', { quantity: '5', minimum: '10' }, '最小数量 10'],
    ['managed_order_invalid_lot_size', { quantity: '501', step: '10' }, '10 的整数倍'],
    ['managed_order_below_minimum_notional', { quantity: '10', notional: '0.628', minimum: '1' }, '最低 1 USD'],
  ] as const)('formats %s with concrete limits', (code, detail, expected) => {
    const text = strategyErrorMessage({ code, label: JSON.stringify({ symbol, ...detail }) }, 'zh');
    expect(text).toContain('Kraken CRO'); expect(text).toContain(expected);
  });
  it('uses the same explanation for persisted protective failures', () => {
    expect(managedReasonMessage(`managed_market_data_unavailable:${JSON.stringify({ symbol, quantity: '20' })}`, 'zh')).toContain('不会因此扩大减仓数量');
  });
  it('does not describe missing funding evidence as a minimum-notional rejection', () => {
    const text = managedReasonMessage('managed_market_data_unavailable', 'zh');
    expect(text).toContain('资金费率'); expect(text).toContain('计时已重置'); expect(text).not.toContain('最低');
  });
  it('shows the failed leg and separate quote/funding recovery status', () => {
    expect(managedReasonMessage(`managed_quote_unavailable:${symbol}`, 'zh')).toContain('Kraken CRO');
    expect(managedReasonMessage(`managed_quote_unavailable:${symbol}`, 'zh')).toContain('正在重连');
    expect(managedReasonMessage(`managed_funding_unavailable:${symbol}`, 'zh')).toContain('正在重取');
  });
  it('handles old labels, malformed details and unrelated errors without changing their meaning', () => {
    expect(strategyErrorMessage({ code: 'managed_market_data_unavailable', label: '{invalid' }, 'en')).toContain('Selected market');
    expect(strategyErrorMessage({ code: 'live_trading_locked', message: 'live trading locked' }, 'zh')).toBe('live trading locked');
  });
});

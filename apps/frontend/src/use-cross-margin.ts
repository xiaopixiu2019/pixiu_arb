import { useEffect, useState } from 'react';
import { riskApi } from './risk-api.js';

export function useCrossMargin(profileId: string | null | undefined, symbols: string[], enabled: boolean) {
  const key = symbols.join(','), [state, setState] = useState<{ key: string; profile: string | null; items: Awaited<ReturnType<typeof riskApi.modes>>['items'] } | null>(null);
  useEffect(() => {
    if (!enabled || !profileId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await riskApi.modes(key.split(','));
        if (!cancelled && result.profileId === profileId) setState({ key, profile: profileId, items: result.items });
      } catch { if (!cancelled) setState(null); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled, key, profileId]);
  return symbols.map(symbol => !enabled ? null : state?.key === key && state.profile === profileId
    ? state.items.find(i => i.symbol === symbol)?.reason ?? (state.items.some(i => i.symbol === symbol) ? null : 'cross_margin_mode_unknown')
    : 'cross_margin_mode_unknown');
}
export function crossMarginMessage(reason: string, zh: boolean): string {
  if (reason === 'cross_margin_unsupported') return zh ? '该合约不支持全仓下单，仅可逐仓；请更换交易对或交易所' : 'Cross margin unsupported. Choose another contract or venue.';
  if (reason === 'cross_margin_mode_isolated') return zh ? '当前为逐仓模式，不能启动全仓对冲' : 'Current margin mode is isolated.';
  return zh ? '全仓下单能力或实际模式尚未核实' : 'Cross-margin capability or mode is not yet verified.';
}

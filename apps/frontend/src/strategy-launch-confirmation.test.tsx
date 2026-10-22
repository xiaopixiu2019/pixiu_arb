import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StrategyLaunchConfirmation } from './strategy-launch-confirmation.js';

function render(busy = false, managed = false): string {
  return renderToStaticMarkup(<StrategyLaunchConfirmation
    market="BTC · Binance ⇄ OKX"
    rows={[
      { label: 'Direction', value: 'Sell Binance ⇄ Buy OKX' },
      { label: 'Total execution', value: '1 BTC' },
    ]}
    busy={busy}
    managed={managed}
    onCancel={vi.fn()}
    onConfirm={vi.fn()}
  />);
}

describe('strategy launch confirmation', () => {
  it('discloses launch authorization only for managed tasks', () => {
    expect(render(false, true)).toContain('Starting authorizes account IMR/MMR reduction for this managed group');
    expect(render()).not.toContain('Starting authorizes');
  });
  it('requires an explicit confirmation and has no preference bypass', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Confirm strategy launch');
    expect(html).toContain('BTC · Binance ⇄ OKX');
    expect(html).toContain('Sell Binance ⇄ Buy OKX');
    expect(html).toContain('>Run strategy<');
    expect(html).not.toContain("Don&#x27;t show this confirmation again");
  });

  it('locks dismissal and confirmation while the strategy is launching', () => {
    const html = render(true);
    expect(html).toContain('>Launching…<');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext } from './i18n.js';
import { PositionsTable } from './positions-table.js';
import type { PositionTableRow } from './strategy-positions.js';

const fixture=vi.hoisted(()=>({now:Date.now(),reference:true}));
const row:PositionTableRow={id:'p',positionId:'p',symbol:'DERIBIT_FUTURE_HYPE_USDC',venue:'DERIBIT',asset:'HYPE',quote:'USDC',side:'Short',quantity:-10,rawQuantity:'-10',rawEntryPrice:'51',value:520,entryPrice:51,markPrice:52,leverage:'5',unrealizedPnl:-10,realizedPnl:0,fundingFee:0,marginMode:'CROSS',liquidationPrice:'0',liquidationPriceCheckedAt:new Date(fixture.now).toISOString()};
function html(r=row) {
  return renderToStaticMarkup(<LanguageContext.Provider value={{language:'en',theme:'dark',t:k=>k,setLanguage:vi.fn()}}><PositionsTable rows={[r]} profileId="test" onClose={vi.fn()}/></LanguageContext.Provider>);
}
describe('liquidation feature removal', () => {
  it.each(['CROSS', 'ISOLATED'])('does not render a liquidation column or scenario in %s mode', marginMode => {
    const markup = html({ ...row, marginMode, liquidationPrice: '150' });
    expect(markup).not.toContain('liquidation-cell');
    expect(markup).not.toContain('Liquidation price');
    expect(markup).not.toContain('10% doc reference');
    expect(markup).toContain('ADL indicator');
    expect(markup).toContain('Unrealized PnL');
    expect(markup).toContain('Close position');
  });
});

import { expect, test, type Page } from '@playwright/test';
import type { AuthenticatedPortfolioSnapshot } from '@gate-crossex/shared-types';

async function dismiss(page: Page) {
  const dialog=page.getByRole('dialog',{name:'Risk disclaimer'});
  await dialog.waitFor({state:'visible',timeout:1500}).catch(()=>undefined);
  if(await dialog.isVisible()){await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:/Continue in read-only mode/}).click();}
}
function portfolio(): AuthenticatedPortfolioSnapshot {
  const at=new Date().toISOString();
  return {dataStatus:'fresh',remoteStatus:'healthy',reconciliation:{id:'synthetic',createdAt:at,status:'clean',previousFetchedAt:null,currentFetchedAt:at,issues:[]},
    snapshot:{source:'gate_crossex_authenticated_rest',fetchedAt:at,account:{availableMargin:'10',marginBalance:'50',initialMargin:'40',maintenanceMargin:'20.15',initialMarginRate:'1.25',maintenanceMarginRate:'2.481389',positionMode:'SINGLE',accountMode:'CROSS_EXCHANGE',exchangeType:'CROSSEX',remoteUpdatedAt:at},
      balances:[],marginPositions:[],openOrders:[],recentFills:[],futuresPositions:['BYBIT','GATE'].map((venue,i)=>({positionId:`estimate-${venue}`,symbol:`${venue}_FUTURE_BTC_USDT`,positionSide:'NONE',initialMargin:'20',maintenanceMargin:'10.075',quantity:i?'-1':'1',value:'100',unrealizedPnl:'0',unrealizedPnlRate:'0',entryPrice:'100',markPrice:'100',leverage:'5',maxLeverage:'10',riskLimit:'1',fee:'0',fundingFee:'0',fundingTime:at,createdAt:at,updatedAt:at,realizedPnl:'0',marginMode:'CROSS',liquidationPrice:'0',liquidationPriceCheckedAt:at}))}};
}
test('removed liquidation feature has no route, controls, cells or background requests', async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', r => r.request().method() === 'GET' ? r.fulfill({ json: { preferences: { language: 'en' } } }) : r.continue());
  await page.route('**/api/crossex/portfolio-snapshot', r => r.fulfill({ json: portfolio() }));
  const requests: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/crossex/liquidation-estimates')) requests.push(r.url()); });
  for (const url of ['/portfolio', '/strategies/paired-position']) {
    await page.goto(url); await dismiss(page);
    await expect(page.locator('.liquidation-estimate-controls')).toHaveCount(0);
    await expect(page.locator('.liquidation-cell')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
  const removed = await page.request.get('/api/crossex/liquidation-estimates');
  expect(removed.status()).toBe(404);
});

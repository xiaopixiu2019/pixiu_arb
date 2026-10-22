import { test,expect } from '@playwright/test';
test('history displays net PnL and withholds an incomplete total without trading writes',async({page})=>{
  await page.request.post('/__e2e/trading-mode',{data:{mode:'readonly'}});
  await page.request.post('/__e2e/paused-managed-strategy');
  const original=await (await page.request.get('/api/strategies')).json();
  const task=original.strategies.find((s:{id:string})=>s.id==='PAIR-LAYOUT01');
  let pending=false,estimated=false;
  await page.addInitScript(()=>localStorage.setItem('crossex-language','en'));
  await page.route('**/api/preferences',r=>r.request().method()==='GET'?r.fulfill({json:{preferences:{language:'en'}}}):r.continue());
  await page.route('**/api/strategies',r=>r.fulfill({json:{strategies:[{...task,status:'COMPLETED',stoppedAt:new Date().toISOString(),
    management:{...task.management,phase:'COMPLETED',leftQuantity:'0',rightQuantity:'0'}}]}}));
  await page.route('**/api/crossex/task-performance',r=>{
    expect(r.request().method()).toBe('GET');expect(r.request().headers()['x-gct-read-intent']).toBe('task-performance');
    const component={amount:'0',native:{},count:0};
    return r.fulfill({json:{profileId:'gate-crossex-default',checkedAt:Date.now(),reason:null,unallocated:component,tasks:[{
      taskId:task.id,amount:pending?null:estimated?'6.38638':'6.4',status:pending?'pending':estimated?'estimated':'settled',checkedAt:Date.now(),currency:'USDT',native:{USD:'9.92',USDT:'-3.52'},
      ...(estimated?{estimate:{adjustment:'-0.01656',maxError:'0.02156',maxErrorPct:'0.3376',tolerancePct:'5'}}:{}),
      reasons:pending?['missing_historical_fx']:[],price:{...component,amount:'0.48'},funding:{...component,amount:'7.26'},fees:{...component,amount:'-1.34'},other:component,
    }]}});
  });
  const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET'&&/\/api\/(strategies|trading|crossex\/transfers)/.test(r.url()))writes.push(r.url());});
  try {
    await page.goto('/strategies/paired-position');
    const disclaimer=page.getByRole('dialog',{name:/Risk disclaimer/});
    await disclaimer.waitFor({state:'visible',timeout:1500}).catch(()=>undefined);
    if(await disclaimer.isVisible()){await disclaimer.getByRole('checkbox').check();await disclaimer.getByRole('button',{name:/Continue in read-only/}).click();}
    await page.getByRole('tab',{name:/Historical/}).click();
    const cell=page.locator('.strategy-realized-pnl');await expect(cell).toContainText('+6.40');
    await cell.locator('summary').click();await expect(cell).toContainText('Funding cashflows: 7.26');await expect(cell).toContainText('-1.34');
    pending=true;await page.reload();await page.getByRole('tab',{name:/Historical/}).click();
    await expect(cell).toContainText('Settlement / evidence pending');await expect(cell).not.toContainText('+6.40');
    pending=false;estimated=true;await page.reload();await page.getByRole('tab',{name:/Historical/}).click();
    await expect(cell).toContainText('≈ +6.39');await expect(cell).toContainText('Estimated error ≤ 5%');
    await cell.locator('summary').click();await expect(cell).toContainText('Known attribution adjustment: -0.01656');
    expect(writes).toEqual([]);
  } finally {await page.request.delete('/__e2e/paused-managed-strategy');}
});

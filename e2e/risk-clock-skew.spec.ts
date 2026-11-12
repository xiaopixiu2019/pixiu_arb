import { test, expect } from '@playwright/test';
import { openRiskConfig, riskConfigFixture } from './risk-config-fixture.js';

test('risk clock renews in the background across two renewal cycles without an unavailable gap', async ({page}) => {
  test.setTimeout(115000);
  const fixture = await riskConfigFixture(page);
  let reads = 0, clockReads = 0;
  await page.route('**/api/risk/margin/clock', async route => {
    clockReads++;
    await new Promise(resolve=>setTimeout(resolve,50));
    await route.fulfill({json:{accountId:fixture.snapshot().accountId,serverAt:Date.now()}});
  });
  await page.route('**/api/risk/margin', async route => {
    reads++;
    // A slow authenticated refresh is valid snapshot evidence, but must never define the UI clock.
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ json: fixture.snapshot() });
  });
  await openRiskConfig(page);
  await expect(page.locator('.risk-status')).toHaveClass(/clear/);
  // Production frames can be roughly 4.6s apart while all backend snapshots remain fresh.
  const stream = setInterval(() => fixture.send(), 4400);
  try {
    const until = Date.now() + 95000;
    while (Date.now() < until) {
      await expect(page.locator('.risk-execution-notice')).toHaveCount(0, { timeout: 100 });
      await expect(page.locator('.risk-status')).toHaveClass(/clear/, { timeout: 100 });
      await page.waitForTimeout(200);
    }
    expect(reads).toBeGreaterThanOrEqual(1);expect(clockReads).toBeGreaterThanOrEqual(3);
    expect(fixture.writes).toEqual([]);
  } finally { clearInterval(stream); }
});

for (const offset of [2850,-60000]) test(`risk evidence survives client wall-clock offset ${offset} but still expires on a stopped stream`, async ({page}) => {
  await page.addInitScript(value => { const original=Date.now.bind(Date); Date.now=()=>original()+value; },offset);
  const fixture=await riskConfigFixture(page);await openRiskConfig(page);
  await expect(page.locator('.risk-status')).toHaveClass(/clear/);
  for(let i=0;i<3;i++) {
    fixture.send();
    const until=Date.now()+3100;
    while(Date.now()<until){await expect(page.locator('.risk-execution-notice')).toHaveCount(0);await page.waitForTimeout(200);}
  }
  // No new sample: even while the socket is connected and server fresh was true,
  // the original evidence must expire rather than being renewed by UI renders.
  await expect(page.locator('.risk-execution-notice')).toContainText('执行状态待核实',{timeout:7000});
  fixture.send();await expect(page.locator('.risk-execution-notice')).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

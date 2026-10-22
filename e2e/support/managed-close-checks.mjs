/* global window, PopStateEvent, requestAnimationFrame */
import assert from 'node:assert/strict';
import { closeExpectations } from './managed-close-contract.mjs';

export function requestBudget({ limit = 80, windowMs = 60000, now = Date.now } = {}) {
  const issued = [];
  return () => {
    const at = now();
    while (issued.length && issued[0] <= at - windowMs) issued.shift();
    if (issued.length >= limit) throw new Error('observation_request_budget_exceeded');
    issued.push(at);
  };
}

export function permittedRead(request, origin) {
  const url = new URL(request.url());
  if (url.origin !== origin) return false;
  if (request.method() === 'GET') return true;
  return request.method() === 'POST' && request.headers()['x-gct-read-intent'] === 'funding-history'
    && ['/api/markets/funding-history', '/api/markets/funding-rankings', '/api/markets/funding-history/series'].includes(url.pathname);
}

async function verifyClose(page, taskIds, live) {
  assert.equal(await page.locator('.position-leg .close-position-action').count(), 0);
  assert.equal(await page.locator('.positions-table tbody > tr:not(.aggregate-row) .close-position-action').count(), 0);
  const buttons = page.getByRole('button', { name: /^(全部平仓|Close all)$/ });
  const checked = [];
  if (!live) return checked;
  for (const button of await buttons.all()) {
    if (!await button.isEnabled()) continue;
    await button.click();
    const dialog = page.getByRole('dialog', { name: /^(停止任务|Stop task)$/ });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox').isChecked(), true);
    assert.equal(await dialog.getByRole('checkbox').isDisabled(), true);
    const text = await dialog.innerText();
    assert.ok(taskIds.some(id => text.includes(id)), 'close_target_outside_baseline');
    assert.equal(await dialog.getByRole('button', { name: /^(停止并平仓|Stop and close positions)$/ }).count(), 1);
    await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).first().click();
    checked.push(taskIds.find(id => text.includes(id)));
  }
  return checked;
}

async function verifyPositionPages(page, expected, live) {
  const checked = [], seen = new Set();
  for (let count=0;count<100;count++) {
    const table=page.locator('.positions-table').first();
    const pager=table.locator('xpath=following-sibling::*[1][contains(@class,"execution-pagination")]');
    const label=await pager.count()?await pager.locator('.page-indicator').innerText():'single';
    assert.ok(!seen.has(label),'position_pagination_not_advancing');seen.add(label);
    for(const expand of await table.locator('.aggregate-row .expand-position').all()) {
      if(await expand.getAttribute('aria-expanded')!=='true')await expand.click();
      assert.equal(await page.locator('.position-leg .close-position-action').count(),0);
    }
    checked.push(...await verifyClose(page,expected,live));
    const next=pager.locator('button').last();
    if(!await pager.count()||!await next.isEnabled()) {
      assert.deepEqual(checked.sort(),[...expected].sort(),'close_controls_missing_or_disabled');
      return checked;
    }
    await next.click();
  }
  throw new Error('position_pagination_limit');
}

export async function managedCloseChecks(context, origin, baseline, repository) {
  const page = await context.newPage(), pages = [];
  const expected = await closeExpectations(baseline, repository);
  try {
    for (const route of ['/portfolio', '/strategies/paired-position', '/']) {
      const targetRead=baseline.positions?.length===0?null:page.waitForResponse(
        r=>new URL(r.url()).pathname==='/api/strategies/close-targets'&&r.status()===200,{timeout:15000});
      if(targetRead)void targetRead.catch(()=>{});
      if(route==='/portfolio')await page.goto(origin+route,{waitUntil:'domcontentloaded'});
      else if (new URL(page.url()).pathname !== route) {
        await page.evaluate(route => { window.history.pushState(null, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
      }
      await page.locator(route==='/portfolio'?'.portfolio-view':route==='/'?'.orderbook-panel':'.strategy-heading').waitFor();
      if (route.startsWith('/strategies')) {
        for (const id of expected.filter(id=>baseline.tasks.find(t=>t.id===id).status==='RUNNING')) {
          const row = page.locator('.running-row').filter({ hasText: id });
          const stop = row.getByRole('button', { name: /^(停止|Stop)$/ });
          await stop.click();
          const dialog = page.getByRole('dialog', { name: /^(停止任务|Stop task)$/ });
          assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
          await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).first().click();
        }
        await page.getByRole('tab', { name: /^(持仓|Positions)/ }).click();
      }
      if (baseline.positions?.length === 0) {
        await page.getByText(/^(No positions|No open positions|暂无持仓|暂无未平仓仓位)$/).waitFor();
        assert.equal(await page.locator('.close-position-action').count(), 0);
        pages.push({ route, checkedTaskIds: [], emptyPositions: true });
        continue;
      }
      await page.locator('.positions-table').waitFor();
      const targets=await targetRead;
      await targets.finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      pages.push({ route, checkedTaskIds: await verifyPositionPages(page, expected, baseline.mode==='live') });
    }
    return { ok: true, closeInteraction:expected.length?'verified':'notApplicable',pages, realCloseSubmitted: false };
  } finally { await page.close(); }
}

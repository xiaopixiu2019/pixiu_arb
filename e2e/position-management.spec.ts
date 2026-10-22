import { expect, test } from '@playwright/test';

test('managed hedge settings have explicit defaults, editable exit rules and legacy opt-out', async ({ page }) => {
  await page.goto('/strategies/paired-position');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  const settings = page.locator('.position-management-settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: /Keep monitoring and exit automatically/ })).toBeChecked();
  await expect(settings.getByRole('checkbox', { name: /Adopt balanced holdings on these two legs and manage additions together/ })).toBeChecked();
  await expect(settings.getByLabel('Spread below (bps)', { exact: true })).toHaveValue('-90');
  await expect(settings.getByLabel('Net funding APR below (%)', { exact: true })).toHaveValue('-150');
  await expect(settings.getByLabel('Trigger rule', { exact: true })).toHaveValue('OR');
  await expect(settings.getByLabel('Confirmation duration (seconds)', { exact: true })).toHaveValue('3000');
  await expect(settings.locator('.management-exit-details')).toHaveJSProperty('tagName', 'SECTION');
  await expect(settings.getByLabel('Exit clip quantity', { exact: true })).toBeVisible();
  await settings.getByLabel('Exit clip quantity', { exact: true }).fill('2');
  await settings.getByLabel('Maker wait (seconds)', { exact: true }).fill('45');
  await settings.getByLabel('Exit maker leg', { exact: true }).selectOption('right');
  await expect(settings.getByRole('checkbox', { name: /Allow market clips after maker timeout/ })).not.toBeChecked();
  await settings.getByRole('checkbox', { name: /Allow market clips after maker timeout/ }).check();
  await settings.getByRole('button', { name: 'Exit settings help · ?', exact: true }).click();
  const explanation = page.getByRole('note', { name: 'Exit settings help', exact: true });
  await expect(explanation).toContainText('45s');
  await expect(explanation).toContainText('Market fallback on');
  await page.keyboard.press('Escape');
  await expect(settings.getByLabel('Exit clip quantity', { exact: true })).toHaveValue('2');
  await expect(settings.getByLabel('Exit maker leg', { exact: true })).toHaveValue('right');
  await settings.getByLabel('Maker wait (seconds)', { exact: true }).fill('1');
  await expect(settings.getByLabel('Maker wait (seconds)', { exact: true })).toBeVisible();
  await expect(settings.getByRole('alert')).toContainText('Check exit clip quantity, interval and maker wait.');
  await settings.getByLabel('Maker wait (seconds)', { exact: true }).fill('45');
  await settings.getByRole('checkbox', { name: /Keep monitoring and exit automatically/ }).uncheck();
  await expect(settings.getByLabel('Spread below (bps)', { exact: true })).toHaveCount(0);
  await expect(page.locator('.compact-stop')).toContainText('Stops after');
  await settings.getByRole('checkbox', { name: /Keep monitoring and exit automatically/ }).check();
  await expect(settings.getByLabel('Exit clip quantity', { exact: true })).toHaveValue('2');
  await expect(page.locator('.compact-stop')).toContainText('Monitor after entry');
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'data/managed-position-mobile.png', fullPage: true });
});

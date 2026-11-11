import { expect, test } from '@playwright/test';

test('headed Chrome has WebGPU and is cross-origin isolated', async ({ page, browser }) => {
  await page.goto('/');
  const report = await page.evaluate(() => window.tidalReport);
  console.log('Chrome', browser.version());
  console.log('WebGPU adapter', JSON.stringify(report));
  console.log('crossOriginIsolated', report?.crossOriginIsolated);
  expect(report?.webgpu).toBe(true);
  expect(report?.crossOriginIsolated).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
});

import { expect, test } from '@playwright/test';

test('headed Chrome has WebGPU and is cross-origin isolated', async ({ page, browser }) => {
  await page.goto('/');
  const report = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return {
      crossOriginIsolated: self.crossOriginIsolated,
      webgpu: adapter !== null,
      vendor: adapter?.info.vendor ?? '',
      architecture: adapter?.info.architecture ?? '',
      sab: typeof SharedArrayBuffer,
    };
  });
  console.log('Chrome', browser.version());
  console.log('WebGPU adapter', JSON.stringify(report));
  console.log('crossOriginIsolated', report.crossOriginIsolated);
  expect(report.webgpu).toBe(true);
  expect(report.crossOriginIsolated).toBe(true);
  expect(report.sab).toBe('function');
});

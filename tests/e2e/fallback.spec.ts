// The no-WebGPU page: /?fallback must render the heading, the one honest line and the source link, and no canvas,
// in Chrome and in the Firefox and WebKit engines.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { firefox, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';
import { expect, test } from '../helpers';

const BASE = process.env.TIDAL_URL ?? 'http://localhost:5174';
const OUT = path.resolve('test-results');
const FIREFOX = path.resolve('.vendor/pw-browsers/firefox-1572/firefox/Nightly.app/Contents/MacOS/firefox');

async function assertFallback(page: Page, engine: string): Promise<void> {
  await page.goto(`${BASE}/?fallback`);
  await page.waitForSelector('html[data-gpu="no"] .tfb', { timeout: 15_000 });
  await page.waitForTimeout(800);
  const h1 = page.locator('h1');
  await expect(h1).toHaveCount(1);
  const heading = ((await h1.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  console.log(`${engine}: h1 "${heading}"`);
  expect(heading).toBe('Water that lives across your browser windows.');
  const body = (await page.locator('main').textContent()) ?? '';
  expect(body.replace(/\s+/g, ' ')).toContain('Tidal needs WebGPU to simulate the water.');
  const link = page.locator('a', { hasText: 'Source on GitHub' });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', 'https://github.com/Venkat-jaswanth/tidal');
  await expect(page.locator('canvas#tank')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.gpu)).toBe('no');
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `fallback-${engine}.png`) });
}

async function inEngine(type: BrowserType, engine: string, executablePath?: string): Promise<string[]> {
  const errors: string[] = [];
  const browser: Browser = await type.launch({ headless: true, channel: undefined, ...(executablePath ? { executablePath } : {}) });
  try {
    console.log(`${engine} ${browser.version()}`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url + m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await assertFallback(page, engine);
  } finally {
    await browser.close();
  }
  return errors;
}

test.describe('fallback page', () => {
  test('chrome: /?fallback', async ({ lab }) => {
    const context = await lab.context({ viewport: { width: 1100, height: 800 } });
    const page = await context.newPage();
    lab.watch(page, 'fallback');
    await assertFallback(page, 'chrome');
  });

  test('firefox engine: /?fallback', async () => {
    expect(existsSync(FIREFOX), `Firefox binary at ${FIREFOX}`).toBe(true);
    const errors = await inEngine(firefox, 'firefox', FIREFOX);
    expect(errors, 'console errors').toEqual([]);
  });

  test('webkit engine: /?fallback', async () => {
    const errors = await inEngine(webkit, 'webkit');
    expect(errors, 'console errors').toEqual([]);
  });
});

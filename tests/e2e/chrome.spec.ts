// The window chrome: tab title and favicon, keyboard shortcuts, live region and canvas semantics.

import type { Page } from '@playwright/test';
import { expect, layoutRow, openPopup, recordMeta, sleep, test, type Lab, type World } from '../helpers';

/** The liquid name shown in the liquid button (the button also carries a quiet "Liquid" lead). */
const liquidButton = (p: Page) => p.locator('#liquid .tc-value');

/** Put a popup against main's right edge (water flows in). */
async function touchingPopup(lab: Lab, gap = 0): Promise<World> {
  const w = await lab.world({ popups: 1 });
  await layoutRow(w, { gapMain: gap, mainSize: { w: 620, h: 520 } });
  return w;
}

test.describe('chrome', () => {
  test('tab title shows the volume and follows it', async ({ lab }) => {
    test.setTimeout(60_000);
    const w = await lab.mainOnly();
    const main = w.main;
    await main.waitForFunction(() => /^Tidal — \d+ mL$/.test(document.title), null, { timeout: 10_000 });
    // the title may read 0 mL for a moment before the first world frame arrives
    await main.waitForFunction(() => document.title === 'Tidal — 1000 mL', null, { timeout: 10_000 });
    const first = await main.title();
    console.log('title alone:', first);
    expect(first).toMatch(/^Tidal — \d+ mL$/);
    expect(first).toBe('Tidal — 1000 mL');
    // open a popup and place it against main
    const popup = await openPopup(main, w.context, { w: 340, h: 263 });
    w.popups.push(popup); w.all.push(popup);
    await layoutRow(w, { gapMain: 0, mainSize: { w: 620, h: 520 } });
    await main.waitForFunction((t) => document.title !== t, first, { timeout: 15_000 });
    await sleep(4000);
    const later = await main.title();
    const popTitle = await popup.title();
    console.log(`title after a touching popup opens: main "${later}", popup "${popTitle}"`);
    expect(later).toMatch(/^Tidal — \d+ mL$/);
    expect(later).not.toBe(first);
    expect(popTitle).toMatch(/^Tidal — \d+ mL$/);
    expect(Number(/\d+/.exec(popTitle)![0])).toBeGreaterThan(0);
  });

  test('favicon is a generated PNG and changes with the level', async ({ lab }) => {
    test.setTimeout(60_000);
    const w = await lab.mainOnly();
    const main = w.main;
    const href = () => main.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? '');
    await main.waitForFunction(() => (document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? '').startsWith('data:image/png'), null, { timeout: 10_000 });
    const first = await href();
    console.log('favicon at 1000 mL:', first.slice(0, 40) + '…', first.length, 'chars');
    expect(first).toMatch(/^data:image\/png;base64,/);
    const popup = await openPopup(main, w.context, { w: 340, h: 263 });
    w.popups.push(popup); w.all.push(popup);
    await layoutRow(w, { gapMain: 0, mainSize: { w: 620, h: 520 } });
    await main.waitForFunction((h) => (document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? '') !== h, first, { timeout: 15_000 });
    const second = await href();
    expect(second).toMatch(/^data:image\/png;base64,/);
    expect(second).not.toBe(first);
  });

  test('keyboard: v opens a vessel', async ({ lab }) => {
    test.setTimeout(60_000);
    const w = await lab.mainOnly();
    await w.main.waitForFunction(() => window.tidalApp != null);
    const n0 = await w.main.evaluate(() => window.tidal!.registry.all().length);
    const [popup] = await Promise.all([w.context.waitForEvent('page', { timeout: 10_000 }), w.main.keyboard.press('v')]);
    await popup.waitForFunction(() => (window.tidal?.stats.fps ?? 0) > 0, null, { timeout: 20_000 });
    await w.main.waitForFunction((n) => window.tidal!.registry.all().length > n, n0, { timeout: 10_000 });
    const info = await popup.evaluate(() => ({ kind: window.tidal!.registry.self.kind, slot: window.tidal!.slot }));
    console.log('v opened:', JSON.stringify(info));
    expect(info.kind).toBe('popup');
  });

  test('keyboard: l cycles the liquid in both windows', async ({ lab }) => {
    test.setTimeout(90_000);
    const w = await touchingPopup(lab);
    await w.main.waitForFunction(() => window.tidalApp != null);
    const order = ['Water', 'Mercury', 'Honey', 'Ink', 'Water'];
    expect(((await liquidButton(w.main).textContent()) ?? '').trim()).toBe('Water');
    for (const next of order.slice(1)) {
      await w.main.keyboard.press('l');
      await expect(liquidButton(w.main)).toHaveText(next, { timeout: 5000 });
      const id = next.toLowerCase();
      await w.main.waitForFunction((x) => window.tidal!.liquid.id === x, id, { timeout: 5000 });
      await w.popups[0]!.waitForFunction((x) => window.tidal!.liquid.id === x, id, { timeout: 5000 });
      await expect(liquidButton(w.popups[0]!)).toHaveText(next, { timeout: 5000 });
      console.log(`liquid -> ${next}: main ${await w.main.evaluate(() => window.tidal!.liquid.id)}, popup ${await w.popups[0]!.evaluate(() => window.tidal!.liquid.id)}`);
    }
    // and pressed in the popup, main follows
    await w.popups[0]!.keyboard.press('l');
    await w.main.waitForFunction(() => window.tidal!.liquid.id === 'mercury', null, { timeout: 5000 });
  });

  test('keyboard: arrow keys slosh the water', async ({ lab }) => {
    test.setTimeout(60_000);
    const w = await lab.mainOnly();
    await sleep(3000);
    const quiet = await recordMeta(w.main, 600);
    const rec = recordMeta(w.main, 3000);
    for (let i = 0; i < 8; i++) { await w.main.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight'); await sleep(150); }
    await w.main.keyboard.press('ArrowUp');
    const samples = await rec;
    const slot = await w.main.evaluate(() => window.tidal!.slot);
    const eq = Math.max(...quiet.map((s) => s.energy[slot]!)), ea = Math.max(...samples.map((s) => s.energy[slot]!));
    console.log(`energy at rest max ${eq.toExponential(2)}, after arrow keys max ${ea.toExponential(2)}`);
    expect(ea).toBeGreaterThan(Math.max(eq * 5, 1e-4));
  });

  test('live region speaks, canvas has a role and a label', async ({ lab }) => {
    test.setTimeout(90_000);
    const w = await lab.mainOnly();
    const main = w.main;
    const canvas = main.locator('canvas#tank');
    await expect(canvas).toHaveAttribute('role', 'img');
    await expect.poll(async () => (await canvas.getAttribute('aria-label')) ?? '', { timeout: 10_000 }).not.toBe('');
    const label = await canvas.getAttribute('aria-label');
    console.log('canvas aria-label:', label);
    expect(label).toMatch(/Vessel \d+/);
    await expect(main.locator('#liquid')).toHaveAttribute('aria-label', /Change liquid/);
    const status = main.locator('[role="status"]');
    await expect(status).toHaveCount(1);
    await main.evaluate(() => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      const el = document.querySelector('[role="status"]')!;
      const t0 = performance.now();
      new MutationObserver(() => { w.__said.push(`${((performance.now() - t0) / 1000).toFixed(1)} s ${window.tidal!.ml.toFixed(0)} mL: ${el.textContent}`); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    // a change in the world (a popup arriving) gives it something to say
    const popup = await openPopup(main, w.context, { w: 340, h: 263 });
    w.popups.push(popup); w.all.push(popup);
    await layoutRow(w, { gapMain: 0, mainSize: { w: 620, h: 520 } });
    await expect.poll(async () => (await status.textContent())?.trim() ?? '', { timeout: 30_000, intervals: [500] }).not.toBe('');
    console.log('live region:', (await status.textContent())?.trim());
    await sleep(8000);
    console.log('everything the live region said:\n  ' + (await main.evaluate(() => (window as unknown as { __said: string[] }).__said)).join('\n  '));
  });
});

// The floating (picture-in-picture) tank is a vessel like any other: water flows into it, it can be shaken, and closing it returns its water.

import type { CDPSession, Page } from '@playwright/test';
import { calibrate, expect, fmt, recordMeta, sleep, stopTotals, test, trackTotals } from '../helpers';

interface PipInfo { x: number; y: number; w: number; h: number; slot: number; kind: string; ml: number }

const pipInfo = (main: Page): Promise<PipInfo | null> =>
  main.evaluate(() => {
    const f = window.tidalApp?.float();
    if (!f) return null;
    const i = f.view.info;
    return { x: i.x, y: i.y, w: i.w, h: i.h, slot: i.slot, kind: i.kind, ml: f.view.ml };
  });

test('pip: floating tank joins the world, takes water, sloshes, and returns its water on close', async ({ lab }) => {
  test.setTimeout(120_000);
  const w = await lab.mainOnly();
  const main = w.main;
  await main.waitForFunction(() => window.tidalApp != null);
  await calibrate(main);
  await sleep(2000);
  let supported = await main.evaluate(() => 'documentPictureInPicture' in window);
  if (!supported) {
    // diagnostics for an intermittent absence of the API (seen only late in a long run)
    const diag = await main.evaluate(() => ({ secure: isSecureContext, origin: location.origin, toolbar: window.toolbar?.visible, opener: window.opener != null, outer: [outerWidth, outerHeight, innerWidth, innerHeight], displayMode: ['browser', 'standalone', 'minimal-ui', 'fullscreen', 'picture-in-picture'].filter((m) => matchMedia(`(display-mode: ${m})`).matches), visibility: document.visibilityState, hasFocus: document.hasFocus(), ua: navigator.userAgent }));
    console.log('documentPictureInPicture MISSING:', JSON.stringify(diag));
    await sleep(5000);
    supported = await main.evaluate(() => 'documentPictureInPicture' in window);
    console.log('after 5 s:', supported);
  }
  expect(supported, 'documentPictureInPicture exists in this Chrome').toBe(true);

  await trackTotals(main);
  const [pip] = await Promise.all([
    w.context.waitForEvent('page', { timeout: 15_000 }),
    main.locator('#float').click(),
  ]);
  await main.waitForFunction(() => window.tidalApp?.float() != null, null, { timeout: 10_000 });
  await sleep(1000);

  // ---- appears in the registry as kind 'pip'
  const kinds = await main.evaluate(() => window.tidal!.registry.all().map((v) => ({ kind: v.kind, slot: v.slot, w: v.w, h: v.h })));
  console.log('vessels after Float:', JSON.stringify(kinds));
  expect(kinds.some((v) => v.kind === 'pip'), "a vessel of kind 'pip' is in registry.all()").toBe(true);
  const apart = await pipInfo(main);
  console.log('pip apart:', JSON.stringify(apart), 'main ml', fmt(await main.evaluate(() => window.tidal!.ml)));

  // ---- drag it (CDP window bounds) until its left edge touches main's right edge, floors level
  const cdp: CDPSession = await w.context.newCDPSession(pip);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const setLeftTop = async (left: number, top: number): Promise<void> => { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: Math.round(left), top: Math.round(top) } }); };
  const bounds = async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;
  let b;
  for (let i = 0; i < 4; i++) {
    const m = await main.evaluate(() => window.tidal!.calibrator.rect());
    const p = (await pipInfo(main))!;
    const dx = m.x + m.w - p.x, dy = m.y + m.h - p.h - p.y;
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) break;
    b = await bounds();
    // glide there in steps, as a drag would
    const steps = 20;
    for (let s = 1; s <= steps; s++) { await setLeftTop((b.left ?? 0) + (dx * s) / steps, (b.top ?? 0) + (dy * s) / steps); await sleep(16); }
    await sleep(400);
  }
  const m = await main.evaluate(() => window.tidal!.calibrator.rect());
  const touching = (await pipInfo(main))!;
  console.log(`main rect ${JSON.stringify(m)}, pip rect ${JSON.stringify(touching)}, gap ${fmt(touching.x - (m.x + m.w), 1)} px`);
  await sleep(5000);
  const gained = (await pipInfo(main))!;
  console.log(`pip volume after 5 s touching: ${fmt(gained.ml, 1)} mL (main ${fmt(await main.evaluate(() => window.tidal!.ml), 1)} mL)`);
  expect(gained.ml, 'pip gained water from the main vessel').toBeGreaterThan(30);

  // ---- shake it
  const slot = gained.slot;
  const quiet = await recordMeta(main, 800);
  const rec = recordMeta(main, 3400);
  b = await bounds();
  const left0 = b.left ?? 0, top0 = b.top ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 2800) {
    await setLeftTop(left0 + 70 * Math.sin((2 * Math.PI * 2.5 * (Date.now() - t0)) / 1000), top0);
    await sleep(8);
  }
  await setLeftTop(left0, top0);
  const shaken = await rec;
  const eQuiet = Math.max(...quiet.map((s) => s.energy[slot] ?? 0));
  const eShake = Math.max(...shaken.map((s) => s.energy[slot] ?? 0));
  console.log(`pip energy: at rest max ${eQuiet.toExponential(2)}, shaken max ${eShake.toExponential(2)} (${fmt(eShake / Math.max(eQuiet, 1e-9), 0)}x)`);
  expect(eShake, 'energy rises when shaken').toBeGreaterThan(Math.max(eQuiet * 3, 1e-4));
  await sleep(1500);

  // ---- close it: water returns, vessel disappears
  const before = (await pipInfo(main))!;
  const closing = recordMeta(main, 4000);
  await main.evaluate(() => { window.tidalApp!.float()!.close(); });
  const after = await closing;
  const last = after[after.length - 1]!;
  const kindsAfter = await main.evaluate(() => window.tidal!.registry.all().map((v) => v.kind));
  const maxRain = Math.max(...after.map((s) => s.rainMl));
  console.log(`closed: pip held ${fmt(before.ml, 1)} mL; afterwards slot ${fmt(last.ml[slot] ?? -1, 2)} mL, main ${fmt(last.ml[0]!, 1)} mL, rain ${fmt(last.rainMl, 2)} (max ${fmt(maxRain, 1)}); vessels ${kindsAfter.join(',')}`);
  expect(kindsAfter, 'pip vessel is gone').not.toContain('pip');
  expect(await main.evaluate(() => window.tidalApp!.float()), 'float() is null').toBeNull();
  expect(last.ml[slot] ?? 0, 'pip slot empty').toBeLessThan(0.5);
  expect(last.ml[0]!, 'main holds everything again').toBeGreaterThan(995);
  expect(last.rainMl).toBeLessThan(1);
  await pip.close().catch(() => undefined);

  const tot = await stopTotals(main);
  console.log(`total over the whole test: min ${fmt(tot.min, 3)}, max ${fmt(tot.max, 3)}, worst deviation ${fmt(tot.worst * 100, 4)} % (${tot.frames} frames)`);
  expect(tot.worst, 'total conserved throughout').toBeLessThanOrEqual(0.005);
});

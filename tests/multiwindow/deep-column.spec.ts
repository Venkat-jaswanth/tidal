// A tall, narrow vessel holds the whole world as a column about 650 px deep. An earlier equation of
// state went unstable at that depth and the liquid boiled into holes; this guards against it.

import { expect, sleep, test } from '../helpers';

test('a deep, narrow column stays solid', async ({ lab }) => {
  const context = await lab.context({ viewport: { width: 340, height: 720 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => (window.tidal?.stats.particles ?? 0) > 0, null, { timeout: 20_000 });
  await sleep(4000);
  // a shove, so the test covers the column in motion as well as at rest
  await page.evaluate(() => window.tidal?.command({ type: 'cmd', cmd: 'impulse', x: 1, y: 0 }));
  await sleep(4000);

  const result = await page.evaluate(() => {
    const engine = window.tidal!;
    const snap = engine.transport.latestSnapshot();
    if (!snap) return null;
    const view = new DataView(snap.data.buffer, snap.data.byteOffset, snap.data.byteLength);
    const rect = engine.calibrator.rect();
    const cols = Math.floor(rect.w / 6), rows = Math.floor(rect.h / 6);
    const filled = new Uint8Array(cols * rows);
    for (let i = 0; i < snap.count; i++) {
      const x = snap.originX + (view.getUint16(i * 12, true) / 64) * 6 - rect.x;
      const y = snap.originY + (view.getUint16(i * 12 + 2, true) / 64) * 6 - rect.y;
      const cx = Math.floor(x / 6), cy = Math.floor(y / 6);
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) filled[cy * cols + cx] = 1;
    }
    // the liquid's own height: the topmost row that is at least half full
    let top = rows;
    for (let r = 0; r < rows; r++) {
      let n = 0;
      for (let c = 0; c < cols; c++) n += filled[r * cols + c]!;
      if (n >= cols / 2) { top = r; break; }
    }
    // inside the body (well below the surface, clear of the walls) every cell should hold liquid
    let cells = 0, empty = 0;
    for (let r = top + 8; r < rows - 2; r++) {
      for (let c = 2; c < cols - 2; c++) { cells++; if (!filled[r * cols + c]) empty++; }
    }
    return { depthPx: (rows - top) * 6, cells, empty, emptyShare: empty / Math.max(1, cells), blowUps: engine.stats.blowUps, total: engine.meta!.ml.reduce((a, b) => a + b, 0) + engine.meta!.rainMl };
  });
  console.log('deep column', JSON.stringify(result));
  expect(result).not.toBeNull();
  expect(result!.depthPx).toBeGreaterThan(500);
  expect(result!.emptyShare).toBeLessThan(0.01);
  expect(result!.blowUps).toBe(0);
  expect(Math.abs(result!.total - 1000)).toBeLessThan(5);
});

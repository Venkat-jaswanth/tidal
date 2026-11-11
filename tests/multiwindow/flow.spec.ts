// Water moves between vessels that touch or sit within the 24 px coupling gap, and not across a wider gap.

import { displayOf, expect, fmt, mlOf, readTotals, setRect, test, calibrate, type Rect, type World } from '../helpers';

const POP = { w: 340, h: 263 };
const MAIN = { w: 620, h: 520 };

interface Row { main: Rect; a: Rect; b: Rect }

/** Main on the left; popups A and B in a row to its right, bottoms level with main's floor. */
async function place(w: World, o: { gapMainA: number; gapAB: number; bDrop?: number; shift?: number }): Promise<Row> {
  const [pa, pb] = w.popups as [World['main'], World['main']];
  const d = await displayOf(w.main);
  const top = d.top + 120;
  const main = await setRect(w.main, { x: d.left + 20, y: top, ...MAIN }, true);
  const ax = main.x + main.w + o.gapMainA + (o.shift ?? 0);
  const ay = main.y + main.h - POP.h;
  const a = await setRect(pa, { x: ax, y: ay, ...POP });
  const b = await setRect(pb, { x: a.x + a.w + o.gapAB, y: ay + (o.bDrop ?? 0), ...POP });
  for (const p of w.all) await calibrate(p);
  return { main, a, b };
}

async function sampleVolumes(w: World, seconds: number, everyMs = 500): Promise<{ t: number; a: number; b: number; main: number; total: number }[]> {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const [a, b, main, t] = await Promise.all([mlOf(w.popups[0]!), mlOf(w.popups[1]!), mlOf(w.main), readTotals(w.main)]);
    out.push({ t: (Date.now() - t0) / 1000, a, b, main, total: t.total });
    await w.main.waitForTimeout(everyMs);
  }
  return out;
}

test.describe('flow between vessels', () => {
  test('touching vessels share water; a 60 px gap stops it; a 12 px gap lets it flow', async ({ lab }) => {
    test.setTimeout(180_000);
    const w = await lab.world({ popups: 2, popupSize: POP });

    // ---- (a) main - A - B all touching: water spreads into both popups
    const row = await place(w, { gapMainA: 0, gapAB: 0 });
    console.log('layout touching', JSON.stringify(row));
    const a = await sampleVolumes(w, 9);
    console.log('(a) touching samples (s, A, B, main, total):\n' + a.map((s) => `  ${fmt(s.t, 1)}  ${fmt(s.a, 1)}  ${fmt(s.b, 1)}  ${fmt(s.main, 1)}  ${fmt(s.total, 1)}`).join('\n'));
    const last = a[a.length - 1]!;
    expect(last.a, 'popup A holds water').toBeGreaterThan(50);
    expect(last.b, 'popup B holds water').toBeGreaterThan(50);
    const aVals = a.map((s) => s.a), bVals = a.map((s) => s.b);
    expect(Math.max(...aVals) - Math.min(...aVals), 'A volume changed while water arrived').toBeGreaterThan(5);
    expect(Math.max(...bVals) - Math.min(...bVals), 'B volume changed while water arrived').toBeGreaterThan(5);
    const range = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
    const head = range(a.filter((s) => s.t <= 3).map((s) => s.a)), tail = range(a.filter((s) => s.t > 6).map((s) => s.a));
    console.log(`(a) range of A's volume: first 3 s ${fmt(head)} mL, last 3 s ${fmt(tail)} mL`);
    expect(tail, 'sloshing between the vessels dies down: the last 3 s move less than the first 3 s').toBeLessThan(head);

    // ---- (b) move the popups away from main, keeping A-B touching, then open a 60 px gap between A and B
    await place(w, { gapMainA: 100, gapAB: 0, bDrop: 80 });
    await w.main.waitForTimeout(2500);
    const row60 = await place(w, { gapMainA: 100, gapAB: 60, bDrop: 80 });
    const gap = row60.b.x - (row60.a.x + row60.a.w);
    console.log('(b) gap between A and B content rects:', gap, 'px');
    expect(gap).toBeGreaterThanOrEqual(55);
    const v0 = { a: await mlOf(w.popups[0]!), b: await mlOf(w.popups[1]!) };
    const frame0 = (await readTotals(w.popups[0]!)).frame;
    const b = await sampleVolumes(w, 5);
    const v1 = { a: b[b.length - 1]!.a, b: b[b.length - 1]!.b };
    const dA = v1.a - v0.a, dB = v1.b - v0.b;
    const maxDevA = Math.max(...b.map((s) => Math.abs(s.a - v0.a))), maxDevB = Math.max(...b.map((s) => Math.abs(s.b - v0.b)));
    console.log(`(b) 60 px gap: A ${fmt(v0.a)} -> ${fmt(v1.a)} (d ${fmt(dA)}, max dev ${fmt(maxDevA)}), B ${fmt(v0.b)} -> ${fmt(v1.b)} (d ${fmt(dB)}, max dev ${fmt(maxDevB)})`);
    expect((await readTotals(w.popups[0]!)).frame, 'world frames kept advancing (the flat volumes are not a stall)').toBeGreaterThan(frame0 + 60);
    expect(Math.abs(dA), 'A change across a 60 px gap').toBeLessThan(3);
    expect(Math.abs(dB), 'B change across a 60 px gap').toBeLessThan(3);

    // ---- (c) lift B level with A while still 60 px apart (B now holds more at the same floor height),
    // then close the gap to 12 px: water runs from B into A through the coupling gap
    await place(w, { gapMainA: 100, gapAB: 60, bDrop: 0 });
    await w.main.waitForTimeout(2500);
    const c0 = { a: await mlOf(w.popups[0]!), b: await mlOf(w.popups[1]!) };
    const row12 = await place(w, { gapMainA: 100, gapAB: 12, bDrop: 0 });
    console.log('(c) gap', row12.b.x - (row12.a.x + row12.a.w), 'px');
    const c = await sampleVolumes(w, 5);
    const cl = c[c.length - 1]!;
    console.log(`(c) 12 px gap: A ${fmt(c0.a)} -> ${fmt(cl.a)}, B ${fmt(c0.b)} -> ${fmt(cl.b)}`);
    const moved = Math.max(Math.abs(cl.a - c0.a), Math.abs(cl.b - c0.b));
    expect(moved, 'water crossed the 12 px gap').toBeGreaterThan(5);
    expect(Math.sign(cl.a - c0.a), 'A and B moved in opposite directions').toBe(-Math.sign(cl.b - c0.b));
    expect(Math.abs(cl.total - 1000) / 1000).toBeLessThanOrEqual(0.005);
  });
});

// Leadership: closing the leader window must not stall the others; a leader that hangs is replaced by the watchdog.

import type { Page } from '@playwright/test';
import { calibrate, deviation, expect, fmt, layoutRow, readTotals, sleep, test, waitForSettledTotal, type Lab } from '../helpers';

interface Arrivals { times: number[]; frames: number[] }

/** In the page: note performance.now() whenever meta.frame changes, polled every animation frame. */
async function startArrivals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __arr: { times: number[]; frames: number[]; on: boolean } };
    const arr = (w.__arr = { times: [] as number[], frames: [] as number[], on: true });
    let last = window.tidal?.meta?.frame ?? -1;
    const tick = (now: number): void => {
      const f = window.tidal?.meta?.frame ?? -1;
      if (f !== last) { arr.times.push(now); arr.frames.push(f); last = f; }
      if (arr.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopArrivals(page: Page): Promise<Arrivals> {
  return page.evaluate(() => {
    const a = (window as unknown as { __arr: { times: number[]; frames: number[]; on: boolean } }).__arr;
    a.on = false;
    return { times: a.times.slice(), frames: a.frames.slice() };
  });
}

/** Longest gap between consecutive arrivals that fall within [from, to] (page clock, ms). */
function longestGap(a: Arrivals, from: number, to: number): { gap: number; at: number; n: number } {
  let gap = 0, at = 0, n = 0;
  for (let i = 1; i < a.times.length; i++) {
    const t = a.times[i]!, p = a.times[i - 1]!;
    if (t < from || t > to) continue;
    n++;
    if (t - p > gap) { gap = t - p; at = t; }
  }
  return { gap, at, n };
}

async function threeWindows(lab: Lab) {
  const w = await lab.world({ popups: 2 });
  await layoutRow(w, { gapMain: 0, gapPopups: 0, alignBottom: process.env.HANDOFF_TOP_ALIGN !== '1' });
  for (const p of w.all) await calibrate(p);
  await sleep(4000);
  return w;
}

test.describe('leadership', () => {
  test('closing the leader window: world frames keep coming (5 repetitions)', async ({ lab }) => {
    test.setTimeout(300_000);
    const rows: string[] = [];
    for (let rep = 1; rep <= 5; rep++) {
      const w = await threeWindows(lab);
      expect(await w.main.evaluate(() => window.tidal!.isLeader), 'main starts as leader').toBe(true);
      await Promise.all(w.popups.map(startArrivals));
      await sleep(1000);
      // the close happens at a known time on each popup's own clock
      const marks = await Promise.all(w.popups.map((p) => p.evaluate(() => performance.now())));
      const closeAt = Date.now();
      await w.main.close();
      await sleep(3500);
      const arrivals = await Promise.all(w.popups.map(stopArrivals));
      const hitches = arrivals.map((a, i) => longestGap(a, marks[i]! - 500, marks[i]! + 3500));
      const leaders = await Promise.all(w.popups.map((p) => p.evaluate(() => window.tidal!.isLeader)));
      const t = await readTotals(w.popups[0]!);
      const slots = await Promise.all(w.popups.map((p) => p.evaluate(() => window.tidal!.slot)));
      const line = `rep ${rep}: hitch popup0 ${fmt(hitches[0]!.gap, 0)} ms (at +${fmt(hitches[0]!.at - marks[0]!, 0)} ms, ${hitches[0]!.n} frames), popup1 ${fmt(hitches[1]!.gap, 0)} ms (at +${fmt(hitches[1]!.at - marks[1]!, 0)} ms, ${hitches[1]!.n} frames); leaders ${leaders.join('/')}; slots ${slots.join('/')}; total after ${fmt(t.total, 2)} mL; rain ${fmt(t.rainMl, 2)} (close at ${closeAt % 100000})`;
      console.log(line);
      rows.push(line);
      expect(leaders.filter(Boolean).length, `rep ${rep}: exactly one popup leads`).toBe(1);
      for (const [i, h] of hitches.entries()) {
        expect(h.n, `rep ${rep} popup${i} saw frames`).toBeGreaterThan(30);
        expect(h.gap, `rep ${rep} popup${i}: longest gap between world frames`).toBeLessThanOrEqual(150);
      }
      expect(deviation(t.total), `rep ${rep}: total after 3 s`).toBeLessThanOrEqual(0.005);
      await w.context.close();
    }
  });

  test('watchdog: a leader that stops simulating is replaced within 2 s', async ({ lab }) => {
    test.setTimeout(120_000);
    const w = await threeWindows(lab);
    const leaderId = await w.main.evaluate(() => window.tidal!.id);
    expect(await w.main.evaluate(() => window.tidal!.isLeader)).toBe(true);
    const before = await readTotals(w.popups[0]!);

    await w.main.evaluate(() => { window.tidal!.stalled = true; });
    const t0 = Date.now();
    let takeover = -1;
    let newLeader: Page | null = null;
    while (Date.now() - t0 < 6000) {
      for (const p of w.popups) {
        if (await p.evaluate(() => window.tidal!.isLeader)) { takeover = Date.now() - t0; newLeader = p; break; }
      }
      if (newLeader) break;
      await sleep(20);
    }
    console.log(`watchdog: takeover after ${takeover} ms (stall set on main, ${before.frame} frames so far)`);
    expect(newLeader, 'another window became leader').not.toBeNull();
    expect(takeover, 'takeover time').toBeLessThanOrEqual(2000);

    // frames advance again, published by the new leader
    const observer = w.popups.find((p) => p !== newLeader)!;
    const f0 = (await readTotals(observer)).frame;
    await sleep(1000);
    const after = await readTotals(observer);
    console.log(`after takeover: observer frame ${f0} -> ${after.frame}; meta.leader is new leader: ${after.leader !== leaderId}`);
    expect(after.frame, 'frames advancing after takeover').toBeGreaterThan(f0 + 20);
    expect(after.leader, 'meta comes from the new leader').not.toBe(leaderId);
    await waitForSettledTotal(observer, 8000);
    expect(deviation((await readTotals(observer)).total)).toBeLessThanOrEqual(0.005);
  });
});

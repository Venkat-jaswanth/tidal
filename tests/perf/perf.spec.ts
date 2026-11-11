// Measurement, not budgets: frame pacing and GPU time with three windows (main + two touching popups) while one popup
// is moved gently, at the default tier and at ?tier=5. Prints a table and writes test-results/perf.json.
// Only a sanity floor is asserted, because anything else running on the machine disturbs the numbers.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { calibrate, expect, fmt, layoutRow, median, percentile, refreshRate, sleep, startRafProbe, stopRafProbe, test, type Lab } from '../helpers';

const MOVE_SECONDS = 20;

interface WindowResult {
  window: string;
  leader: boolean;
  refreshHz: number;
  frames: number;
  fpsP50: number;
  fpsP95: number;
  worstFrameMs: number;
  renderGpuMsP50: number | null;
  renderGpuMsP95: number | null;
  simGpuMsP50: number | null;
  simGpuMsP95: number | null;
  substepsP50: number | null;
  particles: number;
  tier: number;
}

interface Run { label: string; query: string; windows: WindowResult[] }

const clean = (a: (number | null)[]): number[] => a.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const orNull = (n: number): number | null => (Number.isFinite(n) ? n : null);

async function measure(lab: Lab, label: string, query: string): Promise<Run> {
  const w = await lab.world({ popups: 2, query });
  await layoutRow(w, { gapMain: 0, gapPopups: 0, mainSize: { w: 620, h: 520 } });
  for (const p of w.all) await calibrate(p);
  // popups are opened without the query string, so give them the same forced tier as main
  const tier = /[?&]tier=(\d)/.exec(query)?.[1];
  if (tier) for (const p of w.popups) await p.evaluate((t) => window.tidal!.setTier(Number(t), true), tier);
  await sleep(5000);

  await Promise.all(w.all.map(startRafProbe));
  const mover = w.popups[0]!;
  const stats: Record<string, { render: (number | null)[]; sim: (number | null)[]; sub: number[] }> = {};
  w.all.forEach((_, i) => { stats[String(i)] = { render: [], sim: [], sub: [] }; });
  // gentle motion: 30 px at 0.5 Hz, driven from inside the popup
  const moving = mover.evaluate((secs) => new Promise<void>((resolve) => {
    const cx = window.screenX, cy = window.screenY, t0 = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      window.moveTo(Math.round(cx + 30 * Math.sin(2 * Math.PI * 0.5 * t)), cy);
      if (t >= secs) { clearInterval(id); window.moveTo(cx, cy); resolve(); }
    }, 16);
  }), MOVE_SECONDS);
  const t0 = Date.now();
  while (Date.now() - t0 < MOVE_SECONDS * 1000) {
    await Promise.all(w.all.map(async (p, i) => {
      const s = await p.evaluate(() => ({ r: window.tidal!.stats.renderGpuMs, s: window.tidal!.stats.simGpuMs, sub: window.tidal!.stats.substeps, leader: window.tidal!.stats.leader }));
      const bucket = stats[String(i)]!;
      bucket.render.push(s.r);
      if (s.leader) { bucket.sim.push(s.s); bucket.sub.push(s.sub); }
    }));
    await sleep(250);
  }
  await moving;
  const gaps = await Promise.all(w.all.map(stopRafProbe));
  const windows: WindowResult[] = [];
  for (const [i, p] of w.all.entries()) windows.push(await summarize(p, i === 0 ? 'main' : `popup${i - 1}`, gaps[i]!, stats[String(i)]!));
  return { label, query, windows };
}

async function summarize(p: Page, name: string, gaps: number[], s: { render: (number | null)[]; sim: (number | null)[]; sub: number[] }): Promise<WindowResult> {
  const info = await p.evaluate(() => ({ leader: window.tidal!.stats.leader, particles: window.tidal!.stats.particles, tier: window.tidal!.stats.tier }));
  const render = clean(s.render), sim = clean(s.sim);
  return {
    window: name, leader: info.leader, refreshHz: refreshRate(gaps), frames: gaps.length,
    fpsP50: 1000 / median(gaps), fpsP95: 1000 / percentile(gaps, 0.95), worstFrameMs: Math.max(...gaps),
    renderGpuMsP50: orNull(median(render)), renderGpuMsP95: orNull(percentile(render, 0.95)),
    simGpuMsP50: orNull(median(sim)), simGpuMsP95: orNull(percentile(sim, 0.95)),
    substepsP50: orNull(median(s.sub)), particles: info.particles, tier: info.tier,
  };
}

function table(run: Run): string {
  const head = 'window   leader  refresh  frames  fps p50  fps p95  worst ms  render GPU p50/p95 ms  sim GPU p50/p95 ms  substeps  particles  tier';
  const rows = run.windows.map((r) => [
    r.window.padEnd(8), String(r.leader).padEnd(7), `${r.refreshHz} Hz`.padEnd(8), String(r.frames).padEnd(7), fmt(r.fpsP50, 1).padEnd(8), fmt(r.fpsP95, 1).padEnd(8), fmt(r.worstFrameMs, 0).padEnd(9),
    `${r.renderGpuMsP50 === null ? '-' : fmt(r.renderGpuMsP50, 2)} / ${r.renderGpuMsP95 === null ? '-' : fmt(r.renderGpuMsP95, 2)}`.padEnd(22),
    `${r.simGpuMsP50 === null ? '-' : fmt(r.simGpuMsP50, 2)} / ${r.simGpuMsP95 === null ? '-' : fmt(r.simGpuMsP95, 2)}`.padEnd(19),
    String(r.substepsP50 ?? '-').padEnd(9), String(r.particles).padEnd(10), String(r.tier),
  ].join(' '));
  return `${run.label} (${run.query || 'default'}), ${MOVE_SECONDS} s of gentle movement of one popup\n${head}\n${rows.join('\n')}`;
}

test('perf: frame pacing and GPU time, default tier and tier 5', async ({ lab }) => {
  test.setTimeout(240_000);
  const runs: Run[] = [];
  runs.push(await measure(lab, 'default tier', ''));
  console.log(table(runs[0]!));
  runs.push(await measure(lab, 'tier 5', '?tier=5'));
  console.log(table(runs[1]!));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(path.join('test-results', 'perf.json'), JSON.stringify({ when: new Date().toISOString(), moveSeconds: MOVE_SECONDS, runs }, null, 2));
  for (const run of runs) for (const r of run.windows) expect(r.fpsP50, `${run.label} ${r.window} fps p50`).toBeGreaterThan(20);
});

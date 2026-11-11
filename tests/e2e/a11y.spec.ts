// Accessibility: axe on the app and on the fallback page in both colour schemes, and reduced motion.

import AxeBuilder from '@axe-core/playwright';
import { expect, sleep, test } from '../helpers';

type Scheme = 'light' | 'dark';

for (const scheme of ['light', 'dark'] as Scheme[]) {
  for (const target of ['app', 'fallback'] as const) {
    test(`axe: ${target} page, ${scheme} scheme: no critical or serious violations`, async ({ lab }) => {
      test.setTimeout(60_000);
      const context = await lab.context({ colorScheme: scheme });
      const page = await context.newPage();
      lab.watch(page, target);
      if (target === 'app') {
        await page.goto('/');
        await page.waitForFunction(() => (window.tidal?.stats.particles ?? 0) > 0 && window.tidal?.meta != null, null, { timeout: 30_000 });
        await page.locator('#liquid').waitFor();
        await sleep(1500);
      } else {
        await page.goto('/?fallback');
        await page.waitForSelector('html[data-gpu="no"] .tfb');
        await sleep(500);
      }
      const results = await new AxeBuilder({ page }).analyze();
      const rows = results.violations.map((v) => `${v.impact ?? 'n/a'} ${v.id} (${v.nodes.length} nodes): ${v.help}`);
      console.log(`axe ${target}/${scheme}: ${results.violations.length} violations, ${results.passes.length} rules passed, ${results.incomplete.length} incomplete`);
      for (const r of rows) console.log('  ' + r);
      for (const v of results.violations) for (const n of v.nodes.slice(0, 3)) console.log(`    ${v.id}: ${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(0, 3).join(' | ')}`);
      const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(bad.map((v) => `${v.impact} ${v.id} x${v.nodes.length}`), 'critical/serious violations').toEqual([]);
    });
  }
}

test('reduced motion: the world calms and Perform does not start by itself', async ({ lab }) => {
  test.setTimeout(60_000);
  const w = await lab.mainOnly({ contextOptions: { reducedMotion: 'reduce' } });
  await w.main.waitForFunction(() => window.tidalApp != null, null, { timeout: 10_000 });
  const reduced = await w.main.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await w.main.waitForFunction(() => window.tidal!.isCalm, null, { timeout: 5000 });
  await sleep(3000);
  const s = await w.main.evaluate(() => ({ calm: window.tidal!.isCalm, performing: window.tidalApp!.performer.performing, vessels: window.tidal!.registry.all().length }));
  console.log(`prefers-reduced-motion matches: ${reduced}; isCalm ${s.calm}; performing ${s.performing}; vessels ${s.vessels}`);
  expect(reduced).toBe(true);
  expect(s.calm).toBe(true);
  expect(s.performing).toBe(false);

  // control: without the preference the world is not calm
  const w2 = await lab.mainOnly();
  await sleep(1500);
  expect(await w2.main.evaluate(() => window.tidal!.isCalm)).toBe(false);
});

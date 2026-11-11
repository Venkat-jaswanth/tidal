import './ui/base.css';
import { TidalAudio } from './audio/engine';
import { Engine, PX2_PER_ML } from './engine';
import { showFallback, type FallbackReason } from './fallback/fallback';
import { LIQUIDS } from './liquids';
import { isPocket, mountTilt, mountTiltPrompt } from './mobile/tilt';
import { Performer } from './perform/performer';
import { isStagePage, mountStage, openStage } from './perform/stage';
import { floatSupported, openFloat, type FloatTank } from './pip/float';
import { BENCH, DARKROOM } from './render/theme';
import { mountA11y } from './ui/a11y';
import { mountChrome, type ChromeState } from './ui/chrome';
import { mountTabIcon } from './ui/tabicon';
import { nextSpanSpot, requestSpan } from './world/span';

declare global {
  interface Window {
    tidal?: Engine;
    /** Handles for tests and the capture tools. */
    tidalApp?: { performer: Performer; audio: TidalAudio; float: () => FloatTank | null; vessels: () => Window[]; sitOut: (out: boolean) => void };
  }
}

const SAB_ASK = 'tidal-sab?';
const SAB_GIVE = 'tidal-sab';
const ORDER = ['water', 'mercury', 'honey', 'ink'];
const VESSEL_SIZE = { w: 420, h: 360 };

/** Ask the window that opened this one for the shared memory block. */
function askOpener(): Promise<SharedArrayBuffer | null> {
  const opener = window.opener as Window | null;
  if (!opener || !crossOriginIsolated) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 400);
    addEventListener('message', function onMessage(e: MessageEvent<{ type?: string; sab?: SharedArrayBuffer }>) {
      if (e.origin !== location.origin || e.data?.type !== SAB_GIVE) return;
      removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(e.data.sab ?? null);
    });
    try { opener.postMessage({ type: SAB_ASK }, location.origin); } catch { resolve(null); }
  });
}

async function main(): Promise<void> {
  if (isStagePage()) { mountStage(document); return; }

  const canvas = document.querySelector<HTMLCanvasElement>('#tank')!;
  const query = new URLSearchParams(location.search);
  const pocket = isPocket(window);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const engine = new Engine({
    canvas, view: window, kind: window.opener ? 'popup' : pocket ? 'pocket' : 'main',
    theme: dark ? DARKROOM : BENCH, liquids: LIQUIDS,
    particles: query.has('particles') ? Number(query.get('particles')) : undefined,
  });
  window.tidal = engine;

  const shared = await askOpener();
  if (shared) engine.transport.adopt(shared);
  else engine.transport.create();
  // hand the block on to any window this one opens
  addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
    if (e.origin !== location.origin || e.data?.type !== SAB_ASK || !engine.transport.shared) return;
    (e.source as Window).postMessage({ type: SAB_GIVE, sab: engine.transport.shared }, location.origin);
  });

  let failure: FallbackReason | null = query.has('fallback') ? 'no-webgpu' : null;
  if (!failure) {
    try {
      const ok = await engine.start();
      if (!ok) failure = 'gpu' in navigator ? 'no-adapter' : 'no-webgpu';
    } catch {
      failure = 'error';
    }
  }
  if (query.has('tier')) engine.setTier(Number(query.get('tier')), true);
  document.documentElement.dataset.gpu = failure ? 'no' : 'yes';
  if (failure) { engine.stop(); showFallback(document, failure); return; }

  const state: ChromeState = { liquid: engine.liquid.id, sound: false, performing: false, floating: false };
  const set = (patch: Partial<ChromeState>): void => { Object.assign(state, patch); chrome.update(patch); };

  // ---- vessels this window opened ----
  let vessels: Window[] = [];
  const liveVessels = (): Window[] => (vessels = vessels.filter((w) => !w.closed));
  /** Bring popups to the front in slot order, so later vessels sit above earlier ones. */
  const raiseVessels = (): void => {
    const slotOf = (w: Window): number => { try { return w.tidal?.slot ?? 99; } catch { return 99; } };
    for (const w of liveVessels().sort((a, b) => slotOf(a) - slotOf(b))) w.focus();
  };
  let spanning = false;
  let spanUsed = 0;
  const openVessel = (): Window | null => {
    const n = liveVessels().length;
    const anchor = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
    const spot = spanning ? nextSpanSpot(anchor, VESSEL_SIZE, spanUsed++) : null;
    const left = spot ? spot.left : window.screenX + window.outerWidth + n * 24;
    const top = spot ? spot.top : window.screenY + n * 24;
    const w = window.open(location.href.split('?')[0], `tidal-vessel-${Date.now()}-${n}`, `popup,width=${VESSEL_SIZE.w},height=${VESSEL_SIZE.h},left=${left},top=${top}`);
    if (w) vessels.push(w);
    return w;
  };

  // ---- stage ----
  let stage: Window | null = null;
  const stageOpen = (): boolean => !!stage && !stage.closed;
  // behind a stage the main window is covered, so it sits out and its liquid goes to the vessels in front
  // `?inactive`, or tidalApp.sitOut(true), keeps this window out of the world (used when filming)
  let sittingOut = query.has('inactive');
  const restingActive = (): boolean => !sittingOut && !(stageOpen() && engine.registry.all().some((v) => v.kind === 'popup'));
  engine.setActive(restingActive());
  setInterval(() => {
    if (!performer.performing) engine.setActive(restingActive());
    if (state.staged && !stageOpen()) set({ staged: false });
  }, 500);

  // ---- perform ----
  const performer = new Performer(engine, window, restingActive);
  performer.onChange = (performing) => set({ performing });

  // ---- sound ----
  // Only the leader makes sound, and any window may become leader, so the switch is shared: every
  // window turns its audio on or off together. A window that has had no gesture yet starts its
  // audio on its next one.
  const audio = new TidalAudio(engine);
  engine.frameListeners.add(() => audio.update());
  let wantSound = false;
  const applySound = (on: boolean): void => {
    wantSound = on;
    if (on) void audio.enable().catch(() => {}).then(() => set({ sound: true }));
    else { audio.disable(); set({ sound: false }); }
  };
  const setSound = (on: boolean): void => {
    engine.registry.channel.postMessage({ type: 'sound', on });
    applySound(on);
  };
  engine.registry.channel.addEventListener('message', (e: MessageEvent<{ type: string; on?: boolean }>) => {
    if (e.data.type === 'sound') applySound(e.data.on === true);
  });
  for (const type of ['pointerdown', 'keydown'] as const) {
    addEventListener(type, () => { if (wantSound) void audio.enable().catch(() => {}); }, { passive: true });
  }

  // ---- float ----
  let tank: FloatTank | null = null;

  const chrome = mountChrome(document, engine, {
    addVessel: () => { openVessel(); },
    float: () => {
      if (tank) { tank.close(); return; }
      if (!floatSupported()) return;
      void openFloat(engine, (doc, view) => {
        // the floating tank shows its own volume and number through the same chrome
        const facade = new Proxy(engine, {
          get(target, key) {
            if (key === 'ml') return view.ml;
            if (key === 'slot') return view.info.slot;
            if (key === 'capacityMl') return (view.info.w * view.info.h) / PX2_PER_ML;
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        const inner = mountChrome(doc, facade, actions, state);
        return () => inner.destroy();
      }, () => { tank = null; set({ floating: false }); }).then((t) => { tank = t; set({ floating: !!t }); }).catch(() => set({ floating: false }));
    },
    perform: () => {
      if (performer.performing) { performer.stop(); return; }
      // Perform wants three popup vessels. A browser allows one popup per click, so this opens
      // what it may and performs with the vessels that exist.
      const have = engine.registry.all().filter((v) => v.kind === 'popup').length;
      for (let i = have; i < 3; i++) if (!openVessel()) break;
      setTimeout(() => { raiseVessels(); performer.start(); }, have >= 3 ? 0 : 900);
    },
    cycleLiquid: () => {
      const next = ORDER[(ORDER.indexOf(state.liquid) + 1) % ORDER.length] ?? 'water';
      engine.command({ type: 'cmd', cmd: 'liquid', value: next });
      set({ liquid: next });
    },
    toggleSound: () => setSound(!state.sound),
    spanScreens: () => {
      void requestSpan().then((r) => { spanning = r.ok; set({ spanning: r.ok }); });
    },
    stage: () => {
      if (stageOpen()) { stage?.close(); stage = null; set({ staged: false }); return; }
      stage = openStage();
      set({ staged: stageOpen() });
      // the backdrop opens in front; put the vessels back on top of it
      setTimeout(raiseVessels, 300);
    },
  }, state);
  // the chrome inside the floating tank reuses these actions
  const actions = {
    addVessel: () => {}, float: () => { tank?.close(); }, perform: () => {}, spanScreens: () => {}, stage: () => {},
    cycleLiquid: () => {
      const next = ORDER[(ORDER.indexOf(state.liquid) + 1) % ORDER.length] ?? 'water';
      engine.command({ type: 'cmd', cmd: 'liquid', value: next });
      set({ liquid: next });
    },
    toggleSound: () => setSound(!state.sound),
  };

  // another window may change the liquid: follow it
  engine.frameListeners.add((e) => { if (e.liquid.id !== state.liquid) set({ liquid: e.liquid.id }); });

  mountTabIcon(document, engine);
  mountA11y(document, engine);

  if (pocket) {
    const tilt = mountTilt(
      window,
      (x, y) => engine.command({ type: 'cmd', cmd: 'gravity', x, y }),
      (strength) => engine.command({ type: 'cmd', cmd: 'impulse', x: (Math.random() - 0.5) * strength, y: -strength }),
    );
    mountTiltPrompt(document, tilt, { ink: engine.theme.ink, paper: engine.theme.paper });
  }

  window.tidalApp = {
    performer, audio, float: () => tank, vessels: liveVessels,
    sitOut: (out: boolean) => { sittingOut = out; if (!performer.performing) engine.setActive(restingActive()); },
  };
}

if (new URLSearchParams(location.search).has('capture')) void import('./capture/recorder');
void main();

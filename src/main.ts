import { Game } from './game/Game';
import { road } from './track/roadSurface';
import { Vehicle } from './physics/Vehicle';
import * as selftest from './dev/selftest';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const game = new Game(canvas);
game.start();

// Automation / debugging hooks (used by the Playwright verification, harmless for players).
(window as unknown as { __demo: unknown }).__demo = {
  game, road, Vehicle, selftest,
  press: (code: string, hold = false) => game.controls.press(code, hold),
  release: (code: string) => game.controls.release(code),
  step: (sec: number) => game.stepSeconds(sec),
  freeze: (on: boolean) => { game.paused = on; },
  gap: {
    start: () => { game.resetGapStats(); game.gapTracking = true; },
    stop: () => { game.gapTracking = false; },
    reset: () => game.resetGapStats(),
    outliers: () => game.gapOutliers,
    showroom: () => game.sampleShowroomGaps(),
    stats: () => Object.fromEntries(Object.entries(game.gapStats).map(([k, v]) => [k, { maxGapMm: +(v.max * 1000).toFixed(2), maxEmbedMm: +(-v.min * 1000).toFixed(2), n: v.n }])),
  },
  state: () => {
    const p = game.player;
    return {
      mode: game.mode, s: p.s, d: p.d, kmh: p.v * 3.6, rollDeg: p.tel?.rollDeg, pitchDeg: p.tel?.pitchDeg,
      emb: p.opts.emb, active: p.opts.active, crashed: p.crashed, lane: p.laneIdx, section: road.sectionAt(p.s).name,
      refRollDeg: game.ref.tel?.rollDeg, fps: game.fps,
    };
  },
};

const auto = new URLSearchParams(location.search).get('auto');
if (auto === 'drive') game.startDriving();
else if (auto === 'show') game.startShowcase();

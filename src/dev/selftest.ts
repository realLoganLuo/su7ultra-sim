// Headless physics checks, usable from node (scripts/simtest.ts) and from the browser console
// (window.__demo.selftest) so that the verification runs against exactly the shipped model.
import { Vehicle } from '../physics/Vehicle';
import { road } from '../track/roadSurface';

const dt = 1 / 120;

function straightStart(offset = 150): number {
  return road.sections.find((s) => s.name === 'Döttinger Höhe')!.sStart + offset;
}

export interface LaneChangeResult { peakRollDeg: number; peakPitchDeg: number; peakActuatorN: number; peakAyG: number }

/** Alternating left/right lane changes at constant speed on the long straight. */
export function laneChangeTest(active: boolean, speedKmh = 120, emb = true): LaneChangeResult {
  const v0 = speedKmh / 3.6;
  const veh = new Vehicle({ emb, active });
  veh.reset(straightStart(), 0, v0);
  const seq = [1, -1, 1, -1, 0];
  let t = 0, next = 1.0, k = 0;
  const r: LaneChangeResult = { peakRollDeg: 0, peakPitchDeg: 0, peakActuatorN: 0, peakAyG: 0 };
  while (t < 18) {
    if (t >= next && k < seq.length) { veh.setLane(seq[k++]); next += 3.2; }
    veh.step(dt, { throttle: veh.v < v0 ? 0.35 : 0, brake: 0 });
    t += dt;
    if (t > 0.5) {
      r.peakRollDeg = Math.max(r.peakRollDeg, Math.abs(veh.tel.rollDeg));
      r.peakPitchDeg = Math.max(r.peakPitchDeg, Math.abs(veh.tel.pitchDeg));
      r.peakActuatorN = Math.max(r.peakActuatorN, ...veh.tel.fAct.map(Math.abs));
      r.peakAyG = Math.max(r.peakAyG, Math.abs(veh.tel.ayG));
    }
  }
  return r;
}

export interface BrakeTestResult {
  system: string; v0: number; distM: number; timeS: number; responseMs: number;
  slipFLMin: number; slipFLMax: number; slipFLMean: number; absCycles: number; maxDiscTempK: number;
}

/** Full-pedal stop (step input, like Space) from `speedKmh`. */
export function brakeTest(emb: boolean, speedKmh = 200, active = true): BrakeTestResult {
  const v0 = speedKmh / 3.6;
  const veh = new Vehicle({ emb, active });
  veh.reset(straightStart(100), 0, v0);
  let t = 0, dist = 0;
  let mn = 1, mx = 0, sum = 0, n = 0, cycles = 0;
  let wasAbove = false;
  while (t < 20 && veh.v > 0.3) {
    veh.step(dt, { throttle: 0, brake: 1 });
    t += dt;
    dist += veh.v * dt;
    if (veh.v > 15) {
      const sl = veh.slip[0];
      mn = Math.min(mn, sl); mx = Math.max(mx, sl); sum += sl; n++;
      const above = sl > 0.15;
      if (above && !wasAbove) cycles++;
      wasAbove = above;
    }
  }
  return {
    system: emb ? 'EMB' : '液压', v0: speedKmh, distM: dist, timeS: t, responseMs: veh.brake.responseMs,
    slipFLMin: mn, slipFLMax: mx, slipFLMean: sum / Math.max(1, n), absCycles: cycles, maxDiscTempK: Math.max(...veh.discTemp) + 273,
  };
}

export interface FlugplatzResult { active: boolean; speedKmh: number; pitchRangeDeg: number; heaveRangeMm: number; rollRangeDeg: number; airborneS: number; peakTireLoadN: number }

export function flugplatzTest(active: boolean, speedKmh: number): FlugplatzResult {
  const v0 = speedKmh / 3.6;
  const veh = new Vehicle({ emb: true, active });
  const featS = road.controlS[9] + 0.25 * (road.controlS[10] - road.controlS[9]);
  const lead = 120, len = 300;
  veh.reset(featS - lead, 0, v0);
  veh.setLane(0); // Explicit test driver follows the road; gameplay is manual.
  let t = 0;
  const mn = { p: 1e9, h: 1e9, r: 1e9 }, mx = { p: -1e9, h: -1e9, r: -1e9 };
  let air = 0, maxFz = 0;
  while (veh.s < featS - lead + len && t < 30) {
    veh.step(dt, { throttle: veh.v < v0 ? 0.4 : 0, brake: 0 });
    t += dt;
    if (t < 0.5) continue;
    mn.p = Math.min(mn.p, veh.tel.pitchDeg); mx.p = Math.max(mx.p, veh.tel.pitchDeg);
    mn.h = Math.min(mn.h, veh.tel.heaveMm); mx.h = Math.max(mx.h, veh.tel.heaveMm);
    mn.r = Math.min(mn.r, veh.tel.rollDeg); mx.r = Math.max(mx.r, veh.tel.rollDeg);
    if (veh.tel.airborne) air += dt;
    maxFz = Math.max(maxFz, ...veh.tel.fz);
  }
  return { active, speedKmh, pitchRangeDeg: mx.p - mn.p, heaveRangeMm: mx.h - mn.h, rollRangeDeg: mx.r - mn.r, airborneS: air, peakTireLoadN: maxFz };
}

export function runAll() {
  const out: Record<string, unknown> = {};
  for (const spd of [80, 120, 160]) {
    const p = laneChangeTest(false, spd), a = laneChangeTest(true, spd);
    out[`laneChange_${spd}kmh`] = { passiveRollDeg: p.peakRollDeg, activeRollDeg: a.peakRollDeg, ratio: a.peakRollDeg / p.peakRollDeg, peakAyG: p.peakAyG, peakActuatorN: a.peakActuatorN };
  }
  out.brake200 = { emb: brakeTest(true, 200), hydraulic: brakeTest(false, 200) };
  out.flugplatz = [120, 180].map((s) => ({ passive: flugplatzTest(false, s), active: flugplatzTest(true, s) }));
  return out;
}

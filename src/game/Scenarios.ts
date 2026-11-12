import { road } from '../track/roadSurface';
import { Vehicle } from '../physics/Vehicle';

export interface BrakeResult {
  system: string; // 'EMB' | '液压'
  v0: number; // km/h
  dist: number;
  time: number;
  norm200: number; // distance normalised to 200 km/h (d * (200/v0)^2)
  respMs: number;
  ghost?: { dist: number; time: number };
}

export interface MooseResult {
  susp: string; // '主动' | '被动'
  entry: number; // km/h
  maxRoll: number; // deg
  hits: number;
  time: number;
}

export class Scenarios {
  readonly zoneStart: number;
  readonly zoneEnd: number;
  readonly mooseStart: number;
  readonly mooseEnd: number;
  brakeHistory: Record<string, BrakeResult | undefined> = {};
  lastBrake?: BrakeResult;
  lastMoose?: MooseResult;
  // brake test state
  btActive = false;
  private btV0 = 0;
  private btDist0 = 0;
  private btT0 = 0;
  private btIdle = 0;
  // moose test state
  mtActive = false;
  private mtMaxRoll = 0;
  private mtHits = 0;
  private mtT0 = 0;
  private mtEntry = 0;
  mtMaxRollLive = 0;

  constructor() {
    const L = road.length;
    this.zoneEnd = L - 130;
    this.zoneStart = L - 560;
    // find a long straight on the return leg for the moose test
    const wip = road.sections.find((s) => s.name === 'Wippermann')!;
    let best = wip.sStart + 300, bestK = 1;
    for (let s = wip.sStart + 200; s < wip.sEnd - 400; s += 20) {
      let k = 0;
      for (let q = 0; q < 220; q += 10) k = Math.max(k, Math.abs(road.curvature(s + q)));
      if (k < bestK) { bestK = k; best = s; }
    }
    this.mooseStart = best + 60;
    this.mooseEnd = this.mooseStart + 72 * 2 + 55;
  }

  cancelTests() { this.btActive = false; this.mtActive = false; }

  inBrakeZone(s: number) { return s >= this.zoneStart && s <= this.zoneEnd; }

  /** returns a result when a brake test just finished */
  updateBrakeTest(dt: number, veh: Vehicle, pedal: number, ghost: Vehicle | null): BrakeResult | 'cancel' | null {
    const kmh = veh.v * 3.6;
    if (!this.btActive) {
      if (pedal > 0.3 && this.inBrakeZone(veh.s) && kmh > 100 && !veh.crashed) {
        this.btActive = true;
        this.btV0 = kmh;
        this.btDist0 = veh.distance;
        this.btT0 = veh.time;
        this.btIdle = 0;
      }
      return null;
    }
    if (pedal < 0.1 && kmh > 5) {
      this.btIdle += dt;
      if (this.btIdle > 1.0) { this.btActive = false; return 'cancel'; }
    } else this.btIdle = 0;
    if (veh.crashed) { this.btActive = false; return 'cancel'; }
    if (kmh < 1.0) {
      this.btActive = false;
      const dist = veh.distance - this.btDist0;
      const time = veh.time - this.btT0;
      const res: BrakeResult = {
        system: veh.opts.emb ? 'EMB' : '液压',
        v0: this.btV0, dist, time,
        norm200: dist * Math.pow(200 / this.btV0, 2),
        respMs: veh.brake.responseMs,
      };
      void ghost;
      this.lastBrake = res;
      this.brakeHistory[res.system] = res;
      return res;
    }
    return null;
  }

  updateMoose(dt: number, veh: Vehicle, cones: number): MooseResult | null {
    void dt;
    const s = veh.s;
    const inside = s >= this.mooseStart - 25 && s <= this.mooseEnd;
    if (!this.mtActive) {
      if (inside && veh.v > 5 && s >= this.mooseStart - 25 && s < this.mooseStart) {
        this.mtActive = true;
        this.mtMaxRoll = 0;
        this.mtHits = cones;
        this.mtT0 = veh.time;
        this.mtEntry = veh.v * 3.6;
        this.mtMaxRollLive = 0;
      }
      return null;
    }
    this.mtMaxRoll = Math.max(this.mtMaxRoll, Math.abs(veh.tel.rollDeg));
    this.mtMaxRollLive = this.mtMaxRoll;
    if (s > this.mooseEnd || s < this.mooseStart - 40) {
      this.mtActive = false;
      const res: MooseResult = {
        susp: veh.opts.active ? '主动' : '被动',
        entry: this.mtEntry, maxRoll: this.mtMaxRoll, hits: cones - this.mtHits, time: veh.time - this.mtT0,
      };
      this.lastMoose = res;
      return res;
    }
    return null;
  }
}

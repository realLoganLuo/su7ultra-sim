// Coupled bicycle lateral dynamics and slip-based longitudinal
// wheels, 3-DOF sprung body + 4 hubs, brake system (EMB or hydraulic) and optional active suspension.
import { CAR, G, TRACK_CFG } from '../config';
import { road } from '../track/roadSurface';
import { SuspensionModel, CORNER_X, CORNER_Y } from './Suspension';
import { ActiveSuspension } from './ActiveSuspension';
import { BrakeByWire } from './BrakeByWire';
import { HydraulicBrake } from './HydraulicBrake';
import { BrakeSystem } from './BrakeBase';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Normalised longitudinal tyre characteristic, peak near 12 % slip. */
function tyreF(k: number): number {
  return Math.sin(1.65 * Math.atan(11 * k));
}
function tyreDF(k: number): number {
  const a = 11 * k;
  return (1.65 * 11 * Math.cos(1.65 * Math.atan(a))) / (1 + a * a);
}

/** Render snapshots are separate from the fixed-step simulation. */
export interface VehiclePose {
  s: number; d: number; yaw: number; q: number; phi: number; theta: number;
  steer: number; spin: number[]; hubs: number[];
}

export interface VehicleInputs { throttle: number; brake: number; steer?: number; }
export interface VehicleOptions { emb: boolean; active: boolean; }

export interface Telemetry {
  t: number;
  speed: number; // m/s
  rollDeg: number; // + = rolls to the right
  pitchDeg: number; // + = nose down
  heaveMm: number;
  ayG: number; // lateral specific force (+ left)
  axG: number;
  powerKW: number;
  brakeForce: number[]; // N per wheel
  brakeFrac: number[]; // 0..1
  slip: number[];
  fAct: number[];
  fz: number[];
  comp: number[];
  absActive: boolean[];
  tv: number;
  airborne: boolean;
}

export function safeSpeed(s: number, d: number, mu = 1.35): number {
  const kap = road.curvature(s);
  const kd = kap / Math.max(0.25, 1 - kap * d);
  const ak = Math.abs(kd);
  if (ak < 1e-5) return 120;
  const sigma = Math.sign(kd);
  const beta = sigma * road.bankAt(s);
  const kdf = 0.5 * 1.2 * (CAR.clAFront + CAR.clARear) / CAR.mass;
  const den = ak * (Math.cos(beta) - mu * Math.sin(beta)) - mu * kdf;
  if (den <= 1e-6) return 120;
  const v2 = (G * (Math.sin(beta) + mu * Math.cos(beta))) / den;
  return Math.min(120, Math.sqrt(Math.max(v2, 25)));
}

export class Vehicle {
  // path state
  s = 0;
  v = 0;
  lane = { d: 0, dd: 0, ddd: 0, target: 0 };
  private laneAssist = false; // Explicit test driver only; never enabled by keyboard steering.
  lateralSpeed = 0;
  private lateralForce = [0, 0];
  private previousPose!: VehiclePose;
  laneIdx = 0;
  yaw = 0;
  yawRate = 0;
  steerAngle = 0;
  crashed = false;
  offRoad = false;
  time = 0;
  distance = 0;

  susp = new SuspensionModel();
  active = new ActiveSuspension();
  emb = new BrakeByWire();
  hyd = new HydraulicBrake();
  opts: VehicleOptions;
  // wheels
  omega = [0, 0, 0, 0];
  spin = [0, 0, 0, 0];
  slip = [0, 0, 0, 0];
  fx = [0, 0, 0, 0];
  discTemp = [25, 25, 25, 25];
  // frames / telemetry
  rPrev = [0, 0, 0, 0];
  rdF = [0, 0, 0, 0];
  axFelt = 0;
  ayFelt = 0;
  gn = G;
  driveForce = 0;
  wingAngle = 0.12;
  tel!: Telemetry;
  brakeLightLevel = 0;
  lastHit = 0;
  event: string | null = null;

  constructor(opts: VehicleOptions) {
    this.opts = { ...opts };
    this.reset(0, 0, 0);
  }

  get brake(): BrakeSystem { return this.opts.emb ? this.emb : this.hyd; }

  setOptions(o: Partial<VehicleOptions>) {
    if (o.emb !== undefined && o.emb !== this.opts.emb) {
      const nb = o.emb ? this.emb : this.hyd;
      nb.reset();
      this.opts.emb = o.emb;
    }
    if (o.active !== undefined && o.active !== this.opts.active) {
      this.opts.active = o.active;
      this.active.reset();
    }
  }

  reset(s: number, laneIdx: number, v: number) {
    this.s = road.wrap(s);
    this.v = v;
    this.laneIdx = laneIdx;
    this.lane = { d: laneIdx * 4, dd: 0, ddd: 0, target: laneIdx * 4 };
    this.laneAssist = false;
    this.lateralSpeed = 0; this.lateralForce = [0, 0];
    this.steerAngle = 0; this.spin.fill(0);
    this.yaw = 0; this.yawRate = 0;
    this.crashed = false; this.offRoad = false;
    this.susp.reset();
    this.active.reset();
    this.emb.reset(); this.hyd.reset();
    const w = v / CAR.wheelRadius;
    this.omega = [w, w, w, w];
    this.slip = [0, 0, 0, 0];
    this.fx = [0, 0, 0, 0];
    this.discTemp = [25, 25, 25, 25];
    this.rdF = [0, 0, 0, 0];
    this.axFelt = 0;
    this.ayFelt = 0;
    this.brakeLightLevel = 0;
    this.event = null;
    // Settle at the spawn position, not by driving forward for 1/3 second.
    this.v = 0;
    this.rPrev = this.contactHeights(this.s, this.d).r;
    for (let i = 0; i < 240; i++) this.step(1 / 120, { throttle: 0, brake: 0 }, true);
    this.v = v;
    this.omega.fill(v / CAR.wheelRadius);
    this.spin.fill(0); this.fx.fill(0); this.slip.fill(0);
    this.axFelt = 0; this.ayFelt = 0;
    this.time = 0; this.distance = 0;
    this.tel.speed = v; this.tel.axG = 0; this.tel.ayG = 0;
    this.previousPose = this.pose();
  }

  get d(): number { return this.lane.d; }

  /** Optional test driver: follows a target via tyre forces, never teleports sideways. */
  setLane(idx: number) {
    this.laneIdx = clamp(Math.round(idx), -1, 1);
    this.lane.target = this.laneIdx * 4;
    this.laneAssist = true;
  }

  private pose(): VehiclePose {
    return { s: this.s, d: this.d, yaw: this.yaw, q: this.susp.q,
      phi: this.susp.phi, theta: this.susp.theta, steer: this.steerAngle,
      spin: this.spin.slice(), hubs: this.susp.u.slice() };
  }

  renderPose(alpha = 1): VehiclePose {
    const cur = this.pose(), prev = this.previousPose ?? cur;
    const a = clamp(alpha, 0, 1), lerp = (x: number, y: number) => x + (y - x) * a;
    const ds = ((cur.s - prev.s + road.length * 1.5) % road.length) - road.length / 2;
    return { s: road.wrap(prev.s + ds * a), d: lerp(prev.d, cur.d),
      yaw: prev.yaw + Math.atan2(Math.sin(cur.yaw - prev.yaw), Math.cos(cur.yaw - prev.yaw)) * a,
      q: lerp(prev.q, cur.q), phi: lerp(prev.phi, cur.phi), theta: lerp(prev.theta, cur.theta),
      steer: lerp(prev.steer, cur.steer), spin: cur.spin.map((x,i) => lerp(prev.spin[i],x)),
      hubs: cur.hubs.map((x,i) => lerp(prev.hubs[i],x)) };
  }

  private steer(dt: number, input: number | undefined) {
    if (input !== undefined) this.laneAssist = false;
    // Keyboard is a rate-limited virtual steering wheel with speed-sensitive authority.
    const maxAngle = Math.min(0.52, Math.atan(CAR.wheelbase * 0.95 * G / Math.max(4, this.v * this.v)) + 0.012);
    let target = clamp(input ?? 0, -1, 1) * maxAngle;
    if (this.laneAssist) {
      const ay = clamp(1.5 * (this.lane.target - this.d) - 2.4 * this.lane.dd, -0.5 * G, 0.5 * G);
      target = Math.atan(CAR.wheelbase * (road.curvature(this.s) + ay / Math.max(25, this.v * this.v)))
        + 0.02 * ay / G - 0.4 * this.yaw;
    }
    const rate = 0.8 / (1 + this.v / 30);
    const delta = (target - this.steerAngle) * (1 - Math.exp(-dt / 0.09));
    this.steerAngle += clamp(delta, -rate * dt, rate * dt);
  }

  /** Two-axle bicycle dynamics; axle slip forces share grip with longitudinal tyres. */
  private lateralStep(h: number) {
    const v = this.v, a = CAR.xFront, b = -CAR.xRear;
    if (v < 6) {
      const r = v * Math.tan(this.steerAngle) / CAR.wheelbase;
      const k = 1 - Math.exp(-h * 12);
      this.yawRate += (r - this.yawRate) * k;
      this.lateralSpeed += (b * r - this.lateralSpeed) * k;
      if (v < 0.05) { this.yawRate = 0; this.lateralSpeed = 0; }
      this.ayFelt = v * this.yawRate;
      this.lateralForce = [this.ayFelt * CAR.mass * b / CAR.wheelbase, this.ayFelt * CAR.mass * a / CAR.wheelbase];
      return;
    }
    const limits = [0, 1].map(axle => {
      let available = 0;
      for (let i = axle * 2; i < axle * 2 + 2; i++) {
        const grip = CAR.tireMu * this.susp.ft[i] * (this.offRoad ? 0.45 : 1);
        available += Math.sqrt(Math.max(0, grip * grip - Math.min(grip, Math.abs(this.fx[i])) ** 2));
      }
      return available;
    });
    const af = this.steerAngle - Math.atan2(this.lateralSpeed + a * this.yawRate, v);
    const ar = -Math.atan2(this.lateralSpeed - b * this.yawRate, v);
    const fyF = limits[0] * Math.tanh(CAR.corneringFront * af / Math.max(1, limits[0]));
    const fyR = limits[1] * Math.tanh(CAR.corneringRear * ar / Math.max(1, limits[1]));
    this.lateralForce = [fyF, fyR];
    this.ayFelt = (fyF + fyR) / CAR.mass;
    this.lateralSpeed += h * (this.ayFelt + G * Math.sin(road.bankAt(this.s)) - v * this.yawRate);
    this.yawRate += h * (a * fyF - b * fyR) / CAR.yawInertia;
  }

  private contactHeights(s: number, d: number, out?: { r: number[]; h0: number; slope: number }) {
    const r = [0, 0, 0, 0];
    const h0 = road.base(s, d);
    const slope = (road.base(s + 1.5, d) - road.base(s - 1.5, d)) / 3;
    const sb = Math.sin(road.bankAt(s));
    for (let i = 0; i < 4; i++) {
      // corner position in the road frame (car yawed by this.yaw about the road normal)
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const si = s + CORNER_X[i] * cy - CORNER_Y[i] * sy;
      const di = d + CORNER_X[i] * sy + CORNER_Y[i] * cy;
      const h = road.height(si, di);
      r[i] = h - (h0 + slope * (si - s) - sb * (di - d));
    }
    if (out) { out.r = r; out.h0 = h0; out.slope = slope; }
    return { r, h0, slope };
  }

  /** gn and curvature terms at a given s */
  private frameTerms(s: number, d: number, v: number) {
    const kap = road.curvature(s);
    const kd = kap / Math.max(0.25, 1 - kap * d);
    const b = road.bankAt(s);
    const cb = Math.cos(b), sb = Math.sin(b);
    const ac = v * v * kd;
    const h0 = road.base(s, d);
    const hp = road.base(s + 3, d), hm = road.base(s - 3, d);
    const slope = (road.base(s + 1.5, d) - road.base(s - 1.5, d)) / 3;
    const cosS = 1 / Math.sqrt(1 + slope * slope);
    const ap = (v * v * (hp - 2 * h0 + hm)) / 9;
    // Signed apparent gravity in the road frame: real crests may unload the tyres.
    // Clamping it forces the chassis to follow a dropping road and hides lift-off.
    const gn = (G + ap) * cosS * cb + ac * sb;
    return { kd, ac, cb, sb, gn, sinS: slope * cosS, slope };
  }

  step(dt: number, inp: VehicleInputs, settling = false): void {
    this.previousPose = this.pose();
    this.time += dt;
    const brake = this.brake;
    const v = Math.max(this.v, 0);

    if (!settling) this.steer(dt, inp.steer);
    const dTot = this.d;
    const ft = this.frameTerms(this.s, dTot, v);
    const ayRoad = this.ayFelt;
    this.gn = ft.gn;

    // --- aero ----------------------------------------------------------
    const wingTarget = 0.1; // Fixed carbon wing; no invented brake-actuated air brake.
    this.wingAngle += (wingTarget - this.wingAngle) * Math.min(1, dt * 6);
    const wingK = 1 + 1.4 * Math.max(0, this.wingAngle - 0.1);
    const q = 0.5 * 1.2 * v * v;
    const drag = q * (CAR.cdA + 0.35 * Math.max(0, this.wingAngle - 0.1)) * 1;
    const dfF = q * CAR.clAFront;
    const dfR = q * CAR.clARear * wingK;

    // --- road contact ----------------------------------------------------
    const cur = this.contactHeights(this.s, dTot);
    const r = cur.r;
    const rd = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const raw = clamp((r[i] - this.rPrev[i]) / dt, -12, 12);
      this.rdF[i] += (raw - this.rdF[i]) * 0.6;
      rd[i] = this.rdF[i];
    }

    // --- suspension controller ----------------------------------------------
    let cmd = [0, 0, 0, 0];
    if (this.opts.active && !settling) {
      const D = this.active.previewDistance(Math.max(v, 8));
      const sf = this.s + D;
      const ftf = this.frameTerms(sf, dTot, v);
      const rf = [0, 0, 0, 0], rdf = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const di = dTot + CORNER_Y[i];
        const e = 0.4;
        // only the small-scale part (bumps, joints, rumble); the large-scale crest/dip is handled by the frame term gn
        const hh = (ss: number) => road.height(ss + CORNER_X[i], di) - road.base(ss + CORNER_X[i], di);
        rf[i] = hh(sf);
        rdf[i] = (v * (hh(sf + e) - hh(sf - e))) / (2 * e);
      }
      this.active.pushPreview({ tDue: this.time + D / Math.max(v, 8) - 0.03, gn: ftf.gn, r: rf, rd: rdf });
      cmd = this.active.update(this.time, this.susp, v, ayRoad, this.axFelt);
    } else if (!this.opts.active) {
      cmd = [0, 0, 0, 0];
    }

    // --- brake inputs --------------------------------------------------------
    const tvDemand = 0; // No braking intervention without a yaw-error controller.
    const drive = inp.throttle * Math.min(CAR.maxPowerW / Math.max(v, 3), CAR.maxDriveForce) * clamp((CAR.vMax - v) / 6, 0, 1) * (this.crashed ? 0 : 1);
    this.driveForce = inp.brake > 0.02 ? 0 : drive;
    const TD = (this.driveForce * CAR.wheelRadius) / 4;

    // --- sub-stepped wheel / suspension integration ------------------------------
    const N = 2;
    const h = dt / N;
    for (let sub = 0; sub < N; sub++) {
      const f = (sub + 1) / N;
      const rr = [0, 1, 2, 3].map((i) => this.rPrev[i] + (r[i] - this.rPrev[i]) * f);
      this.susp.step(h, {
        r: rr, rd, gn: ft.gn, ay: ayRoad, ax: this.axFelt, dfFront: dfF, dfRear: dfR, actCmd: cmd,
      });
      // brake torque
      brake.update({
        dt: h, time: this.time - dt + h * (sub + 1), pedal: settling ? 0 : inp.brake, speed: v,
        omega: this.omega, slip: this.slip, fz: this.susp.ft, tv: tvDemand,
      });
      // tyres + wheels
      const vref = Math.max(this.v, 2.5);
      let sumFx = 0;
      for (let i = 0; i < 4; i++) {
        const fz = this.susp.ft[i];
        const kappa = clamp((this.v - this.omega[i] * CAR.wheelRadius) / vref, -1, 1);
        this.slip[i] = kappa;
        const axle = i < 2 ? 0 : 1;
        const surfaceMu = CAR.tireMu * (this.offRoad ? 0.45 : 1);
        const axleLoad = this.susp.ft[axle * 2] + this.susp.ft[axle * 2 + 1];
        const lateralUse = Math.min(1, Math.abs(this.lateralForce[axle]) / Math.max(1, surfaceMu * axleLoad));
        const mf = surfaceMu * fz * Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse));
        const fxi = mf * tyreF(kappa);
        this.fx[i] = fxi;
        const dFdw = -mf * Math.max(0, tyreDF(kappa)) * CAR.wheelRadius / vref; // stabilising part of dFx/domega (<=0)
        const g0 = (fxi * CAR.wheelRadius + TD - brake.torque[i]) / CAR.wheelInertia;
        const gp = (CAR.wheelRadius / CAR.wheelInertia) * dFdw;
        let wn = this.omega[i] + (h * g0) / (1 - h * gp);
        if (wn < 0) wn = 0;
        this.omega[i] = wn;
        sumFx += fxi;
        // disc heat
        const pw = brake.torque[i] * this.omega[i];
        const cool = 12 + 0.9 * this.v;
        this.discTemp[i] += (h * (pw / 3500)) - h * ((this.discTemp[i] - 25) * cool) / 3500;
        this.spin[i] += this.omega[i] * h;
      }
      const rolling = this.susp.airborne ? 0 : CAR.rolling * CAR.mass * G;
      const offRoadDrag = this.offRoad ? 3.5 * CAR.mass : 0;
      const aT = (-sumFx - drag - (this.v > 0.05 ? rolling : 0) - (this.v > 0.05 ? offRoadDrag : 0)) / CAR.mass;
      this.axFelt = aT;
      this.v += h * (aT - G * ft.sinS);
      if (this.v < 0) this.v = 0;
      // Static friction: stop without a low-speed slip limit cycle; hold on a gradient.
      if (this.v < 0.12 && inp.brake > 0.05 && brake.torque.reduce((a,b) => a+b,0) / CAR.wheelRadius > CAR.mass * G * Math.abs(ft.sinS)) {
        this.v = 0; this.omega.fill(0); this.slip.fill(0);
      }
      if (settling) { this.v = 0; this.omega.fill(0); }
      else this.lateralStep(h);
    }
    this.rPrev = r;

    // Integrate the actual heading and lateral velocity in track coordinates.
    if (!settling) {
      const forward = this.v * Math.cos(this.yaw) - this.lateralSpeed * Math.sin(this.yaw);
      const lateral = this.v * Math.sin(this.yaw) + this.lateralSpeed * Math.cos(this.yaw);
      const dsdt = forward / Math.max(0.25, 1 - road.curvature(this.s) * this.d);
      this.yaw += (this.yawRate - road.curvature(this.s) * dsdt) * dt;
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
      this.lane.ddd = (lateral - this.lane.dd) / dt;
      this.lane.dd = lateral;
      this.lane.d += lateral * dt;
      this.s = road.wrap(this.s + dsdt * dt);
      this.distance += Math.hypot(this.v, this.lateralSpeed) * dt;
      this.offRoad = Math.abs(this.d) > TRACK_CFG.curbOuter;
      if (Math.abs(this.d) > TRACK_CFG.crashD && !this.crashed) {
        this.crashed = true; this.v *= 0.3; this.event = 'crash';
      }
      if (this.crashed) {
        this.lane.d = clamp(this.d, -TRACK_CFG.crashD, TRACK_CFG.crashD);
        this.lateralSpeed = 0; this.yawRate = 0;
        this.v = Math.max(0, this.v - 12 * dt);
      }
    }

    // brake lights
    this.brakeLightLevel = clamp(brake.torque.reduce((a, b) => a + b, 0) / 7000, 0, 1);

    // telemetry
    this.tel = {
      t: this.time,
      speed: this.v,
      rollDeg: (this.susp.phi * 180) / Math.PI,
      pitchDeg: (this.susp.theta * 180) / Math.PI,
      heaveMm: this.susp.q * 1000,
      ayG: this.ayFelt / G,
      axG: this.axFelt / G,
      powerKW: (this.driveForce * this.v) / 1000,
      brakeForce: this.fx.map(f => Math.max(0, f)),
      brakeFrac: brake.torque.map((t, i) => t / (i < 2 ? 4800 : 3300)),
      slip: this.slip.slice(),
      fAct: this.susp.fAct.slice(),
      fz: this.susp.ft.slice(),
      comp: this.susp.comp.slice(),
      absActive: brake.absActive.slice(),
      tv: tvDemand,
      airborne: this.susp.airborne,
    };
  }
}

// Coupled bicycle lateral dynamics and slip-based longitudinal
// wheels, 3-DOF sprung body + 4 hubs, brake system (EMB or hydraulic) and optional active suspension.
import { CAR, G, TRACK_CFG } from '../config';
import { road } from '../track/roadSurface';
import { SuspensionModel, CORNER_X, CORNER_Y } from './Suspension';
import { ActiveSuspension } from './ActiveSuspension';
import { BrakeByWire } from './BrakeByWire';
import { HydraulicBrake } from './HydraulicBrake';
import { BrakeSystem } from './BrakeBase';
import { BARRIER, BODY_CORNERS, K_EFF, K_UNLOAD, RESTITUTION, WHEEL_DAMAGE, Impact } from './Barrier';

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

/** damage to one wheel / corner: alignment, bent-rim runout, rubbing drag, or the whole wheel gone */
export interface WheelDamage { toe: number; camber: number; runout: number; drag: number; detached: boolean }
const SKID_MU = 0.55; // steel upright / disc sliding on asphalt

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
  /** wrecked: accumulated barrier damage exceeded BARRIER.wreckJ; drive is lost */
  crashed = false;
  offRoad = false;
  /** absorbed barrier impact energy since the last reset [J] */
  damageJ = 0;
  /** barrier impacts since the consumer last drained this queue (visual damage, debris, HUD) */
  impacts: Impact[] = [];
  private contact = BODY_CORNERS.map(() => ({ on: false, vn0: 0, peak: 0, emitted: false }));
  /** per-wheel damage (FL, FR, RL, RR); toe + = points left, camber + = top tilted inwards */
  wheelDmg: WheelDamage[] = [0, 1, 2, 3].map(() => ({ toe: 0, camber: 0, runout: 0, drag: 0, detached: false }));
  private damaged = false;
  private dmgYaw = 0; // yaw torque from asymmetric longitudinal forces of damaged / missing wheels
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
    this.damageJ = 0; this.impacts = [];
    for (const w of this.wheelDmg) { w.toe = 0; w.camber = 0; w.runout = 0; w.drag = 0; w.detached = false; }
    this.damaged = false; this.dmgYaw = 0;
    for (const c of this.contact) { c.on = false; c.vn0 = 0; c.peak = 0; c.emitted = false; }
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
    const rate = 0.8 / (1 + Math.abs(this.v) / 30);
    const delta = (target - this.steerAngle) * (1 - Math.exp(-dt / 0.09));
    this.steerAngle += clamp(delta, -rate * dt, rate * dt);
  }

  /** Two-axle bicycle dynamics; axle slip forces share grip with longitudinal tyres. */
  private lateralStep(h: number) {
    const v = this.v, a = CAR.xFront, b = -CAR.xRear;
    if (Math.abs(v) < 6) {
      const r = v * Math.tan(this.steerAngle) / CAR.wheelbase;
      const k = 1 - Math.exp(-h * 12);
      this.yawRate += (r - this.yawRate) * k;
      this.lateralSpeed += (b * r - this.lateralSpeed) * k;
      if (Math.abs(v) < 0.05) { this.yawRate = 0; this.lateralSpeed = 0; }
      this.ayFelt = v * this.yawRate;
      this.lateralForce = [this.ayFelt * CAR.mass * b / CAR.wheelbase, this.ayFelt * CAR.mass * a / CAR.wheelbase];
      return;
    }
    const limits = [0, 1].map(axle => {
      let available = 0;
      for (let i = axle * 2; i < axle * 2 + 2; i++) {
        if (this.wheelDmg[i].detached) continue;
        const grip = CAR.tireMu * this.susp.ft[i] * this.gripFactor(i) * (this.offRoad ? 0.45 : 1);
        available += Math.sqrt(Math.max(0, grip * grip - Math.min(grip, Math.abs(this.fx[i])) ** 2));
      }
      return available;
    });
    // Slip angles in the wheel frame against |vx|: identical to delta - atan2(vy, vx) when driving
    // forward, and still opposing the contact-patch slide when the car travels backwards after a spin.
    // Damaged wheels: front toe adds to the steering (the car pulls), a bent rim's runout wobbles it
    // once per wheel revolution (shimmy), rear toe steers the rear axle.
    const wd = this.wheelDmg;
    const frontToe = this.damaged ? (wd[0].toe + wd[1].toe) / 2 + (wd[0].runout * Math.sin(this.spin[0]) + wd[1].runout * Math.sin(this.spin[1])) * 0.15 : 0;
    const rearToe = this.damaged ? (wd[2].toe + wd[3].toe) / 2 : 0;
    const delta = this.steerAngle + frontToe;
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const vyF = this.lateralSpeed + a * this.yawRate;
    const af = -Math.atan2(vyF * cd - v * sd, Math.abs(v * cd + vyF * sd));
    const ar = rearToe - Math.atan2(this.lateralSpeed - b * this.yawRate, Math.abs(v));
    const fyF = limits[0] * Math.tanh(CAR.corneringFront * af / Math.max(1, limits[0]));
    const fyR = limits[1] * Math.tanh(CAR.corneringRear * ar / Math.max(1, limits[1]));
    this.lateralForce = [fyF, fyR];
    // skidding corners without a wheel: sliding friction sideways, plus the yaw moment of their drag
    let fySkid = 0, mzSkid = this.damaged ? this.dmgYaw : 0;
    for (let i = 0; i < 4; i++) {
      if (!wd[i].detached) continue;
      const uc = v - this.yawRate * CORNER_Y[i], wc = this.lateralSpeed + this.yawRate * CORNER_X[i];
      const vc = Math.hypot(uc, wc);
      const fy = vc > 0.05 ? -SKID_MU * this.susp.ft[i] * wc / vc : 0;
      fySkid += fy; mzSkid += CORNER_X[i] * fy;
    }
    this.ayFelt = (fyF + fyR + fySkid) / CAR.mass;
    // Body-frame rigid-body equations: the rotating-frame terms come in a pair (+vy*r on vx, -vx*r on vy),
    // so yaw only exchanges speed between the axes and never creates kinetic energy in a spin.
    const coriolisX = this.lateralSpeed * this.yawRate;
    this.lateralSpeed += h * (this.ayFelt + G * Math.sin(road.bankAt(this.s)) - v * this.yawRate);
    this.v += h * coriolisX;
    this.yawRate += h * (a * fyF - b * fyR + mzSkid) / CAR.yawInertia;
  }

  /** lateral / longitudinal grip left on a wheel: camber tilts the contact patch off the road */
  private gripFactor(i: number) {
    const w = this.wheelDmg[i];
    return w.detached ? 0 : 1 - Math.min(0.45, 1.6 * Math.abs(w.camber));
  }

  get undrivable() {
    return this.wheelDmg.some((w) => w.detached || Math.abs(w.toe) > WHEEL_DAMAGE.maxToe || w.camber > WHEEL_DAMAGE.maxCamber);
  }

  /**
   * Distribute an impact to the wheels near the contact point (x forward, y left, push direction
   * (dx, dy) into the car). Local energy bends a wheel: the push's moment about the wheel centre sets
   * the toe direction; enough energy tears the wheel off (crash structures are designed for it, so
   * it does not get driven into the footwell). Returns the wheels that came off.
   */
  damageWheels(x: number, y: number, dx: number, dy: number, energyJ: number): number[] {
    const off: number[] = [];
    for (let i = 0; i < 4; i++) {
      const w = this.wheelDmg[i];
      if (w.detached) continue;
      const dist = Math.hypot(CORNER_X[i] - x, CORNER_Y[i] - y);
      const local = energyJ * Math.max(0, 1 - dist / WHEEL_DAMAGE.reach);
      if (local < 1500) continue;
      if (local > WHEEL_DAMAGE.detachJ) { w.detached = true; off.push(i); continue; }
      const bend = local / WHEEL_DAMAGE.bendJ;
      const moment = (x - CORNER_X[i]) * dy - (y - CORNER_Y[i]) * dx; // r x F about the wheel centre
      const sign = Math.abs(moment) > 0.05 ? Math.sign(moment) : (i % 2 === 0 ? -1 : 1);
      w.toe = clamp(w.toe + sign * bend * 0.8, -0.35, 0.35);
      w.camber = Math.min(0.35, w.camber + bend);
      w.runout = Math.min(0.15, w.runout + bend * 0.4);
      w.drag = Math.min(0.3, w.drag + bend);
    }
    this.damaged = this.wheelDmg.some((w) => w.detached || w.toe !== 0 || w.camber !== 0);
    if (!this.crashed && this.undrivable) { this.crashed = true; this.event = 'crash'; }
    return off;
  }

  /** record an impact from any source (barrier, another car): damage bookkeeping + wheels */
  registerImpact(im: Omit<Impact, 'wrecked' | 'detached'>): Impact {
    const before = this.crashed;
    this.damageJ += im.energyJ;
    if (!this.crashed && this.damageJ > BARRIER.wreckJ) { this.crashed = true; this.event = 'crash'; }
    const detached = this.damageWheels(im.x, im.yL, im.nx, im.nyL, im.energyJ);
    const full: Impact = { ...im, detached, wrecked: !before && this.crashed };
    this.impacts.push(full);
    if (this.impacts.length > 32) this.impacts.shift();
    return full;
  }

  /** an impulse [N s] in the road frame (s, d) at a point r (road frame, from the CG) */
  applyImpulse(jS: number, jD: number, rS: number, rD: number) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    this.v += (jS * cy + jD * sy) / CAR.mass;
    this.lateralSpeed += (-jS * sy + jD * cy) / CAR.mass;
    this.yawRate += (rS * jD - rD * jS) / CAR.yawInertia;
  }

  /** positional correction after a contact (road frame) */
  shift(dS: number, dD: number) {
    this.s = road.wrap(this.s + dS);
    this.lane.d += dD;
  }

  /** road-frame velocity of the CG */
  roadVelocity(): [number, number] {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    return [this.v * cy - this.lateralSpeed * sy, this.v * sy + this.lateralSpeed * cy];
  }

  /**
   * Rigid-body contact of the four body corners with the Armco (see Barrier.ts). Forces act at the
   * corners, so a hit decelerates, rebounds and spins the car; nothing is clamped or zeroed.
   */
  private barrierContact(dt: number, dsdt: number) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const vS = this.v * cy - this.lateralSpeed * sy; // CG velocity in the road frame
    const vD = this.v * sy + this.lateralSpeed * cy;
    const w = this.yawRate - road.curvature(this.s) * dsdt; // body rotation relative to the rail
    let fS = 0, fD = 0, tau = 0;
    for (let i = 0; i < 4; i++) {
      const [x, y] = BODY_CORNERS[i];
      const rS = x * cy - y * sy, rD = x * sy + y * cy;
      const dc = this.d + rD;
      const side = dc >= 0 ? 1 : -1;
      const pen = Math.abs(dc) - TRACK_CFG.armcoD;
      const c = this.contact[i];
      if (pen <= 0) { c.on = false; continue; }
      const vcS = vS - w * rD, vcD = vD + w * rS; // corner velocity
      const penRate = side * vcD;
      const mEff = 1 / (1 / CAR.mass + (rS * rS) / CAR.yawInertia); // effective mass along the rail normal
      if (!c.on) { c.on = true; c.vn0 = Math.max(0, penRate); c.peak = 0; c.emitted = false; }
      c.peak = Math.max(c.peak, pen);
      // elastic-plastic: load along K_EFF, unload along K_UNLOAD towards the permanent set
      const elastic = pen >= c.peak ? K_EFF * pen : Math.max(0, K_UNLOAD * (pen - BARRIER.plastic * c.peak));
      const damp = 2 * BARRIER.zeta * Math.sqrt(K_EFF * mEff);
      const fn = Math.max(0, elastic + (elastic > 0 ? damp * penRate : 0) + (pen > BARRIER.maxPen ? BARRIER.kStop * (pen - BARRIER.maxPen) : 0));
      const ft = -BARRIER.mu * fn * Math.tanh(vcS / 0.3);
      const fdi = -side * fn;
      fS += ft; fD += fdi;
      tau += rS * fdi - rD * ft;
      // report the impact once, at peak penetration
      if (!c.emitted && penRate <= 0.05 && c.vn0 > 0.3) {
        c.emitted = true;
        const energyJ = 0.5 * mEff * c.vn0 * c.vn0 * (1 - RESTITUTION * RESTITUTION);
        const share = BARRIER.kRail / (BARRIER.kRail + BARRIER.kBody);
        this.registerImpact({
          corner: i, x, yL: y, nx: -side * sy, nyL: -side * cy, normalSpeed: c.vn0, energyJ,
          penetration: c.peak, bodyCrush: c.peak * BARRIER.plastic * share, railBend: c.peak * BARRIER.plastic * (1 - share),
          s: road.wrap(this.s + rS), side, slideSpeed: vcS, vS, vD, kind: 'barrier', nS: 0, nD: -side,
        });
      }
    }
    if (fS === 0 && fD === 0) return;
    this.v += ((fS * cy + fD * sy) / CAR.mass) * dt;
    this.lateralSpeed += ((-fS * sy + fD * cy) / CAR.mass) * dt;
    this.yawRate += (tau / CAR.yawInertia) * dt;
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
      // A sliding car's centre may still be inside the crash limit while a yawed corner already reaches
      // past the Armco, where the terrain falls away. The barrier is in the way, so never sample the
      // ground behind it: otherwise that wheel hangs at full droop and visibly floats in the air.
      const h = road.height(si, clamp(di, -TRACK_CFG.armcoD, TRACK_CFG.armcoD));
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
    const v = Math.abs(this.v); // speed magnitude (the car may slide backwards after a spin)
    const dir = this.v < 0 ? -1 : 1;
    // A wrecked car has no drive and drags to a stop on damaged wheels.
    if (this.crashed && !settling) inp = { ...inp, throttle: 0, brake: Math.max(inp.brake, 0.5) };

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
    for (let i = 0; i < 4; i++) this.susp.detached[i] = this.wheelDmg[i].detached;
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
      const vref = Math.max(Math.abs(this.v), 2.5);
      let sumFx = 0;
      this.dmgYaw = 0;
      for (let i = 0; i < 4; i++) {
        const wd = this.wheelDmg[i];
        if (wd.detached) {
          // no wheel: the upright skids; Coulomb friction opposes the corner's sliding velocity
          const uc = this.v - this.yawRate * CORNER_Y[i], wc = this.lateralSpeed + this.yawRate * CORNER_X[i];
          const vc = Math.hypot(uc, wc);
          const fxs = vc > 0.05 ? SKID_MU * this.susp.ft[i] * uc / vc : 0;
          this.fx[i] = fxs; this.slip[i] = 0; this.omega[i] = 0;
          sumFx += fxs;
          this.dmgYaw += CORNER_Y[i] * fxs;
          continue;
        }
        const fz = this.susp.ft[i] * this.gripFactor(i);
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
        const g0 = (fxi * CAR.wheelRadius + TD) / CAR.wheelInertia;
        const gp = (CAR.wheelRadius / CAR.wheelInertia) * dFdw;
        // Brake torque is friction: it slows the wheel towards zero in either direction but never reverses it.
        const free = this.omega[i] + (h * g0) / (1 - h * gp);
        // a bent wheel rubs on its arch / broken suspension: extra friction torque on that wheel only
        const dwBrake = (h * (brake.torque[i] + 8000 * wd.drag) / CAR.wheelInertia) / (1 - h * gp);
        const wn = Math.abs(free) <= dwBrake ? 0 : free - Math.sign(free) * dwBrake;
        this.omega[i] = wn;
        sumFx += fxi;
        if (this.damaged) this.dmgYaw += CORNER_Y[i] * fxi; // left/right force difference yaws the car
        // disc heat
        const pw = brake.torque[i] * Math.abs(this.omega[i]);
        const cool = 12 + 0.9 * Math.abs(this.v);
        this.discTemp[i] += (h * (pw / 3500)) - h * ((this.discTemp[i] - 25) * cool) / 3500;
        this.spin[i] += this.omega[i] * h;
      }
      const rolling = this.susp.airborne ? 0 : CAR.rolling * CAR.mass * G;
      const offRoadDrag = this.offRoad ? 3.5 * CAR.mass : 0;
      const moving = Math.abs(this.v) > 0.05;
      const aT = (-sumFx - dir * (drag + (moving ? rolling + offRoadDrag : 0))) / CAR.mass;
      this.axFelt = aT;
      this.v += h * (aT - G * ft.sinS);
      // Auto hold (as on the real EV): a car creeping backwards at walking pace with no throttle and
      // nothing pushing it is held, instead of rolling back down a gradient.
      if (this.v < 0 && this.v > -0.5 && inp.throttle < 0.02 && Math.abs(this.lateralSpeed) < 0.5 && !this.contact.some((c) => c.on)) {
        this.v = 0; for (let i = 0; i < 4; i++) this.omega[i] = Math.max(0, this.omega[i]);
      }
      // Static friction: stop without a low-speed slip limit cycle; hold on a gradient.
      if (Math.abs(this.v) < 0.12 && inp.brake > 0.05 && brake.torque.reduce((a,b) => a+b,0) / CAR.wheelRadius > CAR.mass * G * Math.abs(ft.sinS)) {
        this.v = 0; this.omega.fill(0); this.slip.fill(0);
      }
      if (settling) { this.v = 0; this.omega.fill(0); }
      else this.lateralStep(h);
    }
    this.rPrev = r;

    // Integrate the actual heading and lateral velocity in track coordinates. Near the Armco the pose and
    // the stiff barrier contact are integrated together in sub-steps (stable for the elastic-plastic rail).
    if (!settling) {
      const reach = Math.hypot(2.65, 1.03) + Math.hypot(this.v, this.lateralSpeed) * dt;
      const n = Math.abs(this.d) + reach > TRACK_CFG.armcoD ? 10 : 1;
      const h = dt / n;
      const dd0 = this.lane.dd;
      for (let k = 0; k < n; k++) {
        const forward = this.v * Math.cos(this.yaw) - this.lateralSpeed * Math.sin(this.yaw);
        const lateral = this.v * Math.sin(this.yaw) + this.lateralSpeed * Math.cos(this.yaw);
        const dsdt = forward / Math.max(0.25, 1 - road.curvature(this.s) * this.d);
        this.yaw += (this.yawRate - road.curvature(this.s) * dsdt) * h;
        this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
        this.lane.dd = lateral;
        this.lane.d += lateral * h;
        this.s = road.wrap(this.s + dsdt * h);
        this.distance += Math.hypot(this.v, this.lateralSpeed) * h;
        if (n > 1) this.barrierContact(h, dsdt);
      }
      this.lane.ddd = (this.lane.dd - dd0) / dt;
      this.offRoad = Math.abs(this.d) > TRACK_CFG.curbOuter;
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

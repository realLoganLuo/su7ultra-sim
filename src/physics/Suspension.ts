// Four-corner suspension model with body heave / roll / pitch (3 DOF) and four unsprung hubs.
// Everything is expressed in a road-aligned frame: n = road normal, "apparent gravity" gn
// carries banking, crest / dip curvature and centripetal load.
//
// Corner order: 0 FL, 1 FR, 2 RL, 3 RR.  x forward, y LEFT-positive.
// Body attach height a_i = q + phi*y_i - theta*x_i, so phi > 0 = body rolls to the RIGHT,
// theta > 0 = nose down.
import { CAR, SUSP, G } from '../config';

export const CORNER_X = [CAR.xFront, CAR.xFront, CAR.xRear, CAR.xRear];
export const CORNER_Y = [CAR.halfTrack, -CAR.halfTrack, CAR.halfTrack, -CAR.halfTrack];

const frontFrac = -CAR.xRear / CAR.wheelbase; // weight share on the front axle (0.48)
export const SPRUNG_CORNER = [
  (CAR.sprungMass * frontFrac) / 2,
  (CAR.sprungMass * frontFrac) / 2,
  (CAR.sprungMass * (1 - frontFrac)) / 2,
  (CAR.sprungMass * (1 - frontFrac)) / 2,
];

/** static tyre deflection per corner: wheel centre sits R - deflection above the road so the contact patch is exactly on it */
export const STATIC_DEFLECT = SPRUNG_CORNER.map((m) => ((m + CAR.unsprungMass) * G) / SUSP.kTire);

/** how far a corner drops without its wheel before the upright touches the road [m], and that contact */
export const SKID_DROP = 0.14;
const SKID_K = 250000, SKID_C = 8000;

export interface SuspInput {
  r: number[]; // road height relative to the reference plane, per corner
  rd: number[]; // rate of r
  gn: number; // apparent normal gravity
  ay: number; // lateral acceleration in road frame (+ left)
  ax: number; // longitudinal specific force (+ forward)
  dfFront: number; // aero downforce on the front axle [N]
  dfRear: number;
  actCmd: number[]; // commanded actuator force per corner [N], + pushes body up
}

export class SuspensionModel {
  q = 0; qd = 0;
  phi = 0; phid = 0;
  theta = 0; thetad = 0;
  u = [0, 0, 0, 0];
  ud = [0, 0, 0, 0];
  fAct = [0, 0, 0, 0];
  // outputs
  ft = SPRUNG_CORNER.map((m) => (m + CAR.unsprungMass) * G); // tire normal force
  fSpring = [0, 0, 0, 0];
  fDamper = [0, 0, 0, 0];
  comp = [0, 0, 0, 0]; // compression x_i [m]
  compRate = [0, 0, 0, 0];
  airborne = false;
  /** corner has lost its wheel: no spring / tyre, the upright and body corner skid on the road */
  detached = [false, false, false, false];

  reset() {
    this.q = this.qd = this.phi = this.phid = this.theta = this.thetad = 0;
    this.u.fill(0); this.ud.fill(0); this.fAct.fill(0);
    this.detached.fill(false);
    this.ft = SPRUNG_CORNER.map((m) => (m + CAR.unsprungMass) * G);
  }

  step(dt: number, inp: SuspInput) {
    const { k, c, kTire, cTire } = SUSP;
    const mu = CAR.unsprungMass;
    const ms = CAR.sprungMass;
    const alpha = 1 - Math.exp(-dt * 2 * Math.PI * SUSP.actBandwidthHz);
    let sumF = 0, sumFy = 0, sumFx = 0;
    let anyContact = false;
    for (let i = 0; i < 4; i++) {
      const x = CORNER_X[i], y = CORNER_Y[i];
      const a = this.q + this.phi * y - this.theta * x;
      const ad = this.qd + this.phid * y - this.thetad * x;
      if (this.detached[i]) {
        // No wheel: the corner is unsupported until the upright / brake disc reaches the road
        // (~SKID_DROP below its normal ride height); then a stiff ground contact carries it.
        const pen = inp.r[i] - a - SKID_DROP, penD = inp.rd[i] - ad;
        let fsk = pen > 0 ? SKID_K * pen + SKID_C * penD : 0;
        if (fsk < 0) fsk = 0; else if (pen > 0) anyContact = true;
        this.ft[i] = fsk;
        this.u[i] = a; this.ud[i] = ad;
        this.comp[i] = 0; this.compRate[i] = 0; this.fSpring[i] = 0; this.fDamper[i] = 0; this.fAct[i] = 0;
        const fb = fsk - (i < 2 ? inp.dfFront / 2 : inp.dfRear / 2);
        sumF += fb; sumFy += fb * y; sumFx += fb * x;
        continue;
      }
      const xc = this.u[i] - a;
      const xcd = this.ud[i] - ad;
      this.comp[i] = xc;
      this.compRate[i] = xcd;
      const cd = xcd > 0 ? c * 0.8 : c * 1.2;
      let fs = k * xc;
      const fdm = cd * xcd;
      let fstop = 0;
      if (xc > SUSP.bumpTravel) fstop += SUSP.stopK * (xc - SUSP.bumpTravel) + 0.5 * SUSP.stopK * 0.0;
      if (xc < -SUSP.droopTravel) fstop += SUSP.stopK * (xc + SUSP.droopTravel);
      // actuator (bandwidth limited, force limited)
      const cmd = Math.max(-SUSP.actMax, Math.min(SUSP.actMax, inp.actCmd[i]));
      this.fAct[i] += (cmd - this.fAct[i]) * alpha;
      fs += fstop;
      this.fSpring[i] = fs;
      this.fDamper[i] = fdm;
      const pre = SPRUNG_CORNER[i] * G;
      const fSusp = pre + fs + fdm + this.fAct[i];
      // tire
      const delta = inp.r[i] - this.u[i];
      const deltaD = inp.rd[i] - this.ud[i];
      const n0 = (SPRUNG_CORNER[i] + mu) * G;
      const compression = n0 / kTire + delta;
      let ft = compression > 0 ? kTire * compression + cTire * deltaD : 0;
      if (ft < 0) ft = 0;
      else anyContact = true;
      this.ft[i] = ft;
      // hub
      this.ud[i] += (dt * (ft - fSusp - mu * inp.gn)) / mu;
      const dfi = i < 2 ? inp.dfFront / 2 : inp.dfRear / 2;
      const fb = fSusp - dfi;
      sumF += fb;
      sumFy += fb * y;
      sumFx += fb * x;
    }
    this.airborne = !anyContact;
    // body
    this.qd += (dt * (sumF - ms * inp.gn)) / ms;
    this.phid += (dt * (sumFy + ms * inp.ay * CAR.rollArm)) / CAR.Ix;
    this.thetad += (dt * (-sumFx - ms * inp.ax * CAR.pitchArm)) / CAR.Iy;
    this.q += dt * this.qd;
    this.phi += dt * this.phid;
    this.theta += dt * this.thetad;
    for (let i = 0; i < 4; i++) this.u[i] += dt * this.ud[i];
    // hard limits for numerical safety
    this.phi = Math.max(-0.5, Math.min(0.5, this.phi));
    this.theta = Math.max(-0.35, Math.min(0.35, this.theta));
    this.q = Math.max(-0.4, Math.min(0.4, this.q));
  }
}

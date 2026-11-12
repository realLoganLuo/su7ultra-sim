// Full active suspension controller: anti-roll, anti-pitch, road preview and speed-dependent ride height.
import { CAR, SUSP, G } from '../config';
import { CORNER_X, CORNER_Y, SuspensionModel } from './Suspension';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface PreviewSample {
  tDue: number;
  gn: number;
  r: number[]; // road height rel. plane at the corner positions D metres ahead
  rd: number[];
}

export interface ActiveParams {
  antiRoll: number; // fraction of roll moment compensated (0.8)
  antiPitch: number; // fraction of pitch moment compensated
  previewGain: number;
}

export const ACTIVE_DEFAULT: ActiveParams = { antiRoll: 0.8, antiPitch: 0.8, previewGain: 0.85 };

// pseudo-inverse of the 3 x 4 allocation matrix  A = [1; y; -x]
const A = [CORNER_X.map(() => 1), CORNER_Y.slice(), CORNER_X.map((x) => -x)];
function alloc(): number[][] {
  // M = A A^T (3x3), then F = A^T M^-1 Q
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let i = 0; i < 4; i++) M[r][c] += A[r][i] * A[c][i];
  const det =
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const inv = [
    [(M[1][1] * M[2][2] - M[1][2] * M[2][1]) / det, (M[0][2] * M[2][1] - M[0][1] * M[2][2]) / det, (M[0][1] * M[1][2] - M[0][2] * M[1][1]) / det],
    [(M[1][2] * M[2][0] - M[1][0] * M[2][2]) / det, (M[0][0] * M[2][2] - M[0][2] * M[2][0]) / det, (M[0][2] * M[1][0] - M[0][0] * M[1][2]) / det],
    [(M[1][0] * M[2][1] - M[1][1] * M[2][0]) / det, (M[0][1] * M[2][0] - M[0][0] * M[2][1]) / det, (M[0][0] * M[1][1] - M[0][1] * M[1][0]) / det],
  ];
  // P[i][r] = sum_c A[c][i] * inv[c][r]
  const P: number[][] = [];
  for (let i = 0; i < 4; i++) {
    P.push([0, 1, 2].map((r) => A[0][i] * inv[0][r] + A[1][i] * inv[1][r] + A[2][i] * inv[2][r]));
  }
  return P;
}
const ALLOC = alloc();

export class ActiveSuspension {
  params = { ...ACTIVE_DEFAULT };
  private queue: PreviewSample[] = [];
  private cur: PreviewSample = { tDue: 0, gn: G, r: [0, 0, 0, 0], rd: [0, 0, 0, 0] };
  cmd = [0, 0, 0, 0];
  lastPreviewDist = 5;
  // telemetry
  qRoll = 0; qPitch = 0; qHeave = 0;

  reset() {
    this.queue.length = 0;
    this.cur = { tDue: 0, gn: G, r: [0, 0, 0, 0], rd: [0, 0, 0, 0] };
    this.cmd.fill(0);
  }

  pushPreview(s: PreviewSample) {
    this.queue.push(s);
  }

  /** speed [m/s]; returns preview distance in 5..15 m */
  previewDistance(v: number) {
    return (this.lastPreviewDist = Math.max(5, Math.min(15, v * 0.22)));
  }

  update(t: number, susp: SuspensionModel, v: number, ay: number, ax: number): number[] {
    // pop due preview samples
    while (this.queue.length && this.queue[0].tDue <= t) this.cur = this.queue.shift()!;
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 200);
    const ms = CAR.sprungMass;
    const p = this.params;
    // when the wheels are (nearly) off the ground the actuators cannot do anything useful: fade out
    const load = (susp.ft[0] + susp.ft[1] + susp.ft[2] + susp.ft[3]) / (CAR.mass * G);
    const grounded = smooth(0.02, 0.3, load);
    // --- generalised force demands ---
    // anti-roll (feed-forward on lateral specific force + roll feedback)
    let Qphi = (-p.antiRoll * ms * ay * CAR.rollArm - (75000 * susp.phi + 9000 * susp.phid)) * grounded;
    // anti-pitch
    let Qtheta = (p.antiPitch * ms * ax * CAR.pitchArm - (60000 * susp.theta + 7000 * susp.thetad)) * grounded;
    // heave: skyhook damping + speed dependent ride height + preview of normal load (compression / dip)
    const qTarget = -0.022 * smooth(25, 85, v);
    const dg = this.cur.gn - G;
    let Qq = (-9000 * susp.qd - 70000 * (susp.q - qTarget)) * grounded + p.previewGain * ms * (dg > 0 ? dg : 0);
    this.qRoll = Qphi; this.qPitch = Qtheta; this.qHeave = Qq;
    // allocate to corners
    for (let i = 0; i < 4; i++) {
      let f = ALLOC[i][0] * Qq + ALLOC[i][1] * Qphi + ALLOC[i][2] * Qtheta;
      // corner road preview: cancel the force the spring/damper would transmit when the wheel arrives
      const ff = -p.previewGain * (SUSP.k * this.cur.r[i] + SUSP.c * this.cur.rd[i]) * grounded;
      f += Math.max(-3500, Math.min(3500, ff));
      // little hub-damping help: skyhook per corner
      this.cmd[i] = Math.max(-SUSP.actMax, Math.min(SUSP.actMax, f));
    }
    return this.cmd;
  }
}

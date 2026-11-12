// Analytic body surface for the predicted SU7 Ultra (gen 2).
// Car coordinates: +X forward, +Y up, +Z right, origin at CG footprint (ground level).
// "xd" is a design coordinate from the tail (0) to the nose (5.115).
import * as THREE from 'three';

export const BODY_LEN = 5.115;
export const XD_OFFSET = 2.54; // x = xd - XD_OFFSET  (front axle at xd=4.10 -> x=+1.56)

/** Monotone cubic interpolation (Fritsch-Carlson) over keyframes. */
export class Curve1D {
  private xs: number[];
  private ys: number[];
  private ms: number[];
  constructor(pts: [number, number][]) {
    this.xs = pts.map((p) => p[0]);
    this.ys = pts.map((p) => p[1]);
    const n = pts.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]));
    const m: number[] = new Array(n).fill(0);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
      } else {
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
          const t = 3 / Math.sqrt(s);
          m[i] = t * a * d[i];
          m[i + 1] = t * b * d[i];
        }
      }
    }
    this.ms = m;
  }
  at(x: number): number {
    const { xs, ys, ms } = this;
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * ms[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * ms[i + 1]
    );
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const yTopC = new Curve1D([
  [0.0, 0.8], [0.1, 0.88], [0.35, 0.97], [0.8, 1.08], [1.3, 1.23], [1.8, 1.35], [2.3, 1.44],
  [2.65, 1.465], [2.95, 1.445], [3.35, 1.26], [3.8, 1.0], [4.1, 0.95], [4.5, 0.86], [4.85, 0.72], [5.115, 0.54],
]);
const yBeltC = new Curve1D([
  [0.0, 0.78], [0.4, 0.9], [1.2, 0.92], [2.2, 0.9], [3.0, 0.89], [3.8, 0.88], [4.3, 0.82], [4.8, 0.68], [5.115, 0.5],
]);
const yBotC = new Curve1D([
  [0.0, 0.36], [0.25, 0.22], [0.55, 0.12], [1.0, 0.1], [3.9, 0.1], [4.4, 0.09], [4.8, 0.09], [5.115, 0.14],
]);
// wide-body: strongly flared front and rear fenders, narrow waist between the axles
const wMaxC = new Curve1D([
  [0.0, 0.7], [0.3, 0.83], [0.7, 0.95], [1.1, 0.99], [1.6, 0.985], [2.1, 0.93], [2.7, 0.905], [3.3, 0.925], [3.7, 0.98],
  [4.1, 0.99], [4.5, 0.98], [4.9, 0.88], [5.115, 0.66],
]);

export interface Section {
  y0: number; y1: number; y2: number; yc: number; // yc: centre-line top height
  w0: number; w1: number; w2: number;
}

const CROWN = 0.03;

export function section(xd: number): Section {
  let yTop = yTopC.at(xd);
  const yBelt = yBeltC.at(xd);
  yTop = Math.max(yTop, yBelt + CROWN + 0.02);
  let y0 = yBotC.at(xd);
  let y1 = yBelt;
  const cabin = smooth(0.08, 0.35, yTop - yBelt);
  const crown = -0.022 + 0.052 * cabin;
  let y2 = yTop - crown;
  const w1m = wMaxC.at(xd);
  const tumble = 0.2 + 0.17 * cabin;
  let w1 = w1m;
  let w2 = w1m - tumble;
  let w0 = w1m - 0.08;
  // end rounding
  let e = 1;
  if (xd > 4.55) {
    const t = Math.min(1, (xd - 4.55) / (BODY_LEN - 4.55));
    e = Math.pow(1 - Math.pow(t, 2.3), 1 / 2.3);
  } else if (xd < 0.3) {
    const t = Math.min(1, (0.3 - xd) / 0.3);
    e = Math.pow(1 - Math.pow(t, 2.2), 1 / 2.2);
  }
  if (e < 1) {
    const eh = Math.pow(e, 0.75);
    const mid = (y0 + y2 + CROWN) / 2;
    y0 = mid + (y0 - mid) * eh;
    y1 = mid + (y1 - mid) * eh;
    y2 = mid + (y2 - mid) * eh;
    w0 *= e; w1 *= e; w2 *= e;
  }
  w0 = Math.max(w0, 0.003); w1 = Math.max(w1, 0.004); w2 = Math.max(w2, 0.003);
  return { y0, y1, y2, yc: y2 + crown * Math.min(1, e * 1.2), w0, w1, w2 };
}

const P_BOT = 0.12;
const P_LOW = 0.42;
const P_UP = 0.8;

function spow(a: number, e: number) { return Math.pow(Math.max(0, a), e); }

/** right-side profile at p in [0,1]: returns [y, z] (z >= 0). */
export function profile(sec: Section, p: number): [number, number] {
  const { y0, y1, y2, yc, w0, w1, w2 } = sec;
  if (p <= P_BOT) return [y0, w0 * (p / P_BOT)];
  if (p <= P_LOW) {
    const b = ((p - P_BOT) / (P_LOW - P_BOT)) * (Math.PI / 2); // 0..pi/2
    const ca = Math.sin(b); // 0 -> 1 : z grows
    const sa = Math.cos(b); // 1 -> 0 : y rises
    const z = w0 + (w1 - w0) * spow(ca, 2 / 2.4);
    const y = y1 - (y1 - y0) * spow(sa, 2 / 2.4);
    return [y, z];
  }
  if (p <= P_UP) {
    const b = ((p - P_LOW) / (P_UP - P_LOW)) * (Math.PI / 2);
    const z = w2 + (w1 - w2) * spow(Math.cos(b), 2 / 2.2);
    const y = y1 + (y2 - y1) * spow(Math.sin(b), 2 / 2.2);
    return [y, z];
  }
  const u = (p - P_UP) / (1 - P_UP);
  const z = w2 * (1 - u);
  const y = y2 + (yc - y2) * (1 - (1 - u) * (1 - u));
  return [y, z];
}

/** Ring parameter q in [0,2]: 0 = bottom centre, ->1 over the right side to the top centre, ->2 down the left side. */
export function surface(xd: number, q: number, out = new THREE.Vector3()): THREE.Vector3 {
  const sec = section(xd);
  const right = q <= 1;
  const p = right ? q : 2 - q;
  const [y, z] = profile(sec, p);
  return out.set(xd - XD_OFFSET, y, right ? z : -z);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Outward unit normal by finite differences. */
export function surfaceNormal(xd: number, q: number, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = 0.01;
  const dq = 0.004;
  const x0 = Math.min(Math.max(xd, dx), BODY_LEN - dx);
  surface(x0 + dx, q, _a).sub(surface(x0 - dx, q, _b));
  const q0 = Math.min(Math.max(q, dq), 2 - dq);
  surface(x0, q0 + dq, _c).sub(surface(x0, q0 - dq, _d));
  // ring runs bottom -> right -> top, so (dx x dq) points outward on the right side
  out.crossVectors(_c, _a);
  if (out.lengthSq() < 1e-14) return out.set(0, 1, 0);
  out.normalize();
  // fix orientation: should point away from centre
  const s = surface(x0, q0, _b);
  const centre = _d.set(s.x, (section(x0).y0 + section(x0).yc) / 2, 0);
  if (out.dot(_a.copy(s).sub(centre)) < 0) out.negate();
  return out;
}

// ---- point-in-section test & projection of fascia details ----

function ringPoints(xd: number, n = 72): [number, number][] {
  const pts: [number, number][] = [];
  const sec = section(xd);
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    pts.push(profile(sec, p));
  }
  return pts; // right half (y, z); mirrored by symmetry
}

function insideSection(xd: number, y: number, z: number): boolean {
  const pts = ringPoints(xd, 60);
  const az = Math.abs(z);
  // polygon: right half profile from bottom centre (z=0) over the top back to z=0
  let inside = false;
  const poly: [number, number][] = pts.map(([yy, zz]) => [zz, yy]);
  // close along centreline
  poly.push([0, poly[poly.length - 1][1]]);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [zi, yi] = poly[i];
    const [zj, yj] = poly[j];
    if (yi > y !== yj > y && az < ((zj - zi) * (y - yi)) / (yj - yi) + zi) inside = !inside;
  }
  return inside;
}

/** x (car coords) of the front surface at height y, lateral z. Returns null if nothing is hit. */
export function projectFront(y: number, z: number): { x: number; xd: number } | null {
  let lo = 3.8;
  let hi = BODY_LEN;
  if (!insideSection(lo, y, z)) return null;
  if (insideSection(hi - 1e-4, y, z)) return { x: hi - XD_OFFSET, xd: hi };
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (insideSection(mid, y, z)) lo = mid; else hi = mid;
  }
  return { x: lo - XD_OFFSET, xd: lo };
}

export function projectRear(y: number, z: number): { x: number; xd: number } | null {
  let hi = 1.6; // inside
  let lo = 0;
  if (!insideSection(hi, y, z)) return null;
  if (insideSection(lo + 1e-4, y, z)) return { x: lo - XD_OFFSET, xd: lo };
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (insideSection(mid, y, z)) hi = mid; else lo = mid;
  }
  return { x: hi - XD_OFFSET, xd: hi };
}

/** Approximate outward normal of the front/rear fascia at a projected point (numeric). */
export function fasciaNormal(xd: number, y: number, z: number, front: boolean): THREE.Vector3 {
  const e = 0.02;
  const f = (yy: number, zz: number) => {
    const r = front ? projectFront(yy, zz) : projectRear(yy, zz);
    return r ? r.xd : (front ? 3.8 : 1.6);
  };
  const dxdy = (f(y + e, z) - f(y - e, z)) / (2 * e);
  const dxdz = (f(y, z + e) - f(y, z - e)) / (2 * e);
  // surface x = X(y,z); outward normal ~ (±1, -dX/dy, -dX/dz)
  const n = front ? new THREE.Vector3(1, -dxdy, -dxdz) : new THREE.Vector3(-1, dxdy, dxdz);
  return n.normalize();
}

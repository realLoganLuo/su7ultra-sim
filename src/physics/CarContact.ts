// Car-to-car collisions in the road plane: two rigid rectangles, impulse-based contact.
//
// Detection: a corner of one body inside the other; the shallowest exit face gives the normal and depth.
// Response: the standard rigid-body impulse at the contact point with restitution (crumpling cars are
// mostly plastic, e ~ 0.2) and Coulomb friction (bodywork sliding on bodywork, mu ~ 0.3), so linear and
// angular momentum are conserved and an off-centre hit spins either car. The overlap is then removed
// in proportion to the inverse masses. Lost kinetic energy is the deformation energy of both cars.

export const CAR_CONTACT = { restitution: 0.2, mu: 0.3, kBody: 1.0e6 };

/** state of one body in the local road frame (s along the road, d to the left), angles from the road tangent */
export interface RigidState {
  s: number; d: number; yaw: number;
  vS: number; vD: number; w: number; // CG velocity and yaw rate
  m: number; I: number;
  hx: number; hy: number; cx: number; // rectangle half extents, rectangle centre ahead of the CG
}

export interface CarHit {
  /** contact normal (road frame) pointing from B into A, i.e. the direction A is pushed */
  nS: number; nD: number;
  /** contact point relative to each CG (road frame) */
  rAS: number; rAD: number; rBS: number; rBD: number;
  pen: number;
  /** impulse on A along the normal / tangent [N s], and the kinetic energy turned into deformation [J] */
  jn: number; jt: number; energyJ: number;
  /** normal closing speed and tangential sliding speed at the contact [m/s] */
  closing: number; sliding: number;
}

function corners(b: RigidState, ox: number) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const cs = ox + b.cx * c, cd = b.d + b.cx * s;
  const out: [number, number][] = [];
  for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) out.push([cs + x * b.hx * c - y * b.hy * s, cd + x * b.hx * s + y * b.hy * c]);
  return out;
}

interface Pt { pen: number; pS: number; pD: number; nS: number; nD: number }

/** every corner of `a` inside `b`, each with the normal of b's nearest face (pushes `a` out of `b`) */
function inside(a: RigidState, aS: number, b: RigidState, bS: number, flip: boolean, out: Pt[]) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const bcS = bS + b.cx * c, bcD = b.d + b.cx * s;
  for (const [pS, pD] of corners(a, aS)) {
    const qx = (pS - bcS) * c + (pD - bcD) * s, qy = -(pS - bcS) * s + (pD - bcD) * c;
    const px = b.hx - Math.abs(qx), py = b.hy - Math.abs(qy);
    if (px <= 0 || py <= 0) continue;
    const lx = px < py ? Math.sign(qx) || 1 : 0, ly = px < py ? 0 : Math.sign(qy) || 1;
    const nS = lx * c - ly * s, nD = lx * s + ly * c;
    out.push({ pen: Math.min(px, py), pS, pD, nS: flip ? -nS : nS, nD: flip ? -nD : nD });
  }
}

/**
 * Resolve contact between A and B (both mutated: velocities and positions). `ds` is B.s - A.s wrapped
 * to the short way round the lap. Returns the hit, or null if they do not touch or are separating.
 */
export function collide(A: RigidState, B: RigidState, ds: number): CarHit | null {
  if (Math.abs(ds) > A.hx + B.hx + 2 || Math.abs(B.d - A.d) > A.hx + B.hx + 2) return null;
  // contact manifold: all penetrating corners; the deepest sets the normal, and every corner pushing
  // along (nearly) the same normal shares the contact point, so a square rear-end pushes straight
  const pts: Pt[] = [];
  inside(A, 0, B, ds, false, pts); // A's corners inside B: push A along B's face normal
  inside(B, ds, A, 0, true, pts); // B's corners inside A: push A against A's face normal
  if (!pts.length) return null;
  const top = pts.reduce((x, y) => (y.pen > x.pen ? y : x));
  const nS = top.nS, nD = top.nD, pen = top.pen;
  let wSum = 0, pS = 0, pD = 0;
  for (const q of pts) {
    if (q.nS * nS + q.nD * nD < 0.9 || q.pen < 0.3 * pen) continue;
    wSum += q.pen; pS += q.pS * q.pen; pD += q.pD * q.pen;
  }
  pS /= wSum; pD /= wSum;
  const rAS = pS, rAD = pD - A.d, rBS = pS - ds, rBD = pD - B.d;
  // velocity of the contact point on each body, relative
  const vAS = A.vS - A.w * rAD, vAD = A.vD + A.w * rAS;
  const vBS = B.vS - B.w * rBD, vBD = B.vD + B.w * rBS;
  const rvS = vAS - vBS, rvD = vAD - vBD;
  const vn = rvS * nS + rvD * nD;
  // separate the overlap (inverse-mass weighted) whatever the velocities
  const invA = 1 / A.m, invB = 1 / B.m, corr = Math.max(0, pen - 0.005) * 0.8 / (invA + invB);
  A.s += nS * corr * invA; A.d += nD * corr * invA;
  B.s -= nS * corr * invB; B.d -= nD * corr * invB;
  if (vn >= 0) return null;

  const ke = () => 0.5 * A.m * (A.vS ** 2 + A.vD ** 2) + 0.5 * A.I * A.w ** 2 + 0.5 * B.m * (B.vS ** 2 + B.vD ** 2) + 0.5 * B.I * B.w ** 2;
  const ke0 = ke();
  const crossA = (x: number, y: number) => rAS * y - rAD * x; // r x d (scalar)
  const crossB = (x: number, y: number) => rBS * y - rBD * x;
  const kN = invA + invB + crossA(nS, nD) ** 2 / A.I + crossB(nS, nD) ** 2 / B.I;
  const jn = (-(1 + CAR_CONTACT.restitution) * vn) / kN;
  const tS = -nD, tD = nS;
  const vt = rvS * tS + rvD * tD;
  const kT = invA + invB + crossA(tS, tD) ** 2 / A.I + crossB(tS, tD) ** 2 / B.I;
  const jt = Math.max(-CAR_CONTACT.mu * jn, Math.min(CAR_CONTACT.mu * jn, -vt / kT));
  const JS = jn * nS + jt * tS, JD = jn * nD + jt * tD;
  A.vS += JS * invA; A.vD += JD * invA; A.w += crossA(JS, JD) / A.I;
  B.vS -= JS * invB; B.vD -= JD * invB; B.w -= crossB(JS, JD) / B.I;
  return { nS, nD, rAS, rAD, rBS, rBD, pen, jn, jt, energyJ: Math.max(0, ke0 - ke()), closing: -vn, sliding: vt };
}

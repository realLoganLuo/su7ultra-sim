import * as THREE from 'three';
import { CAR } from '../config';
import {
  BODY_LEN, XD_OFFSET, surface, surfaceNormal, profile, section, projectFront, projectRear, fasciaNormal,
} from './bodyProfile';
import { createCarMaterials, applyPaint, addArchCutouts, CarMaterials, PaintName } from './materials';
import { GlbTemplate, GlbInstance, instantiate } from './glbCar';

const V3 = THREE.Vector3;

// wheel indices: 0 FL, 1 FR, 2 RL, 3 RR
export const WHEEL_POS: { x: number; yL: number; front: boolean; left: boolean }[] = [
  { x: CAR.xFront, yL: CAR.halfTrack, front: true, left: true },
  { x: CAR.xFront, yL: -CAR.halfTrack, front: true, left: false },
  { x: CAR.xRear, yL: CAR.halfTrack, front: false, left: true },
  { x: CAR.xRear, yL: -CAR.halfTrack, front: false, left: false },
];

/** car-frame z (+right) of a wheel */
export const wheelZ = (i: number) => -WHEEL_POS[i].yL;

/** static wheel-centre height (tyre radius minus static deflection ~20 mm) */
export const WHEEL_CENTER_Y = CAR.wheelRadius - 0.02;
const ARCH_R = CAR.wheelRadius + 0.03; // 30 mm tyre-to-arch gap

type XRange = (v: number) => [number, number];

interface PatchOpts {
  mirror?: boolean;
  /** reverse u on the mirrored (left) copy so text reads correctly on both flanks */
  flipUMirror?: boolean;
  /** extra outward offset as function of (u,v) */
  bulge?: (u: number, v: number) => number;
  uvf?: (u: number, v: number) => [number, number];
}

/** Generic patch on the body surface in (xd, q) domain. u runs along xd, v along q. */
function surfacePatch(
  mat: THREE.Material, qa: number, qb: number, xr: XRange, off: number,
  nu = 14, nv = 14, opts: PatchOpts = {},
): THREE.Mesh {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const tmp = new V3();
  const nrm = new V3();
  const doOne = (flip: boolean) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const q0 = qa + (qb - qa) * v;
      const q = flip ? 2 - q0 : q0;
      const [x0, x1] = xr(v);
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const xd = x0 + (x1 - x0) * u;
        surface(xd, q, tmp);
        surfaceNormal(xd, q, nrm);
        const o = off + (opts.bulge ? opts.bulge(u, v) : 0);
        pos.push(tmp.x + nrm.x * o, tmp.y + nrm.y * o, tmp.z + nrm.z * o);
        const uu = flip && opts.flipUMirror ? 1 - u : u;
        const t = opts.uvf ? opts.uvf(uu, v) : [uu, v];
        uvs.push(t[0], t[1]);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  };
  doOne(false);
  if (opts.mirror) doOne(true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  fixWinding(g);
  return new THREE.Mesh(g, mat);
}

/** make sure triangles face outwards (test against the section centre). */
function fixWinding(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const idx = g.getIndex()!;
  const a = new V3(), b = new V3(), c = new V3(), n = new V3(), m = new V3();
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(p, idx.getX(t));
    b.fromBufferAttribute(p, idx.getX(t + 1));
    c.fromBufferAttribute(p, idx.getX(t + 2));
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const xd = m.x + XD_OFFSET;
    const sec = section(Math.min(Math.max(xd, 0.01), BODY_LEN - 0.01));
    const center = new V3(m.x, (sec.y0 + sec.yc) / 2, 0);
    if (n.dot(m.sub(center)) < 0) {
      const i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
      idx.setX(t + 1, i2);
      idx.setX(t + 2, i1);
    }
  }
  g.computeVertexNormals();
}

function fasciaPoint(front: boolean, y: number, z: number, off: number): THREE.Vector3 | null {
  const pr = front ? projectFront(y, z) : projectRear(y, z);
  if (!pr) return null;
  const n = fasciaNormal(pr.xd, y, z, front);
  return new V3(pr.x + n.x * off, y + n.y * off, z + n.z * off);
}

/** Patch on the front/rear fascia defined in (y,z) space, projected on the body surface. */
function fasciaPatch(
  mat: THREE.Material, front: boolean, y0: number, y1: number, zr: (v: number) => [number, number],
  off: number, nu = 14, nv = 10, mirror = true, uvFromZ = false,
): THREE.Mesh {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const doOne = (sgn: number) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const y = y0 + (y1 - y0) * v;
      const [za, zb] = zr(v);
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const z = (za + (zb - za) * u) * sgn;
        const p = fasciaPoint(front, y, z, off) ?? new V3(0, y, z);
        pos.push(p.x, p.y, p.z);
        uvs.push(uvFromZ ? (sgn > 0 ? u : 1 - u) : u, v);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  };
  doOne(1);
  if (mirror) doOne(-1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  fixWinding(g);
  return new THREE.Mesh(g, mat);
}

/** Strip on the fascia following control points (z, yBottom, yTop). */
function fasciaStrip(mat: THREE.Material, front: boolean, pts: [number, number, number][], seg: number, off: number, mirror = true): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const doOne = (sgn: number) => {
    const base = pos.length / 3;
    const rows: [number, number, number][] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      for (let s = 0; s < seg; s++) {
        const t = s / seg;
        rows.push([0, 1, 2].map((c) => pts[k][c] + (pts[k + 1][c] - pts[k][c]) * t) as [number, number, number]);
      }
    }
    rows.push(pts[pts.length - 1]);
    rows.forEach(([z, yb, yt]) => {
      for (const y of [yb, yt]) {
        const p = fasciaPoint(front, y, z * sgn, off) ?? new V3(0, y, z * sgn);
        pos.push(p.x, p.y, p.z);
      }
    });
    for (let r = 0; r < rows.length - 1; r++) {
      const a = base + r * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
  };
  doOne(1);
  if (mirror) doOne(-1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  fixWinding(g);
  return new THREE.Mesh(g, mat);
}

/** Tube following surface points given in (xd, q) */
function surfaceTube(mat: THREE.Material, pts: [number, number][], radius: number, off: number, mirror = true, closed = false): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const flip of mirror ? [false, true] : [false]) {
    const v: THREE.Vector3[] = pts.map(([xd, q]) => {
      const qq = flip ? 2 - q : q;
      const p = surface(xd, qq);
      const n = surfaceNormal(xd, qq);
      return p.addScaledVector(n, off);
    });
    const curve = new THREE.CatmullRomCurve3(v, closed);
    out.push(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), radius, 6, closed), mat));
  }
  return out;
}

function tubeFromPoints(mat: THREE.Material, pts: THREE.Vector3[], radius: number, seg = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, seg, radius, 8, false), mat);
}

function sideZ(xd: number, y: number): number {
  // lateral half-width of the flank at height y (lower profile region)
  const sec = section(xd);
  let best = sec.w1;
  for (let i = 0; i <= 80; i++) {
    const p = 0.12 + (0.3 * i) / 80;
    const [yy, zz] = profile(sec, p);
    best = zz;
    if (yy >= y) break;
  }
  return best;
}

// ---------------------------------------------------------------------------

export class CarModel {
  root = new THREE.Group();
  bodyGroup = new THREE.Group(); // pivot at roll/pitch centre
  bodyMesh = new THREE.Group(); // visual content (shifted down so pivot sits at hCG)
  wheelGroups: THREE.Group[] = [];
  spinGroups: THREE.Group[] = [];
  steerGroups: THREE.Group[] = [];
  wing = new THREE.Group();
  mats: CarMaterials;
  discMats: THREE.MeshStandardMaterial[] = [];
  caliperMats: THREE.MeshStandardMaterial[] = [];
  private bodyMats: THREE.Material[] = [];
  private spin = [0, 0, 0, 0];
  readonly pivotY = CAR.hCG;
  isGhost: boolean;
  private xrayOn = false;
  /** real GLB model state (null while the procedural fallback is shown) */
  glb: GlbInstance | null = null;
  /** tyre radius of the currently shown model */
  wheelR = CAR.wheelRadius;
  private paintName: PaintName = 'lava';

  constructor(opts: { ghost?: boolean } = {}) {
    this.isGhost = !!opts.ghost;
    this.mats = createCarMaterials();
    applyPaint(this.mats, 'lava');
    this.root.add(this.bodyGroup);
    this.bodyGroup.position.y = this.pivotY;
    this.bodyGroup.add(this.bodyMesh);
    this.bodyMesh.position.y = -this.pivotY;

    this.buildBody();
    this.buildWing();
    for (let i = 0; i < 4; i++) this.buildWheel(i);

    const m = this.mats;
    this.bodyMats = [
      m.paint, m.stripe, m.black, m.carbon, m.glass, m.trim, m.headlight, m.drl, m.tail, m.chrome, m.rubber,
      m.vent, m.door, m.banner, m.number,
    ];
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    if (this.isGhost) this.makeGhost();
  }

  // ---- body -----------------------------------------------------------
  private buildBody() {
    const m = this.mats;
    const B = this.bodyMesh;

    // main loft
    const N = 120;
    const R = 88;
    const pos: number[] = [];
    const idx: number[] = [];
    const tmp = new V3();
    for (let k = 0; k <= N; k++) {
      const xd = 0.5 * BODY_LEN * (1 - Math.cos((Math.PI * k) / N));
      for (let j = 0; j <= R; j++) {
        surface(xd, (2 * j) / R, tmp);
        pos.push(tmp.x, tmp.y, tmp.z);
      }
    }
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < R; j++) {
        const a = k * (R + 1) + j, b = a + 1, c = a + R + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    fixWinding(g);
    B.add(new THREE.Mesh(g, m.paint));

    // ---------------- livery ----------------
    // wide black centre stripe: front bumper -> hood -> roof -> tail
    B.add(surfacePatch(m.stripe, 0.944, 1.056, () => [0.2, 5.02], 0.003, 110, 4));
    // black lower body / sills
    B.add(surfacePatch(m.black, 0.12, 0.29, () => [0.5, 4.72], 0.004, 90, 8, { mirror: true }));
    // black door wedge with yellow "Ultra" script (reads correctly on both sides)
    B.add(surfacePatch(m.door, 0.285, 0.5, () => [2.5, 3.42], 0.0048, 30, 8, { mirror: true, flipUMirror: true }));
    // "XIAOMI" banner at the top of the windscreen
    B.add(surfacePatch(m.banner, 0.82, 1.18, () => [3.08, 3.2], 0.007, 24, 4, { uvf: (u, v) => [v, 1 - u] }));

    // ---------------- glass ----------------
    const off = 0.0062;
    B.add(surfacePatch(m.glass, 0.62, 1.38, (v) => {
      const w = Math.abs(v - 0.5) * 2;
      return [3.0 + 0.18 * w * w, 3.78 - 0.45 * w * w];
    }, off, 18, 30));
    B.add(surfacePatch(m.glass, 0.45, 0.775, (v) => [2.62 + 0.08 * (1 - v) + 0.2 * v, 3.48 - 0.52 * v], off, 18, 10, { mirror: true }));
    B.add(surfacePatch(m.glass, 0.45, 0.775, (v) => [1.4 + 0.5 * v, 2.5 - 0.1 * v], off, 14, 10, { mirror: true }));
    B.add(surfacePatch(m.glass, 0.72, 1.28, (v) => {
      const w = Math.abs(v - 0.5) * 2;
      return [0.95 + 0.25 * w * w, 2.1 - 0.15 * w * w];
    }, off, 18, 24));

    // ---------------- hood scoops (twin raised intakes) + louvres ----------------
    const scoopX0 = 3.86, scoopX1 = 4.62, scoopQ0 = 0.832, scoopQ1 = 0.936;
    const scoopH = (u: number, v: number) => 0.07 * Math.pow(Math.sin(Math.PI * u), 0.65) * Math.pow(Math.sin(Math.PI * v), 0.8);
    B.add(surfacePatch(m.paint, scoopQ0, scoopQ1, () => [scoopX0, scoopX1], 0.003, 40, 12, { mirror: true, bulge: scoopH }));
    const ventU0 = 4.08, ventU1 = 4.5, ventQ0 = 0.85, ventQ1 = 0.92;
    B.add(surfacePatch(m.vent, ventQ0, ventQ1, () => [ventU0, ventU1], 0.003, 24, 8, {
      mirror: true,
      bulge: (u, v) => {
        const xd = ventU0 + (ventU1 - ventU0) * u;
        const q = ventQ0 + (ventQ1 - ventQ0) * v;
        return scoopH((xd - scoopX0) / (scoopX1 - scoopX0), (q - scoopQ0) / (scoopQ1 - scoopQ0)) + 0.002;
      },
    }));
    // dark scoop mouths at the front edge of each scoop
    B.add(surfacePatch(m.trim, 0.85, 0.92, () => [4.54, 4.62], 0.003, 6, 8, {
      mirror: true,
      bulge: (u, v) => {
        const xd = 4.54 + 0.08 * u;
        const q = 0.85 + 0.07 * v;
        return scoopH((xd - scoopX0) / (scoopX1 - scoopX0), (q - scoopQ0) / (scoopQ1 - scoopQ0)) + 0.002;
      },
    }));
    // fender-top louvres behind the front wheels
    B.add(surfacePatch(m.vent, 0.52, 0.6, () => [3.38, 3.68], 0.004, 14, 6, { mirror: true }));

    // door shut lines
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const dl = (xd0: number, xd1: number) => {
      for (const t of surfaceTube(lineMat, [[xd0, 0.2], [(xd0 + xd1) / 2, 0.45], [xd1, 0.76]], 0.004, 0.001)) B.add(t);
    };
    dl(3.5, 3.1);
    dl(2.42, 2.38);
    dl(1.5, 1.55);

    this.buildLights(B);
    this.buildFront(B);
    this.buildRear(B);
    this.buildSides(B);

    // ---------------- wheel arches: openings with ~30 mm tyre gap ----------------
    addArchCutouts(m.paint, WHEEL_POS.map((w) => ({ x: w.x, y: WHEEL_CENTER_Y, r: ARCH_R })));
    addArchCutouts(m.black, WHEEL_POS.map((w) => ({ x: w.x, y: WHEEL_CENTER_Y, r: ARCH_R })));
    const wellMat = new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.95, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const wp = WHEEL_POS[i];
      const side = wp.left ? -1 : 1;
      const xd = wp.x + XD_OFFSET;
      const zOut = sideZ(xd, WHEEL_CENTER_Y) + 0.01;
      const zIn = 0.5;
      const well = new THREE.Mesh(new THREE.CylinderGeometry(ARCH_R, ARCH_R, zOut - zIn, 40, 1, true), wellMat);
      well.rotation.x = Math.PI / 2;
      well.position.set(wp.x, WHEEL_CENTER_Y, side * (zIn + zOut) / 2);
      B.add(well);
      const back = new THREE.Mesh(new THREE.CircleGeometry(ARCH_R, 32), wellMat);
      back.position.set(wp.x, WHEEL_CENTER_Y, side * zIn);
      back.rotation.y = side > 0 ? 0 : Math.PI;
      B.add(back);
      // carbon arch lip following the flank
      const lipPts: THREE.Vector3[] = [];
      for (let k = 0; k <= 30; k++) {
        const a = (k / 30) * Math.PI;
        const x = wp.x + Math.cos(a) * (ARCH_R + 0.004);
        const y = WHEEL_CENTER_Y + Math.sin(a) * (ARCH_R + 0.004);
        lipPts.push(new V3(x, y, side * (sideZ(x + XD_OFFSET, y) + 0.006)));
      }
      B.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lipPts), 48, 0.01, 6, false), m.carbon));
    }

    // small aerodynamic stalk mirrors
    for (const sgn of [-1, 1]) {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), m.stripe);
      shell.scale.set(0.95, 0.42, 0.62);
      shell.position.set(3.5 - XD_OFFSET - 0.05, 1.0, sgn * 1.04);
      B.add(shell);
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.022, 0.13), m.carbon);
      stem.position.set(3.5 - XD_OFFSET - 0.0, 0.965, sgn * 0.95);
      stem.rotation.z = sgn * 0.0;
      B.add(stem);
    }
  }

  private buildLights(B: THREE.Group) {
    const m = this.mats;
    // slim swept-back "water drop" LED units: long inboard, tapering to a point on the outer fender
    B.add(fasciaStrip(m.headlight, true, [
      [0.34, 0.572, 0.628], [0.46, 0.588, 0.642], [0.6, 0.607, 0.655], [0.74, 0.628, 0.667], [0.86, 0.652, 0.676], [0.93, 0.668, 0.676],
    ], 5, 0.004));
    // DRL: thin bright line along the upper edge, wrapping down the outer end
    for (const sgn of [-1, 1]) {
      const path: [number, number][] = [
        [0.33, 0.632], [0.46, 0.646], [0.6, 0.659], [0.74, 0.671], [0.86, 0.68], [0.935, 0.676], [0.955, 0.655], [0.95, 0.625],
      ];
      const pts: THREE.Vector3[] = [];
      for (const [z, y] of path) {
        const p = fasciaPoint(true, y, z * sgn, 0.007);
        if (p) pts.push(p);
      }
      if (pts.length > 3) B.add(tubeFromPoints(m.drl, pts, 0.0085, 40));
    }
    // small round auxiliary light, inboard / below the headlight
    for (const sgn of [-1, 1]) {
      const p = fasciaPoint(true, 0.41, 0.56 * sgn, 0.012);
      if (p) {
        const aux = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), m.headlight);
        aux.scale.set(0.45, 1, 1);
        aux.position.copy(p);
        B.add(aux);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.006, 8, 20), m.carbon);
        ring.rotation.y = Math.PI / 2;
        ring.position.copy(p);
        B.add(ring);
      }
    }
    // taillight through bar
    const tpts: THREE.Vector3[] = [];
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const z = -0.86 + 1.72 * t;
      const y = 0.95 - 0.03 * Math.pow(Math.abs(t - 0.5) * 2, 2);
      const p = fasciaPoint(false, y, z, 0.008);
      if (p) tpts.push(p);
    }
    if (tpts.length > 3) B.add(tubeFromPoints(m.tail, tpts, 0.02, 40));
  }

  private buildFront(B: THREE.Group) {
    const m = this.mats;
    // big central lower intake (black) with vertical strakes
    B.add(fasciaPatch(m.trim, true, 0.15, 0.4, (v) => [0.62 - 0.1 * v, 0.62 - 0.1 * v].map((z, i) => (i === 0 ? -z : z)) as [number, number], 0.004, 20, 6, false));
    for (let k = -7; k <= 7; k++) {
      const z = k * 0.082;
      const p = fasciaPoint(true, 0.275, z, 0.012);
      if (!p) continue;
      const strake = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.012), m.carbon);
      strake.position.copy(p);
      B.add(strake);
    }
    // race number plate, upper grille slot and badge
    B.add(fasciaPatch(m.number, true, 0.405, 0.47, () => [0.12, -0.12], 0.006, 4, 2, false, false));
    B.add(fasciaPatch(m.trim, true, 0.49, 0.515, () => [-0.32, 0.32], 0.004, 8, 2, false));
    // side air curtains and bumper corner ducts
    B.add(fasciaPatch(m.trim, true, 0.2, 0.44, (v) => [0.68, 0.84 - 0.06 * v], 0.004, 10, 5, true));
    // very large carbon front splitter
    const sh = new THREE.Shape();
    sh.moveTo(1.85, -0.97);
    sh.lineTo(2.3, -0.99);
    sh.quadraticCurveTo(2.62, -0.95, 2.76, -0.6);
    sh.lineTo(2.82, 0);
    sh.lineTo(2.76, 0.6);
    sh.quadraticCurveTo(2.62, 0.95, 2.3, 0.99);
    sh.lineTo(1.85, 0.97);
    sh.lineTo(1.85, -0.97);
    const sg = new THREE.ExtrudeGeometry(sh, { depth: 0.022, bevelEnabled: false });
    sg.rotateX(-Math.PI / 2);
    const splitter = new THREE.Mesh(sg, m.carbon);
    splitter.position.set(0, 0.045, 0);
    B.add(splitter);
    // end plates
    for (const sgn of [-1, 1]) {
      const ep = new THREE.Shape();
      ep.moveTo(2.0, 0);
      ep.lineTo(2.62, 0);
      ep.lineTo(2.6, 0.06);
      ep.lineTo(2.4, 0.1);
      ep.lineTo(2.1, 0.12);
      ep.lineTo(2.0, 0.09);
      const eg = new THREE.ExtrudeGeometry(ep, { depth: 0.012, bevelEnabled: false });
      const e = new THREE.Mesh(eg, m.carbon);
      e.position.set(0, 0.045, sgn * 0.975 - (sgn > 0 ? 0 : 0.012));
      B.add(e);
      // yellow trim on the end plate
      const acc = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.016), m.caliper);
      acc.position.set(2.3, 0.15, sgn * 0.975);
      B.add(acc);
    }
    // dive planes on the bumper corners (two stacked blades per side)
    for (const sgn of [-1, 1]) {
      for (const [y, dz] of [[0.2, 0.0], [0.28, -0.03]]) {
        const p = fasciaPoint(true, y, sgn * 0.8, 0.0);
        const x = p ? p.x : 2.2;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.01, 0.12), m.carbon);
        blade.position.set(x - 0.02, y, sgn * (0.84 + dz));
        blade.rotation.x = sgn * 0.25;
        B.add(blade);
      }
    }
  }

  private buildSides(B: THREE.Group) {
    const m = this.mats;
    for (const sgn of [-1, 1]) {
      // black side-skirt blade with end fences
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.014, 0.16), m.carbon);
      blade.position.set(3.55 - XD_OFFSET - 0.95 + 0.0, 0.1, sgn * 0.93);
      blade.position.x = 2.62 - XD_OFFSET - 0.02 + 0.0;
      B.add(blade);
      for (const fx of [-0.96, -0.5, 0, 0.5, 0.96]) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.012), m.carbon);
        f.position.set(blade.position.x + fx, 0.135, sgn * (fx === 0.96 || fx === -0.96 ? 1.005 : 1.0));
        B.add(f);
      }
    }
  }

  private buildRear(B: THREE.Group) {
    const m = this.mats;
    // black lower rear bumper + carbon diffuser
    B.add(fasciaPatch(m.trim, false, 0.2, 0.55, (v) => [0.82 - 0.06 * v, 0.82 - 0.06 * v].map((z, i) => (i === 0 ? -z : z)) as [number, number], 0.004, 16, 6, false));
    B.add(fasciaPatch(m.carbon, false, 0.22, 0.46, (v) => [0.72 - 0.05 * v, 0.72 - 0.05 * v].map((z, i) => (i === 0 ? -z : z)) as [number, number], 0.007, 14, 6, false));
    for (let i = -3; i <= 3; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.01), m.carbon);
      f.position.set(-2.4, 0.3, i * 0.2);
      f.rotation.z = -0.3;
      B.add(f);
    }
    // outer fences + lower lip
    for (const sgn of [-1, 1]) {
      const fence = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.24, 0.014), m.carbon);
      fence.position.set(-2.4, 0.3, sgn * 0.75);
      fence.rotation.z = -0.3;
      B.add(fence);
    }
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 1.5), m.carbon);
    lip.position.set(-2.46, 0.2, 0);
    B.add(lip);
  }

  private buildWing() {
    const m = this.mats;
    const W = this.wing;
    // two-element airfoil, chord along x (leading edge forward)
    const c = 0.36;
    const top = (t: number) => 0.05 * Math.sin(Math.PI * Math.pow(t, 0.8)) + 0.012 * t;
    const bot = (t: number) => 0.006 * Math.sin(Math.PI * t) - 0.01 * t;
    const shape = new THREE.Shape();
    const pts: [number, number][] = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push([c / 2 - c * t, top(t)]); }
    for (let i = 24; i >= 0; i--) { const t = i / 24; pts.push([c / 2 - c * t, bot(t)]); }
    shape.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) shape.lineTo(p[0], p[1]);
    const span = 1.86;
    const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false });
    g.translate(0, 0, -span / 2);
    W.add(new THREE.Mesh(g, m.carbon));
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.014, span * 0.97), m.carbon);
    flap.position.set(-c / 2 - 0.03, 0.1, 0);
    flap.rotation.z = 0.2;
    W.add(flap);
    const gf = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.04, span), m.carbon);
    gf.position.set(-c / 2 + 0.006, 0.03, 0);
    W.add(gf);
    // big end plates with yellow accent
    for (const sgn of [-1, 1]) {
      const ep = new THREE.Shape();
      ep.moveTo(0.26, -0.04);
      ep.lineTo(-0.3, -0.03);
      ep.lineTo(-0.34, 0.14);
      ep.lineTo(-0.1, 0.19);
      ep.lineTo(0.22, 0.11);
      ep.lineTo(0.26, -0.04);
      const e = new THREE.Mesh(new THREE.ExtrudeGeometry(ep, { depth: 0.016, bevelEnabled: false }), m.carbon);
      e.position.set(0, -0.02, sgn * (span / 2) - (sgn > 0 ? 0 : 0.016));
      W.add(e);
      const acc = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.026, 0.02), m.caliper);
      acc.position.set(-0.06, 0.14, sgn * (span / 2 + (sgn > 0 ? 0.01 : -0.01)));
      W.add(acc);
    }
    // high mount, well above the trunk lid
    W.position.set(-2.32, 1.36, 0);
    this.bodyMesh.add(W);
    // tall swan-neck uprights attached to the wing's upper surface
    for (const sgn of [-1, 1]) {
      const z = sgn * 0.46;
      const stay = tubeFromPoints(m.carbon, [
        new V3(-1.82, 0.97, z), new V3(-1.9, 1.08, z), new V3(-2.04, 1.2, z), new V3(-2.22, 1.32, z), new V3(-2.32, 1.4, z),
      ], 0.036, 24);
      stay.scale.set(1, 1, 0.42);
      stay.position.z = z * (1 - 0.42);
      this.bodyMesh.add(stay);
    }
  }

  setWingAngle(rad: number) {
    this.wing.rotation.z = rad;
  }

  // ---- wheels ---------------------------------------------------------
  private buildWheel(i: number) {
    const m = this.mats;
    const wp = WHEEL_POS[i];
    const R = CAR.wheelRadius;
    const wheelGroup = new THREE.Group(); // hub position
    const orient = new THREE.Group(); // mirrored for left
    const steer = new THREE.Group();
    const spin = new THREE.Group();
    wheelGroup.add(steer);
    steer.add(orient);
    orient.add(spin);
    if (wp.left) orient.rotation.y = Math.PI;

    // low-profile tyre: 21" rim (r = 0.268) + ~0.092 m sidewall
    const prof: THREE.Vector2[] = [];
    const hw = 0.15;
    const rimR = 0.268;
    prof.push(new THREE.Vector2(rimR, -hw + 0.02));
    prof.push(new THREE.Vector2(rimR + 0.022, -hw - 0.003));
    prof.push(new THREE.Vector2(R - 0.03, -hw - 0.01));
    prof.push(new THREE.Vector2(R - 0.012, -hw + 0.012));
    prof.push(new THREE.Vector2(R - 0.002, -hw + 0.045));
    prof.push(new THREE.Vector2(R, -hw + 0.09));
    prof.push(new THREE.Vector2(R, hw - 0.09));
    prof.push(new THREE.Vector2(R - 0.002, hw - 0.045));
    prof.push(new THREE.Vector2(R - 0.012, hw - 0.012));
    prof.push(new THREE.Vector2(R - 0.03, hw + 0.01));
    prof.push(new THREE.Vector2(rimR + 0.022, hw + 0.003));
    prof.push(new THREE.Vector2(rimR, hw - 0.02));
    const tg = new THREE.LatheGeometry(prof, 56);
    tg.rotateX(Math.PI / 2);
    spin.add(new THREE.Mesh(tg, m.tire));

    // forged black rim: barrel, lip, deep dish, swept spokes, centre-lock nut
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, 0.3, 40, 1, true), m.rimBlack);
    barrel.rotation.x = Math.PI / 2;
    spin.add(barrel);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR - 0.002, 0.008, 8, 56), m.rim);
    lip.position.z = hw - 0.012;
    spin.add(lip);
    const sp = new THREE.Shape();
    sp.moveTo(0.06, -0.016);
    sp.lineTo(0.262, -0.01);
    sp.lineTo(0.262, 0.05);
    sp.lineTo(0.06, 0.016);
    sp.closePath();
    const spg = new THREE.ExtrudeGeometry(sp, { depth: 0.016, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 1 });
    for (let k = 0; k < 10; k++) {
      const s = new THREE.Mesh(spg, m.rimBlack);
      s.rotation.z = (k / 10) * Math.PI * 2;
      s.position.z = 0.092;
      spin.add(s);
    }
    // thin inner webbing between spokes (keeps the wheel from looking hollow)
    const web = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.01, 40), m.rimBlack);
    web.rotation.x = Math.PI / 2;
    web.position.z = 0.078;
    spin.add(web);
    const hubRing = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.034, 28), m.rimBlack);
    hubRing.rotation.x = Math.PI / 2;
    hubRing.position.z = 0.1;
    spin.add(hubRing);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 8), m.rim);
    nut.rotation.x = Math.PI / 2;
    nut.position.z = 0.122;
    spin.add(nut);
    const nutBadge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 16), m.caliper);
    nutBadge.rotation.x = Math.PI / 2;
    nutBadge.position.z = 0.139;
    spin.add(nutBadge);

    // brake disc (spins)
    const dm = m.disc.clone();
    this.discMats[i] = dm;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.212, 0.212, 0.03, 48), dm);
    disc.rotation.x = Math.PI / 2;
    disc.position.z = 0.03;
    spin.add(disc);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 24), dm);
    hat.rotation.x = Math.PI / 2;
    hat.position.z = 0.055;
    spin.add(hat);
    const holeGeo = new THREE.CircleGeometry(0.007, 8);
    const holes = new THREE.InstancedMesh(holeGeo, new THREE.MeshBasicMaterial({ color: 0x050505 }), 48);
    const mt = new THREE.Matrix4();
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const r = k % 2 === 0 ? 0.155 : 0.185;
      mt.makeTranslation(Math.cos(a) * r, Math.sin(a) * r, 0.0455);
      holes.setMatrixAt(k, mt);
    }
    spin.add(holes);

    // large yellow caliper (static)
    const cm = m.caliper.clone();
    this.caliperMats[i] = cm;
    const cs = new THREE.Shape();
    const r0 = 0.15, r1 = 0.262, a0 = 0, a1 = 1.25;
    cs.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0);
    cs.lineTo(Math.cos(a0) * r1, Math.sin(a0) * r1);
    cs.absarc(0, 0, r1, a0, a1, false);
    cs.lineTo(Math.cos(a1) * r0, Math.sin(a1) * r0);
    cs.absarc(0, 0, r0, a1, a0, true);
    const cg = new THREE.ExtrudeGeometry(cs, { depth: 0.09, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2 });
    const cal = new THREE.Mesh(cg, cm);
    const ang = Math.PI * 0.5;
    cal.rotation.z = ang;
    cal.position.z = -0.014;
    orient.add(cal);
    for (let b = 0; b < 5; b++) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), m.chrome);
      const ba = ang + 0.12 + b * 0.25;
      bolt.position.set(Math.cos(ba) * 0.238, Math.sin(ba) * 0.238, 0.085);
      bolt.rotation.x = Math.PI / 2;
      orient.add(bolt);
    }

    wheelGroup.position.set(wp.x, WHEEL_CENTER_Y, wheelZ(i));
    this.root.add(wheelGroup);
    this.wheelGroups[i] = wheelGroup;
    this.spinGroups[i] = spin;
    this.steerGroups[i] = steer;
  }

  setSpin(i: number, angle: number) {
    this.spin[i] = angle;
    const left = WHEEL_POS[i].left;
    this.spinGroups[i].rotation.z = this.glb || !left ? -angle : angle;
  }

  setSteer(angle: number) {
    // positive = turn left (yaw about +Y)
    this.steerGroups[0].rotation.y = angle;
    this.steerGroups[1].rotation.y = angle;
  }

  /** f in 0..1 brake force fraction, temp in 0..1 */
  setBrakeGlow(i: number, f: number, temp: number) {
    const e = Math.min(1, f * 0.9 + temp * 0.6);
    this.discMats[i].emissiveIntensity = e * 5.0;
    this.caliperMats[i].emissiveIntensity = e * 1.6;
  }

  setBrakeLights(level: number) {
    if (this.glb) {
      for (const m of this.glb.tailMats) {
        m.emissive.setRGB(1.0, 0.04, 0.02);
        m.emissiveIntensity = 0.25 + level * 3.2;
      }
      return;
    }
    this.mats.tail.emissiveIntensity = 1.2 + level * 4.0;
  }

  setPaint(name: PaintName) {
    this.paintName = name;
    applyPaint(this.mats, name);
    if (this.glb) this.applyGlbPaint();
  }

  private paintMaps: Partial<Record<PaintName, THREE.Texture>> = {};

  /** Recolour the palette cells that hold the (pale) yellow: deeper Ultra yellow or pearl white. */
  private makePaintMap(orig: THREE.Texture, name: PaintName): THREE.Texture {
    const img = orig.image as CanvasImageSource & { width: number; height: number };
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height);
    const col = name === 'lava' ? [247, 182, 6] : [236, 238, 241];
    for (let k = 0; k < d.data.length; k += 4) {
      const r = d.data[k], gg = d.data[k + 1], b = d.data[k + 2];
      if (r > 190 && gg > 150 && b < 110 && r - b > 100) { d.data[k] = col[0]; d.data[k + 1] = col[1]; d.data[k + 2] = col[2]; }
    }
    g.putImageData(d, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.flipY = orig.flipY; t.channel = orig.channel; t.colorSpace = orig.colorSpace;
    t.wrapS = orig.wrapS; t.wrapT = orig.wrapT; t.magFilter = orig.magFilter; t.minFilter = orig.minFilter;
    return t;
  }

  private applyGlbPaint() {
    if (!this.glb) return;
    const paint = this.glb.paint;
    if (!paint.length) return;
    const orig = (paint[0].userData.origMap ??= paint[0].map) as THREE.Texture;
    if (!orig || !orig.image) return;
    const map = (this.paintMaps[this.paintName] ??= this.makePaintMap(orig, this.paintName));
    for (const m of paint) { m.map = map; m.needsUpdate = true; }
  }

  /** Replace the procedural body / wheels with the real GLB model. */
  applyGlb(tpl: GlbTemplate) {
    const inst = instantiate(tpl);
    const dispose = (o: THREE.Object3D) => o.traverse((x) => { const mm = x as THREE.Mesh; if (mm.isMesh) mm.geometry.dispose(); });
    dispose(this.bodyMesh);
    this.bodyMesh.clear();
    this.root.add(inst.root);
    inst.root.updateMatrixWorld(true);
    for (const part of inst.bodyParts) this.bodyMesh.attach(part);
    for (let i = 0; i < 4; i++) {
      const wg = this.wheelGroups[i];
      dispose(wg);
      wg.clear();
      const w = inst.wheels[i];
      wg.position.copy(w.center);
      wg.updateMatrixWorld(true);
      const steer = new THREE.Group(), orient = new THREE.Group(), spin = new THREE.Group();
      wg.add(steer);
      steer.add(orient);
      orient.add(spin);
      steer.updateMatrixWorld(true);
      spin.attach(w.wheel);
      if (w.hub) orient.attach(w.hub);
      this.steerGroups[i] = steer;
      this.spinGroups[i] = spin;
    }
    this.root.remove(inst.root);
    this.glb = inst;
    this.wheelR = tpl.wheelR;
    this.discMats = inst.discMats;
    this.caliperMats = inst.caliperMats;
    this.bodyMats = inst.bodyMats;
    // shadows only from the big body parts
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let p: THREE.Object3D | null = o;
      let cast = false;
      while (p) { if (p.name.startsWith('bodyshell') || p.name.startsWith('chassis')) cast = true; p = p.parent; }
      mesh.castShadow = cast && !this.isGhost;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
    });
    this.applyGlbPaint();
    this.addDoorNumbers();
    if (this.isGhost) this.makeGhost();
    this.applyTransparency();
  }

  /** Race number on the white door panels of the GLB livery. */
  private addDoorNumbers() {
    if (!this.glb) return;
    this.root.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    const targets: THREE.Object3D[] = [];
    this.bodyMesh.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name !== '') targets.push(o); });
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#0a0a0a'; g.font = '900 170px "Arial Black","Helvetica Neue",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('01', 128, 140);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
    this.glb.bodyMats.push(mat);
    mat.userData.baseOpacity = 1;
    for (const sgn of [1, -1]) {
      // work in car-local space: the car may already sit somewhere on the track when the GLB arrives
      rc.set(this.root.localToWorld(new THREE.Vector3(0.68, 0.49, sgn * 3)), new THREE.Vector3(0, 0, -sgn).transformDirection(this.root.matrixWorld));
      const hit = rc.intersectObjects(targets, false)[0];
      if (!hit) continue;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.48), mat);
      plane.position.copy(this.bodyMesh.worldToLocal(hit.point.clone()));
      plane.position.z += sgn * 0.009;
      plane.rotation.y = sgn > 0 ? 0 : Math.PI;
      this.bodyMesh.add(plane);
    }
  }

  // ---- display modes --------------------------------------------------
  setXray(on: boolean) {
    this.xrayOn = on;
    this.applyTransparency();
  }

  private ghostOpacity = 1;
  private makeGhost() {
    this.ghostOpacity = 0.38;
    const tint = new THREE.Color(0x66b8ff);
    for (const mat of this.allMaterials()) {
      mat.transparent = true;
      mat.opacity = 0.38;
      mat.depthWrite = false;
      const sm = mat as THREE.MeshStandardMaterial;
      if (sm.color && !sm.emissive?.getHex()) sm.color.lerp(tint, 0.55);
    }
    this.root.traverse((o) => { o.castShadow = false; });
    this.applyTransparency();
  }

  private allMaterials(): THREE.Material[] {
    const set = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mm = mesh.material;
        (Array.isArray(mm) ? mm : [mm]).forEach((x) => set.add(x));
      }
    });
    return [...set];
  }

  private applyTransparency() {
    const op = this.xrayOn ? 0.16 : this.ghostOpacity;
    for (const mat of this.bodyMats) {
      const base = (mat.userData.baseOpacity as number | undefined) ?? 1;
      const o = base * op;
      mat.transparent = o < 1 || base < 1 || (!this.glb && mat === this.mats.door);
      mat.opacity = o;
      mat.depthWrite = o >= 1;
      mat.needsUpdate = true;
    }
  }

  dispose() {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}

void surface;

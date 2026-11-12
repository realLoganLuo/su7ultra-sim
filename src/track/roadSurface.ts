// Shared road surface model: used by the render mesh, the vehicle physics and the active
// suspension road preview, so all three see exactly the same ground.
import * as THREE from 'three';
import { CONTROL, SECTIONS, FEATURES, BUMPS } from './nordschleifeData';
import { TRACK_CFG } from '../config';

export interface SectionInfo { name: string; concrete: boolean; sStart: number; sEnd: number; idx: number }

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class RoadSurface {
  readonly length: number;
  readonly n: number;
  readonly ds: number;
  cx: Float64Array;
  cz: Float64Array;
  prof: Float64Array; // centreline elevation incl. crest / dip features
  bank: Float64Array; // rad, + = left side lower
  kappa: Float64Array; // 1/m, + = turning left
  tx: Float64Array;
  tz: Float64Array;
  lx: Float64Array;
  lz: Float64Array;
  controlS: number[] = [];
  sections: SectionInfo[] = [];
  private bumps: { s: number; amp: number; sigma: number; lat: number }[] = [];
  readonly curve: THREE.CatmullRomCurve3;

  constructor() {
    const pts = CONTROL.map((c) => new THREE.Vector3(c.x, c.y, c.z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.curve.arcLengthDivisions = 24000;
    const L = this.curve.getLength();
    const N = Math.round(L);
    this.length = L;
    this.n = N;
    this.ds = L / N;
    const mk = () => new Float64Array(N);
    this.cx = mk(); this.cz = mk(); this.prof = mk(); this.bank = mk(); this.kappa = mk();
    this.tx = mk(); this.tz = mk(); this.lx = mk(); this.lz = mk();

    const nc = CONTROL.length;
    const bankRaw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const p = this.curve.getPointAt(u);
      this.cx[i] = p.x; this.cz[i] = p.z; this.prof[i] = p.y;
      const t = this.curve.getUtoTmapping(u, u * L);
      const f = t * nc;
      const i1 = Math.floor(f) % nc;
      const w = f - Math.floor(f);
      const b = (k: number) => CONTROL[((k % nc) + nc) % nc].bank;
      const b0 = b(i1 - 1), b1 = b(i1), b2 = b(i1 + 1), b3 = b(i1 + 2);
      // Catmull-Rom (uniform)
      const v = 0.5 * (2 * b1 + (-b0 + b2) * w + (2 * b0 - 5 * b1 + 4 * b2 - b3) * w * w + (-b0 + 3 * b1 - 3 * b2 + b3) * w * w * w);
      bankRaw[i] = (v * Math.PI) / 180;
    }
    // smooth bank
    const win = 12;
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let k = -win; k <= win; k++) a += bankRaw[(i + k + N) % N];
      this.bank[i] = a / (2 * win + 1);
    }
    // tangents / left normals
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = this.cx[b] - this.cx[a], dz = this.cz[b] - this.cz[a];
      const m = Math.hypot(dx, dz);
      dx /= m; dz /= m;
      this.tx[i] = dx; this.tz[i] = dz;
      this.lx[i] = dz; this.lz[i] = -dx;
    }
    // curvature (left positive), smoothed
    const kraw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b]; // sin of heading change (x,z plane)
      const dot = this.tx[a] * this.tx[b] + this.tz[a] * this.tz[b];
      const dpsi = Math.atan2(cross, dot);
      kraw[i] = -dpsi / (4 * this.ds);
    }
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let k = -6; k <= 6; k++) a += kraw[(i + k + N) % N];
      this.kappa[i] = a / 13;
    }

    // control point -> s
    for (let c = 0; c < nc; c++) {
      let best = 0, bd = 1e12;
      const cp = CONTROL[c];
      // coarse search near expected index
      for (let i = 0; i < N; i++) {
        const d = (this.cx[i] - cp.x) ** 2 + (this.cz[i] - cp.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      this.controlS.push(best * this.ds);
    }
    // features (crests / dips)
    const L2 = this.length;
    const sAt = (idx: number, frac: number) => {
      const a = this.controlS[idx % nc];
      let b = this.controlS[(idx + 1) % nc];
      if (b < a) b += L2;
      return a + frac * (b - a);
    };
    for (const f of FEATURES) {
      const s0 = sAt(f.idx, f.frac);
      for (let i = 0; i < N; i++) {
        let d = i * this.ds - s0;
        d = ((d + L2 / 2) % L2 + L2) % L2 - L2 / 2;
        if (Math.abs(d) < f.sigma * 4) this.prof[i] += f.amp * Math.exp(-((d / f.sigma) ** 2));
      }
    }
    for (const b of BUMPS) this.bumps.push({ s: sAt(b.idx, b.frac) % L2, amp: b.amp, sigma: b.sigma, lat: b.lat });

    // sections
    for (let k = 0; k < SECTIONS.length; k++) {
      const sc = SECTIONS[k];
      const next = SECTIONS[(k + 1) % SECTIONS.length];
      const s0 = this.controlS[sc.idx];
      let s1 = this.controlS[next.idx];
      if (k === SECTIONS.length - 1) s1 = L2; // last section runs to the line
      this.sections.push({ name: sc.name, concrete: !!sc.concrete, sStart: s0, sEnd: s1, idx: sc.idx });
    }
  }

  wrap(s: number): number {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  private idx(s: number): [number, number, number] {
    const f = this.wrap(s) / this.ds;
    let i = Math.floor(f);
    const w = f - i;
    if (i >= this.n) i -= this.n;
    return [i, (i + 1) % this.n, w];
  }

  private lerpArr(a: Float64Array, s: number): number {
    const [i, j, w] = this.idx(s);
    return a[i] + (a[j] - a[i]) * w;
  }

  profile(s: number) { return this.lerpArr(this.prof, s); }
  bankAt(s: number) { return this.lerpArr(this.bank, s); }
  curvature(s: number) { return this.lerpArr(this.kappa, s); }
  cxAt(s: number) { return this.lerpArr(this.cx, s); }
  czAt(s: number) { return this.lerpArr(this.cz, s); }
  lxAt(s: number) { return this.lerpArr(this.lx, s); }
  lzAt(s: number) { return this.lerpArr(this.lz, s); }
  txAt(s: number) { return this.lerpArr(this.tx, s); }
  tzAt(s: number) { return this.lerpArr(this.tz, s); }

  sectionAt(s: number): SectionInfo {
    const w = this.wrap(s);
    for (const sec of this.sections) if (w >= sec.sStart && w < sec.sEnd) return sec;
    return this.sections[this.sections.length - 1];
  }

  /** smooth surface (no bumps / noise): used for the road-aligned reference plane and large-scale curvature */
  base(s: number, d: number): number {
    const b = this.bankAt(s);
    return this.profile(s) - d * Math.sin(b);
  }

  /** full surface height at (s, d). d>0 = left of centre line. */
  height(s: number, d: number): number {
    const ad = Math.abs(d);
    const dd = Math.max(-9, Math.min(9, d));
    let h = this.base(s, dd);
    if (ad > 9) h -= 0.3 * (ad - 9);
    // low-frequency undulation
    h += 0.007 * Math.sin(s * 0.31 + d * 0.5) + 0.004 * Math.sin(s * 0.83 - d * 0.9 + 1.7) + 0.0012 * Math.sin(s * 2.1 + d * 1.3);
    // local bumps
    const w = this.wrap(s);
    const L = this.length;
    for (const b of this.bumps) {
      let ds = w - b.s;
      ds = ((ds + L / 2) % L + L) % L - L / 2;
      if (ds > -b.sigma * 4 && ds < b.sigma * 4) {
        const lat = b.lat === 0 ? 1 : smoothstep(-1, 1, (d * b.lat) / 3);
        h += b.amp * lat * Math.exp(-((ds / b.sigma) ** 2));
      }
    }
    // curb rumble strips
    if (ad > TRACK_CFG.roadHalfWidth && ad < TRACK_CFG.curbOuter) {
      const k = smoothstep(TRACK_CFG.roadHalfWidth, TRACK_CFG.roadHalfWidth + 0.15, ad) * (1 - smoothstep(TRACK_CFG.curbOuter - 0.2, TRACK_CFG.curbOuter, ad));
      h += k * (0.012 + 0.012 * Math.sin((w / 0.9) * Math.PI * 2)); // smooth ramps: no vertical steps at the curb edges
    }
    return h;
  }

  /** Newton projection of a world XZ point onto the centre line: returns (s, d) with d>0 left. */
  worldToSD(x: number, z: number, sHint: number, out: { s: number; d: number }) {
    let s = sHint;
    for (let k = 0; k < 6; k++) {
      const dx = x - this.cxAt(s), dz = z - this.czAt(s);
      s += dx * this.txAt(s) + dz * this.tzAt(s);
    }
    out.s = s;
    out.d = (x - this.cxAt(s)) * this.lxAt(s) + (z - this.czAt(s)) * this.lzAt(s);
    return out;
  }

  /** world position on the surface */
  pos(s: number, d: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.cxAt(s) + d * this.lxAt(s), this.height(s, d), this.czAt(s) + d * this.lzAt(s));
  }

  /** horizontal position only */
  posXZ(s: number, d: number): [number, number] {
    return [this.cxAt(s) + d * this.lxAt(s), this.czAt(s) + d * this.lzAt(s)];
  }

  /** Road-aligned orthonormal frame at (s, d), based on the smooth surface. f forward, l left, n up. */
  frame(s: number, d: number, origin: THREE.Vector3, f: THREE.Vector3, l: THREE.Vector3, n: THREE.Vector3) {
    const p = (ss: number, dd: number, o: THREE.Vector3) => {
      o.set(this.cxAt(ss) + dd * this.lxAt(ss), this.base(ss, Math.max(-9, Math.min(9, dd))), this.czAt(ss) + dd * this.lzAt(ss));
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    p(s, d, origin);
    p(s + 1.5, d, a); p(s - 1.5, d, b);
    f.copy(a).sub(b).normalize();
    p(s, d + 1, a); p(s, d - 1, b);
    l.copy(a).sub(b).normalize();
    n.crossVectors(f, l).normalize();
    l.crossVectors(n, f).normalize();
  }
}

export const road = new RoadSurface();

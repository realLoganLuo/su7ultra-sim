import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { road, RoadSurface } from './roadSurface';
import { TRACK_CFG } from '../config';
import { asphaltTexture, grassTexture, curbTexture, signTexture, graffitiTextures } from './textures';

const CHUNK = 120; // metres per mesh chunk

type UVFn = (s: number, d: number) => [number, number];

function buildRibbon(rs: RoadSurface, s0: number, s1: number, dCols: number[], uv: UVFn, yOff = 0, step = 1): THREE.BufferGeometry {
  const rows = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  for (let k = 0; k <= rows; k++) {
    const s = s0 + ((s1 - s0) * k) / rows;
    for (const d of dCols) {
      rs.pos(s, d, p);
      pos.push(p.x, p.y + yOff, p.z);
      const ds = 0.6, dd = 0.4;
      rs.pos(s + ds, d, a).sub(rs.pos(s - ds, d, b)); // forward
      const l = rs.pos(s, d + dd, new THREE.Vector3()).sub(rs.pos(s, d - dd, new THREE.Vector3()));
      n.crossVectors(a, l).normalize();
      nrm.push(n.x, n.y, n.z);
      const [u, v] = uv(s, d);
      uvs.push(u, v);
    }
  }
  const nc = dCols.length;
  for (let k = 0; k < rows; k++) {
    for (let c = 0; c < nc - 1; c++) {
      const A = k * nc + c, B = A + 1, C = A + nc, D = C + 1;
      idx.push(A, C, B, B, C, D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class Track {
  group = new THREE.Group();
  roadGroup = new THREE.Group();
  props = new THREE.Group();
  /** Armco segments with per-vertex track position, so impacts can bend the rail where they happen */
  private armco: { mesh: THREE.Mesh; s0: number; s1: number; vs: Float32Array; side: Int8Array; orig: Float32Array; bent: boolean }[] = [];
  rs = road;

  constructor() {
    this.group.add(this.roadGroup, this.props);
    this.buildRoad();
    this.buildArmco();
    this.buildDecals();
    this.buildSigns();
  }

  private chunks(): { s0: number; s1: number; concrete: boolean }[] {
    const L = this.rs.length;
    const cuts = new Set<number>([0, L]);
    for (const sec of this.rs.sections) if (sec.concrete) { cuts.add(sec.sStart); cuts.add(Math.min(L, sec.sEnd)); }
    const sorted = [...cuts].sort((a, b) => a - b);
    const out: { s0: number; s1: number; concrete: boolean }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      const mid = (a + b) / 2;
      const concrete = this.rs.sectionAt(mid).concrete;
      const nChunks = Math.max(1, Math.ceil((b - a) / CHUNK));
      for (let k = 0; k < nChunks; k++) out.push({ s0: a + ((b - a) * k) / nChunks, s1: a + ((b - a) * (k + 1)) / nChunks, concrete });
    }
    return out;
  }

  private buildRoad() {
    const rs = this.rs;
    const hw = TRACK_CFG.roadHalfWidth;
    const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTexture(false), roughness: 0.88, metalness: 0 });
    const concrete = new THREE.MeshStandardMaterial({ map: asphaltTexture(true), roughness: 0.92, metalness: 0 });
    const curb = new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.7 });
    const grass = new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1, color: 0xb5c9a0 });
    const roadCols: number[] = [];
    for (let d = -hw; d <= hw + 1e-6; d += 1) roadCols.push(d);
    // left-to-right order ascending d (right -> left); texture u from d
    const uvRoad: UVFn = (s, d) => [(d + hw) / (2 * hw), s / 10];
    const uvCurb: UVFn = (s, d) => [Math.abs(d) > 0 ? (Math.abs(d) - hw) / 1.4 : 0, s / 3];
    const uvGrass: UVFn = (s, d) => [d / 12, s / 12];

    // One mesh per material per chunk: left and right curbs / grass share the same s-range, so merging
    // them halves their draw calls without coarsening frustum culling.
    const merged = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts)!;
      parts.forEach((x) => x.dispose());
      g.computeBoundingSphere();
      return g;
    };
    for (const ch of this.chunks()) {
      const m = new THREE.Mesh(buildRibbon(rs, ch.s0, ch.s1, roadCols, uvRoad, 0), ch.concrete ? concrete : asphalt);
      m.receiveShadow = true;
      this.roadGroup.add(m);
      const curbs: THREE.BufferGeometry[] = [], grasses: THREE.BufferGeometry[] = [];
      for (const sgn of [-1, 1]) {
        const cols = sgn > 0 ? [hw, (hw + TRACK_CFG.curbOuter) / 2, TRACK_CFG.curbOuter] : [-TRACK_CFG.curbOuter, -(hw + TRACK_CFG.curbOuter) / 2, -hw];
        curbs.push(buildRibbon(rs, ch.s0, ch.s1, cols, uvCurb, 0.004));
        const gcols = sgn > 0 ? [TRACK_CFG.curbOuter, 9, 12, 16, 22] : [-22, -16, -12, -9, -TRACK_CFG.curbOuter];
        grasses.push(buildRibbon(rs, ch.s0, ch.s1, gcols, uvGrass, -0.003, 2));
      }
      const cm = new THREE.Mesh(merged(curbs), curb);
      cm.receiveShadow = true;
      this.roadGroup.add(cm);
      const gm = new THREE.Mesh(merged(grasses), grass);
      gm.receiveShadow = true;
      this.roadGroup.add(gm);
    }
  }

  /**
   * Permanently bend the Armco outwards after an impact: `depth` metres at s, fading along the rail over a
   * length that grows with the depth (a hard hit drags more of the rail and its posts with it).
   */
  bendArmco(s: number, side: 1 | -1, depth: number) {
    if (depth < 0.005) return;
    const L = this.rs.length;
    const span = 1.2 + 4 * depth;
    for (const seg of this.armco) {
      const ds0 = ((s - seg.s0 + L / 2) % L + L) % L - L / 2, ds1 = ((s - seg.s1 + L / 2) % L + L) % L - L / 2;
      if (ds0 < -3 * span || ds1 > 3 * span) continue;
      const a = seg.mesh.geometry.attributes.position as THREE.BufferAttribute;
      let touched = false;
      for (let i = 0; i < a.count; i++) {
        if (seg.side[i] !== side) continue;
        let dd = seg.vs[i] - s;
        dd = ((dd + L / 2) % L + L) % L - L / 2;
        if (Math.abs(dd) > 3 * span) continue;
        const push = depth * Math.exp(-((dd / span) ** 2));
        const sv = seg.vs[i];
        a.setXYZ(i, a.getX(i) + this.rs.lxAt(sv) * side * push, a.getY(i) - 0.15 * push, a.getZ(i) + this.rs.lzAt(sv) * side * push);
        touched = true;
      }
      if (touched) {
        a.needsUpdate = true;
        seg.mesh.geometry.computeVertexNormals();
        seg.mesh.geometry.computeBoundingSphere();
        seg.bent = true;
      }
    }
  }

  /** straighten every bent rail (new session) */
  repairArmco() {
    for (const seg of this.armco) {
      if (!seg.bent) continue;
      const a = seg.mesh.geometry.attributes.position as THREE.BufferAttribute;
      (a.array as Float32Array).set(seg.orig);
      a.needsUpdate = true;
      seg.mesh.geometry.computeVertexNormals();
      seg.mesh.geometry.computeBoundingSphere();
      seg.bent = false;
    }
  }

  private buildArmco() {
    const rs = this.rs;
    const L = rs.length;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.65, roughness: 0.42, side: THREE.DoubleSide });
    const profile: [number, number][] = [[0.0, 0.3], [-0.04, 0.2], [0.0, 0.1], [0.03, 0.0], [0, -0.1], [-0.04, -0.2], [0, -0.3]]; // (toward road, height)
    // both rails on both sides of a 240 m segment become one mesh (one draw call instead of four)
    for (let s0 = 0; s0 < L; s0 += 240) {
      const s1 = Math.min(L, s0 + 240);
      const rails: THREE.BufferGeometry[] = [];
      const vs: number[] = [], vside: number[] = [];
      for (const sgn of [-1, 1]) {
        for (const hRail of [0.52, 0.86]) {
          const pos: number[] = [];
          const idx: number[] = [];
          const rows = Math.ceil((s1 - s0) / 2);
          const p = new THREE.Vector3();
          for (let k = 0; k <= rows; k++) {
            const s = s0 + ((s1 - s0) * k) / rows;
            const d = sgn * TRACK_CFG.armcoD;
            rs.pos(s, d, p);
            const lx = rs.lxAt(s), lz = rs.lzAt(s);
            for (const [off, h] of profile) {
              const dd = -sgn * off; // toward the road = -sgn direction
              pos.push(p.x + lx * dd, p.y + hRail + h, p.z + lz * dd);
              vs.push(s); vside.push(sgn);
            }
          }
          const nv = profile.length;
          for (let k = 0; k < rows; k++) for (let c = 0; c < nv - 1; c++) {
            const A = k * nv + c, B = A + 1, C = A + nv, D = C + 1;
            idx.push(A, C, B, B, C, D);
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          g.setIndex(idx);
          g.computeVertexNormals();
          rails.push(g);
        }
      }
      const g = mergeGeometries(rails)!;
      rails.forEach((x) => x.dispose());
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.castShadow = false;
      this.props.add(m);
      this.armco.push({ mesh: m, s0, s1, vs: new Float32Array(vs), side: Int8Array.from(vside), orig: new Float32Array(g.attributes.position.array as Float32Array), bent: false });
    }
    // posts
    const postGeo = new THREE.BoxGeometry(0.12, 1.15, 0.14);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x7c8590, roughness: 0.6, metalness: 0.5 });
    const count = Math.floor(L / 4) * 2;
    const inst = new THREE.InstancedMesh(postGeo, postMat, count);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < count / 2; i++) {
      const s = i * 4;
      for (const sgn of [-1, 1]) {
        rs.pos(s, sgn * (TRACK_CFG.armcoD + 0.1), p);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(rs.tzAt(s), rs.txAt(s)));
        m4.compose(new THREE.Vector3(p.x, p.y + 0.4, p.z), q, sc);
        inst.setMatrixAt(n++, m4);
      }
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    this.props.add(inst);
  }

  private buildDecals() {
    const rs = this.rs;
    const texs = graffitiTextures();
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const n = 70;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.2 + rnd() * 0.6) * (rs.length / n);
      const sec = rs.sectionAt(s);
      if (sec.name === 'Karussell') continue;
      const dc = (rnd() < 0.5 ? -2.2 : 2.2) + (rnd() - 0.5) * 1.5;
      const tex = texs[Math.floor(rnd() * texs.length)];
      const w = 4.2, h = 10.5; // w along travel (text height), h across the road (text width)
      const cols = 14, rows = 6;
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      const p = new THREE.Vector3();
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          // text reads from the driver's seat: text 'up' = direction of travel
          const s_ = s + (r / rows - 0.5) * w; // along the track (texture v)
          const d_ = dc + (c / cols - 0.5) * h; // across the road
          rs.pos(s_, d_, p);
          pos.push(p.x, p.y + 0.035, p.z);
          uv.push(1 - c / cols, r / rows); // text reads left->right across the road, 'up' = travel direction
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const A = r * (cols + 1) + c, B = A + 1, C = A + cols + 1, D = C + 1;
        idx.push(A, C, B, B, C, D);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, color: 0xffffff }));
      m.renderOrder = 2;
      this.props.add(m);
    }
  }

  private buildSigns() {
    const rs = this.rs;
    for (const sec of rs.sections) {
      this.addSign(sec.sStart + 25, sec.name, sec.name === '起点 · T13' ? '纽北风格 · 7.2 km' : `S ${Math.round(sec.sStart)} m`, -1);
    }
  }

  /** Roadside board facing oncoming traffic. side -1 = right of the road (d<0). */
  addSign(s: number, title: string, sub: string, side: number, bg = '#0d3b66') {
    const rs = this.rs;
    const d = side * (TRACK_CFG.armcoD + 1.6);
    const p = rs.pos(s, d);
    const tex = signTexture(title, sub, bg);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.31), new THREE.MeshBasicMaterial({ map: tex }));
    const yaw = Math.atan2(rs.txAt(s), rs.tzAt(s)); // plane normal +Z -> face backwards along track
    board.position.set(p.x, p.y + 3.1, p.z);
    board.rotation.y = yaw + Math.PI;
    this.props.add(board);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.7 });
    for (const o of [-1.7, 1.7]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8), legMat);
      const lx = rs.txAt(s) * 0, lz = 0;
      void lx; void lz;
      // offset along board's width direction
      const wx = Math.cos(yaw + Math.PI), wz = -Math.sin(yaw + Math.PI);
      leg.position.set(p.x + wx * o, p.y + 1.6, p.z + wz * o);
      this.props.add(leg);
    }
  }

  /** Overhead gantry across the full road. */
  addGantry(s: number, title: string, sub: string, color = '#7a1010') {
    const rs = this.rs;
    const c = rs.pos(s, 0);
    const yaw = Math.atan2(rs.txAt(s), rs.tzAt(s));
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.5, metalness: 0.6 });
    const halfSpan = TRACK_CFG.armcoD + 1.5;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(halfSpan * 2 + 1, 0.5, 0.5), mat);
    beam.position.set(0, 7.2, 0);
    g.add(beam);
    for (const sgn of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8, 0.5), mat);
      post.position.set(sgn * halfSpan, 3.6, 0);
      g.add(post);
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.8), new THREE.MeshBasicMaterial({ map: signTexture(title, sub, color), side: THREE.DoubleSide }));
    banner.position.set(0, 5.6, 0.0);
    banner.rotation.y = Math.PI; // front faces the oncoming driver (-Z in gantry space)
    g.add(banner);
    // gantry is in a frame where +X = left of the road (l), +Z = forward ... build orientation
    g.rotation.y = yaw; // local +Z = travel direction, +X = left normal
    // base height: take min of road edge heights
    const y = Math.min(rs.height(s, halfSpan), rs.height(s, -halfSpan));
    g.position.set(c.x, y, c.z);
    this.props.add(g);
  }
}

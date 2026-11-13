// Crush deformation shared by the player's car and traffic cars.
//
// The thing that was hit (rail, another car) acts like a rigid plane pushed into the body by the
// permanent crush depth from the contact physics. Every vertex that sticks out past that plane is
// flattened onto it, with a short smooth blend behind the plane and crumple noise, limited to the
// contact height band. Geometry is copied before its first deformation so shared geometry stays intact.
import * as THREE from 'three';

interface Saved { pos: Float32Array; nrm: Float32Array | null; col: Float32Array | null }

const hash = (x: number, y: number, z: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
};
/** cheap smooth 3-D value noise in [0, 1) for crumple wrinkles */
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

export class MeshCrusher {
  private saved = new Map<THREE.Mesh, Saved>();
  private tmpM = new THREE.Matrix4();
  private v = new THREE.Vector3();

  get size() { return this.saved.size; }

  /**
   * Deform `meshes`. `bodyInv` maps world to the body frame (x forward, y up, z right); P is the contact
   * point and D the unit crush direction (into the body) in that frame; `bandHalf` is the half height of
   * the contact band around P.y. Returns false if nothing was within reach.
   */
  crush(meshes: THREE.Mesh[], bodyInv: THREE.Matrix4, P: THREE.Vector3, D: THREE.Vector3, crush: number, bandHalf: number): boolean {
    const RAIL_HALF = bandHalf;
    const reach = 0.9 + 2.2 * crush; // in-plane extent of the dent around the contact point
    // 1. find the outermost body surface along -D near the contact: that is where the rail touched
    let minDepth = Infinity;
    const rel = new Map<THREE.Mesh, THREE.Matrix4>();
    for (const m of meshes) {
      const M = new THREE.Matrix4().multiplyMatrices(bodyInv, m.matrixWorld);
      rel.set(m, M);
      const a = m.geometry.attributes.position as THREE.BufferAttribute;
      const step = Math.max(1, Math.floor(a.count / 1500));
      for (let i = 0; i < a.count; i += step) {
        this.v.fromBufferAttribute(a, i).applyMatrix4(M).sub(P);
        const depth = this.v.dot(D);
        const lat = Math.sqrt(Math.max(0, this.v.lengthSq() - depth * depth));
        if (lat < reach && Math.abs(this.v.y) < RAIL_HALF) minDepth = Math.min(minDepth, depth);
      }
    }
    if (!isFinite(minDepth) || crush < 0.005) return false;
    const plane = minDepth + crush;

    // 2. flatten everything outside the crushed plane, blend behind it
    const blend = 0.06 + 0.5 * crush;
    for (const m of meshes) {
      const M = rel.get(m)!;
      const a0 = m.geometry.attributes.position as THREE.BufferAttribute;
      // quick reject: bounding sphere entirely behind the blend zone or out of reach
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const bs = m.geometry.boundingSphere!;
      const c = this.v.copy(bs.center).applyMatrix4(M).sub(P);
      const scale = M.getMaxScaleOnAxis();
      if (c.dot(D) - bs.radius * scale > plane + blend) continue;
      if (Math.sqrt(Math.max(0, c.lengthSq() - c.dot(D) ** 2)) - bs.radius * scale > reach) continue;
      let moved: number[] | null = null;
      const inv = this.tmpM.copy(M).invert();
      const dLocal = D.clone().transformDirection(inv).multiplyScalar(1 / scale);
      const e = M.elements, arr = a0.array as Float32Array, stride = 3;
      const px = P.x, py = P.y, pz = P.z, Dx = D.x, Dy = D.y, Dz = D.z;
      for (let i = 0; i < a0.count; i++) {
        const lx = arr[i * stride], ly = arr[i * stride + 1], lz = arr[i * stride + 2];
        // body-frame position (affine transform, no allocation)
        const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
        const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
        const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        const qx = x - px, qy = y - py, qz = z - pz;
        const depth = qx * Dx + qy * Dy + qz * Dz;
        if (depth > plane + blend) continue;
        const lat2 = qx * qx + qy * qy + qz * qz - depth * depth;
        if (lat2 > reach * reach) continue;
        const hy = 1 - Math.min(1, Math.max(0, (Math.abs(qy) - RAIL_HALF * 0.6) / (RAIL_HALF * 0.8)));
        if (hy <= 0) continue;
        const fl = 1 - lat2 / (reach * reach); // fades out at the edge of the contact patch
        const flat = Math.max(0, plane - depth); // part that sticks out through the rail
        const behind = depth > plane ? blend - (depth - plane) : blend;
        const soft = Math.max(0, behind / blend) ** 2 * 0.35 * crush;
        const wrinkle = 0.75 + 0.5 * noise3(x * 7, y * 7, z * 7);
        const push = (flat + soft) * fl * hy * wrinkle;
        if (push < 1e-4) continue;
        if (!moved) { moved = []; this.ensureOwn(m); }
        const out = (m.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        out[i * 3] += dLocal.x * push; out[i * 3 + 1] += dLocal.y * push; out[i * 3 + 2] += dLocal.z * push;
        // meshes with vertex colours get scuffed where they are crushed (scraped paint, dark creases)
        const col = m.geometry.attributes.color as THREE.BufferAttribute | undefined;
        if (col) {
          const k = 1 - Math.min(0.75, push * 3 * wrinkle), ca = col.array as Float32Array;
          ca[i * 3] *= k; ca[i * 3 + 1] *= k; ca[i * 3 + 2] *= k;
          col.needsUpdate = true;
        }
        moved.push(i);
      }
      if (moved) this.fixNormals(m, moved);
    }

    return true;
  }

  /** put every deformed mesh back to its original shape */
  restore() {
    for (const [m, s] of this.saved) {
      const a = m.geometry.attributes.position as THREE.BufferAttribute;
      (a.array as Float32Array).set(s.pos); a.needsUpdate = true;
      const n = m.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      if (n && s.nrm) { (n.array as Float32Array).set(s.nrm); n.needsUpdate = true; }
      const c = m.geometry.attributes.color as THREE.BufferAttribute | undefined;
      if (c && s.col) { (c.array as Float32Array).set(s.col); c.needsUpdate = true; }
      m.geometry.computeBoundingSphere();
    }
  }

  /** geometry may be shared (ghost car, GLB template, other traffic cars): deform a private copy */
  private ensureOwn(m: THREE.Mesh) {
    if (this.saved.has(m)) return;
    m.geometry = m.geometry.clone();
    const a = m.geometry.attributes.position as THREE.BufferAttribute;
    const n = m.geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const c = m.geometry.attributes.color as THREE.BufferAttribute | undefined;
    this.saved.set(m, { pos: new Float32Array(a.array as Float32Array), nrm: n ? new Float32Array(n.array as Float32Array) : null, col: c ? new Float32Array(c.array as Float32Array) : null });
  }

  /** recompute normals only for the moved vertices (the rest keeps the authored shading) */
  private fixNormals(m: THREE.Mesh, moved: number[]) {
    const g = m.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    pos.needsUpdate = true;
    g.computeBoundingSphere();
    const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
    if (!nrm) return;
    const isMoved = new Uint8Array(pos.count);
    for (const i of moved) { isMoved[i] = 1; nrm.setXYZ(i, 0, 0, 0); }
    const idx = g.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
    for (let t = 0; t < tri; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if (!isMoved[i0] && !isMoved[i1] && !isMoved[i2]) continue;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      fn.subVectors(c, b).cross(a.sub(b)); // area-weighted
      for (const i of [i0, i1, i2]) if (isMoved[i]) nrm.setXYZ(i, nrm.getX(i) + fn.x, nrm.getY(i) + fn.y, nrm.getZ(i) + fn.z);
    }
    for (const i of moved) {
      a.fromBufferAttribute(nrm, i);
      if (a.lengthSq() > 0) { a.normalize(); nrm.setXYZ(i, a.x, a.y, a.z); }
    }
    nrm.needsUpdate = true;
  }
}

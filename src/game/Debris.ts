// Crash debris: torn-off car parts plus generated paint / carbon / glass fragments.
// Every piece is a small rigid body (position, velocity, orientation, angular velocity) under gravity.
// Ground contact: restitution in the normal direction, Coulomb friction impulse along the ground, rolling
// spin decay; the Armco reflects low pieces (high ones fly over); pieces sleep once at rest.
// Fragments are drawn with one InstancedMesh per material (3 draw calls for all of them).
import * as THREE from 'three';
import { road } from '../track/roadSurface';
import { TRACK_CFG, G } from '../config';

const E_GROUND = 0.3, MU_GROUND = 0.55, E_RAIL = 0.3, RAIL_TOP = 1.05;
const MAX_FRAGMENTS = 160;

interface Body {
  pos: THREE.Vector3; vel: THREE.Vector3; quat: THREE.Quaternion; ang: THREE.Vector3;
  r: number; scale: THREE.Vector3; sHint: number; sleeping: boolean; outside: boolean;
  obj?: THREE.Object3D; kind?: number; slot?: number;
}

export type GroundFn = (x: number, z: number, sHint: number) => { y: number; s: number; d: number };

export class Debris {
  group = new THREE.Group();
  private parts: Body[] = [];
  private frags: Body[] = [];
  private inst: THREE.InstancedMesh[];
  private free: number[][] = [[], [], []];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(private ground: GroundFn, paintColor: THREE.ColorRepresentation) {
    // an irregular thin shard (flattened, slightly bent tetrahedron pair)
    const shard = new THREE.BufferGeometry();
    const p = [0, 0.5, 0, -0.5, -0.4, 0.15, 0.55, -0.35, -0.1, 0.05, 0.1, 0.18, 0.05, 0.05, -0.18];
    shard.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    shard.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3, 0, 2, 4, 2, 1, 4, 1, 0, 4]);
    shard.computeVertexNormals();
    const mats = [
      new THREE.MeshStandardMaterial({ color: paintColor, metalness: 0.15, roughness: 0.3, side: THREE.DoubleSide, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.2, roughness: 0.45, side: THREE.DoubleSide, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x9fb4c0, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.55, side: THREE.DoubleSide, flatShading: true }),
    ];
    this.inst = mats.map((m, k) => {
      const im = new THREE.InstancedMesh(shard, m, MAX_FRAGMENTS);
      im.count = 0;
      im.visible = false; // no draw calls until something breaks
      im.castShadow = k < 2;
      im.frustumCulled = false;
      this.group.add(im);
      return im;
    });
  }

  setPaint(color: THREE.ColorRepresentation) { (this.inst[0].material as THREE.MeshStandardMaterial).color.set(color); }

  get count() { return this.parts.length + this.frags.length; }

  /** a real part that tore off the car: keeps its world pose and gets the contact-point velocity */
  addPart(obj: THREE.Object3D, vel: THREE.Vector3, sHint: number) {
    this.group.attach(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const pos = box.getCenter(new THREE.Vector3());
    // re-pivot the part around its centre so it tumbles about its own centre of mass
    const pivot = new THREE.Group();
    pivot.position.copy(pos);
    this.group.add(pivot);
    pivot.updateMatrixWorld(true);
    pivot.attach(obj);
    const r = Math.max(0.02, Math.min(size.x, size.y, size.z) / 2);
    this.parts.push({ pos, vel: vel.clone(), quat: new THREE.Quaternion(), ang: randAng(9), r, scale: new THREE.Vector3(1, 1, 1), sHint, sleeping: false, outside: false, obj: pivot });
  }

  /** generated fragments around a world point */
  spawnFragments(n: number, at: THREE.Vector3, base: THREE.Vector3, spray: THREE.Vector3, kinds: number[], sHint: number) {
    for (let k = 0; k < n; k++) {
      const kind = kinds[k % kinds.length];
      if (this.frags.length >= MAX_FRAGMENTS * 3) this.release(this.frags.shift()!);
      const slot = this.take(kind);
      if (slot < 0) continue;
      const size = kind === 2 ? 0.03 + Math.random() * 0.06 : 0.04 + Math.random() * 0.16;
      const scale = new THREE.Vector3(size, size * (0.5 + Math.random()), size * (0.15 + Math.random() * 0.25));
      const vel = base.clone()
        .addScaledVector(spray, 0.3 + Math.random())
        .add(new THREE.Vector3((Math.random() - 0.5) * 4, 1.5 + Math.random() * 4, (Math.random() - 0.5) * 4));
      const pos = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.3) * 0.4, (Math.random() - 0.5) * 0.5));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
      this.frags.push({ pos, vel, quat: q, ang: randAng(25), r: scale.z / 2 + 0.005, scale, sHint, sleeping: false, outside: false, kind, slot });
    }
  }

  clear() {
    for (const b of this.parts) b.obj!.removeFromParent();
    this.parts = [];
    this.frags = [];
    for (let k = 0; k < this.inst.length; k++) { this.inst[k].count = 0; this.inst[k].visible = false; this.free[k] = []; }
  }

  /** forget torn parts (a repair has put them back on the car) but keep the fragments on the track */
  clearParts() {
    for (const b of this.parts) b.obj!.removeFromParent();
    this.parts = [];
  }

  update(dt: number) {
    const n = Math.max(1, Math.ceil(dt * 120));
    const h = Math.min(dt, 0.1) / n;
    for (let k = 0; k < n; k++) {
      for (const b of this.parts) this.stepBody(b, h);
      for (const b of this.frags) this.stepBody(b, h);
    }
    for (const b of this.parts) { b.obj!.position.copy(b.pos); b.obj!.quaternion.copy(b.quat); }
    for (const b of this.frags) {
      this.m4.compose(b.pos, b.quat, b.scale);
      this.inst[b.kind!].setMatrixAt(b.slot!, this.m4);
    }
    for (const im of this.inst) { im.instanceMatrix.needsUpdate = true; im.visible = im.count > 0; }
  }

  private stepBody(b: Body, h: number) {
    if (b.sleeping) return;
    b.vel.y -= G * h;
    b.vel.multiplyScalar(1 - 0.02 * h); // air drag on small pieces
    b.pos.addScaledVector(b.vel, h);
    const w = b.ang.length();
    if (w > 1e-6) { this.q.setFromAxisAngle(this.tmpAxis.copy(b.ang).divideScalar(w), w * h); b.quat.premultiply(this.q).normalize(); }
    // ground and road frame under the piece
    const g = this.ground(b.pos.x, b.pos.z, b.sHint);
    b.sHint = g.s;
    // Armco: low pieces bounce back towards the track, high ones fly over it
    const ad = Math.abs(g.d);
    if (!b.outside && ad > TRACK_CFG.armcoD) {
      if (b.pos.y - g.y < RAIL_TOP) {
        road.frame(g.s, 0, this.o, this.f, this.l, this.nn);
        const side = Math.sign(g.d);
        const vl = b.vel.dot(this.l) * side;
        if (vl > 0) b.vel.addScaledVector(this.l, -side * (1 + E_RAIL) * vl);
        b.pos.addScaledVector(this.l, -side * (ad - TRACK_CFG.armcoD + 0.01));
        b.ang.multiplyScalar(0.7);
      } else b.outside = true;
    }
    if (b.pos.y - b.r < g.y) {
      b.pos.y = g.y + b.r;
      if (b.vel.y < 0) {
        const vn = -b.vel.y;
        b.vel.y = vn * E_GROUND;
        // Coulomb friction impulse along the ground, bounded so it can only stop the slide
        const ht = Math.hypot(b.vel.x, b.vel.z);
        if (ht > 1e-6) {
          const dv = Math.min(ht, MU_GROUND * (1 + E_GROUND) * vn + MU_GROUND * G * h);
          b.vel.x -= (b.vel.x / ht) * dv; b.vel.z -= (b.vel.z / ht) * dv;
        }
        b.ang.multiplyScalar(0.8);
        if (b.vel.lengthSq() < 0.04 && vn < 0.6) { b.sleeping = true; b.vel.set(0, 0, 0); b.ang.set(0, 0, 0); }
      }
    }
  }

  private take(kind: number) {
    const im = this.inst[kind];
    if (this.free[kind].length) return this.free[kind].pop()!;
    if (im.count < MAX_FRAGMENTS) return im.count++;
    return -1;
  }

  private release(b: Body) {
    this.m4.makeScale(0, 0, 0);
    this.inst[b.kind!].setMatrixAt(b.slot!, this.m4);
    this.inst[b.kind!].instanceMatrix.needsUpdate = true;
    this.free[b.kind!].push(b.slot!);
  }

  private tmpAxis = new THREE.Vector3();
  private o = new THREE.Vector3(); private f = new THREE.Vector3(); private l = new THREE.Vector3(); private nn = new THREE.Vector3();
}

function randAng(max: number) {
  return new THREE.Vector3((Math.random() - 0.5) * 2 * max, (Math.random() - 0.5) * 2 * max, (Math.random() - 0.5) * 2 * max);
}

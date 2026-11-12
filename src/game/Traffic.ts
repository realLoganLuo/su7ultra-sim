import * as THREE from 'three';
import { road } from '../track/roadSurface';
import { surfaceLocalY } from '../car/wheelContact';

export interface TrafficCar {
  s: number; d: number; v: number;
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  hitTimer: number;
}

export interface Cone {
  s: number; d: number;
  hit: boolean;
  vx: number; vz: number; fly: number; // knock animation
  t: number;
  group: 'random' | 'moose';
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const BODY_GEO = new THREE.BoxGeometry(4.5, 0.62, 1.82);
const CABIN_GEO = new THREE.BoxGeometry(2.1, 0.5, 1.55);
const WHEEL_GEO = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14);
const LIGHT_GEO = new THREE.BoxGeometry(0.05, 0.1, 1.5);

function makeTrafficMesh(color: number): { group: THREE.Group; wheels: THREE.Mesh[] } {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35 });
  const body = new THREE.Mesh(BODY_GEO, paint);
  body.position.y = 0.62;
  const cabin = new THREE.Mesh(CABIN_GEO, new THREE.MeshStandardMaterial({ color: 0x0b0e12, metalness: 0.3, roughness: 0.1 }));
  cabin.position.set(-0.2, 1.13, 0);
  const tail = new THREE.Mesh(LIGHT_GEO, new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff2020, emissiveIntensity: 1.5 }));
  tail.position.set(-2.26, 0.85, 0);
  g.add(body, cabin, tail);
  const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const wheels: THREE.Mesh[] = [];
  for (const x of [-1.4, 1.4]) for (const z of [-0.85, 0.85]) {
    const w = new THREE.Mesh(WHEEL_GEO, wm);
    wheels.push(w);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.33, z);
    g.add(w);
  }
  g.traverse((o) => { o.castShadow = true; });
  return { group: g, wheels };
}

export class Traffic {
  group = new THREE.Group();
  cars: TrafficCar[] = [];
  cones: Cone[] = [];
  private coneMesh: THREE.InstancedMesh;
  private tmpM = new THREE.Matrix4();
  private maxCones = 400;

  constructor(count = 9, avoid: [number, number][] = []) {
    const r = rng(2024);
    const colors = [0x3d5a80, 0xb23a48, 0x2a9d8f, 0x6d6875, 0xe9c46a, 0x264653, 0x8d99ae, 0xd62828, 0x588157];
    for (let i = 0; i < count; i++) {
      const s = ((i + 0.3 + r() * 0.4) / count) * road.length;
      const sec = road.sectionAt(s);
      if (sec.name === '起点 · T13') { /* keep clear of the start */ }
      if (avoid.some(([a, b]) => s > a && s < b)) continue;
      const tm = makeTrafficMesh(colors[i % colors.length]);
      const car: TrafficCar = {
        s: Math.max(s, 400), d: [-4, 0, 4][Math.floor(r() * 3)], v: (60 + r() * 55) / 3.6,
        mesh: tm.group, wheels: tm.wheels, hitTimer: 0,
      };
      this.cars.push(car);
      this.group.add(car.mesh);
    }
    // cones
    const geo = new THREE.ConeGeometry(0.2, 0.55, 12);
    geo.translate(0, 0.275, 0);
    const base = new THREE.BoxGeometry(0.42, 0.04, 0.42);
    base.translate(0, 0.02, 0);
    const merged = mergeTwo(geo, base);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.5, emissive: 0x331100, emissiveIntensity: 0.6 });
    this.coneMesh = new THREE.InstancedMesh(merged, mat, this.maxCones);
    this.coneMesh.frustumCulled = false;
    this.coneMesh.castShadow = true;
    this.coneMesh.count = 0;
    this.group.add(this.coneMesh);

    // random cone clusters
    let seed = 777;
    const rr = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 14; k++) {
      const s0 = 350 + ((k + 0.5 + (rr() - 0.5) * 0.6) / 14) * (road.length - 700);
      const lane = [-4, 0, 4][Math.floor(rr() * 3)];
      const n = 3 + Math.floor(rr() * 3);
      if (avoid.some(([a, b]) => s0 > a && s0 < b)) continue;
      for (let j = 0; j < n; j++) this.cones.push(this.newCone(s0 + j * 3, lane + (rr() - 0.5) * 1.8, 'random'));
    }
    this.refreshInstances();
  }

  private newCone(s: number, d: number, group: Cone['group']): Cone {
    return { s, d, hit: false, vx: 0, vz: 0, fly: 0, t: 0, group };
  }

  addMoose(sStart: number) {
    // three gates, 72 m apart: blocked lanes {0,-1} (free +1), {+1,-1} (free 0), {0,+1} (free -1)
    const gates: number[][] = [[0, -4], [4, -4], [0, 4]];
    gates.forEach((lanes, gi) => {
      const s = sStart + gi * 72;
      for (const ld of lanes) for (const off of [-1.4, -0.47, 0.47, 1.4]) this.cones.push(this.newCone(s, ld + off, 'moose'));
    });
    // guide cones marking the free lane entry
    this.refreshInstances();
  }

  /** move traffic out of a stretch (used by the test teleports) */
  clearArea(s: number, behind: number, ahead: number) {
    const L = road.length;
    for (const car of this.cars) {
      let d = car.s - s;
      d = ((d + L / 2) % L + L) % L - L / 2;
      if (d > -behind && d < ahead) car.s = road.wrap(car.s + 2600);
    }
  }

  resetCones() {
    for (const c of this.cones) { c.hit = false; c.t = 0; c.fly = 0; }
    this.refreshInstances();
  }

  refreshInstances() {
    const n = Math.min(this.cones.length, this.maxCones);
    this.coneMesh.count = n;
    for (let i = 0; i < n; i++) this.writeCone(i);
    this.coneMesh.instanceMatrix.needsUpdate = true;
  }

  private writeCone(i: number) {
    const c = this.cones[i];
    const m = this.tmpM;
    const p = road.pos(c.s, c.d);
    if (!c.hit) {
      m.makeTranslation(p.x, p.y, p.z);
    } else {
      const t = c.t;
      const lat = new THREE.Vector3(road.lxAt(c.s), 0, road.lzAt(c.s));
      const fwd = new THREE.Vector3(road.txAt(c.s), 0, road.tzAt(c.s));
      const h = Math.max(0, c.fly * t - 9 * t * t);
      const pos = new THREE.Vector3(p.x, p.y + h, p.z).addScaledVector(fwd, c.vx * t).addScaledVector(lat, c.vz * t);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(t * 9, t * 5, t * 7));
      const settle = Math.min(1, t * 1.0);
      void settle;
      m.compose(pos, q, new THREE.Vector3(1, 1, 1));
    }
    this.coneMesh.setMatrixAt(i, m);
  }

  hitCone(c: Cone, carV: number, side: number) {
    c.hit = true;
    c.vx = Math.min(30, carV * 0.9);
    c.vz = side * (4 + Math.random() * 4);
    c.fly = 6 + Math.random() * 4;
    c.t = 0;
  }

  update(dt: number) {
    for (const car of this.cars) {
      car.s = road.wrap(car.s + car.v * dt);
      if (car.hitTimer > 0) car.hitTimer -= dt;
    }
    let dirty = false;
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      if (c.hit && c.t < 3) { c.t += dt; this.writeCone(i); dirty = true; }
    }
    if (dirty) this.coneMesh.instanceMatrix.needsUpdate = true;
  }

  syncMeshes() {
    const o = new THREE.Vector3(), f = new THREE.Vector3(), l = new THREE.Vector3(), n = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const car of this.cars) {
      road.frame(car.s, car.d, o, f, l, n);
      const right = new THREE.Vector3().crossVectors(f, n);
      m.makeBasis(f, n, right);
      car.mesh.quaternion.setFromRotationMatrix(m);
      car.mesh.position.copy(o);
      car.mesh.updateMatrixWorld(true);
      // every tyre sits on the real road surface (1 cm embedded = static deflection)
      for (const w of car.wheels) w.position.y = surfaceLocalY(car.mesh, car.s, w.position.x, w.position.z) + 0.33 - 0.01;
      car.mesh.visible = car.hitTimer <= 0 || Math.floor(car.hitTimer * 8) % 2 === 0;
    }
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pa = a.getAttribute('position'), pb = b.getAttribute('position');
  const na = a.getAttribute('normal'), nb = b.getAttribute('normal');
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let i = 0; i < pa.count; i++) { pos.push(pa.getX(i), pa.getY(i), pa.getZ(i)); nor.push(na.getX(i), na.getY(i), na.getZ(i)); }
  const off = pa.count;
  for (let i = 0; i < pb.count; i++) { pos.push(pb.getX(i), pb.getY(i), pb.getZ(i)); nor.push(nb.getX(i), nb.getY(i), nb.getZ(i)); }
  if (a.index) for (let i = 0; i < a.index.count; i++) idx.push(a.index.getX(i));
  if (b.index) for (let i = 0; i < b.index.count; i++) idx.push(b.index.getX(i) + off);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

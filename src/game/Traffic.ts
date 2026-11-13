import * as THREE from 'three';
import { road } from '../track/roadSurface';
import { surfaceLocalY } from '../car/wheelContact';
import { TRACK_CFG, G, CAR } from '../config';
import { collide, RigidState, CAR_CONTACT } from '../physics/CarContact';
import type { Vehicle } from '../physics/Vehicle';
import type { Impact } from '../physics/Barrier';
import { MeshCrusher } from '../car/crush';

/**
 * A traffic car. While cruising it follows its lane kinematically. After a hit it is a rigid body
 * (two-axle model with saturating tyres): it slides and spins under its tyre forces while the driver
 * brakes, steers back to the lane once it has it under control, and resumes speed. A heavy hit wrecks it:
 * it brakes to a stop and stays there.
 */
export interface TrafficCar {
  s: number; d: number;
  /** forward (body-frame) speed */
  v: number;
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
  hitTimer: number;
  yaw: number; w: number; r: number; // heading from the road tangent, lateral body speed, yaw rate
  lane: number; cruiseV: number;
  mode: 'cruise' | 'loose' | 'wrecked';
  damageJ: number;
  touching: boolean;
  /** deformation energy of an ongoing contact not yet reported as an impact */
  pendingJ: number;
  homeLane: number;
  /** wheels torn off (same order as `wheels`: RL, RR, FL, FR) */
  wheelOff: boolean[];
  body: THREE.Mesh[]; // deformable bodywork
  tail: THREE.Mesh;
}

export const TRAFFIC_BODY = { m: 1500, I: 2900, hx: 2.25, hy: 0.91, a: 1.35, b: 1.35, C: 70000, mu: 1.0, wreckJ: 40e3, wheelOffJ: 45e3 };
/** wheel positions in the car frame (x forward, y left), same order as TrafficCar.wheels */
const WHEEL_XY: [number, number][] = [[-1.4, 0.85], [-1.4, -0.85], [1.4, 0.85], [1.4, -0.85]];

/** an impact on a traffic car, for the visuals (deformation, debris, bent rail) */
export interface TrafficHit {
  car: TrafficCar;
  /** contact point and push direction (into the car) in the car frame: x forward, y left */
  x: number; yL: number; nx: number; nyL: number;
  energyJ: number; crush: number;
  kind: 'barrier' | 'car';
  s: number; side: 1 | -1;
  /** road-frame velocity of the car at the impact */
  vS: number; vD: number;
  wheelsOff: number[];
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

// segmented so that crash damage can crumple them (shared until a car is actually deformed)
const BODY_GEO = new THREE.BoxGeometry(4.5, 0.62, 1.82, 18, 3, 8);
const CABIN_GEO = new THREE.BoxGeometry(2.1, 0.5, 1.55, 8, 2, 6);
for (const g of [BODY_GEO, CABIN_GEO]) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
const WHEEL_GEO = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14);
const LIGHT_GEO = new THREE.BoxGeometry(0.05, 0.1, 1.5);

function makeTrafficMesh(color: number): { group: THREE.Group; wheels: THREE.Mesh[]; body: THREE.Mesh[]; tail: THREE.Mesh } {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35, vertexColors: true });
  const body = new THREE.Mesh(BODY_GEO, paint);
  body.position.y = 0.62;
  const cabin = new THREE.Mesh(CABIN_GEO, new THREE.MeshStandardMaterial({ color: 0x0b0e12, metalness: 0.3, roughness: 0.1, vertexColors: true }));
  cabin.position.set(-0.2, 1.13, 0);
  const tail = new THREE.Mesh(LIGHT_GEO, new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff2020, emissiveIntensity: 1.5 }));
  tail.position.set(-2.26, 0.85, 0);
  g.add(body, cabin, tail);
  const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const wheels: THREE.Mesh[] = [];
  for (const [x, yL] of WHEEL_XY) {
    const w = new THREE.Mesh(WHEEL_GEO, wm);
    wheels.push(w);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.33, -yL);
    g.add(w);
  }
  g.traverse((o) => { o.castShadow = true; });
  return { group: g, wheels, body: [body, cabin], tail };
}

export function makeTrafficCar(s: number, d: number, v: number, color = 0x3d5a80): TrafficCar {
  const tm = makeTrafficMesh(color);
  return {
    s, d, v, mesh: tm.group, wheels: tm.wheels, body: tm.body, tail: tm.tail, hitTimer: 0,
    yaw: 0, w: 0, r: 0, lane: d, homeLane: d, cruiseV: v, mode: 'cruise', damageJ: 0, touching: false, pendingJ: 0,
    wheelOff: [false, false, false, false],
  };
}

/** something a cruising driver has to brake for or drive around */
export interface Obstacle { s: number; d: number; vS: number; half: number }

export class Traffic {
  group = new THREE.Group();
  cars: TrafficCar[] = [];
  cones: Cone[] = [];
  private coneMesh: THREE.InstancedMesh;
  private tmpM = new THREE.Matrix4();
  private maxCones = 400;
  /** impacts on traffic cars since the consumer last drained this queue */
  hits: TrafficHit[] = [];
  private crusher = new MeshCrusher();
  private pairs = new Map<number, { touching: boolean; pendingJ: number }>();

  constructor(count = 9, avoid: [number, number][] = []) {
    const r = rng(2024);
    const colors = [0x3d5a80, 0xb23a48, 0x2a9d8f, 0x6d6875, 0xe9c46a, 0x264653, 0x8d99ae, 0xd62828, 0x588157];
    for (let i = 0; i < count; i++) {
      const s = ((i + 0.3 + r() * 0.4) / count) * road.length;
      const sec = road.sectionAt(s);
      if (sec.name === '起点 · T13') { /* keep clear of the start */ }
      if (avoid.some(([a, b]) => s > a && s < b)) continue;
      const car = makeTrafficCar(Math.max(s, 400), [-4, 0, 4][Math.floor(r() * 3)], (60 + r() * 55) / 3.6, colors[i % colors.length]);
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

  /** back to normal traffic (new session) */
  repair() {
    this.crusher.restore();
    this.hits = []; this.pairs.clear();
    for (const c of this.cars) {
      c.mode = 'cruise'; c.lane = c.homeLane; c.d = c.lane; c.v = c.cruiseV; c.yaw = c.w = c.r = 0;
      c.damageJ = 0; c.hitTimer = 0; c.touching = false; c.pendingJ = 0;
      c.tail.visible = true;
      for (let k = 0; k < 4; k++) {
        if (!c.wheelOff[k]) continue;
        c.wheelOff[k] = false;
        const w = c.wheels[k];
        c.mesh.add(w);
        w.position.set(WHEEL_XY[k][0], 0.33, -WHEEL_XY[k][1]); w.quaternion.identity(); w.rotation.x = Math.PI / 2; w.scale.set(1, 1, 1);
      }
    }
  }

  /**
   * Record an impact on a traffic car: damage, wreck threshold, wheels torn off by a big local hit.
   * (x, yL) contact point and (nx, nyL) push direction in the car frame.
   */
  registerHit(car: TrafficCar, x: number, yL: number, nx: number, nyL: number, energyJ: number, kind: 'barrier' | 'car', side: 1 | -1) {
    const B = TRAFFIC_BODY;
    car.damageJ += energyJ;
    const wheelsOff: number[] = [];
    for (let k = 0; k < 4; k++) {
      if (car.wheelOff[k]) continue;
      const local = energyJ * Math.max(0, 1 - Math.hypot(WHEEL_XY[k][0] - x, WHEEL_XY[k][1] - yL) / 2);
      if (local > B.wheelOffJ) { car.wheelOff[k] = true; wheelsOff.push(k); }
    }
    if (car.damageJ > B.wreckJ || wheelsOff.length) car.mode = 'wrecked';
    else if (car.mode === 'cruise') car.mode = 'loose';
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    this.hits.push({
      car, x, yL, nx, nyL, energyJ, crush: Math.min(0.5, Math.sqrt((energyJ * 2) / CAR_CONTACT.kBody)), kind,
      s: car.s, side, vS: car.v * cy - car.w * sy, vD: car.v * sy + car.w * cy, wheelsOff,
    });
    if (this.hits.length > 32) this.hits.shift();
  }

  state(car: TrafficCar, s: number): RigidState {
    const B = TRAFFIC_BODY, cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    return { s, d: car.d, yaw: car.yaw, vS: car.v * cy - car.w * sy, vD: car.v * sy + car.w * cy, w: car.r, m: B.m, I: B.I, hx: B.hx, hy: B.hy, cx: 0 };
  }

  writeBack(car: TrafficCar, st: RigidState) {
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    car.v = st.vS * cy + st.vD * sy; car.w = -st.vS * sy + st.vD * cy; car.r = st.w;
  }

  /** contact point (road frame, from the CG) and push direction into a car, expressed in its own frame */
  static local(car: TrafficCar, rS: number, rD: number, nS: number, nD: number): [number, number, number, number] {
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    return [rS * cy + rD * sy, -rS * sy + rD * cy, nS * cy + nD * sy, -nS * sy + nD * cy];
  }

  /** rigid-body contact between traffic cars (same impulse model as player vs traffic) */
  private carVsCar() {
    const L = road.length, n = this.cars.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = this.cars[i], b = this.cars[j];
      const ds = ((b.s - a.s + L / 2) % L + L) % L - L / 2;
      const key = i * 64 + j;
      if (Math.abs(ds) > 7 || Math.abs(b.d - a.d) > 6) { if (this.pairs.has(key)) this.pairs.delete(key); continue; }
      const A = this.state(a, 0), B = this.state(b, ds);
      const hit = collide(A, B, ds);
      a.s = road.wrap(a.s + A.s); a.d = A.d;
      b.s = road.wrap(b.s + (B.s - ds)); b.d = B.d;
      if (!hit) continue;
      this.writeBack(a, A); this.writeBack(b, B);
      const half = hit.energyJ / 2;
      let pr = this.pairs.get(key);
      if (!pr) { pr = { touching: false, pendingJ: 0 }; this.pairs.set(key, pr); }
      const fresh = !pr.touching;
      pr.touching = true; pr.pendingJ += half;
      if (a.mode === 'cruise') a.mode = 'loose';
      if (b.mode === 'cruise') b.mode = 'loose';
      if (!fresh && pr.pendingJ < 6e3) continue;
      const e = pr.pendingJ; pr.pendingJ = 0;
      this.registerHit(a, ...Traffic.local(a, hit.rAS, hit.rAD, hit.nS, hit.nD), e, 'car', hit.nD >= 0 ? -1 : 1);
      this.registerHit(b, ...Traffic.local(b, hit.rBS, hit.rBD, -hit.nS, -hit.nD), e, 'car', hit.nD >= 0 ? 1 : -1);
    }
  }

  /**
   * A cruising driver looks ahead in the own lane: brakes for anything slower (keeping a time gap) and
   * moves to a free neighbouring lane to pass something much slower or stopped.
   */
  private drive(car: TrafficCar, dt: number, extra: Obstacle[]) {
    const L = road.length, B = TRAFFIC_BODY;
    const look = 25 + (car.v * car.v) / (2 * 5);
    let gap = Infinity, vAhead = 0;
    const blocked = (lane: number, behind: number, ahead: number, self: boolean) => {
      let hit = false;
      const test = (s: number, d: number, vS: number, half: number) => {
        const ds = ((s - car.s + L / 2) % L + L) % L - L / 2;
        // something closing from behind needs more room: 4 s at the closing speed
        if (ds < -(behind + 4 * Math.max(0, vS - car.v)) || ds > ahead || Math.abs(d - lane) > half + B.hy + 0.5) return;
        hit = true;
        if (self && ds > 0 && vS < car.v + 0.5 && ds < gap) { gap = ds; vAhead = Math.max(0, vS); }
      };
      for (const o of this.cars) {
        if (o === car) continue;
        const cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
        test(o.s, o.d, o.v * cy - o.w * sy, B.hx * Math.abs(sy) + B.hy * Math.abs(cy));
      }
      for (const o of extra) test(o.s, o.d, o.vS, o.half);
      return hit;
    };
    blocked(car.d, 0, look, true);
    let target = car.cruiseV;
    if (gap < Infinity) {
      // speed that still stops / matches at a 6 m + 0.8 s gap with 6 m/s² braking
      const room = Math.max(0, gap - 2 * B.hx - 3 - 0.4 * vAhead);
      target = Math.min(target, Math.sqrt(vAhead * vAhead + 2 * 6 * room));
      if (vAhead < 0.9 * car.cruiseV && Math.abs(car.d - car.lane) < 0.3) {
        for (const lane of [car.lane - 4, car.lane + 4]) {
          if (Math.abs(lane) > 4.01) continue;
          if (!blocked(lane, 15 + car.v, look, false)) { car.lane = lane; break; }
        }
      }
    }
    car.v += Math.max(-8 * dt, Math.min(2 * dt, target - car.v));
    if (car.v < 0.05 && target < 0.05) car.v = 0;
    car.s = road.wrap(car.s + car.v * dt);
    car.d += Math.max(-1.5 * dt, Math.min(1.5 * dt, car.lane - car.d));
  }

  /** deform a hit car, tear its wheels off; returns the loose wheels (world pose kept) for the debris */
  applyHit(h: TrafficHit): THREE.Object3D[] {
    const car = h.car;
    car.mesh.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(car.mesh.matrixWorld).invert();
    const P = new THREE.Vector3(h.x, 0.62, -h.yL), D = new THREE.Vector3(h.nx, 0, -h.nyL).normalize();
    if (h.crush > 0.005) this.crusher.crush(car.body, inv, P, D, h.crush, 0.55);
    if (h.x < -1.6 && h.crush > 0.12) car.tail.visible = false; // smashed
    const out: THREE.Object3D[] = [];
    for (const k of h.wheelsOff) { const w = car.wheels[k]; car.mesh.parent?.attach(w); out.push(w); }
    return out;
  }

  update(dt: number, obstacles: Obstacle[] = []) {
    for (const car of this.cars) {
      if (car.hitTimer > 0) car.hitTimer -= dt;
      if (car.mode === 'cruise') { this.drive(car, dt, obstacles); continue; }
      for (let k = 0; k < 2; k++) this.looseStep(car, dt / 2);
      // regained control: straight, slow yaw, near its lane
      if (car.mode === 'loose' && Math.abs(car.yaw) < 0.05 && Math.abs(car.r) < 0.08 && Math.abs(car.w) < 0.4 && Math.abs(car.d - car.lane) < 0.5) {
        car.mode = 'cruise'; car.yaw = 0; car.w = 0; car.r = 0;
      }
    }
    this.carVsCar();
    let dirty = false;
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      if (c.hit && c.t < 3) { c.t += dt; this.writeCone(i); dirty = true; }
    }
    if (dirty) this.coneMesh.instanceMatrix.needsUpdate = true;
  }

  /** rigid-body step of a car that is not simply cruising */
  private looseStep(car: TrafficCar, h: number) {
    const B = TRAFFIC_BODY;
    const u = car.v;
    // driver: brake (harder when wrecked), steer back to the lane once the car is pointing roughly forward
    const brakeG = car.mode === 'wrecked' ? 0.9 : Math.abs(car.yaw) > 0.25 || Math.abs(car.r) > 0.3 ? 0.6 : 0.15;
    const steer = car.mode === 'loose' && Math.abs(car.yaw) < 0.6 && u > 1
      ? Math.max(-0.35, Math.min(0.35, 0.05 * (car.lane - car.d) - 0.8 * car.yaw - 0.25 * car.r - 0.03 * car.w))
      : 0;
    const fz = (B.m * G) / 2;
    let fx: number, fyF: number, fyR: number;
    if (car.mode === 'wrecked' || Math.abs(car.yaw) > 0.6) {
      // brakes locked (or a wrecked car's wheels jammed): each axle slides, and its friction opposes that
      // axle's own sliding velocity; the front / rear difference is what damps the spin
      const vF = Math.hypot(u, car.w + B.a * car.r), vR = Math.hypot(u, car.w - B.b * car.r);
      const kF = vF > 0.05 ? (B.mu * fz) / vF : 0, kR = vR > 0.05 ? (B.mu * fz) / vR : 0;
      fx = -(kF + kR) * u;
      fyF = -kF * (car.w + B.a * car.r);
      fyR = -kR * (car.w - B.b * car.r);
    } else {
      const fxMax = B.mu * B.m * G;
      // under control again but slow or stopped off its line: drive on gently so it can steer back
      const calm = car.mode === 'loose' && Math.abs(car.yaw) < 0.25 && Math.abs(car.r) < 0.3;
      fx = calm && u < 8 ? 0.2 * B.m * G
        : Math.abs(u) > 0.3 ? -Math.sign(u) * Math.min(fxMax * 0.95, brakeG * B.m * G) : -u * B.m / h * 0.5;
      const lat = Math.sqrt(Math.max(0, 1 - (fx / fxMax) ** 2)); // friction circle (ABS keeps the wheels turning)
      const lim = B.mu * fz * lat;
      const cd = Math.cos(steer), sd = Math.sin(steer);
      const vyF = car.w + B.a * car.r;
      const af = Math.abs(u) + Math.abs(vyF) < 0.3 ? 0 : -Math.atan2(vyF * cd - u * sd, Math.abs(u * cd + vyF * sd));
      const ar = Math.abs(u) + Math.abs(car.w) < 0.3 ? 0 : -Math.atan2(car.w - B.b * car.r, Math.abs(u));
      fyF = lim * Math.tanh((B.C * af) / Math.max(1, lim)); fyR = lim * Math.tanh((B.C * ar) / Math.max(1, lim));
    }
    const cor = car.w * car.r;
    car.w += h * ((fyF + fyR) / B.m - u * car.r);
    car.v += h * (fx / B.m + cor);
    car.r += h * (B.a * fyF - B.b * fyR) / B.I;
    if (fx <= 0 && Math.abs(car.v) < 0.05 && Math.abs(car.w) < 0.05) { car.v = 0; car.w = 0; car.r *= 0.9; } // at rest (not when pulling away)
    // pose in road coordinates
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const kap = road.curvature(car.s);
    const dsdt = (car.v * cy - car.w * sy) / Math.max(0.25, 1 - kap * car.d);
    car.yaw += (car.r - kap * dsdt) * h;
    car.yaw = Math.atan2(Math.sin(car.yaw), Math.cos(car.yaw));
    car.d += (car.v * sy + car.w * cy) * h;
    car.s = road.wrap(car.s + dsdt * h);
    // the Armco stops it (inelastic, scraping)
    const lim2 = TRACK_CFG.armcoD - (B.hx * Math.abs(sy) + B.hy * Math.abs(cy));
    if (Math.abs(car.d) > lim2) {
      car.d = Math.sign(car.d) * lim2;
      const vd = car.v * sy + car.w * cy, vs = car.v * cy - car.w * sy;
      const side = car.d > 0 ? 1 : -1;
      if (vd * side > 0.5) {
        // the normal kinetic energy goes into the bodywork and the rail; contact at the leading corner
        let cx = B.hx, cyL = B.hy, best = -Infinity;
        for (const [x, y] of [[B.hx, B.hy], [B.hx, -B.hy], [-B.hx, B.hy], [-B.hx, -B.hy]]) { const reach = side * (x * sy + y * cy); if (reach > best) { best = reach; cx = x; cyL = y; } }
        this.registerHit(car, cx, cyL, -side * sy, -side * cy, 0.5 * B.m * vd * vd, 'barrier', side);
      }
      if (vd * Math.sign(car.d) > 0) { // remove the motion into the rail, keep a scraped share of the rest
        const vs2 = vs * 0.8;
        car.v = vs2 * cy; car.w = -vs2 * sy;
        car.r *= 0.5;
      }
    }
  }

  syncMeshes() {
    const o = new THREE.Vector3(), f = new THREE.Vector3(), l = new THREE.Vector3(), n = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const car of this.cars) {
      road.frame(car.s, car.d, o, f, l, n);
      const right = new THREE.Vector3().crossVectors(f, n);
      m.makeBasis(f, n, right);
      car.mesh.quaternion.setFromRotationMatrix(m);
      if (car.yaw !== 0) car.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(n, car.yaw));
      car.mesh.position.copy(o);
      // a corner without its wheel drops onto the road (~0.18 m): tilt the body towards it
      if (car.wheelOff.some(Boolean)) {
        let a = 0, b = 0;
        for (let k = 0; k < 4; k++) if (car.wheelOff[k]) { a -= (0.09 * Math.sign(WHEEL_XY[k][0])) / 1.4; b -= (0.09 * Math.sign(-WHEEL_XY[k][1])) / 0.85; }
        car.mesh.rotateZ(Math.atan(a)); car.mesh.rotateX(-Math.atan(b));
        car.mesh.position.addScaledVector(n, -0.09 * car.wheelOff.filter(Boolean).length / 2);
      }
      car.mesh.updateMatrixWorld(true);
      // every tyre sits on the real road surface (1 cm embedded = static deflection)
      for (let k = 0; k < 4; k++) { const w = car.wheels[k]; if (!car.wheelOff[k]) w.position.y = surfaceLocalY(car.mesh, car.s, w.position.x, w.position.z) + 0.33 - 0.01; }
    }
  }
}

/**
 * Rigid-body contact between the player's car and a traffic car: impulse, overlap removal, and the
 * deformation energy split equally between the two crush zones. A new contact (or a hard one) is
 * registered as an impact on both cars (damage, wheels, debris). Returns null if they do not touch.
 */
export function playerVsTraffic(traffic: Traffic, p: Vehicle, car: TrafficCar, ds: number): { impact: Impact | null; energyJ: number; fresh: boolean } | null {
  if (Math.abs(ds) > 9 || Math.abs(car.d - p.d) > 6) { car.touching = false; return null; }
  const [pvS, pvD] = p.roadVelocity();
  const A: RigidState = { s: 0, d: p.d, yaw: p.yaw, vS: pvS, vD: pvD, w: p.yawRate, m: CAR.mass, I: CAR.yawInertia, hx: 2.6, hy: 1.03, cx: 0.05 };
  const B = traffic.state(car, ds);
  const hit = collide(A, B, ds);
  // positions (overlap removed even without an impulse)
  p.shift(A.s, A.d - p.d);
  car.s = road.wrap(car.s + (B.s - ds)); car.d = B.d;
  if (!hit) { if (Math.abs(ds) > 6) car.touching = false; return null; }
  p.applyImpulse(hit.jn * hit.nS - hit.jt * hit.nD, hit.jn * hit.nD + hit.jt * hit.nS, hit.rAS, hit.rAD);
  traffic.writeBack(car, B);
  if (car.mode === 'cruise') car.mode = 'loose';
  const half = hit.energyJ / 2;
  const fresh = !car.touching;
  car.touching = true;
  // A sustained push is many small impulses: report a new impact (damage, debris) for the first touch
  // and then for every 6 kJ the ongoing contact has absorbed.
  car.pendingJ += half;
  if (!fresh && car.pendingJ < 6e3) return { impact: null, energyJ: half, fresh };
  const reported = car.pendingJ;
  car.pendingJ = 0;
  traffic.registerHit(car, ...Traffic.local(car, hit.rBS, hit.rBD, -hit.nS, -hit.nD), reported, 'car', hit.nD >= 0 ? 1 : -1);
  const pc = Math.cos(p.yaw), ps = Math.sin(p.yaw);
  const impact = p.registerImpact({
    corner: -1,
    x: hit.rAS * pc + hit.rAD * ps, yL: -hit.rAS * ps + hit.rAD * pc,
    nx: hit.nS * pc + hit.nD * ps, nyL: -hit.nS * ps + hit.nD * pc,
    normalSpeed: hit.closing, energyJ: reported,
    penetration: hit.pen, bodyCrush: Math.min(0.5, Math.sqrt((reported * 2) / CAR_CONTACT.kBody)), railBend: 0,
    s: road.wrap(p.s + hit.rAS), side: hit.nD >= 0 ? -1 : 1, slideSpeed: pvS, vS: pvS, vD: pvD,
    kind: 'car', nS: hit.nS, nD: hit.nD,
  });
  return { impact, energyJ: half, fresh };
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

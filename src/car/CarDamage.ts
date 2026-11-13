// Visible crash damage on a CarModel, driven by physical barrier impacts (src/physics/Barrier.ts).
//
// The bodywork is flattened against the impact plane by the permanent crush depth the contact model
// computed (see crush.ts): a glancing hit scrapes a flank flat by a few centimetres, a corner hit folds
// the corner in.
// Small exterior parts near a hard hit tear off (handed to the debris system), side glass near it breaks.
// Wheel alignment and torn-off wheels follow the physical wheel damage of the Vehicle.
import * as THREE from 'three';
import type { CarModel } from './CarModel';
import { WHEEL_POS } from './CarModel';
import type { Impact } from '../physics/Barrier';
import { MeshCrusher } from './crush';

/** rail contact height band in the car frame (lower rail 0.52 m, upper 0.86 m, 0.3 m profile) */
const RAIL_Y = 0.69, RAIL_HALF = 0.46;

export interface TornPart { obj: THREE.Object3D; parent: THREE.Object3D; local: THREE.Matrix4 }

export class CarDamage {
  private crusher = new MeshCrusher();
  private torn: TornPart[] = [];
  private hidden: THREE.Object3D[] = [];
  private wheelHandles: { i: number; steer: THREE.Group; spin: THREE.Group }[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpInv = new THREE.Matrix4();

  constructor(private car: CarModel) {}

  get damaged() { return this.crusher.size > 0 || this.torn.length > 0; }

  /**
   * Deform the body for one impact. Returns exterior parts that tore off (now detached from the car,
   * still at their world transform) for the debris system.
   */
  apply(im: Impact): THREE.Object3D[] {
    const car = this.car;
    car.root.updateMatrixWorld(true);
    // body frame == car root frame at rest (bodyGroup / bodyMesh offsets cancel)
    const bodyInv = this.tmpInv.copy(car.bodyMesh.matrixWorld).invert();
    // contact point and crush direction (into the car) in the body frame: x forward, y up, z right
    const P = new THREE.Vector3(im.x, RAIL_Y, -im.yL);
    const D = new THREE.Vector3(im.nx, 0, -im.nyL).normalize();
    const crush = Math.min(0.55, im.bodyCrush);
    const meshes: THREE.Mesh[] = [];
    car.bodyMesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible) meshes.push(m); });

    // 1 + 2. flatten the bodywork against the impact plane
    if (!this.crusher.crush(meshes, bodyInv, P, D, crush, RAIL_HALF)) return [];

    // 3. tear off small exterior parts close to a hard hit, break side glass
    const torn: THREE.Object3D[] = [];
    if (im.energyJ > 6e3 && car.glb) {
      const box = new THREE.Box3(), ctr = new THREE.Vector3(), size = new THREE.Vector3();
      for (const part of car.glb.bodyParts) {
        if (!part.parent || this.torn.some((t) => t.obj === part)) continue;
        box.makeEmpty();
        part.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const g = (o as THREE.Mesh).geometry; if (!g.boundingBox) g.computeBoundingBox(); box.union(g.boundingBox!.clone().applyMatrix4(this.tmpM.multiplyMatrices(bodyInv, o.matrixWorld))); } });
        if (box.isEmpty()) continue;
        box.getCenter(ctr); box.getSize(size);
        const near = ctr.distanceTo(P) < 0.6 + 1.4 * crush + size.length() / 2;
        const isGlass = /^(window_|windscreen)/.test(part.name);
        const isLight = /light|indicator|lamp/.test(part.name);
        if (near && isGlass && im.energyJ > 25e3 && Math.abs(ctr.z) > 0.6) {
          part.visible = false; this.hidden.push(part);
        } else if (near && isLight && size.length() < 0.95) {
          this.torn.push({ obj: part, parent: part.parent, local: part.matrix.clone() });
          car.root.parent?.attach(part); // keep its world transform, leave the car
          torn.push(part);
        }
      }
    }

    return torn;
  }

  /**
   * Tear a whole wheel (with its upright) off the car. Returns it at its world pose for the debris
   * system; the car's steer / spin handles are replaced by placeholders until the repair.
   */
  detachWheel(i: number): THREE.Object3D {
    const car = this.car;
    const steer = car.steerGroups[i], spin = car.spinGroups[i];
    this.torn.push({ obj: steer, parent: car.wheelGroups[i], local: steer.matrix.clone() });
    this.wheelHandles.push({ i, steer, spin });
    car.steerGroups[i] = new THREE.Group();
    car.spinGroups[i] = new THREE.Group();
    car.root.parent?.attach(steer);
    return steer;
  }

  /** wheel alignment from the physical damage state: toe, camber, and a bent rim's wobble */
  alignWheels(dmg: { toe: number; camber: number; runout: number; detached: boolean }[], spin: number[]) {
    for (let i = 0; i < 4; i++) {
      const d = dmg[i];
      const side = WHEEL_POS[i].left ? 1 : -1;
      this.car.wheelGroups[i].rotation.set(side * d.camber, d.toe + d.runout * 0.15 * Math.sin(spin[i]), 0);
    }
  }

  /** undo everything (new car) */
  repair() {
    for (const h of this.wheelHandles) { this.car.steerGroups[h.i] = h.steer; this.car.spinGroups[h.i] = h.spin; }
    this.wheelHandles = [];
    this.crusher.restore();
    for (const t of this.torn) {
      t.parent.add(t.obj);
      t.obj.matrix.copy(t.local);
      t.obj.matrix.decompose(t.obj.position, t.obj.quaternion, t.obj.scale);
    }
    this.torn = [];
    for (const h of this.hidden) h.visible = true;
    this.hidden = [];
    for (const g of this.car.wheelGroups) g.rotation.set(0, 0, 0);
  }

}

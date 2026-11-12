// X-ray visualisation: double wishbones, coil spring + damper (colour coded by actuator force),
// and the brake signal path (electric pulses for EMB, slow oil flow for hydraulic).
import * as THREE from 'three';
import { CAR } from '../config';
import { CarModel, wheelZ, WHEEL_POS } from './CarModel';
import { Vehicle } from '../physics/Vehicle';

class Link {
  mesh: THREE.Mesh;
  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.mesh = new THREE.Mesh(geo, mat);
    parent.add(this.mesh);
  }
  set(a: THREE.Vector3, b: THREE.Vector3, radius: number) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    this.mesh.position.copy(a).addScaledVector(d, 0.5);
    this.mesh.scale.set(radius, Math.max(len, 1e-4), radius);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(Math.max(len, 1e-6)));
  }
}

const CYL = new THREE.CylinderGeometry(1, 1, 1, 8);
const TORUS = new THREE.TorusGeometry(1, 0.22, 6, 14);

export class SuspensionRig {
  group = new THREE.Group();
  private arms: Link[][] = [];
  private sleeve: Link[] = [];
  private rod: Link[] = [];
  private coils: THREE.Mesh[][] = [];
  private armMat = new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 0.6, roughness: 0.3, emissive: 0x223344, emissiveIntensity: 0.6 });
  private damperMat: THREE.MeshStandardMaterial[] = [];
  private springMat = new THREE.MeshStandardMaterial({ color: 0xffd23a, metalness: 0.3, roughness: 0.4, emissive: 0x553300, emissiveIntensity: 0.4 });
  private wireMat: THREE.MeshBasicMaterial[] = [];
  private wires: THREE.Mesh[] = [];
  private pulses: THREE.Mesh[][] = [];
  private curves: THREE.CatmullRomCurve3[] = [];
  private pulseT = 0;
  private bodyPts: { arm: THREE.Vector3[]; damperTop: THREE.Vector3; ped: THREE.Vector3 }[] = [];
  visible = false;

  constructor(private model: CarModel) {
    this.group.visible = false;
    model.root.add(this.group);
    for (let i = 0; i < 4; i++) {
      const sgn = WHEEL_POS[i].left ? -1 : 1; // z sign
      const x = WHEEL_POS[i].x;
      const body = {
        // body side mounting points (in car/body coordinates, ground at y=0): [upper front, upper rear, lower front, lower rear]
        arm: [
          new THREE.Vector3(x + 0.22, 0.62, sgn * 0.3), new THREE.Vector3(x - 0.22, 0.62, sgn * 0.3),
          new THREE.Vector3(x + 0.25, 0.26, sgn * 0.32), new THREE.Vector3(x - 0.25, 0.26, sgn * 0.32),
        ],
        damperTop: new THREE.Vector3(x + 0.05, 0.86, sgn * 0.5),
        ped: new THREE.Vector3(x + 0.0, 0.5, sgn * 0.0),
      };
      this.bodyPts.push(body);
      this.arms[i] = [0, 1, 2, 3].map(() => new Link(this.group, CYL, this.armMat));
      const dm = new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0x000000, metalness: 0.5, roughness: 0.35 });
      this.damperMat[i] = dm;
      this.sleeve[i] = new Link(this.group, CYL, dm);
      this.rod[i] = new Link(this.group, CYL, this.armMat);
      this.coils[i] = [];
      for (let c = 0; c < 9; c++) {
        const t = new THREE.Mesh(TORUS, this.springMat);
        this.group.add(t);
        this.coils[i].push(t);
      }
      // brake signal path
      const wm = new THREE.MeshBasicMaterial({ color: 0x40c8ff, transparent: true, opacity: 0.55 });
      this.wireMat[i] = wm;
      this.pulses[i] = [];
      for (let k = 0; k < 4; k++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: 0x9be8ff }));
        this.group.add(p);
        this.pulses[i].push(p);
      }
    }
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.group.visible = v;
  }

  update(veh: Vehicle, dt: number) {
    if (!this.visible) return;
    const m = this.model;
    m.bodyGroup.updateMatrix();
    const mb = m.bodyGroup.matrix;
    const pivot = m.pivotY;
    const toRoot = (p: THREE.Vector3) => new THREE.Vector3(p.x, p.y - pivot, p.z).applyMatrix4(mb);
    const emb = veh.opts.emb;
    const demand = veh.brake.request.reduce((a, b) => a + b, 0) / 12000;
    this.pulseT += dt * (emb ? 14 : 2.6);
    for (let i = 0; i < 4; i++) {
      const wg = m.wheelGroups[i];
      const sgn = WHEEL_POS[i].left ? -1 : 1;
      const hub = wg.position.clone();
      const inner = new THREE.Vector3(0, 0, -sgn * 0.12); // towards the car centre
      const b = this.bodyPts[i];
      // upper / lower wishbones: two links each, meeting at the hub
      const hubUp = hub.clone().add(new THREE.Vector3(0, 0.2, -sgn * 0.12));
      const hubLo = hub.clone().add(new THREE.Vector3(0, -0.2, -sgn * 0.1)).add(inner);
      this.arms[i][0].set(toRoot(b.arm[0]), hubUp, 0.02);
      this.arms[i][1].set(toRoot(b.arm[1]), hubUp, 0.02);
      this.arms[i][2].set(toRoot(b.arm[2]), hubLo, 0.024);
      this.arms[i][3].set(toRoot(b.arm[3]), hubLo, 0.024);
      // damper: from lower arm (near hub) to body mount
      const low = hubLo.clone().lerp(toRoot(b.arm[2]).add(toRoot(b.arm[3])).multiplyScalar(0.5), 0.35);
      const top = toRoot(b.damperTop);
      const mid = low.clone().lerp(top, 0.5);
      this.sleeve[i].set(low, mid, 0.034);
      this.rod[i].set(mid, top, 0.017);
      // colour by actuator force: blue = extension (force pushing apart), red = compression
      const f = veh.susp.fAct[i] / 6000;
      const mat = this.damperMat[i];
      if (f >= 0) mat.emissive.setRGB(0.1 * f, 0.4 * f, 1.0 * f); else mat.emissive.setRGB(1.0 * -f, 0.12 * -f, 0.05 * -f);
      mat.emissiveIntensity = 0.4 + 2.2 * Math.abs(f);
      mat.color.setRGB(0.35 + 0.1 * (f < 0 ? -f : 0), 0.35, 0.35 + 0.2 * (f > 0 ? f : 0));
      // coil spring around the damper
      const axis = new THREE.Vector3().subVectors(top, low);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
      for (let c = 0; c < this.coils[i].length; c++) {
        const t = (c + 0.5) / this.coils[i].length;
        const mesh = this.coils[i][c];
        mesh.position.copy(low).addScaledVector(axis, 0.12 + t * 0.7);
        mesh.quaternion.copy(q);
        mesh.scale.setScalar(0.07);
      }
      // brake signal path: pedal (inside the cabin) -> caliper
      const pedal = toRoot(new THREE.Vector3(0.6, 0.45, 0.2));
      const cal = hub.clone().add(new THREE.Vector3(0, 0.1, -sgn * 0.05));
      const mid1 = pedal.clone().lerp(cal, 0.5).add(new THREE.Vector3(0, 0.12, 0));
      const curve = new THREE.CatmullRomCurve3([pedal, mid1, cal]);
      for (let k = 0; k < this.pulses[i].length; k++) {
        const t = ((this.pulseT * 0.25 + k / this.pulses[i].length) % 1);
        const p = this.pulses[i][k];
        p.position.copy(curve.getPoint(t));
        const on = demand > 0.03;
        p.visible = on;
        const mat2 = p.material as THREE.MeshBasicMaterial;
        mat2.color.set(emb ? 0x9be8ff : 0xff9a2e);
        p.scale.setScalar(emb ? 0.7 + demand : 1.3 + demand);
      }
    }
  }
}
void CAR; void wheelZ;

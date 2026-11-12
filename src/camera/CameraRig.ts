import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { road } from '../track/roadSurface';

export type CamMode = 'chase' | 'side' | 'wheel' | 'orbit';
export const CAM_NAMES: Record<CamMode, string> = { chase: '追尾', side: '侧面低机位', wheel: '前轮特写', orbit: '自由环绕' };
const ORDER: CamMode[] = ['chase', 'side', 'wheel', 'orbit'];

export interface CamTarget {
  pos: THREE.Vector3; // car ground position under CG
  f: THREE.Vector3; l: THREE.Vector3; n: THREE.Vector3;
  wheelPos: THREE.Vector3; // front-left wheel world position
  speed: number;
  s: number; d: number;
  sideSign?: number;
}

export class CameraRig {
  mode: CamMode = 'chase';
  orbit: OrbitControls;
  private cur = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lastTarget = new THREE.Vector3();
  private initialised = false;
  private keepView = false;
  private lastHeading = 0;
  private lastCarTarget = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private upV = new THREE.Vector3(0, 1, 0);

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.495; // down to near ground level
    this.orbit.minPolarAngle = 0.02; // up to top-down
    this.orbit.enablePan = false;
    this.orbit.rotateSpeed = 0.9;
    this.orbit.addEventListener('start', () => { this.orbit.autoRotate = false; });
    this.orbit.minDistance = 2.2;
    this.orbit.maxDistance = 60;
    this.orbit.enabled = false;
  }

  /** switch to free orbit exactly where the camera currently is (no jump), e.g. when the user starts dragging */
  startOrbitKeepView() {
    this.keepView = true;
    this.setMode('orbit');
  }

  setMode(m: CamMode) {
    if (m !== 'orbit') this.keepView = false;
    this.mode = m;
    this.orbit.enabled = m === 'orbit';
    this.initialised = false;
  }

  cycle(): CamMode {
    const i = ORDER.indexOf(this.mode);
    this.setMode(ORDER[(i + 1) % ORDER.length]);
    return this.mode;
  }

  /** free orbit around an arbitrary point (showcase) */
  orbitAround(target: THREE.Vector3, distance: number, azimuth: number, height: number) {
    this.orbit.enabled = true;
    this.orbit.target.copy(target);
    this.camera.position.set(target.x + Math.cos(azimuth) * distance, target.y + height, target.z + Math.sin(azimuth) * distance);
    this.orbit.update();
  }

  update(dt: number, t: CamTarget) {
    const cam = this.camera;
    const k = 1 - Math.exp(-dt * 7);
    // Follow translation exactly; damp camera offsets rather than world position.
    // Otherwise frame-time variation changes the lag by metres at 300 km/h.
    if (this.initialised && this.mode !== 'orbit') {
      const delta = new THREE.Vector3().subVectors(t.pos, this.lastCarTarget);
      this.cur.add(delta); this.look.add(delta);
    }
    this.lastCarTarget.copy(t.pos);
    const lookAtCar = this.tmp;
    switch (this.mode) {
      case 'chase': {
        const dist = 6.3 + t.speed * 0.012;
        const h = 1.9 + t.speed * 0.004;
        const desired = new THREE.Vector3().copy(t.pos).addScaledVector(t.f, -dist).addScaledVector(t.n, h);
        const ground = road.height(road.wrap(t.s - dist), t.d) + 0.9;
        if (desired.y < ground) desired.y = ground;
        if (!this.initialised) { this.cur.copy(desired); this.look.copy(t.pos); this.initialised = true; }
        this.cur.lerp(desired, k);
        const lookT = lookAtCar.copy(t.pos).addScaledVector(t.f, 5).addScaledVector(t.n, 0.9);
        this.look.lerp(lookT, k);
        cam.position.copy(this.cur);
        this.upV.set(0, 1, 0).lerp(t.n, 0.45).normalize();
        cam.up.copy(this.upV);
        cam.lookAt(this.look);
        const fov = 62 + Math.min(18, t.speed * 0.12);
        if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * k; cam.updateProjectionMatrix(); }
        break;
      }
      case 'side': {
        const desired = new THREE.Vector3().copy(t.pos).addScaledVector(t.l, 7.4 * (t.sideSign ?? 1)).addScaledVector(t.n, 0.7).addScaledVector(t.f, 0.4);
        if (!this.initialised) { this.cur.copy(desired); this.initialised = true; }
        this.cur.lerp(desired, 1 - Math.exp(-dt * 14));
        cam.position.copy(this.cur);
        cam.up.copy(t.n);
        cam.lookAt(this.tmp.copy(t.pos).addScaledVector(t.n, 0.6));
        if (cam.fov !== 42) { cam.fov = 42; cam.updateProjectionMatrix(); }
        break;
      }
      case 'wheel': {
        const desired = new THREE.Vector3().copy(t.wheelPos).addScaledVector(t.f, 1.5).addScaledVector(t.l, 1.9).addScaledVector(t.n, 0.2);
        if (!this.initialised) { this.cur.copy(desired); this.initialised = true; }
        this.cur.lerp(desired, 1 - Math.exp(-dt * 14));
        cam.position.copy(this.cur);
        cam.up.copy(t.n);
        cam.lookAt(this.tmp.copy(t.wheelPos).addScaledVector(t.n, 0.15));
        if (cam.fov !== 42) { cam.fov = 42; cam.updateProjectionMatrix(); }
        break;
      }
      case 'orbit': {
        const target = this.tmp.copy(t.pos).addScaledVector(t.n, 0.7);
        const heading = Math.atan2(t.f.x, t.f.z);
        if (!this.initialised) {
          this.lastTarget.copy(target);
          if (!this.keepView) cam.position.copy(target).addScaledVector(t.f, -6).addScaledVector(t.l, 4.5).addScaledVector(t.n, 2);
          this.keepView = false;
          this.orbit.target.copy(target);
          cam.up.set(0, 1, 0);
          this.lastHeading = heading;
          this.initialised = true;
        }
        // keep the user's view relative to the car: follow its translation and turn with its heading
        let dh = heading - this.lastHeading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const off = new THREE.Vector3().subVectors(cam.position, this.lastTarget).applyAxisAngle(new THREE.Vector3(0, 1, 0), dh);
        cam.position.copy(target).add(off);
        this.lastHeading = heading;
        this.orbit.target.copy(target);
        this.lastTarget.copy(target);
        this.orbit.update();
        if (cam.fov !== 45) { cam.fov = 45; cam.updateProjectionMatrix(); }
        break;
      }
    }
  }
}

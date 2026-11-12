// Road-surface projection and independent tyre-gap measurements.
import * as THREE from 'three';
import { road } from '../track/roadSurface';

const _p = new THREE.Vector3();
const _sd = { s: 0, d: 0 };

/**
 * Local Y (in the frame of `root`, whose matrixWorld must be current) of the road surface under the local
 * horizontal position (x, z). Iterates because the root frame is tilted by banking / slope.
 */
export function surfaceLocalY(root: THREE.Object3D, sHint: number, x: number, z: number): number {
  const m = root.matrixWorld;
  const ny = Math.max(0.5, m.elements[5]);
  let y = 0;
  for (let k = 0; k < 5; k++) {
    _p.set(x, y, z).applyMatrix4(m);
    road.worldToSD(_p.x, _p.z, sHint, _sd);
    y += (road.height(_sd.s, _sd.d) - _p.y) / ny;
  }
  return y;
}

/**
 * Independent measurement: signed gap between the tyre bottom (centre - R along the root's up axis)
 * and the road surface at the bottom point's world XZ.  > 0 = floating, < 0 = embedded.
 */
export function tyreGap(root: THREE.Object3D, wheel: THREE.Object3D, radius: number, sHint: number): number {
  const c = wheel.getWorldPosition(new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0).transformDirection(root.matrixWorld);
  c.addScaledVector(up, -radius);
  road.worldToSD(c.x, c.z, sHint, _sd);
  return c.y - road.height(_sd.s, _sd.d);
}

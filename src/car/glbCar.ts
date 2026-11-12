// Loader / normaliser for the real SU7 Ultra Nurburgring GLB (CC-BY-4.0, MattDoesBlender, Sketchfab).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { CAR } from '../config';

const BASE = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
export const GLB_URL = `${BASE}models/su7ultra.glb`;

export interface GlbTemplate {
  scene: THREE.Object3D;
  rotY: number;
  offset: THREE.Vector3;
  wheelR: number; // measured tyre radius
  clearance: number; // body underside above the road (m)
  front: number; // measured front axle x (car coordinates after normalisation)
  rear: number;
  halfTrack: number;
  wheelCenters: THREE.Vector3[]; // car coordinates, order: FL FR RL RR
  info: string;
}

let cache: Promise<GlbTemplate> | null = null;

export function loadGlbTemplate(onProgress?: (f: number) => void): Promise<GlbTemplate> {
  if (cache) return cache;
  cache = new Promise<GlbTemplate>((resolve, reject) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${BASE}draco/`);
    draco.setDecoderConfig({ type: 'wasm' });
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load(
      GLB_URL,
      (gltf) => {
        try {
          resolve(normalise(gltf.scene));
        } catch (e) {
          reject(e);
        } finally {
          draco.dispose();
        }
      },
      (ev) => { if (ev.total) onProgress?.(ev.loaded / ev.total); },
      (err) => { cache = null; reject(err); },
    );
  });
  return cache;
}

function byName(root: THREE.Object3D, prefix: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.name.startsWith(prefix)) out.push(o); });
  return out;
}

const wrapperOf = (scene: THREE.Object3D, rotY: number, off: THREE.Vector3) => {
  const w = new THREE.Group();
  w.rotation.y = rotY;
  w.position.copy(off);
  w.add(scene);
  w.updateMatrixWorld(true);
  return w;
};

function normalise(scene: THREE.Object3D): GlbTemplate {
  scene.updateMatrixWorld(true);
  const head = new THREE.Box3().setFromObject(byName(scene, 'headlight_l')[0]).getCenter(new THREE.Vector3());
  const tail = new THREE.Box3().setFromObject(byName(scene, 'taillight_l')[0]).getCenter(new THREE.Vector3());
  // forward must be +X: if the nose points to +Z rotate +90 deg about Y, if -Z rotate -90 deg
  const rotY = head.z > tail.z ? Math.PI / 2 : -Math.PI / 2;
  let w = wrapperOf(scene, rotY, new THREE.Vector3());
  const wheels = byName(scene, 'wheel_').filter((o) => o.parent && o.parent.name.startsWith('su7ultra'));
  if (wheels.length !== 4) throw new Error('expected 4 wheel nodes, found ' + wheels.length);
  const boxes = wheels.map((o) => new THREE.Box3().setFromObject(o));
  const centers = boxes.map((b) => b.getCenter(new THREE.Vector3()));
  const wheelR = boxes.reduce((a, b) => a + (b.max.y - b.min.y) / 2, 0) / 4;
  const minY = Math.min(...boxes.map((b) => b.min.y));
  const xs = centers.map((c) => c.x);
  const front = Math.max(...xs), rear = Math.min(...xs);
  const zs = centers.map((c) => Math.abs(c.z));
  const halfTrack = zs.reduce((a, b) => a + b, 0) / 4;
  const zMid = centers.reduce((a, c) => a + c.z, 0) / 4;
  const off = new THREE.Vector3(0.06 - (front + rear) / 2, -minY - 0.02, -zMid);
  w.position.copy(off);
  w.updateMatrixWorld(true);
  // body underside clearance: lowest point of chassis / bodyshell (ignoring splitters/skirts below is part of the car)
  const under = new THREE.Box3();
  for (const n of ['chassis', 'bodyshell']) for (const o of byName(scene, n)) under.union(new THREE.Box3().setFromObject(o));
  const clearance = under.min.y + 0.02; // relative to the road (tyre bottom at -0.02)
  const wc = centers.map((c) => c.clone().add(off));
  // order FL FR RL RR  (left = -Z in car coordinates)
  const order: THREE.Vector3[] = [];
  for (const [fx, sz] of [[1, -1], [1, 1], [-1, -1], [-1, 1]]) {
    order.push(wc.filter((c) => Math.sign(c.x - 0.06) === fx && Math.sign(c.z) === sz)[0] ?? new THREE.Vector3());
  }
  const info = `GLB ok: tyre R=${wheelR.toFixed(3)} m, wheelbase=${(front - rear).toFixed(3)} m, half-track=${halfTrack.toFixed(3)} m, clearance=${clearance.toFixed(3)} m`;
  void w; w = null as unknown as THREE.Group;
  return { scene, rotY, offset: off, wheelR, clearance, front: front + off.x, rear: rear + off.x, halfTrack, wheelCenters: order, info };
}

export interface GlbInstance {
  root: THREE.Group; // normalised wrapper
  bodyParts: THREE.Object3D[];
  wheels: { wheel: THREE.Object3D; hub: THREE.Object3D | null; center: THREE.Vector3 }[]; // FL FR RL RR
  paint: THREE.MeshStandardMaterial[];
  discMats: THREE.MeshStandardMaterial[]; // per corner (glow)
  caliperMats: THREE.MeshStandardMaterial[];
  tailMats: THREE.MeshStandardMaterial[];
  bodyMats: THREE.Material[]; // everything that becomes see-through in x-ray / ghost mode
}

type StdMat = THREE.MeshStandardMaterial;

/** Clone the template (shared geometry, per-instance materials), repair the optimised materials and classify parts. */
export function instantiate(tpl: GlbTemplate): GlbInstance {
  const clone = tpl.scene.clone(true);
  const root = wrapperOf(clone, tpl.rotY, tpl.offset);
  const mapM = new Map<THREE.Material, THREE.Material>();
  const cloneMat = (m: THREE.Material) => {
    let c = mapM.get(m);
    if (!c) { c = m.clone(); mapM.set(m, c); }
    return c;
  };
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMat) : cloneMat(mesh.material);
      mesh.frustumCulled = true;
    }
  });
  const holder = byName(clone, 'su7ultramesh')[0] ?? clone;
  const children = [...holder.children];
  const wheelNodes = children.filter((c) => c.name.startsWith('wheel_'));
  const hubNodes = children.filter((c) => c.name.startsWith('hub_'));
  const bodyParts = children.filter((c) => !c.name.startsWith('wheel_') && !c.name.startsWith('hub_'));
  const centerOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
  const wheels: GlbInstance['wheels'] = [];
  for (const [fx, sz] of [[1, -1], [1, 1], [-1, -1], [-1, 1]]) {
    const w = wheelNodes.find((n) => { const c = centerOf(n); return Math.sign(c.x - 0.06) === fx && Math.sign(c.z) === sz; })!;
    const c = centerOf(w);
    let hub: THREE.Object3D | null = null, best = 1e9;
    for (const h of hubNodes) { const d = centerOf(h).distanceTo(c); if (d < best) { best = d; hub = h; } }
    wheels.push({ wheel: w, hub, center: c });
  }

  // ---- material repair (the optimised file lost the intended PBR values; defaults are metal=1 / rough=1) ----
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x06090c, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.6, envMapIntensity: 1.1, side: THREE.DoubleSide, depthWrite: false });
  const paint: StdMat[] = [];
  const tailMats: StdMat[] = [];
  const bodyMats: THREE.Material[] = [glass];
  const meshesOf = (o: THREE.Object3D) => { const out: THREE.Mesh[] = []; o.traverse((x) => { if ((x as THREE.Mesh).isMesh) out.push(x as THREE.Mesh); }); return out; };
  for (const part of bodyParts) {
    const isGlass = /^(glass|window|windscreen)/.test(part.name);
    const isTail = /^(taillight|brakelight)/.test(part.name);
    for (const mesh of meshesOf(part)) {
      if (isGlass) { mesh.material = glass; mesh.castShadow = false; continue; }
      const m = mesh.material as StdMat;
      switch (m.name) {
        case 'PaletteMaterial005': if (!paint.includes(m)) paint.push(m); m.metalness = 0.15; m.roughness = 0.16; break;
        case 'PaletteMaterial004': m.metalness = 0.0; m.roughness = 0.3; break;
        case 'PaletteMaterial001': m.metalness = 0.35; m.roughness = 0.4; break;
        case 'PaletteMaterial002': m.roughness = 0.6; break;
        case 'PaletteMaterial007': m.metalness = 0.25; break;
        case '00000174135B04F8': m.color.set(0x1b1c1f); m.metalness = 0.3; m.roughness = 0.5; break;
        default: break;
      }
      if (isTail) {
        mesh.material = m.clone();
        const tm = mesh.material as StdMat;
        tm.metalness = 0; tm.roughness = 0.25;
        tailMats.push(tm);
      }
    }
    for (const mesh of meshesOf(part)) for (const mm of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) if (!bodyMats.includes(mm)) bodyMats.push(mm);
  }

  // ---- wheels: tyre / forged rim / brake disc / small parts; hub = yellow caliper ----
  // The source wheel materials are all doubleSided and several faces (tyre sidewall, spoke fronts) have
  // inward-facing normals, so replacement materials must be DoubleSide too — otherwise the tyre outer
  // sidewall and spoke faces get back-face culled and you look straight at the inside of the rim barrel.
  const DS = THREE.DoubleSide;
  const rubber = (): StdMat => new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.88, metalness: 0, side: DS });
  const rim = (): StdMat => new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.42, metalness: 0.45, side: DS });
  const small = (): StdMat => new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.3, metalness: 0.9, side: DS });
  const discMats: StdMat[] = [];
  const caliperMats: StdMat[] = [];
  wheels.forEach((w, i) => {
    const disc = new THREE.MeshStandardMaterial({ color: 0x8e9197, roughness: 0.42, metalness: 0.9, emissive: 0xff3a00, emissiveIntensity: 0, side: DS });
    const cal = new THREE.MeshStandardMaterial({ color: 0xf2b200, roughness: 0.35, metalness: 0.25, emissive: 0xff5a00, emissiveIntensity: 0, side: DS });
    discMats.push(disc);
    caliperMats.push(cal);
    const rm = rim(), tm = rubber(), sm = small();
    for (const mesh of meshesOf(w.wheel)) {
      mesh.geometry.computeBoundingBox();
      const sz = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      const md = Math.max(sz.x, sz.y, sz.z);
      const thin = Math.min(sz.x, sz.y, sz.z);
      mesh.material = md > 0.62 ? tm : md > 0.42 ? rm : md > 0.25 && thin < 0.1 ? disc : sm;
      mesh.castShadow = false;
    }
    if (w.hub) for (const mesh of meshesOf(w.hub)) { mesh.material = cal; mesh.castShadow = false; }
  });
  const allBody = [...bodyMats];
  for (const m of allBody) m.userData.baseOpacity = m.opacity;
  return { root, bodyParts, wheels, paint, discMats, caliperMats, tailMats, bodyMats: allBody };
}

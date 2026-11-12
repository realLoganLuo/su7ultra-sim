import * as THREE from 'three';
import { doorTexture, bannerTexture, numberTexture, ventTexture } from './decals';

function carbonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0b0d';
  g.fillRect(0, 0, 256, 256);
  const cell = 16;
  for (let y = 0; y < 256; y += cell) {
    for (let x = 0; x < 256; x += cell) {
      const alt = ((x / cell + y / cell) & 1) === 0;
      const grad = alt ? g.createLinearGradient(x, y, x + cell, y + cell) : g.createLinearGradient(x + cell, y, x, y + cell);
      grad.addColorStop(0, '#26272c');
      grad.addColorStop(0.5, '#0c0c0e');
      grad.addColorStop(1, '#2a2b31');
      g.fillStyle = grad;
      g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      for (let k = 2; k < cell; k += 3) {
        g.beginPath();
        if (alt) { g.moveTo(x + k, y); g.lineTo(x + k, y + cell); } else { g.moveTo(x, y + k); g.lineTo(x + cell, y + k); }
        g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export type PaintName = 'lava' | 'pearl';

export interface CarMaterials {
  paint: THREE.MeshPhysicalMaterial;
  stripe: THREE.MeshPhysicalMaterial; // black centre stripe
  black: THREE.MeshPhysicalMaterial; // black lower body
  rimBlack: THREE.MeshStandardMaterial;
  vent: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  banner: THREE.MeshStandardMaterial;
  number: THREE.MeshStandardMaterial;
  carbon: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  trim: THREE.MeshStandardMaterial; // black plastic / grille
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  rimDark: THREE.MeshStandardMaterial;
  disc: THREE.MeshStandardMaterial;
  caliper: THREE.MeshStandardMaterial;
  headlight: THREE.MeshStandardMaterial;
  drl: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
}

export function createCarMaterials(): CarMaterials {
  const ctex = carbonTexture();
  const mk = (c: number) => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  ctex.repeat.set(6, 6);
  const po = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  return {
    paint: mk(0xf5b800),
    stripe: new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0.1, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 0.45, ...po }),
    black: new THREE.MeshPhysicalMaterial({ color: 0x08080a, metalness: 0.1, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    rimBlack: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.38, metalness: 0.7 }),
    vent: new THREE.MeshStandardMaterial({ map: ventTexture(), roughness: 0.6, metalness: 0.3, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    door: new THREE.MeshStandardMaterial({ map: doorTexture(), transparent: true, roughness: 0.35, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    banner: new THREE.MeshStandardMaterial({ map: bannerTexture(), roughness: 0.3, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
    number: new THREE.MeshStandardMaterial({ map: numberTexture(), roughness: 0.5, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    carbon: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: ctex, metalness: 0.25, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.08, side: THREE.DoubleSide, ...po }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x030507, metalness: 0.1, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.55, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }),
    tire: new THREE.MeshStandardMaterial({ color: 0x131313, roughness: 0.85, metalness: 0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xcfd2d8, roughness: 0.3, metalness: 0.7 }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x6b7078, roughness: 0.4, metalness: 0.5 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x8c8f95, roughness: 0.35, metalness: 0.9, emissive: 0xff3a00, emissiveIntensity: 0 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xffc400, roughness: 0.3, metalness: 0.3, emissive: 0xff5a00, emissiveIntensity: 0 }),
    headlight: new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.1, metalness: 0.5, emissive: 0xbfe6ff, emissiveIntensity: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    drl: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff4ff, emissiveIntensity: 3.0, roughness: 0.3 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff1010, emissiveIntensity: 1.6, roughness: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }),
  };
}

/** Cut the wheel-arch openings into a material (fragment discard in car-local space). */
export function addArchCutouts(mat: THREE.Material, arches: { x: number; y: number; r: number }[]) {
  const arr = arches.map((a) => `vec3(${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${(a.r * a.r).toFixed(5)})`).join(',');
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBodyPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBodyPos;\nconst vec3 ARCH[${arches.length}] = vec3[${arches.length}](${arr});`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (abs(vBodyPos.z) > 0.45) {
          for (int i = 0; i < ${arches.length}; i++) {
            vec2 dd = vBodyPos.xy - ARCH[i].xy;
            if (dot(dd, dd) < ARCH[i].z) discard;
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'arch' + arches.length;
  mat.needsUpdate = true;
}

export function applyPaint(m: CarMaterials, name: PaintName) {
  if (name === 'lava') {
    m.paint.color.set(0xf2b200);
    m.paint.metalness = 0.4;
  } else {
    m.paint.color.set(0xeef0f2);
    m.paint.metalness = 0.25;
  }
}

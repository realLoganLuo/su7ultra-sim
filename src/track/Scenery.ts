import * as THREE from 'three';
import { road } from './roadSurface';
import { grassTexture } from './textures';

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.15;
}

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Terrain height field built from the track samples (Shepard blending) + low hills. */
export class Terrain {
  private cell = 60;
  private grid = new Map<number, number[]>();
  private sx: number[] = [];
  private sz: number[] = [];
  private sh: number[] = [];
  private ss: number[] = [];
  minX = 1e9; maxX = -1e9; minZ = 1e9; maxZ = -1e9;

  constructor() {
    const step = 4;
    for (let i = 0; i < road.n; i += step) {
      const x = road.cx[i], z = road.cz[i];
      const k = this.sx.length;
      this.sx.push(x); this.sz.push(z); this.sh.push(road.base(i * road.ds, 0)); this.ss.push(i * road.ds);
      const key = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(k);
      this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z); this.maxZ = Math.max(this.maxZ, z);
    }
  }

  private key(i: number, j: number) { return (i + 5000) * 10000 + (j + 5000); }

  /** nearest-track distance (horizontal) and blended road elevation */
  query(x: number, z: number): { dmin: number; e: number; sNear: number } {
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    let dmin = 1e9, sw = 0, hw = 0, sNear = 0;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const arr = this.grid.get(this.key(ci + a, cj + b));
      if (!arr) continue;
      for (const k of arr) {
        const dx = x - this.sx[k], dz = z - this.sz[k];
        const d2 = dx * dx + dz * dz;
        if (d2 < dmin * dmin) { dmin = Math.sqrt(d2); sNear = this.ss[k]; }
        const w = 1 / ((d2 + 25) * (d2 + 25));
        sw += w; hw += w * this.sh[k];
      }
    }
    if (sw === 0) return { dmin: 400, e: 0, sNear: 0 };
    return { dmin, e: hw / sw, sNear };
  }

  heightAt(x: number, z: number, q = this.query(x, z)): number {
    const { dmin, e } = q;
    const drop = Math.min(0.32 * Math.max(0, dmin - 9), 26);
    const under = dmin < 24 ? 0.5 * (1 - sm(14, 24, dmin)) : 0;
    const hills = (fbm(x * 0.0035, z * 0.0035) - 0.35) * 70 * sm(30, 220, dmin) + (fbm(x * 0.012 + 9, z * 0.012) - 0.5) * 9 * sm(20, 120, dmin);
    return e - drop - under + Math.max(hills, -10);
  }
}

export function buildTerrainMesh(terrain: Terrain): THREE.Mesh {
  const margin = 420;
  const step = 10;
  const x0 = terrain.minX - margin, x1 = terrain.maxX + margin;
  const z0 = terrain.minZ - margin, z1 = terrain.maxZ + margin;
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const col = new Float32Array((nx + 1) * (nz + 1) * 3);
  const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const q = terrain.query(x, z);
      const h = terrain.heightAt(x, z, q);
      const k = j * (nx + 1) + i;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 14; uv[k * 2 + 1] = z / 14;
      const n = fbm(x * 0.02, z * 0.02);
      const forest = sm(16, 40, q.dmin);
      c.setRGB(0.78 + n * 0.3, 0.9 + n * 0.25, 0.68 + n * 0.2);
      c.multiplyScalar(1 - 0.38 * forest);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, cc = a + nx + 1, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const gt = grassTexture();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: gt, vertexColors: true, roughness: 1, metalness: 0 }));
  mesh.receiveShadow = true;
  return mesh;
}

function coniferGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.2, 6);
  trunk.translate(0, 1.1, 0);
  paint(trunk, 0x4a3524);
  parts.push(trunk);
  const layers: [number, number, number][] = [[2.6, 1.95, 3.0], [4.4, 1.55, 2.8], [6.1, 1.1, 2.6], [7.5, 0.7, 2.2]];
  for (const [y, r, h] of layers) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, y + h / 2 - 0.3, 0);
    paint(cone, 0x1f3d24);
    parts.push(cone);
  }
  return mergeGeoms(parts);
}

function paint(g: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function mergeGeoms(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  let base = 0;
  for (const p of parts) {
    const g = p.index ? p : p;
    const pa = g.getAttribute('position'), na = g.getAttribute('normal'), ca = g.getAttribute('color');
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      nor.push(na.getX(i), na.getY(i), na.getZ(i));
      col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
    else for (let i = 0; i < pa.count; i++) idx.push(i + base);
    base += pa.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

export function buildForest(terrain: Terrain, count = 7000): THREE.Group {
  const group = new THREE.Group();
  const geo = coniferGeometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cells = new Map<string, { m: THREE.Matrix4; c: THREE.Color }[]>();
  let placed = 0, tries = 0;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  while (placed < count && tries < count * 8) {
    tries++;
    const i = Math.floor(rnd() * road.n);
    const side = rnd() < 0.5 ? -1 : 1;
    const r = 13 + Math.pow(rnd(), 1.7) * 330;
    const x = road.cx[i] + road.lx[i] * side * r + (rnd() - 0.5) * 10;
    const z = road.cz[i] + road.lz[i] * side * r + (rnd() - 0.5) * 10;
    const qy = terrain.query(x, z);
    if (qy.dmin < 13.5) continue;
    // sparse clearings
    if (fbm(x * 0.01 + 40, z * 0.01) < 0.3) continue;
    const y = terrain.heightAt(x, z, qy) - 0.2;
    const s = 0.8 + rnd() * 0.9;
    e.set((rnd() - 0.5) * 0.08, rnd() * 6.28, (rnd() - 0.5) * 0.08);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * (0.9 + rnd() * 0.5), s));
    const key = `${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
    let arr = cells.get(key);
    if (!arr) { arr = []; cells.set(key, arr); }
    const shade = 0.75 + rnd() * 0.5;
    arr.push({ m: m4.clone(), c: new THREE.Color(shade * (0.9 + rnd() * 0.2), shade, shade * 0.9) });
    placed++;
  }
  for (const arr of cells.values()) {
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    arr.forEach((t, i) => { im.setMatrixAt(i, t.m); im.setColorAt(i, t.c); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}

export function createSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sunDir: { value: new THREE.Vector3(-0.4, 0.28, -0.6).normalize() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
    fragmentShader: `
      varying vec3 vDir; uniform vec3 sunDir;
      void main(){
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 zen = vec3(0.20,0.33,0.52);
        vec3 mid = vec3(0.55,0.65,0.76);
        vec3 hor = vec3(0.84,0.80,0.72);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, h));
        c = mix(c, zen, smoothstep(0.2, 0.9, h));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += vec3(1.0,0.78,0.5) * (pow(s, 24.0) * 0.45 + pow(s, 600.0) * 3.0);
        // soft clouds
        float cl = smoothstep(0.55,0.9, sin(vDir.x*6.0+1.3)*sin(vDir.z*5.0)*0.5+0.5) * smoothstep(0.02,0.35,h) * 0.25;
        c = mix(c, vec3(0.92,0.9,0.88), cl);
        if (vDir.y < 0.0) c = mix(c, vec3(0.45,0.48,0.46), smoothstep(0.0,-0.2,vDir.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  m.scale.setScalar(900);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

/** Sky/studio environment map for reflections. */
export function createSkyEnvScene(): THREE.Scene {
  const s = new THREE.Scene();
  const sky = createSky();
  sky.scale.setScalar(50);
  s.add(sky);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 24), new THREE.MeshBasicMaterial({ color: 0x3a3d3c }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1;
  s.add(ground);
  return s;
}

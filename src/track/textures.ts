import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noiseFill(g: CanvasRenderingContext2D, w: number, h: number, count: number, r: () => number, light = 255, alpha = 0.08, size = 1.6) {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(r() * light);
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    g.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Road texture: u across the 12 m road, v along 10 m. */
export function asphaltTexture(concrete = false): THREE.CanvasTexture {
  const W = 512, H = 512;
  const [c, g] = canvas(W, H);
  const r = rng(concrete ? 7 : 3);
  g.fillStyle = concrete ? '#9a9b9a' : '#2e2f33';
  g.fillRect(0, 0, W, H);
  // large mottling
  for (let i = 0; i < 220; i++) {
    const v = concrete ? 130 + r() * 50 : 30 + r() * 28;
    g.fillStyle = `rgba(${v},${v},${v + 2},0.22)`;
    const rad = 10 + r() * 40;
    g.beginPath();
    g.ellipse(r() * W, r() * H, rad, rad * (0.4 + r() * 0.6), r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  noiseFill(g, W, H, 26000, r, concrete ? 230 : 140, concrete ? 0.1 : 0.12, 1.4);
  // darker racing lines (lane centres) with tyre tracks
  for (const cx of [1 / 6, 1 / 2, 5 / 6]) {
    for (const off of [-0.035, 0.035]) {
      const x = (cx + off) * W;
      const gr = g.createLinearGradient(x - 14, 0, x + 14, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.5, concrete ? 'rgba(60,60,60,0.22)' : 'rgba(5,5,6,0.28)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x - 14, 0, 28, H);
    }
  }
  // repair patches
  for (let i = 0; i < 4; i++) {
    g.fillStyle = concrete ? 'rgba(110,110,110,0.2)' : 'rgba(18,18,20,0.35)';
    g.fillRect(r() * W * 0.8, r() * H * 0.8, 30 + r() * 120, 14 + r() * 40);
  }
  // edge lines
  g.fillStyle = 'rgba(235,235,235,0.9)';
  g.fillRect(W * 0.018, 0, 7, H);
  g.fillRect(W * 0.982 - 7, 0, 7, H);
  // dashed lane dividers
  g.fillStyle = 'rgba(225,225,225,0.55)';
  for (const u of [1 / 3, 2 / 3]) {
    g.fillRect(u * W - 3, 0, 6, H * 0.28);
    g.fillRect(u * W - 3, H * 0.5, 6, H * 0.28);
  }
  // concrete panel joints
  if (concrete) {
    g.fillStyle = 'rgba(40,40,40,0.55)';
    g.fillRect(0, 0, W, 3);
    g.fillRect(0, H / 2, W, 2);
  }
  return finish(c);
}

export function grassTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const r = rng(11);
  g.fillStyle = '#3d5a2c';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const gv = 70 + r() * 70;
    g.fillStyle = `rgba(${gv * 0.55},${gv},${gv * 0.38},0.35)`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 4);
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = 'rgba(30,45,20,0.25)';
    g.beginPath();
    g.ellipse(r() * 256, r() * 256, 8 + r() * 18, 6 + r() * 10, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

export function curbTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  g.fillStyle = '#c4161c';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 64, 64, 64);
  noiseFill(g, 64, 128, 500, rng(5), 120, 0.15, 1.5);
  return finish(c);
}

export function signTexture(title: string, sub: string, bg = '#0d3b66', fg = '#ffffff'): THREE.CanvasTexture {
  const [c, g] = canvas(512, 160);
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = fg;
  g.lineWidth = 6;
  g.strokeRect(6, 6, 500, 148);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${title.length > 12 ? 52 : 66}px "PingFang SC","Microsoft YaHei",sans-serif`;
  g.fillText(title, 256, sub ? 62 : 80);
  if (sub) {
    g.font = '28px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(sub, 256, 123);
  }
  return finish(c, false);
}

const GRAFFITI = [
  ['SU7 ULTRA', '#ffd400'], ['绿色地狱', '#ffffff'], ['6:22', '#ffffff'], ['NÜRBURG', '#ffffff'],
  ['RING', '#ff4040'], ['加油！', '#ffd400'], ['7:04', '#ffffff'], ['GO FAST', '#ffffff'],
  ['EMB ✓', '#7fd7ff'], ['ACTIVE', '#ffd400'], ['↑ 全开', '#ffffff'], ['LOW & WIDE', '#ffffff'],
] as const;

export function graffitiTextures(): THREE.CanvasTexture[] {
  return GRAFFITI.map(([text, col], i) => {
    const [c, g] = canvas(512, 192);
    g.clearRect(0, 0, 512, 192);
    g.save();
    g.translate(256, 96);
    g.rotate(((i % 3) - 1) * 0.04);
    g.font = 'italic 900 96px "Arial Black","PingFang SC","Microsoft YaHei",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.strokeText(text, 3, 4);
    g.fillStyle = col;
    g.globalAlpha = 0.95;
    g.fillText(text, 0, 0);
    // dry-brush: erase a few streaks
    g.globalCompositeOperation = 'destination-out';
    const r = rng(i * 17 + 1);
    for (let k = 0; k < 70; k++) {
      g.fillStyle = `rgba(0,0,0,${0.2 + r() * 0.5})`;
      g.fillRect(-240 + r() * 480, -90 + r() * 180, 2 + r() * 30, 1 + r() * 2);
    }
    g.restore();
    return finish(c, false);
  });
}

export function skyGradientTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(16, 256);
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#3c5675');
  gr.addColorStop(0.45, '#8ea3b7');
  gr.addColorStop(0.8, '#d3c9b8');
  gr.addColorStop(1, '#cfc4b2');
  g.fillStyle = gr;
  g.fillRect(0, 0, 16, 256);
  return finish(c, false);
}

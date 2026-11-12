// Procedural livery textures (all generated at runtime, no external images).
import * as THREE from 'three';

function cv(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Door livery: slanted black wedge with yellow "Ultra" script. u = front direction, v = up. */
export function doorTexture(): THREE.CanvasTexture {
  const [c, g] = cv(1024, 256);
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = '#0b0b0d';
  g.beginPath();
  g.moveTo(0, 256);
  g.lineTo(1024, 256);
  g.lineTo(1024, 170);
  g.lineTo(560, 60);
  g.lineTo(140, 8);
  g.lineTo(0, 8);
  g.closePath();
  g.fill();
  g.save();
  g.translate(430, 150);
  g.rotate(-0.1);
  g.fillStyle = '#ffc800';
  g.font = 'italic 900 150px "Snell Roundhand","Brush Script MT","Apple Chancery","Arial Black",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Ultra', 0, 0);
  g.restore();
  return tex(c);
}

/** Windscreen banner. u runs left->right as seen from the front, v up. */
export function bannerTexture(): THREE.CanvasTexture {
  const [c, g] = cv(1024, 128);
  g.fillStyle = '#060607';
  g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#f4f4f4';
  g.font = '600 78px "Helvetica Neue","Arial",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  (g as unknown as { letterSpacing: string }).letterSpacing = '22px';
  g.fillText('XIAOMI', 512, 68);
  return tex(c);
}

/** Front bumper race number. */
export function numberTexture(): THREE.CanvasTexture {
  const [c, g] = cv(256, 128);
  g.fillStyle = '#08080a';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.font = '900 100px "Arial Black","Helvetica Neue",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText('01', 128, 70);
  // slashed zero look
  g.beginPath();
  g.moveTo(68, 104);
  g.lineTo(104, 34);
  g.stroke();
  return tex(c);
}

/** Louvred vent. */
export function ventTexture(): THREE.CanvasTexture {
  const [c, g] = cv(256, 256);
  g.fillStyle = '#050506';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9; i++) {
    const y = 14 + i * 28;
    const gr = g.createLinearGradient(0, y, 0, y + 14);
    gr.addColorStop(0, '#6a6d73');
    gr.addColorStop(1, '#17181b');
    g.fillStyle = gr;
    g.fillRect(8, y, 240, 14);
  }
  return tex(c);
}

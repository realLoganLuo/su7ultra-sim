/** Fixed-size ring buffer of samples for the Canvas graphs. */
export class History {
  data: Float32Array;
  head = 0;
  count = 0;
  constructor(public size: number) {
    this.data = new Float32Array(size);
  }
  push(v: number) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.size;
    this.count = Math.min(this.size, this.count + 1);
  }
  clear() { this.head = 0; this.count = 0; }
  /** i = 0 oldest */
  at(i: number): number {
    return this.data[(this.head - this.count + i + this.size * 2) % this.size];
  }
  maxAbs(window = this.count): number {
    let m = 0;
    for (let i = this.count - Math.min(window, this.count); i < this.count; i++) m = Math.max(m, Math.abs(this.at(i)));
    return m;
  }
}

export interface Series { h: History; color: string; width?: number; dash?: number[] }

export function drawGraph(
  canvas: HTMLCanvasElement, series: Series[], yMin: number, yMax: number,
  opts: { band?: [number, number, string]; zero?: boolean; label?: string; guides?: number[] } = {},
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const y = (v: number) => h - ((v - yMin) / (yMax - yMin)) * h;
  if (opts.band) {
    g.fillStyle = opts.band[2];
    g.fillRect(0, y(opts.band[1]), w, y(opts.band[0]) - y(opts.band[1]));
  }
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 1;
  if (opts.zero) { g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); }
  for (const gv of opts.guides ?? []) { g.beginPath(); g.moveTo(0, y(gv)); g.lineTo(w, y(gv)); g.stroke(); }
  for (const s of series) {
    const n = s.h.count;
    if (n < 2) continue;
    g.beginPath();
    g.strokeStyle = s.color;
    g.lineWidth = s.width ?? 1.6;
    g.setLineDash(s.dash ?? []);
    for (let i = 0; i < n; i++) {
      const x = (i / (s.h.size - 1)) * w + (w - (n / (s.h.size - 1)) * w);
      const v = Math.max(yMin, Math.min(yMax, s.h.at(i)));
      if (i === 0) g.moveTo(x, y(v)); else g.lineTo(x, y(v));
    }
    g.stroke();
  }
  g.setLineDash([]);
  if (opts.label) {
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '10px system-ui, sans-serif';
    g.fillText(opts.label, 5, 11);
  }
}

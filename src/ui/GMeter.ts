export class GMeter {
  canvas: HTMLCanvasElement;
  private trail: [number, number][] = [];
  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 236;
    this.canvas.height = 236;
    parent.appendChild(this.canvas);
  }
  /** lateral g (+ left), longitudinal g (+ accelerating) */
  update(ay: number, ax: number) {
    const g = this.canvas.getContext('2d')!;
    const W = 236, c = W / 2, R = 104, scale = R / 1.6;
    g.clearRect(0, 0, W, W);
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 2;
    for (const r of [R, R * 0.625, R * 0.3125]) { g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(c - R, c); g.lineTo(c + R, c); g.moveTo(c, c - R); g.lineTo(c, c + R); g.stroke();
    // screen x: right = right turn (car accelerates right when ay<0)
    const px = c - ay * scale, py = c - ax * scale;
    this.trail.push([px, py]);
    if (this.trail.length > 40) this.trail.shift();
    g.lineWidth = 3;
    for (let i = 1; i < this.trail.length; i++) {
      g.strokeStyle = `rgba(70,210,255,${i / this.trail.length * 0.55})`;
      g.beginPath(); g.moveTo(...this.trail[i - 1]); g.lineTo(...this.trail[i]); g.stroke();
    }
    g.fillStyle = '#ffc400';
    g.beginPath(); g.arc(Math.max(c - R, Math.min(c + R, px)), Math.max(c - R, Math.min(c + R, py)), 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '18px system-ui';
    g.fillText('1.0G', c + R * 0.625 - 20, c - 6);
  }
}

export class LapTimer {
  running = false;
  lapTime = 0; // incl. penalties
  penalty = 0;
  lastLap = 0;
  bestLap = 0;
  laps = 0;
  private prevS = 0;

  reset() {
    this.running = false;
    this.lapTime = 0;
    this.penalty = 0;
    this.lastLap = 0;
    this.bestLap = 0;
    this.laps = 0;
    this.prevS = 0;
  }

  addPenalty(sec: number) {
    this.penalty += sec;
    this.lapTime += sec;
  }

  update(dt: number, s: number, v: number): 'lap' | null {
    let ev: 'lap' | null = null;
    if (!this.running && v > 0.5) this.running = true;
    if (this.running) this.lapTime += dt;
    if (this.prevS > 6000 && s < 1200 && this.running && this.prevS - s > 3000) {
      this.lastLap = this.lapTime;
      if (this.bestLap === 0 || this.lapTime < this.bestLap) this.bestLap = this.lapTime;
      this.laps++;
      this.lapTime = 0;
      this.penalty = 0;
      ev = 'lap';
    }
    this.prevS = s;
    return ev;
  }
}

export function fmtTime(t: number): string {
  if (!isFinite(t) || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

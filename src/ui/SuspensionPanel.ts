import { History, drawGraph } from './History';
import type { PanelCtx } from './types';

const LABELS = ['左前', '右前', '左后', '右后'];

export class SuspensionPanel {
  el: HTMLElement;
  private title: HTMLElement;
  private rollC: HTMLCanvasElement;
  private pitchC: HTMLCanvasElement;
  private peaks: HTMLElement;
  private peaksP: HTMLElement;
  private heave: HTMLElement;
  private actFill: HTMLElement[] = [];
  private actVal: HTMLElement[] = [];
  private prev: HTMLElement;
  readonly rollCur = new History(360);
  readonly rollRef = new History(360);
  readonly pitchCur = new History(360);
  readonly pitchRef = new History(360);
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panel';
    this.el.innerHTML = `
      <h3><span class="t">悬架</span><small>[2] 切换 · [X] 透视</small></h3>
      <canvas class="graph roll"></canvas>
      <canvas class="graph pitch" style="height:50px"></canvas>
      <div class="kv"><span class="dim">侧倾峰值(6s)</span><span class="pk"></span></div>
      <div class="kv"><span class="dim">俯仰峰值(6s)</span><span class="pkp"></span></div>
      <div class="kv"><span class="dim">车身升降 / 预瞄</span><span class="hv"></span></div>
      <div class="actbars">${LABELS.map(() => '<div class="ab"><i></i><span></span></div>').join('')}</div>
      <div class="wlabels" style="margin-top:3px">${LABELS.map((l) => `<span>${l}作动力</span>`).join('')}</div>
      <div class="kv"><span class="dim">图例</span><span><span class="cy">━ 当前</span> <span class="or">━ 被动对照</span></span></div>`;
    parent.appendChild(this.el);
    this.title = this.el.querySelector('.t') as HTMLElement;
    this.rollC = this.el.querySelector('.roll') as HTMLCanvasElement;
    this.pitchC = this.el.querySelector('.pitch') as HTMLCanvasElement;
    this.peaks = this.el.querySelector('.pk') as HTMLElement;
    this.peaksP = this.el.querySelector('.pkp') as HTMLElement;
    this.heave = this.el.querySelector('.hv') as HTMLElement;
    this.prev = this.heave;
    this.el.querySelectorAll('.ab').forEach((a) => {
      this.actFill.push(a.querySelector('i') as HTMLElement);
      this.actVal.push(a.querySelector('span') as HTMLElement);
    });
  }

  sample(ctx: PanelCtx) {
    this.rollCur.push(ctx.player.tel.rollDeg);
    this.rollRef.push(ctx.ref.tel.rollDeg);
    this.pitchCur.push(ctx.player.tel.pitchDeg);
    this.pitchRef.push(ctx.ref.tel.pitchDeg);
  }

  update(ctx: PanelCtx, dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    const p = ctx.player;
    const act = p.opts.active;
    this.title.innerHTML = act ? '悬架 · <span class="cy">全主动概念</span>' : '悬架 · <span class="or">弹簧阻尼</span>';
    const W = 360;
    const pc = this.rollCur.maxAbs(W), pr = this.rollRef.maxAbs(W);
    const ppc = this.pitchCur.maxAbs(W), ppr = this.pitchRef.maxAbs(W);
    const pct = (a: number, b: number) => (b > 0.2 ? ` <span class="dim">(${((a / b) * 100).toFixed(0)}%)</span>` : '');
    this.peaks.innerHTML = `<span class="cy">${pc.toFixed(1)}°</span> / <span class="or">${pr.toFixed(1)}°</span>${pct(pc, pr)}`;
    this.peaksP.innerHTML = `<span class="cy">${ppc.toFixed(2)}°</span> / <span class="or">${ppr.toFixed(2)}°</span>${pct(ppc, ppr)}`;
    this.heave.innerHTML = `${p.tel.heaveMm.toFixed(0)} mm · <span class="dim">${act ? p.active.lastPreviewDist.toFixed(0) + ' m' : '关'}</span>`;
    const rmax = Math.max(3, Math.min(14, Math.ceil(Math.max(pc, pr) + 1)));
    drawGraph(this.rollC, [
      { h: this.rollRef, color: '#ff8a3d', width: 1.3 },
      { h: this.rollCur, color: '#46d2ff', width: 1.9 },
    ], -rmax, rmax, { zero: true, label: `侧倾角 ±${rmax}°` });
    const pmax = Math.max(1, Math.min(8, Math.ceil(Math.max(ppc, ppr) + 0.5)));
    drawGraph(this.pitchC, [
      { h: this.pitchRef, color: '#ff8a3d', width: 1.3 },
      { h: this.pitchCur, color: '#46d2ff', width: 1.9 },
    ], -pmax, pmax, { zero: true, label: `俯仰角 ±${pmax}°` });
    for (let i = 0; i < 4; i++) {
      const f = p.tel.fAct[i] / 6000;
      const fill = this.actFill[i];
      const hgt = Math.min(1, Math.abs(f)) * 50;
      fill.style.height = `${hgt}%`;
      fill.style.top = f >= 0 ? `${50 - hgt}%` : '50%';
      fill.style.background = f >= 0 ? '#3d8bff' : '#ff4d4d';
      this.actVal[i].textContent = `${(p.tel.fAct[i] / 1000).toFixed(1)}kN`;
    }
  }
}

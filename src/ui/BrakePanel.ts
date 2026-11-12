import { History, drawGraph } from './History';
import type { PanelCtx } from './types';

const LABELS = ['左前', '右前', '左后', '右后'];

export class BrakePanel {
  el: HTMLElement;
  private bars: HTMLElement[] = [];
  private fills: HTMLElement[] = [];
  private vals: HTMLElement[] = [];
  private title: HTMLElement;
  private resp: HTMLElement;
  private stopCur: HTMLElement;
  private stopRef: HTMLElement;
  private test: HTMLElement;
  private canvas: HTMLCanvasElement;
  private slipCur = new History(240);
  private slipRef = new History(240);
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panel';
    this.el.innerHTML = `
      <h3><span class="t">制动</span><small>[1] 切换</small></h3>
      <div class="wheelbars"></div>
      <div class="wlabels">${LABELS.map((l) => `<span>${l}</span>`).join('')}</div>
      <div class="kv"><span class="dim">模拟响应</span><span class="resp"></span></div>
      <div class="kv"><span class="dim">本次制动</span><span class="stopc"></span></div>
      <div class="kv"><span class="dim">对照(液压)</span><span class="stopr"></span></div>
      <div class="kv"><span class="dim">测试区 200→0</span><span class="test"></span></div>
      <canvas class="graph"></canvas>
      <div class="kv"><span class="dim">左前轮滑移率</span><span><span class="cy">━ 当前</span> <span class="or">━ 液压对照</span></span></div>`;
    parent.appendChild(this.el);
    const wb = this.el.querySelector('.wheelbars') as HTMLElement;
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('div');
      b.className = 'wb';
      b.innerHTML = '<i></i><span></span>';
      wb.appendChild(b);
      this.bars.push(b);
      this.fills.push(b.querySelector('i') as HTMLElement);
      this.vals.push(b.querySelector('span') as HTMLElement);
    }
    this.title = this.el.querySelector('.t') as HTMLElement;
    this.resp = this.el.querySelector('.resp') as HTMLElement;
    this.stopCur = this.el.querySelector('.stopc') as HTMLElement;
    this.stopRef = this.el.querySelector('.stopr') as HTMLElement;
    this.test = this.el.querySelector('.test') as HTMLElement;
    this.canvas = this.el.querySelector('canvas') as HTMLCanvasElement;
  }

  sample(ctx: PanelCtx) {
    this.slipCur.push(Math.max(0, ctx.player.slip[0]));
    this.slipRef.push(Math.max(0, ctx.ref.slip[0]));
  }

  update(ctx: PanelCtx, dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    const p = ctx.player;
    const emb = p.opts.emb;
    this.title.innerHTML = emb ? '制动 · <span class="cy">EMB 概念对照</span>' : '制动 · <span class="or">液压 ABS / EBD</span>';
    const tel = p.tel;
    for (let i = 0; i < 4; i++) {
      this.fills[i].style.height = `${Math.min(100, tel.brakeFrac[i] * 100)}%`;
      this.vals[i].textContent = `${(tel.brakeForce[i] / 1000).toFixed(1)}kN`;
      this.bars[i].classList.toggle('abs', tel.absActive[i] && tel.brakeFrac[i] > 0.05);
    }
    const fmtResp = (v: { hasResponse: boolean; responseMs: number }) => (v.hasResponse ? `${v.responseMs.toFixed(0)} ms` : '--');
    this.resp.innerHTML = `<span class="cy">EMB ${fmtResp(p.emb)}</span> · <span class="or">液压 ${fmtResp(ctx.ref.hyd.hasResponse ? ctx.ref.hyd : p.hyd)}</span>`;
    const ev = ctx.brakeEv;
    const fmtEv = (e: typeof ev.player) => (e.v0 > 0 ? `${e.dist.toFixed(0)} m / ${e.time.toFixed(2)} s <span class="dim">(${e.v0.toFixed(0)}→0)</span>` : '--');
    this.stopCur.innerHTML = fmtEv(ev.player);
    this.stopRef.innerHTML = fmtEv(ev.ref);
    const h = ctx.scen.brakeHistory;
    const f = (k: string) => (h[k] ? `${h[k]!.norm200.toFixed(0)} m` : '--');
    this.test.innerHTML = `<span class="cy">EMB ${f('EMB')}</span> · <span class="or">液压 ${f('液压')}</span>`;
    drawGraph(this.canvas, [
      { h: this.slipRef, color: '#ff8a3d', width: 1.2 },
      { h: this.slipCur, color: '#46d2ff', width: 1.8 },
    ], 0, 0.5, { band: [0.10, 0.12, 'rgba(70,210,255,0.14)'], guides: [0.25], label: '滑移率 0–50%  (10–12% 为目标区)' });
  }
}

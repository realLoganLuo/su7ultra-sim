import './style.css';
import { BrakePanel } from './BrakePanel';
import { SuspensionPanel } from './SuspensionPanel';
import { GMeter } from './GMeter';
import { fmtTime } from '../game/LapTimer';
import type { PanelCtx } from './types';

export interface HudState {
  section: string;
  lapTime: number;
  bestLap: number;
  lastLap: number;
  penalty: number;
  laps: number;
  kmh: number;
  powerKW: number;
  throttle: number;
  brake: number;
  ayG: number;
  axG: number;
  emb: boolean;
  active: boolean;
  ghost: boolean;
  xray: boolean;
  cam: string;
  paint: string;
  overspeed: 0 | 1 | 2; // 1 = warn, 2 = danger
  advisedKmh: number;
  crashed: boolean;
  inBrakeZone: boolean;
  fps: number;
}

export class Hud {
  root: HTMLElement;
  brakePanel: BrakePanel;
  suspPanel: SuspensionPanel;
  gmeter: GMeter;
  private el: Record<string, HTMLElement> = {};
  private menu: HTMLElement;
  private toasts: HTMLElement;
  private result: HTMLElement;
  private hint: HTMLElement;
  private resultTimer = 0;
  private acc = 0;

  constructor(cb: { onStart: () => void; onShowcase: () => void }) {
    this.root = document.createElement('div');
    this.root.id = 'ui';
    document.body.appendChild(this.root);
    this.root.innerHTML = `
      <div class="hud-tl">
        <div class="sec" data-k="sec">起点 · T13</div>
        <div class="lap" data-k="lap"></div>
      </div>
      <div class="hud-top">
        <div class="hud-chips" data-k="chips"></div>
        <div class="orbit-hint" data-k="ohint">鼠标拖动 360° 查看 · 滚轮缩放 · 双击 / C 回追尾</div>
      </div>
      <div class="toasts" data-k="toasts"></div>
      <div class="warn-banner" data-k="warn"></div>
      <div class="hud-speed">
        <div><span class="v" data-k="speed">0</span><span class="u">km/h</span></div>
        <div class="pw" data-k="pw"></div>
        <div class="bars"><div class="bar"><i data-k="thr"></i></div><div class="bar br"><i data-k="brk"></i></div></div>
      </div>
      <div class="hud-g" data-k="g"><div class="gt" data-k="gt"></div></div>
      <div class="panel hud-help">
        <b>W/↑</b> 加速 · <b>S/↓</b> 制动 · <b>空格</b> 紧急制动<br><b>A D/←→</b> 转向 · <b>1</b> EMB⇄液压 · <b>2</b> 主动⇄被动<br>
        <b>X</b> 透视 · <b>C</b> 镜头 · <b>G</b> 幽灵车 · <b>R</b> 重置<br><b>T</b> 急刹测试 · <b>M</b> 麋鹿测试 · <b>P</b> 涂装<br><b>Tab</b> 隐藏面板 · <b>Esc</b> 菜单
      </div>
      <div class="panel result" data-k="result"></div>
      <div class="hud-right" data-k="right"></div>
      <div class="loading" data-k="loading"><div class="lb"><i data-k="lbar"></i></div><span data-k="ltxt">正在加载真实车模…</span></div>
      <div class="bottom-dock">
        <div class="showcase-hint" data-k="hint"><b>展示模式</b> · 鼠标拖动旋转 / 滚轮缩放 · <b>P</b> 切换涂装 · <b>X</b> 透视悬架 · <b>Esc</b> 返回菜单</div>
        <div class="credit" data-k="credit">车模：<a>Xiaomi SU7 Ultra Nürburgring</a> by MattDoesBlender · CC-BY-4.0 (sketchfab.com/3d-models/xiaomi-su7-ultra-nurburgring-df6d8c7af9764d31a4ecef61925c13bb)</div>
      </div>
      <div class="fps" data-k="fps"></div>
      <div class="menu" data-k="menu">
        <div class="card">
          <div class="disc">物理驾驶演示 · 参数近似，非官方标定</div>
          <h1>SU7 <span>Ultra</span> · 纽北驾驶演示</h1>
          <div class="sub">小米 SU7 Ultra 纽北原型车 3D 车模 · 连续转向 × 轮胎抓地 × ABS 制动 · 仿纽博格林北环赛道</div>
          <table>
            <tr><td>加速 / 制动</td><td><kbd>W</kbd>/<kbd>↑</kbd> 加速 · <kbd>S</kbd>/<kbd>↓</kbd> 渐进制动 · <kbd>空格</kbd> 紧急制动 (触发 ABS)</td></tr>
            <tr><td>转向</td><td><kbd>A</kbd><kbd>D</kbd> 或 <kbd>←</kbd><kbd>→</kbd> 按住连续转向，松开回正；高速请点按微调，需要自行转弯</td></tr>
            <tr><td>技术开关</td><td><kbd>1</kbd> EMB 概念对照 ⇄ 液压 ABS / EBD · <kbd>2</kbd> 全主动概念对照 ⇄ 弹簧阻尼近似</td></tr>
            <tr><td>观察</td><td><kbd>X</kbd> 透视（悬架/减震器变色） · <kbd>C</kbd> 切换镜头 · <kbd>G</kbd> 幽灵车（被动+液压）</td></tr>
            <tr><td>测试</td><td><kbd>T</kbd> 200→0 急刹测试 · <kbd>M</kbd> 麋鹿测试 · <kbd>R</kbd> 重置到检查点 · <kbd>P</kbd> 涂装</td></tr>
          </table>
          <div class="btns"><button class="primary" data-k="start">开始驾驶</button><button data-k="show">展示模式（看车）</button></div>
          <div class="note">默认使用液压 ABS / EBD 与弹簧阻尼近似；EMB 和全主动悬架仅为可选概念对照。<br>轮胎、转向与阻尼参数为估算，赛道为近似重建，不等同实车测试。<br>
          赛道、路面、环境与车辆物理均为程序生成；赛道为纽北风格虚构赛道，非实测数据。<br>
          车模：<a href="https://sketchfab.com/3d-models/xiaomi-su7-ultra-nurburgring-df6d8c7af9764d31a4ecef61925c13bb" target="_blank" rel="noopener">“Xiaomi Su7 Ultra Nurburgring”</a> by <a href="https://sketchfab.com/MattDoesBlender" target="_blank" rel="noopener">MattDoesBlender</a>，授权 <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY-4.0</a>（已压缩/重排节点用于网页）。</div>
        </div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.menu = this.el.menu;
    this.toasts = this.el.toasts;
    this.result = this.el.result;
    this.hint = this.el.hint;
    this.el.start.addEventListener('click', cb.onStart);
    this.el.show.addEventListener('click', cb.onShowcase);
    this.brakePanel = new BrakePanel(this.el.right);
    this.suspPanel = new SuspensionPanel(this.el.right);
    this.gmeter = new GMeter(this.el.g);
    this.el.g.insertBefore(this.gmeter.canvas, this.el.gt);
    this.setPlaying(false);
  }

  /** menu / showcase / playing visibility */
  setMenu(visible: boolean) {
    this.menu.style.display = visible ? 'flex' : 'none';
  }

  setLoading(on: boolean, frac: number) {
    this.el.loading.style.display = on ? 'flex' : 'none';
    (this.el.lbar as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    this.el.ltxt.textContent = frac > 0 && frac < 1 ? `正在加载真实车模… ${Math.round(frac * 100)}%` : '正在加载真实车模…';
  }

  setShowcase(on: boolean) {
    this.hint.style.display = on ? 'block' : 'none';
  }

  setPlaying(on: boolean) {
    const vis = on ? '' : 'none';
    for (const k of ['pw', 'g', 'right', 'sec', 'lap', 'chips', 'ohint']) if (this.el[k]) this.el[k].style.display = vis;
    this.root.querySelector<HTMLElement>('.hud-speed')!.style.display = vis;
    this.root.querySelector<HTMLElement>('.hud-help')!.style.display = vis;
    this.root.querySelector<HTMLElement>('.hud-tl')!.style.display = vis;
    if (!on) this.result.style.display = 'none';
  }

  togglePanels() {
    this.root.classList.toggle('hidden-panels');
  }

  toast(text: string, kind: '' | 'warn' | 'good' = '', ms = 2600) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild!.remove();
    setTimeout(() => t.remove(), ms);
  }

  showResult(html: string, ms = 14000) {
    this.result.innerHTML = html;
    this.result.style.display = 'block';
    clearTimeout(this.resultTimer);
    this.resultTimer = window.setTimeout(() => (this.result.style.display = 'none'), ms);
  }

  sampleGraphs(ctx: PanelCtx) {
    this.brakePanel.sample(ctx);
    this.suspPanel.sample(ctx);
  }

  update(s: HudState, ctx: PanelCtx, dt: number) {
    this.acc += dt;
    const e = this.el;
    this.brakePanel.update(ctx, dt);
    this.suspPanel.update(ctx, dt);
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    e.sec.textContent = s.section;
    e.lap.innerHTML = `圈速 <b>${fmtTime(s.lapTime)}</b>${s.penalty > 0 ? ` <span style="color:#ff8080">(+${s.penalty.toFixed(0)}s 罚时)</span>` : ''}<br>
      <span class="dim">最佳</span> ${fmtTime(s.bestLap)} · <span class="dim">上圈</span> ${fmtTime(s.lastLap)} · <span class="dim">第</span> ${s.laps + 1} <span class="dim">圈</span>`;
    e.speed.textContent = s.kmh.toFixed(0);
    e.pw.innerHTML = `功率 <b class="acc">${Math.max(0, s.powerKW).toFixed(0)}</b> kW ${s.inBrakeZone ? '<span class="cy"> · 急刹测试区</span>' : ''}`;
    (e.thr as HTMLElement).style.width = `${s.throttle * 100}%`;
    (e.brk as HTMLElement).style.width = `${s.brake * 100}%`;
    e.gt.textContent = `横向 ${s.ayG >= 0 ? '←' : '→'} ${Math.abs(s.ayG).toFixed(2)} G · 纵向 ${s.axG >= 0 ? '加' : '减'} ${Math.abs(s.axG).toFixed(2)} G`;
    this.gmeter.update(s.ayG, s.axG);
    const chip = (label: string, val: string, on = false) => `<div class="chip ${on ? 'on' : ''}">${label} <b>${val}</b></div>`;
    e.chips.innerHTML =
      chip('制动', s.emb ? 'EMB 概念' : '液压 ABS / EBD', s.emb) +
      chip('悬架', s.active ? '全主动概念' : '弹簧阻尼', s.active) +
      chip('幽灵车', s.ghost ? '开' : '关', s.ghost) +
      chip('透视', s.xray ? '开' : '关', s.xray) +
      chip('镜头', s.cam) +
      chip('涂装', s.paint);
    if (s.crashed) { e.warn.style.display = 'block'; e.warn.textContent = '冲出赛道！按 R 重置'; }
    else if (s.overspeed > 0) { e.warn.style.display = 'block'; e.warn.textContent = s.overspeed === 2 ? `弯道超速！ 建议 ≤ ${s.advisedKmh.toFixed(0)} km/h` : `弯道注意减速 · 建议 ≤ ${s.advisedKmh.toFixed(0)} km/h`; e.warn.style.background = s.overspeed === 2 ? 'rgba(210,30,30,.85)' : 'rgba(210,130,20,.85)'; }
    else e.warn.style.display = 'none';
    e.fps.textContent = s.fps > 0 ? `${s.fps.toFixed(0)} fps` : '';
  }
}

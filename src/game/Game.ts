import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CAR, KEYS, DEFAULTS, PHYS_DT } from '../config';
import { road } from '../track/roadSurface';
import { Track } from '../track/Track';
import { Terrain, buildTerrainMesh, buildForest, createSky, createSkyEnvScene } from '../track/Scenery';
import { CarModel, WHEEL_POS } from '../car/CarModel';
import { loadGlbTemplate, GlbTemplate } from '../car/glbCar';
import { tyreGap } from '../car/wheelContact';
import { STATIC_DEFLECT } from '../physics/Suspension';
import { SuspensionRig } from '../car/SuspensionRig';
import { PaintName } from '../car/materials';
import { Vehicle, safeSpeed } from '../physics/Vehicle';
/** tyres are drawn this deep into the road (contact-patch flattening) - never a positive gap */
const VISUAL_SINK = 0.015;
import { CameraRig, CAM_NAMES } from '../camera/CameraRig';
import { Controls } from '../ui/Controls';
import { Hud, HudState } from '../ui/Hud';
import type { BrakeEvent, PanelCtx } from '../ui/types';
import { Traffic, TrafficCar, playerVsTraffic } from './Traffic';
import { Scenarios, BrakeResult, MooseResult } from './Scenarios';
import { LapTimer, fmtTime } from './LapTimer';
import { Debris } from './Debris';
import { CarDamage } from '../car/CarDamage';
import type { Impact } from '../physics/Barrier';

const PAINT_RGB = { lava: 0xf2b200, pearl: 0xeef0f2 } as const;

export type Mode = 'menu' | 'showcase' | 'drive';

const newEv = (): BrakeEvent => ({ active: false, done: false, v0: 0, dist: 0, time: 0, system: '' });

export class Game {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  smaa!: SMAAPass;
  quality = 2; // 2 full, 1 no SMAA / lower resolution, 0 no bloom / 1x pixel ratio
  private autoQuality = new URLSearchParams(location.search).get('quality') !== 'high';
  private lowFpsChecks = 0;
  private qualityClock = 0;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 0.2, 4000);
  rig: CameraRig;
  controls = new Controls();
  hud: Hud;
  mode: Mode = 'menu';

  // world
  world = new THREE.Group();
  showroom = new THREE.Group();
  track!: Track;
  terrain!: Terrain;
  traffic!: Traffic;
  sky: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  studioKey: THREE.DirectionalLight;
  envSky: THREE.Texture;
  envStudio: THREE.Texture;

  // cars
  car: CarModel;
  refCar: CarModel | null = null;
  rig3: SuspensionRig;
  damage: CarDamage;
  debris: Debris;
  private sdTmp = { s: 0, d: 0 };
  player = new Vehicle({ emb: DEFAULTS.emb, active: DEFAULTS.activeSusp });
  ref = new Vehicle({ emb: false, active: false });
  ghostVisible = false;
  private ghostSide = 1;
  xray = false;
  paint: PaintName = 'lava';

  // gameplay
  scen = new Scenarios();
  lap = new LapTimer();
  throttle = 0;
  brake = 0;
  private brakeEv = { player: newEv(), ref: newEv() };
  private prevBrakePedal = 0;
  private coneHits = 0;
  private lastToastAt = 0;
  private acc = 0;
  private simTick = 0;
  private lastTime = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  fps = 0;
  private overspeedLevel: 0 | 1 | 2 = 0;
  private advised = 0;
  private firstCornerHinted = false;
  private autoRotate = true;
  paused = false; // debug / automation: render without advancing the simulation
  glbTpl: GlbTemplate | null = null;
  modelState: 'loading' | 'glb' | 'procedural' = 'loading';

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // environments
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envSky = pm.fromScene(createSkyEnvScene(), 0.02).texture;
    this.envStudio = pm.fromScene(new RoomEnvironment(), 0.03).texture;
    pm.dispose();

    this.scene.add(this.world, this.showroom);
    this.scene.fog = new THREE.Fog(0xc9c8c0, 150, 1500);

    // lights
    this.sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 220;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.hemi = new THREE.HemisphereLight(0xbfd2ea, 0x4a5a3a, 0.55);
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.studioKey = new THREE.DirectionalLight(0xffffff, 0.95);
    this.studioKey.position.set(5, 8, 4);
    this.studioKey.castShadow = true;
    this.studioKey.shadow.mapSize.set(2048, 2048);
    const kc = this.studioKey.shadow.camera;
    kc.left = -9; kc.right = 9; kc.top = 9; kc.bottom = -9; kc.near = 1; kc.far = 30;
    this.showroom.add(this.studioKey);

    // sky
    this.sky = createSky();
    this.scene.add(this.sky);

    // world content
    this.track = new Track();
    this.terrain = new Terrain();
    this.world.add(this.track.group);
    const tm = buildTerrainMesh(this.terrain);
    this.world.add(tm);
    this.world.add(buildForest(this.terrain));
    this.traffic = new Traffic(9, [[0, 350], [this.scen.zoneStart - 500, road.length], [this.scen.mooseStart - 250, this.scen.mooseEnd + 60]]);
    this.world.add(this.traffic.group);
    this.buildScenarioProps();

    // showroom
    const fc = document.createElement('canvas');
    fc.width = fc.height = 256;
    const fg = fc.getContext('2d')!;
    const grad = fg.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, '#3a3f48');
    grad.addColorStop(0.55, '#1c1f25');
    grad.addColorStop(1, '#0d0f13');
    fg.fillStyle = grad;
    fg.fillRect(0, 0, 256, 256);
    const ftex = new THREE.CanvasTexture(fc);
    ftex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 80),
      new THREE.MeshStandardMaterial({ map: ftex, color: 0x777777, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.2 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.showroom.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 5.68, 96), new THREE.MeshBasicMaterial({ color: 0xffc400 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.showroom.add(ring);

    // car(s)
    this.car = new CarModel();
    this.scene.add(this.car.root);
    this.rig3 = new SuspensionRig(this.car);
    this.damage = new CarDamage(this.car);
    this.debris = new Debris((x, z, sHint) => {
      road.worldToSD(x, z, sHint, this.sdTmp);
      const { s, d } = this.sdTmp;
      // road, curbs and verges are the road surface; beyond them the terrain mesh
      return { y: Math.abs(d) <= 22 ? road.height(s, d) : this.terrain.heightAt(x, z), s, d };
    }, PAINT_RGB[this.paint]);
    this.world.add(this.debris.group);

    // camera / ui
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.rig = new CameraRig(this.camera, canvas);
    this.hud = new Hud({ onStart: () => this.startDriving(), onShowcase: () => this.startShowcase() });

    // post-processing
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaa);

    window.addEventListener('resize', () => this.onResize());
    // mouse: dragging / scrolling while driving switches to a free 360 deg orbit that follows the car
    const grab = (e: Event) => {
      if (this.mode === 'drive' && e.target === canvas && this.rig.mode !== 'orbit') this.rig.startOrbitKeepView();
    };
    window.addEventListener('pointerdown', grab, true);
    window.addEventListener('wheel', grab, { capture: true, passive: true });
    canvas.addEventListener('dblclick', () => {
      if (this.mode === 'drive') { this.rig.setMode('chase'); this.hud.toast(`镜头：${CAM_NAMES.chase}`); }
    });
    void this.loadModel();
    this.controls.onPress((c) => this.onKey(c));
    this.enterMenu();
  }

  /** Load the real SU7 Ultra GLB; the procedural car stays as fallback. */
  private async loadModel() {
    this.hud.setLoading(true, 0);
    try {
      if (new URLSearchParams(location.search).get('glb') === 'off') throw new Error('GLB disabled by ?glb=off');
      const tpl = await loadGlbTemplate((f) => this.hud.setLoading(true, f));
      this.glbTpl = tpl;
      this.car.applyGlb(tpl);
      if (this.refCar) this.refCar.applyGlb(tpl);
      this.car.setPaint(this.paint);
      this.modelState = 'glb';
      console.info(tpl.info);
    } catch (e) {
      this.modelState = 'procedural';
      console.warn('GLB load failed, using the procedural car', e);
      this.hud.toast('真实车模加载失败，已使用程序化车模', 'warn', 5000);
    }
    this.hud.setLoading(false, 1);
  }

  // ------------------------------------------------------------------ scenario props
  private buildScenarioProps() {
    const sc = this.scen;
    this.track.addGantry(sc.zoneStart, '急刹测试区 · 200→0', '进入后全力制动 (空格)  ·  按 T 传送', '#5a1010');
    this.track.addGantry(sc.zoneEnd, '测试区结束', '', '#333b45');
    this.track.addGantry(sc.mooseStart - 30, '麋鹿测试 · 建议 ≤ 80 km/h', '三道锥桶门 · 按 M 传送', '#6a3a00');
    this.track.addGantry(1, '起点 / 终点  START · FINISH', '', '#10305a');
    this.traffic.addMoose(sc.mooseStart);
  }

  // ------------------------------------------------------------------ modes
  private setWorldVisible(world: boolean) {
    this.world.visible = world;
    this.showroom.visible = !world;
    this.sky.visible = world;
    this.scene.fog = world ? new THREE.Fog(0xc9c8c0, 150, 1500) : null;
    this.scene.environment = world ? this.envSky : this.envStudio;
    this.scene.background = world ? null : new THREE.Color(0x0d0f13);
    this.sun.visible = world;
    this.hemi.visible = world;
    this.studioKey.visible = !world;
    this.scene.environmentIntensity = world ? 0.9 : 0.55;
    this.renderer.toneMappingExposure = world ? 0.9 : 0.8;
    this.bloom.strength = world ? 0.45 : 0.22;
  }

  /** a new car: undo body damage, torn parts go back on (fragments and bent rails stay where they are) */
  private newCar() {
    this.damage.repair();
    this.debris.clearParts();
  }

  /** fresh session: the track is clean again */
  private cleanTrack() {
    this.newCar();
    this.debris.clear();
    this.track.repairArmco();
    this.traffic.repair();
  }

  enterMenu() {
    this.cleanTrack();
    this.mode = 'menu';
    this.setWorldVisible(false);
    this.hud.setMenu(true);
    this.hud.setPlaying(false);
    this.hud.setShowcase(false);
    this.poseShowroom();
    this.rig.setMode('orbit');
    this.autoRotate = true;
    this.rig.orbit.autoRotate = true;
    this.rig.orbit.autoRotateSpeed = 1.1;
    this.camera.fov = 34;
    this.camera.updateProjectionMatrix();
    this.rig.orbit.enabled = true;
    this.rig.orbit.target.set(0, 0.62, 0);
    this.camera.position.set(6.4, 1.55, 5.6);
    this.camera.up.set(0, 1, 0);
    this.rig.orbit.update();
  }

  startShowcase() {
    this.mode = 'showcase';
    this.hud.setMenu(false);
    this.hud.setPlaying(false);
    this.hud.setShowcase(true);
    this.rig.orbit.autoRotate = true;
    this.rig.orbit.autoRotateSpeed = 0.9;
  }

  startDriving() {
    this.mode = 'drive';
    this.hud.setMenu(false);
    this.hud.setPlaying(true);
    this.hud.setShowcase(false);
    this.setWorldVisible(true);
    this.rig.orbit.autoRotate = false;
    this.rig.setMode('chase');
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
    this.resetAll(true);
    this.lap.reset();
    this.hud.toast('准备出发 · W 加速，A / D 连续转向，按 1 / 2 对比技术', 'good', 4200);
  }

  private poseShowroom() {
    this.car.root.position.set(0, 0, 0);
    this.car.root.quaternion.identity();
    this.car.bodyGroup.rotation.set(0, 0, 0);
    this.car.bodyGroup.position.y = this.car.pivotY;
    for (let i = 0; i < 4; i++) {
      const w = WHEEL_POS[i];
      this.car.wheelGroups[i].position.set(w.x, this.car.wheelR - VISUAL_SINK, -w.yL);
      this.car.setSpin(i, 0);
      this.car.setBrakeGlow(i, 0, 0);
    }
    this.car.setWingAngle(0.1);
    this.car.setBrakeLights(0);
    if (this.refCar) this.refCar.root.visible = false;
  }

  // ------------------------------------------------------------------ input
  private onKey(code: string) {
    const is = (arr: string[]) => arr.includes(code);
    if (code === 'Escape') {
      if (this.mode === 'drive' || this.mode === 'showcase') this.enterMenu();
      return;
    }
    if (is(KEYS.xray)) { this.setXray(!this.xray); return; }
    if (is(KEYS.paint)) {
      this.paint = this.paint === 'lava' ? 'pearl' : 'lava';
      this.debris.setPaint(PAINT_RGB[this.paint]);
      this.car.setPaint(this.paint);
      if (this.mode === 'drive') this.hud.toast(`涂装：${this.paint === 'lava' ? '熔岩黄' : '珍珠白 + 黄色条纹'}`);
      return;
    }
    if (this.mode !== 'drive') return;
    const p = this.player;
    if (is(KEYS.toggleBrake)) {
      p.setOptions({ emb: !p.opts.emb });
      this.hud.toast(p.opts.emb ? '制动：EMB 概念对照（非量产实车标定）' : '制动：液压 + ABS / EBD（模拟）', 'good');
    } else if (is(KEYS.toggleSusp)) {
      p.setOptions({ active: !p.opts.active });
      this.hud.toast(p.opts.active ? '悬架：全主动概念对照' : '悬架：弹簧阻尼近似（保留真实载荷转移）', 'good');
    } else if (is(KEYS.camera)) {
      const m = this.rig.cycle();
      this.hud.toast(`镜头：${CAM_NAMES[m]}`);
    } else if (is(KEYS.ghost)) {
      this.ghostVisible = !this.ghostVisible;
      this.ensureRefCar();
      this.ghostSide = p.d > 0 ? -1 : 1;
      if (this.ghostVisible) { this.ref.reset(p.s, p.laneIdx, p.v); this.syncRefLane(true); }
      this.hud.toast(this.ghostVisible ? '幽灵车：被动悬架 + 液压制动（同样输入）' : '幽灵车：关');
    } else if (is(KEYS.reset)) this.resetToCheckpoint();
    else if (code === 'KeyT') this.teleportBrakeTest();
    else if (code === 'KeyM') this.teleportMoose();
    else if (is(KEYS.hidePanels)) this.hud.togglePanels();
  }

  setXray(on: boolean) {
    this.xray = on;
    this.car.setXray(on);
    this.rig3.setVisible(on);
    if (this.mode === 'drive') this.hud.toast(on ? '透视模式：双叉臂 + 减震器（蓝=伸张 红=压缩），制动信号路径' : '透视模式：关');
  }

  private ensureRefCar() {
    if (!this.refCar) {
      this.refCar = new CarModel({ ghost: true });
      if (this.glbTpl) this.refCar.applyGlb(this.glbTpl);
      this.scene.add(this.refCar.root);
    }
  }

  private syncRefLane(immediate = false) {
    const p = this.player;
    const currentLane = Math.max(-1, Math.min(1, Math.round(p.d / 4)));
    let lane = currentLane;
    if (this.ghostVisible) {
      lane += this.ghostSide;
      if (lane < -1 || lane > 1) lane = currentLane - this.ghostSide;
    }
    if (immediate) { this.ref.reset(p.s, lane, p.v); return; }
    this.ref.setLane(lane);
  }

  // ------------------------------------------------------------------ resets / teleports
  resetAll(start = false) {
    this.cleanTrack();
    this.acc = 0;
    this.player.reset(start ? 6 : this.player.s, start ? 0 : this.player.laneIdx, 0);
    this.ref.reset(this.player.s, 0, 0);
    this.throttle = 0; this.brake = 0;
    this.brakeEv = { player: newEv(), ref: newEv() };
    this.traffic.resetCones();
    this.syncRefLane(true);
  }

  resetToCheckpoint() {
    this.newCar();
    const p = this.player;
    const cp = Math.floor(p.s / 500) * 500;
    const crashed = p.crashed;
    const s = Math.max(6, cp);
    p.reset(s, 0, crashed ? 18 : Math.min(p.v, 25));
    this.ref.reset(s, 0, p.v);
    this.syncRefLane(true);
    this.throttle = 0; this.brake = 0;
    this.scen.cancelTests();
    this.hud.toast('已重置到检查点', 'good');
  }

  teleportBrakeTest() {
    this.newCar();
    const p = this.player;
    const s = this.scen.zoneStart + 5;
    this.traffic.clearArea(s, 200, 900);
    p.reset(s, 0, 205 / 3.6);
    this.ref.reset(s, 0, 205 / 3.6);
    this.syncRefLane(true);
    this.throttle = 0; this.brake = 0;
    this.brakeEv = { player: newEv(), ref: newEv() };
    this.scen.cancelTests();
    this.hud.toast('急刹测试：以 205 km/h 进入测试区，请全力制动（空格）。按 1 切换制动系统后再按 T 对比', 'good', 5000);
  }

  teleportMoose() {
    this.newCar();
    const p = this.player;
    const s = this.scen.mooseStart - 150;
    this.traffic.clearArea(s, 200, 600);
    p.reset(s, 0, 88 / 3.6);
    this.ref.reset(s, 0, 88 / 3.6);
    this.syncRefLane(true);
    this.throttle = 0.12; this.brake = 0;
    this.scen.cancelTests();
    for (const c of this.traffic.cones) if (c.group === 'moose') { c.hit = false; c.t = 0; }
    this.traffic.refreshInstances();
    this.hud.toast('麋鹿测试：保持 ~80 km/h，依次变道绕过三道锥桶门：先左道 → 中道 → 右道（A / D）', 'good', 5000);
  }

  // ------------------------------------------------------------------ simulation
  private updatePedals(dt: number) {
    const c = this.controls;
    if (c.ebrake) {
      this.brake = 1;
    } else if (c.brake) {
      if (this.brake < 0.05) this.brake = 0.05;
      this.brake = Math.min(1, this.brake + dt / 0.28);
    } else {
      this.brake = Math.max(0, this.brake - dt * 6);
    }
    if (c.accel && this.brake < 0.02) this.throttle = Math.min(1, this.throttle + dt * 2.4);
    else this.throttle = Math.max(0, this.throttle - dt * 5);
    if (this.brake > 0.02) this.throttle = 0;
  }

  private trackBrakeEvent(ev: BrakeEvent, veh: Vehicle, pedal: number) {
    const kmh = veh.v * 3.6;
    if (!ev.active) {
      if (pedal > 0.3 && kmh > 30 && this.prevBrakePedal < 0.3) {
        ev.active = true; ev.done = false; ev.v0 = kmh; ev.dist = 0; ev.time = 0; ev.system = veh.opts.emb ? 'EMB' : '液压';
      }
    } else {
      ev.dist += veh.v * PHYS_DT * 1;
      ev.time += PHYS_DT;
      if (kmh < 1) { ev.active = false; ev.done = true; }
      else if (pedal < 0.05 && ev.time > 0.3) { ev.active = false; ev.v0 = 0; }
    }
  }

  simStep(dt: number) {
    this.updatePedals(dt);
    const inp = { throttle: this.throttle, brake: this.brake, steer: this.controls.steer };
    const p = this.player;
    p.step(dt, inp);
    this.ref.step(dt, inp);
    this.traffic.update(dt);

    // brake statistics (player vs reference)
    this.trackBrakeEvent(this.brakeEv.player, p, this.brake);
    this.trackBrakeEvent(this.brakeEv.ref, this.ref, this.brake);
    this.prevBrakePedal = this.brake;

    // lap timer
    if (this.lap.update(dt, p.s, p.v) === 'lap') {
      this.hud.toast(`完成一圈 ${fmtTime(this.lap.lastLap)}`, 'good', 4000);
    }

    // collisions
    this.collisions(dt);

    // scenarios
    const bt = this.scen.updateBrakeTest(dt, p, this.brake, this.ref);
    if (bt === 'cancel') this.hud.toast('急刹测试中断', 'warn');
    else if (bt) this.showBrakeResult(bt);
    const mt = this.scen.updateMoose(dt, p, this.coneHits);
    if (mt) this.showMooseResult(mt);

    // overspeed warning
    const look = Math.min(260, 30 + (p.v * p.v) / (2 * 9));
    let vs = 1e9;
    for (let q = 0; q <= look; q += 15) vs = Math.min(vs, safeSpeed(p.s + q, p.d));
    this.advised = vs * 3.6;
    const vsHere = safeSpeed(p.s, p.d);
    this.overspeedLevel = p.v > vsHere * 0.98 ? 2 : p.v > vs * 0.97 && p.v > 20 ? 1 : 0;

    // One gentle hint per page load: holding only W from the grid runs wide at the first bend (~6 s).
    if (!this.firstCornerHinted && this.lap.laps === 0 && p.s > 30 && p.s < 100 && p.v > 20) {
      this.firstCornerHinted = true;
      this.hud.toast('前方连续弯道 · 用 A / D 转向跟随赛道，入弯前松开 W、按 S 减速', 'warn', 4500);
    }

    // graph sampling at 60 Hz
    if (++this.simTick % 2 === 0) this.hud.sampleGraphs(this.panelCtx());
  }

  private collisions(dt: number) {
    void dt;
    const p = this.player;
    const L = road.length;
    const dsOf = (s: number) => { let d = s - p.s; d = ((d + L / 2) % L + L) % L - L / 2; return d; };
    for (const c of this.traffic.cones) {
      if (c.hit) continue;
      const ds = dsOf(c.s);
      if (Math.abs(ds) < 2.5 && Math.abs(c.d - p.d) < 1.3) {
        this.traffic.hitCone(c, p.v, Math.sign(c.d - p.d) || 1);
        this.lap.addPenalty(2);
        this.coneHits++;
        p.v = Math.max(0, p.v - Math.min(2.5, 0.05 * p.v + 0.5));
        this.notify('撞倒锥桶  +2 s', 'warn');
      }
    }
    for (const car of this.traffic.cars) this.carContact(car, dsOf(car.s));
  }

  /** rigid-body contact between the player and one traffic car (see playerVsTraffic) */
  private carContact(car: TrafficCar, ds: number) {
    const r = playerVsTraffic(this.player, car, ds);
    if (r && r.fresh && car.hitTimer <= 0 && r.energyJ > 1500) { this.lap.addPenalty(5); car.hitTimer = 3; }
  }

  private notify(text: string, kind: '' | 'warn' | 'good') {
    const now = performance.now();
    if (now - this.lastToastAt < 350) return;
    this.lastToastAt = now;
    this.hud.toast(text, kind, 1800);
  }

  private showBrakeResult(r: BrakeResult) {
    const o = this.scen.brakeHistory;
    const row = (k: string, label: string) => {
      const x = o[k];
      return x ? `<tr><td>${label}</td><td>${x.v0.toFixed(0)}</td><td>${x.dist.toFixed(1)}</td><td>${x.time.toFixed(2)}</td><td>${x.norm200.toFixed(0)}</td><td>${x.respMs.toFixed(0)}</td></tr>` : `<tr><td>${label}</td><td colspan=5 class="dim">尚无成绩</td></tr>`;
    };
    this.hud.showResult(`
      <h3>急刹测试结果 <small>本次：${r.system}</small></h3>
      <table><tr><th></th><th>初速</th><th>距离m</th><th>用时s</th><th>折算200→0 m</th><th>响应ms</th></tr>
      ${row('EMB', 'EMB 概念')}${row('液压', '液压 ABS / EBD')}</table>
      <div class="dim" style="margin-top:4px">按 1 切换制动系统，再按 T 重新测试以对比。</div>`);
    this.hud.toast(`急刹测试：${r.v0.toFixed(0)}→0 km/h · ${r.dist.toFixed(1)} m · ${r.time.toFixed(2)} s`, 'good', 5000);
  }

  private showMooseResult(r: MooseResult) {
    this.hud.showResult(`
      <h3>麋鹿测试结果 <small>${r.susp}悬架</small></h3>
      <table><tr><th>进入车速</th><td>${r.entry.toFixed(0)} km/h</td></tr>
      <tr><th>最大侧倾角</th><td>${r.maxRoll.toFixed(2)}°</td></tr>
      <tr><th>撞倒锥桶</th><td>${r.hits}</td></tr>
      <tr><th>用时</th><td>${r.time.toFixed(2)} s</td></tr></table>
      <div class="dim" style="margin-top:4px">按 2 切换主动/被动悬架后按 M 重做，对比最大侧倾角。</div>`);
    this.hud.toast(`麋鹿测试：最大侧倾 ${r.maxRoll.toFixed(2)}°，撞倒 ${r.hits} 个锥桶`, 'good', 5000);
  }

  panelCtx(): PanelCtx {
    return {
      player: this.player, ref: this.ref, ghostVisible: this.ghostVisible,
      brakeEv: this.brakeEv, scen: this.scen, pedal: this.brake,
    };
  }

  // ------------------------------------------------------------------ visual sync
  private tmpO = new THREE.Vector3();
  private tmpF = new THREE.Vector3();
  private tmpL = new THREE.Vector3();
  private tmpN = new THREE.Vector3();
  private tmpR = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();

  private syncCar(model: CarModel, veh: Vehicle, alpha = 1) {
    const o = this.tmpO, f = this.tmpF, l = this.tmpL, n = this.tmpN, r = this.tmpR;
    const pose = veh.renderPose(alpha);
    road.frame(pose.s, pose.d, o, f, l, n);
    r.crossVectors(f, n);
    this.tmpM.makeBasis(f, n, r);
    this.tmpQ.setFromRotationMatrix(this.tmpM);
    this.tmpQ2.setFromAxisAngle(n, pose.yaw);
    this.tmpQ.premultiply(this.tmpQ2);
    model.root.position.copy(o);
    model.root.quaternion.copy(this.tmpQ);
    const sp = pose;
    model.bodyGroup.position.y = model.pivotY + sp.q;
    model.bodyGroup.rotation.set(sp.phi, 0, -sp.theta);
    model.root.updateMatrixWorld(true);
    for (let i = 0; i < 4; i++) {
      const w = WHEEL_POS[i];
      // Follow the simulated unsprung hub, including tyre deflection and lift-off.
      // Snapping every wheel directly to each road ripple bypasses suspension filtering.
      model.wheelGroups[i].position.set(w.x, pose.hubs[i] + model.wheelR - STATIC_DEFLECT[i], -w.yL);
      model.setSpin(i, pose.spin[i]);
      const temp = Math.min(1, Math.max(0, (veh.discTemp[i] - 60) / 500));
      model.setBrakeGlow(i, veh.tel.brakeFrac[i] ?? 0, temp);
    }
    model.setSteer(pose.steer);
    if (model === this.car) this.damage.alignWheels(veh.wheelDmg, pose.spin);
    model.setWingAngle(veh.wingAngle);
    model.setBrakeLights(veh.brakeLightLevel);
  }

  /** place car, ghost and traffic meshes from the simulation state */
  syncVisuals(forceGhost = false, alpha = 1) {
    this.syncCar(this.car, this.player, alpha);
    if ((this.ghostVisible || forceGhost) && this.refCar) {
      this.refCar.root.visible = this.ghostVisible;
      this.syncCar(this.refCar, this.ref, alpha);
    } else if (this.refCar) this.refCar.root.visible = false;
    this.traffic.syncMeshes();
  }

  // ---- tyre / road contact measurement (debug + verification) ----
  gapTracking = false;
  gapStats: Record<string, { max: number; min: number; n: number }> = {};
  gapOutliers: string[] = [];
  resetGapStats() {
    this.gapStats = {};
    this.gapOutliers = [];
  }
  private addGap(key: string, gap: number) {
    const g = (this.gapStats[key] ??= { max: -1e9, min: 1e9, n: 0 });
    g.max = Math.max(g.max, gap);
    g.min = Math.min(g.min, gap);
    g.n++;
  }
  /** measure bottom-of-tyre minus road height for every wheel currently placed (player, ghost, traffic) */
  sampleGaps() {
    const wheelsOf = (model: CarModel, key: string, s: number) => {
      for (let i = 0; i < 4; i++) this.addGap(`${key}_w${i}`, tyreGap(model.root, model.wheelGroups[i], model.wheelR, s));
      for (let i = 0; i < 4; i++) this.addGap(key, tyreGap(model.root, model.wheelGroups[i], model.wheelR, s));
    };
    wheelsOf(this.car, 'player', this.player.s);
    const out = (key: string, model: CarModel, veh: Vehicle) => {
      for (let i = 0; i < 4; i++) {
        const gp = tyreGap(model.root, model.wheelGroups[i], model.wheelR, veh.s);
        if (!veh.tel.airborne && (gp > 0.08 || gp < -0.08) && this.gapOutliers.length < 8) {
          this.syncCar(model, veh);
          const gp2 = tyreGap(model.root, model.wheelGroups[i], model.wheelR, veh.s);
          this.gapOutliers.push(`resync ${(gp2 * 1000).toFixed(1)}mm | ${key} w${i} gap ${(gp * 1000).toFixed(1)}mm s=${veh.s.toFixed(0)} d=${veh.d.toFixed(2)} v=${(veh.v * 3.6).toFixed(0)} crashed=${veh.crashed} off=${veh.offRoad} yaw=${(veh.yaw * 57.3).toFixed(0)} bank=${(road.bankAt(veh.s) * 57.3).toFixed(0)} RAW ${JSON.stringify({ s: veh.s, lane: veh.lane.d, yaw: veh.yaw })}`);
        }
      }
    };
    out('player', this.car, this.player);
    if (this.refCar && this.ghostVisible) out('ghost', this.refCar, this.ref);
    if (this.refCar && this.ghostVisible) wheelsOf(this.refCar, 'ghost', this.ref.s);
    for (const c of this.traffic.cars) for (const w of c.wheels) this.addGap('traffic', tyreGap(c.mesh, w, 0.33, c.s));
  }
  /** showroom pose: tyre bottoms against the floor plane y = 0 */
  sampleShowroomGaps() {
    this.poseShowroom();
    this.car.root.updateMatrixWorld(true);
    for (let i = 0; i < 4; i++) {
      const c = this.car.wheelGroups[i].getWorldPosition(new THREE.Vector3());
      this.addGap('showroom', c.y - this.car.wheelR);
    }
  }

  private render(dt: number) {
    if (this.mode === 'drive') {
      this.syncVisuals(false, this.paused ? 1 : this.acc / PHYS_DT);
      if (this.gapTracking) this.sampleGaps();
      this.rig3.update(this.player, dt);
      // camera
      const o = this.car.root.position;
      const f = new THREE.Vector3(1, 0, 0).applyQuaternion(this.car.root.quaternion);
      const l = new THREE.Vector3(0, 0, -1).applyQuaternion(this.car.root.quaternion);
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(this.car.root.quaternion);
      const wp = new THREE.Vector3();
      this.car.wheelGroups[0].getWorldPosition(wp);
      // Camera and car use the same interpolated pose.
      const pose = this.player.renderPose(this.paused ? 1 : this.acc / PHYS_DT);
      this.rig.update(dt, {
        pos: o.clone(), f, l, n,
        wheelPos: wp, speed: this.player.v, s: pose.s, d: pose.d,
        sideSign: this.ghostVisible && this.ref.d > this.player.d + 1 ? -1 : this.player.d > 1 ? -1 : 1,
      });
      // sun & sky follow
      this.sun.position.set(o.x - 45, o.y + 70, o.z - 55);
      this.sun.target.position.copy(o);
      this.sun.target.updateMatrixWorld();
      this.sky.position.copy(this.camera.position);
    } else {
      this.poseShowroom();
      this.rig3.update(this.player, dt);
      this.rig.orbit.update();
    }
    this.composer.render();
  }

  private setQuality(q: number) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    const pr = q >= 2 ? Math.min(dpr, 2) : q === 1 ? Math.min(dpr, 1.5) : 1;
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.smaa.enabled = q >= 2;
    this.bloom.enabled = q >= 1;
    this.onResize();
  }

  private updateQuality(dt: number) {
    if (!this.autoQuality || this.quality === 0) return;
    this.qualityClock += dt;
    if (this.qualityClock < 3) return;
    this.qualityClock = 0;
    if (this.fps > 0 && this.fps < 36) this.lowFpsChecks++; else this.lowFpsChecks = 0;
    if (this.lowFpsChecks >= 3) {
      this.lowFpsChecks = 0;
      this.setQuality(this.quality - 1);
      if (this.mode === 'drive') this.hud.toast(`帧率偏低，已自动降低画质 (等级 ${this.quality})`, 'warn');
    }
  }

  private onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  hudState(): HudState {
    const p = this.player;
    return {
      section: road.sectionAt(p.s).name,
      lapTime: this.lap.lapTime, bestLap: this.lap.bestLap, lastLap: this.lap.lastLap, penalty: this.lap.penalty, laps: this.lap.laps,
      kmh: Math.abs(p.v) * 3.6, powerKW: p.tel.powerKW, throttle: this.throttle, brake: this.brake,
      ayG: p.tel.ayG, axG: p.tel.axG, emb: p.opts.emb, active: p.opts.active, ghost: this.ghostVisible, xray: this.xray,
      cam: CAM_NAMES[this.rig.mode], paint: this.paint === 'lava' ? '熔岩黄' : '珍珠白', overspeed: this.overspeedLevel,
      advisedKmh: this.advised, crashed: p.crashed, inBrakeZone: this.scen.inBrakeZone(p.s), fps: this.fps,
    };
  }

  // ------------------------------------------------------------------ main loop
  start() {
    const loop = (now: number) => {
      const dtReal = Math.min(0.1, Math.max(0.0001, (now - (this.lastTime || now)) / 1000));
      this.lastTime = now;
      this.frame(dtReal);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(dt: number) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }
    if (this.mode === 'drive' && !this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 16) {
        this.simStep(PHYS_DT);
        this.acc -= PHYS_DT;
        steps++;
      }
      if (steps >= 16) this.acc %= PHYS_DT;
      this.handleImpacts();
      this.debris.update(dt);
      this.hud.update(this.hudState(), this.panelCtx(), dt);
    }
    this.updateQuality(dt);
    this.render(dt);
  }

  /** advance the simulation without rendering (automation / tests) */
  stepSeconds(sec: number) {
    const n = Math.round(sec / PHYS_DT);
    for (let i = 0; i < n; i++) {
      this.simStep(PHYS_DT);
      if (this.gapTracking && i % 2 === 0) {
        this.syncVisuals(true);
        this.sampleGaps();
      }
      if (this.player.impacts.length) this.handleImpacts();
    }
  }

  // ------------------------------------------------------------------ crash damage
  private tmpW = { o: new THREE.Vector3(), f: new THREE.Vector3(), l: new THREE.Vector3(), n: new THREE.Vector3() };

  /** turn the physics' barrier impacts into visible damage, debris, a bent rail and feedback */
  private handleImpacts() {
    this.ref.impacts.length = 0; // the ghost car only shows the reference run, it does not get damaged
    const list = this.player.impacts.splice(0);
    if (!list.length) return;
    this.syncCar(this.car, this.player);
    for (const im of list) this.applyImpact(im);
  }

  private applyImpact(im: Impact) {
    const torn = this.damage.apply(im);
    if (im.kind === 'barrier') this.track.bendArmco(im.s, im.side, im.railBend);
    for (const wi of im.detached) torn.push(this.damage.detachWheel(wi));
    // world-space contact point and velocities
    const w = this.tmpW;
    road.frame(im.s, 0, w.o, w.f, w.l, w.n);
    const at = this.car.root.localToWorld(new THREE.Vector3(im.x, 0.55, -im.yL));
    const intoTrack = w.f.clone().multiplyScalar(im.nS).addScaledVector(w.l, im.nD);
    const base = w.f.clone().multiplyScalar(0.85 * im.slideSpeed).addScaledVector(w.l, 0.2 * im.vD);
    const spray = intoTrack.multiplyScalar(1 + 0.35 * im.normalSpeed);
    for (const part of torn) {
      const v = base.clone().addScaledVector(spray, 0.5 + Math.random()).add(new THREE.Vector3(0, 2 + Math.random() * 3, 0));
      this.debris.addPart(part, v, im.s);
    }
    const n = Math.round(Math.min(40, Math.max(2, im.energyJ / 2500)));
    this.debris.spawnFragments(n, at, base, spray, im.energyJ > 25e3 ? [0, 1, 0, 1, 2] : [0, 1], im.s);
    const what = im.kind === 'car' ? '车辆' : '护栏';
    const wheelNames = ['左前', '右前', '左后', '右后'];
    if (im.detached.length) this.hud.toast(`${im.detached.map((i) => wheelNames[i]).join('、')}车轮脱落`, 'warn', 4000);
    if (im.wrecked) this.hud.toast(`严重撞击 · 车辆报废（吸收 ${(im.energyJ / 1000).toFixed(0)} kJ）`, 'warn', 4000);
    else if (im.energyJ > 15e3) this.notify(`撞击${what} · 车身受损（${(im.energyJ / 1000).toFixed(0)} kJ）`, 'warn');
    else this.notify(`擦碰${what}`, 'warn');
    // tell the driver what the damage does to the car
    const bent = this.player.wheelDmg.map((d, i) => ({ i, d })).filter((x) => !x.d.detached && Math.abs(x.d.toe) > 0.004);
    if (!this.player.crashed && bent.length) {
      const worst = bent.sort((a, b) => Math.abs(b.d.toe) - Math.abs(a.d.toe))[0];
      const deg = (Math.abs(worst.d.toe) * 57.3).toFixed(1);
      this.hud.toast(`${wheelNames[worst.i]}车轮受损 · 前束偏 ${deg}° · 方向会跑偏`, 'warn', 3500);
    }
  }
}

import { Vehicle } from '../src/physics/Vehicle';
import { road } from '../src/track/roadSurface';
import { CAR, PHYS_DT as dt } from '../src/config';

function assert(ok: boolean, msg: string) { if (!ok) throw new Error(msg); }
// A level, straight, dry proving ground isolates vehicle dynamics from track geometry.
road.base = () => 0; road.height = () => 0; road.bankAt = () => 0; road.curvature = () => 0;
function vehicle(speed = 0) { const v = new Vehicle({emb: false, active: false}); v.reset(100, 0, speed / 3.6); return v; }
const stop = vehicle();
for (let i = 0; i < 120; i++) stop.step(dt, {throttle:0, brake:0, steer:1});
assert(Math.abs(stop.d) < 1e-8, 'Steering must not translate a stationary car');
const turn = vehicle(100);
for (let i = 0; i < 36; i++) turn.step(dt, {throttle:0, brake:0, steer:0.5});
assert(turn.d > 0.02 && turn.yaw > 0, 'Held left steering must turn and move the car left');
const brakeResults = [];
for (const kmh of [100,200,300]) {
  const v = vehicle(kmh); let t = 0; let lockTime = 0;
  const initial = v.v;
  while (t < 15 && v.v > 0.05) {
    v.step(dt, {throttle:0, brake:1}); t += dt;
    if (v.v > 10 && v.slip.some(s => s > 0.8)) lockTime += dt;
  }
  assert(Math.abs(initial * 3.6 - kmh) < 0.01, 'Reset must preserve requested speed');
  assert(v.v < 0.05, `Must stop from ${kmh}`);
  assert(lockTime < 0.15, `ABS must recover without sustained lock: ${lockTime}`);
  const d = v.distance;
  if (kmh === 100) assert(d > 28 && d < 37, `Dry 100-0 stopping distance outside calibration range: ${d}`);
  for (let i = 0; i < 240; i++) v.step(dt, {throttle:0, brake:1});
  assert(v.v === 0, 'Brakes must hold at rest without wheel creep');
  brakeResults.push({kmh, metres:+d.toFixed(2), seconds:+t.toFixed(3), lockTime});
}
console.log({brakeResults, mass:CAR.mass});

// EMB concept: its slip controller must hold the target slip on every wheel (the lightly
// loaded rear axle used to limit-cycle between 3 % and 20 % slip) and stop within its
// latency budget of the hydraulic ABS, never far behind it.
const embStop = (() => {
  const v = new Vehicle({emb: true, active: false}); v.reset(100, 0, 200 / 3.6);
  let t = 0, rearMin = Infinity, rearMax = -Infinity;
  while (t < 15 && v.v > 0.05) {
    v.step(dt, {throttle:0, brake:1}); t += dt;
    if (t > 1 && v.v > 10) for (const i of [2, 3]) { rearMin = Math.min(rearMin, v.slip[i]); rearMax = Math.max(rearMax, v.slip[i]); }
  }
  return {metres: v.distance, seconds: t, rearMin, rearMax};
})();
const hydStop = (() => { const v = vehicle(200); while (v.v > 0.05) v.step(dt, {throttle:0, brake:1}); return v.distance; })();
assert(embStop.rearMin > 0.07 && embStop.rearMax < 0.15, `EMB rear slip must stay near target: ${embStop.rearMin.toFixed(3)}..${embStop.rearMax.toFixed(3)}`);
assert(embStop.metres < hydStop * 1.05, `EMB 200-0 (${embStop.metres.toFixed(1)} m) must be within 5 % of hydraulic (${hydStop.toFixed(1)} m)`);
console.log({embStop200:{metres:+embStop.metres.toFixed(1),seconds:+embStop.seconds.toFixed(2),rearSlip:[+embStop.rearMin.toFixed(3),+embStop.rearMax.toFixed(3)]},hydStop200:+hydStop.toFixed(1)});

// Armco impacts are rigid-body contacts with a compliant, elastic-plastic rail (src/physics/Barrier.ts).
{
  const { BODY_CORNERS } = await import('../src/physics/Barrier');
  const flatHeight = road.height;
  road.height = (s, d) => (Math.abs(d) > 9 ? -0.3 * (Math.abs(d) - 9) : 0); // terrain falls away behind the rail
  const ke = (v: Vehicle) => 0.5 * CAR.mass * (v.v ** 2 + v.lateralSpeed ** 2) + 0.5 * CAR.yawInertia * v.yawRate ** 2;
  const hit = (kmh: number, deg: number, seconds = 6) => {
    const v = vehicle(kmh), a = deg / 57.3;
    v.yaw = a; v.lane.d = 9 - 2.8 * Math.sin(a) - 1.03 * Math.cos(a) - 0.05; // a moment before the left rail
    const ke0 = ke(v); let keMax = 0, pen = 0, penFirst = 0, wreckedFirst = false, maxFloat = 0, minV = Infinity, vAt1s = 0, stopT = Infinity;
    for (let i = 0; i < seconds * 120; i++) {
      v.step(dt, {throttle:0, brake:0, steer:0});
      keMax = Math.max(keMax, ke(v));
      const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
      for (const [x, y] of BODY_CORNERS) pen = Math.max(pen, Math.abs(v.d + x * sy + y * cy) - 9);
      if (i < 180) { penFirst = pen; wreckedFirst = v.crashed; } // the first contact (a car with bent wheels drifts on afterwards)
      const ground = (v as unknown as { rPrev: number[] }).rPrev;
      maxFloat = Math.max(maxFloat, ...v.susp.u.map((u, k) => u - ground[k]));
      minV = Math.min(minV, v.v);
      if (i === 119) vAt1s = Math.hypot(v.v, v.lateralSpeed);
      if (stopT === Infinity && Math.hypot(v.v, v.lateralSpeed) < 0.5) stopT = i * dt;
    }
    return { v, ke0, keMax, pen, penFirst, wreckedFirst, maxFloat, minV, vAt1s, stopT };
  };
  const graze = hit(200, 3), angled = hit(120, 30), headOn = hit(60, 90, 2);
  assert(!graze.wreckedFirst && graze.vAt1s > 0.85 * 200 / 3.6 && graze.penFirst < 0.15, `A 3 deg graze at 200 km/h scrapes and carries on: ${graze.vAt1s.toFixed(1)} m/s, ${graze.penFirst.toFixed(2)} m`);
  assert(angled.v.crashed && angled.pen > 0.3 && angled.pen < 1.0 && angled.stopT < 5, `A 30 deg hit at 120 km/h wrecks the car a short way into the rail: ${angled.pen.toFixed(2)} m, stops ${angled.stopT.toFixed(1)} s`);
  const rebound = -headOn.minV / (60 / 3.6);
  assert(rebound > 0.1 && rebound < 0.35, `Head-on restitution must be car-like (0.1-0.35): ${rebound.toFixed(2)}`);
  for (const [name, r] of [['graze', graze], ['angled', angled], ['head-on', headOn]] as const) {
    assert(r.keMax <= r.ke0 * 1.001, `${name}: a barrier impact must never add kinetic energy (${(r.ke0 / 1e3).toFixed(0)} -> ${(r.keMax / 1e3).toFixed(0)} kJ)`);
    assert(r.maxFloat < 0.03, `${name}: wheels must not float past the Armco: ${r.maxFloat.toFixed(3)} m`);
  }
  // Spinning without a wall: the body-frame equations only exchange speed between the axes.
  const spin = vehicle(150); spin.yawRate = 4; let spinKe = ke(spin); const spin0 = spinKe;
  for (let i = 0; i < 360; i++) { spin.step(dt, {throttle:0, brake:0, steer:0}); spinKe = Math.max(spinKe, ke(spin)); }
  assert(spinKe <= spin0 * 1.001, `A spinning car must not gain kinetic energy: ${(spin0 / 1e3).toFixed(0)} -> ${(spinKe / 1e3).toFixed(0)} kJ`);
  road.height = flatHeight;
  console.log({barrier: {grazeKeepsMs: +graze.vAt1s.toFixed(1), grazePenM: +graze.penFirst.toFixed(2), angledPenM: +angled.pen.toFixed(2), angledStopS: +angled.stopT.toFixed(1), headOnRestitution: +rebound.toFixed(2), damageKJ: [graze, angled, headOn].map(r => +(r.v.damageJ / 1e3).toFixed(0))}});
}

// Wheel damage changes how the car drives; car-to-car contact is a momentum-conserving impulse.
{
  const THREE3 = await import('three');
  const { playerVsTraffic, TRAFFIC_BODY, Traffic } = await import('../src/game/Traffic');
  type TC = import('../src/game/Traffic').TrafficCar;
  const hands = (v: Vehicle, secs: number, throttle = 0.25) => { for (let i = 0; i < secs * 120; i++) v.step(dt, {throttle, brake:0, steer:0}); };
  // a 1 deg toe on the right-front wheel pulls the car left (toe + = points left) but leaves it drivable
  const toed = vehicle(100);
  toed.wheelDmg[1].toe = 1 / 57.3; toed.damageWheels(0, 0, 0, 0, 0); // zero-energy call refreshes the damage state
  hands(toed, 1.5);
  assert(toed.d > 0.8 && toed.d < 4 && !toed.undrivable && !toed.crashed, `A 1 deg toe must pull the car without disabling it: ${toed.d.toFixed(2)} m`);
  // a big hit right at a wheel tears it off: that corner drops onto its upright and drags the car round
  const off = vehicle(100); const lost = off.damageWheels(1.56, -1.03, 0, 1, 150e3);
  let drop = 0; for (let i = 0; i < 600; i++) { off.step(dt, {throttle:1, brake:0, steer:0}); drop = Math.min(drop, off.susp.q - off.susp.phi * 0.863 - off.susp.theta * 1.56); }
  assert(lost.includes(1) && off.undrivable && off.crashed, 'A 150 kJ hit at the right-front wheel must tear it off and disable the car');
  assert(-drop > 0.12 && -drop < 0.3 && off.d < -0.5 && off.v < 2 && [off.v, off.d, off.yaw].every(Number.isFinite), `Missing wheel: corner drop ${(-drop).toFixed(2)} m, dragged to d=${off.d.toFixed(1)}, v=${off.v.toFixed(1)}`);
  // car to car
  const tcar = (s: number, d: number, kmh: number): TC => ({ s, d, v: kmh / 3.6, mesh: new THREE3.Group(), wheels: [], hitTimer: 0, yaw: 0, w: 0, r: 0, lane: d, cruiseV: kmh / 3.6, mode: 'cruise', damageJ: 0, touching: false, pendingJ: 0 });
  const traffic = Object.create(Traffic.prototype) as InstanceType<typeof Traffic>;
  const mom = (v: Vehicle, c: TC) => { const [a, b] = v.roadVelocity(); return [CAR.mass * a + TRAFFIC_BODY.m * (c.v * Math.cos(c.yaw) - c.w * Math.sin(c.yaw)), CAR.mass * b + TRAFFIC_BODY.m * (c.v * Math.sin(c.yaw) + c.w * Math.cos(c.yaw))]; };
  const crash = (v: Vehicle, c: TC, secs: number) => {
    (traffic as unknown as { cars: TC[]; cones: unknown[] }).cars = [c]; (traffic as unknown as { cones: unknown[] }).cones = [];
    let momErr = -1, rP = 0, rC = 0, e = 0;
    for (let i = 0; i < secs * 120; i++) {
      v.step(dt, {throttle:0, brake:0, steer:0}); traffic.update(dt);
      const m0 = mom(v, c); const hit = playerVsTraffic(v, c, c.s - v.s);
      if (hit && momErr < 0) { const m1 = mom(v, c); momErr = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) / Math.hypot(...m0); e = hit.energyJ; }
      rP = Math.max(rP, Math.abs(v.yawRate)); rC = Math.max(rC, Math.abs(c.r));
      if (momErr >= 0 && i > 60 && Math.abs(v.d) > 7) break; // stop before barrier hits muddy the comparison
    }
    return { momErr, rP, rC, e };
  };
  const rear = crash(vehicle(150), tcar(100 + 7.2, 0, 100), 1);
  assert(rear.momErr >= 0 && rear.momErr < 1e-9 && rear.e > 1e3, `Rear-end impact must conserve momentum: err ${rear.momErr}`);
  assert(rear.rP < 0.2 && rear.rC < 0.2, `A square rear-end pushes straight (no spin): ${(rear.rP * 57.3).toFixed(0)} / ${(rear.rC * 57.3).toFixed(0)} deg/s`);
  const pit = crash(vehicle(140), tcar(100 + 7.0, -1.7, 100), 1.2);
  assert(pit.rC > 1.0, `Hitting a car's rear corner spins it: ${(pit.rC * 57.3).toFixed(0)} deg/s`);
  const side = vehicle(150); const sc = tcar(100 - 1.6, 2.3, 150); sc.mode = 'loose'; sc.w = -8; sc.yaw = -0.15;
  const sideHit = crash(side, sc, 1.5);
  assert(sideHit.rP > 1.5, `A hard hit on the rear quarter can make the player lose control: ${(sideHit.rP * 57.3).toFixed(0)} deg/s`);
  console.log({wheelsAndCars: {toePullM: +toed.d.toFixed(2), wheelOffDropM: +(-drop).toFixed(2), wheelOffDraggedToD: +off.d.toFixed(1), rearEndKJ: +(rear.e / 1e3).toFixed(1), rearEndSpinDegS: +(Math.max(rear.rP, rear.rC) * 57.3).toFixed(1), pitSpinDegS: +(pit.rC * 57.3).toFixed(0), sideHitPlayerSpinDegS: +(sideHit.rP * 57.3).toFixed(0)}});
}

// Left/right symmetry, short taps, reversal and release: use actual steering input.
for (const speed of [5, 20, 100, 200, 300, 350]) {
  const left = vehicle(speed), right = vehicle(speed);
  for (let i = 0; i < 60; i++) {
    const input = i < 12 ? 0.6 : i < 24 ? -0.6 : 0;
    left.step(dt, {throttle:0, brake:0, steer:input});
    right.step(dt, {throttle:0, brake:0, steer:-input});
    assert([left.v,left.d,left.yaw,left.yawRate,left.susp.q,...left.susp.ft].every(Number.isFinite), `Finite dynamics at ${speed}`);
    assert(Math.abs(left.d + right.d) < 0.015, `Symmetric steering at ${speed}`);
  }
  assert(Math.abs(left.steerAngle) < 0.002, `Steering must return at ${speed}`);
  assert(Math.abs(left.d) < 1, `Short corrections must stay below one metre at ${speed}`);
  assert(!left.crashed, `Short corrections must remain controllable at ${speed}`);
}

// Braking force grows with pedal, settles at rest, and tolerates simultaneous steering.
const pedalStops: number[] = [];
for (const pedal of [0.25,0.5,1]) {
  const v = vehicle(100);
  for (let i = 0; i < 1800 && v.v > 0.05; i++) v.step(dt,{throttle:0,brake:pedal});
  pedalStops.push(v.distance);
}
assert(pedalStops[0] > pedalStops[1] && pedalStops[1] > pedalStops[2], 'Pedal must progressively increase braking');
const combined = vehicle(200);
for (let i=0;i<120;i++) combined.step(dt,{throttle:0,brake:1,steer:i<30?0.2:0});
assert(!combined.crashed && Number.isFinite(combined.yaw) && combined.v < 200/3.6-8,'Steering while braking must remain bounded');

// No idle oscillation or creep after high-speed stops; reset must discard all history.
const reused = vehicle(300);
for (let i=0;i<120;i++) reused.step(dt,{throttle:0,brake:0.7,steer:0.1});
reused.reset(100,0,100/3.6);
const fresh = vehicle(100);
for (let i=0;i<240;i++) {
  reused.step(dt,{throttle:0,brake:0.5}); fresh.step(dt,{throttle:0,brake:0.5});
  assert(Math.abs(reused.v-fresh.v)<1e-9 && Math.abs(reused.susp.q-fresh.susp.q)<1e-9,'Reset reproducibility');
}

// Variable refresh-rate render timeline must interpolate, not staircase at physics Hz.
const renderResults = [];
for (const rate of [30,60,144,165]) {
  const v = vehicle(300); let accumulator=0, time=0, last=0, lastTime=0; let maxSpeedError=0;
  for (let frame=0;frame<rate*2;frame++) {
    const frameDt = (1 + (frame%2 ? 0.12 : -0.12))/rate;
    accumulator += frameDt; time += frameDt;
    while(accumulator>=dt) { v.step(dt,{throttle:0,brake:0}); accumulator-=dt; }
    const pose=v.renderPose(accumulator/dt);
    if(frame>2) {
      const apparentSpeed=(pose.s-last)/(time-lastTime);
      maxSpeedError=Math.max(maxSpeedError,Math.abs(apparentSpeed-v.v));
    }
    last=pose.s; lastTime=time;
  }
  assert(maxSpeedError<0.1, `Render jumps at ${rate} Hz: ${maxSpeedError}`);
  renderResults.push({hz:rate,maxSpeedError:+maxSpeedError.toFixed(4)});
}
const wrap = vehicle(300); wrap.reset(road.length-0.2,0,300/3.6); wrap.step(dt,{throttle:0,brake:0});
assert(wrap.renderPose(0.5).s<2 || wrap.renderPose(0.5).s>road.length-2,'Interpolation across finish line');
console.log({pedalStops,renderResults,checks:'steering, braking, reset, interpolation passed'});

// Exercise the actual chase camera with irregular frame times (no WebGL required).
const { CameraRig } = await import('../src/camera/CameraRig');
const THREE = await import('three');
const events = { addEventListener() {}, removeEventListener() {} };
const dom = { ...events, style: {}, getRootNode: () => events } as unknown as HTMLElement;
const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 4000);
const cameraRig = new CameraRig(camera, dom);
let x = 0, minOffset = Infinity, maxOffset = -Infinity;
for (let i=0;i<240;i++) {
  const frameDt = i%2 ? 1/40 : 1/100;
  x += 300/3.6*frameDt;
  cameraRig.update(frameDt,{pos:new THREE.Vector3(x,0,0),f:new THREE.Vector3(1,0,0),l:new THREE.Vector3(0,0,-1),n:new THREE.Vector3(0,1,0),wheelPos:new THREE.Vector3(x,0,0),speed:300/3.6,s:x,d:0});
  minOffset=Math.min(minOffset,x-camera.position.x); maxOffset=Math.max(maxOffset,x-camera.position.x);
}
cameraRig.orbit.dispose();
assert(maxOffset-minOffset<1e-8,`Camera must not oscillate behind a steady car: ${maxOffset-minOffset}`);
console.log({chaseCameraOffsetVariation:maxOffset-minOffset});

// Suspension settles after aero load and a road disturbance, rather than sustaining shake.
road.height = (s) => 0.012 * Math.exp(-(((s - 200) / 1.5) ** 2));
const bump = vehicle(300); let peak = 0, tail = 0;
for(let i=0;i<600;i++) {
  bump.step(dt,{throttle:0,brake:0});
  peak = Math.max(peak,Math.abs(bump.susp.q));
  if(i>480) tail=Math.max(tail,Math.abs(bump.susp.qd));
  assert([bump.susp.q,bump.susp.phi,bump.susp.theta,...bump.susp.u].every(Number.isFinite),'Suspension must stay finite after a high-speed bump');
}
assert(peak<0.1 && tail<0.002,'High-speed suspension must settle after a bump');
const {SuspensionModel} = await import('../src/physics/Suspension');
const separated = new SuspensionModel();
separated.step(dt/2,{r:[-0.1,-0.1,-0.1,-0.1],rd:[40,40,40,40],gn:9.81,ay:0,ax:0,dfFront:0,dfRear:0,actCmd:[0,0,0,0]});
assert(separated.ft.every(f=>f===0),'Tyre damping must not create force across an air gap');
console.log({highSpeedBumpPeakHeaveMm:peak*1000,settledHeaveVelocity:tail});

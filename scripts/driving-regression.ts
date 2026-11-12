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

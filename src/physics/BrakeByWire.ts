// 48 V electro-mechanical brake (EMB, brake-by-wire):
//  * ~80 ms pedal-to-clamp latency, linear fast force build-up
//  * every wheel has its own motor-caliper: ideal axle/side distribution from live wheel loads
//  * fine, high-rate (100 Hz) slip-controller keeps slip around 10-12 %
//  * brake torque vectoring during lane changes
import { CAR } from '../config';
import { BrakeSystem, BrakeInput, DelayLine, T_MAX } from './BrakeBase';
import { PHYS_DT } from '../config';

export class BrakeByWire extends BrakeSystem {
  readonly name = '48V 线控制动 (EMB)';
  readonly short = 'EMB';
  readonly nominalDelayMs = 80;
  private delay = [0, 1, 2, 3].map(() => new DelayLine(PHYS_DT / 2, 0.3));
  private lag = [0, 0, 0, 0];
  private cap = [Infinity, Infinity, Infinity, Infinity];
  private absTimer = 0;
  private fzF = [5500, 5500, 5900, 5900];
  readonly dead = 0.073; // s
  readonly tau = 0.012; // s
  readonly absHz = 100;
  readonly slipTarget = 0.11;

  reset() {
    this.delay.forEach((d) => d.fill(0));
    this.lag.fill(0);
    this.cap.fill(Infinity);
    this.torque.fill(0);
    this.request.fill(0);
    this.absActive.fill(false);
    this.tvTorque.fill(0);
    this.wasIdle = true; this.absTimer = 0;
    this.fzF = [5500, 5500, 5900, 5900];
    this.hasResponse = false; this.responseMs = 0;
    this.measuring = false; this.tReqCross = this.tAppCross = -1;
  }

  update(inp: BrakeInput) {
    const { dt, pedal } = inp;
    // filtered wheel load for ideal distribution
    let sumFz = 0;
    for (let i = 0; i < 4; i++) {
      this.fzF[i] += (Math.max(inp.fz[i], 1500) - this.fzF[i]) * Math.min(1, dt * 12);
      sumFz += this.fzF[i];
    }
    const demand = pedal * 1.55 * CAR.mass * 9.81 * CAR.wheelRadius; // total torque demand
    for (let i = 0; i < 4; i++) {
      this.request[i] = Math.min(T_MAX[i], demand * (this.fzF[i] / sumFz));
      this.delay[i].push(this.request[i]);
    }
    // ABS controller at 100 Hz
    this.absTimer += dt;
    const tick = 1 / this.absHz;
    if (this.absTimer >= tick) {
      this.absTimer -= tick;
      for (let i = 0; i < 4; i++) {
        const slip = inp.slip[i];
        const delayed = this.delay[i].read(this.dead);
        if (!this.absActive[i]) {
          if (slip > 0.125 && inp.speed > 3 && delayed > 200) {
            this.absActive[i] = true;
            this.cap[i] = this.lag[i] * 0.85;
          }
        } else {
          const e = slip - this.slipTarget;
          this.cap[i] -= 2600 * e;
          if (slip > 0.2) this.cap[i] *= 0.9;
          this.cap[i] = Math.max(0, Math.min(this.cap[i], T_MAX[i] * 1.2));
          if (delayed < this.cap[i] * 0.7 || inp.speed < 2) {
            this.absActive[i] = false;
            this.cap[i] = Infinity;
          }
        }
      }
    }
    // torque vectoring: brake the inside wheels during lateral transitions
    const tvMag = Math.min(1, Math.abs(inp.tv));
    for (let i = 0; i < 4; i++) {
      const left = i % 2 === 0;
      const inside = inp.tv > 0 ? left : !left;
      this.tvTorque[i] += ((inside ? tvMag * (i < 2 ? 380 : 280) : 0) - this.tvTorque[i]) * Math.min(1, dt * 30);
    }
    // apply
    const k = 1 - Math.exp(-dt / this.tau);
    for (let i = 0; i < 4; i++) {
      let target = Math.min(this.delay[i].read(this.dead), this.cap[i]);
      target += this.tvTorque[i];
      this.lag[i] += (target - this.lag[i]) * k;
      this.torque[i] = Math.max(0, this.lag[i]);
    }
    this.measure(inp);
  }
}

import { CAR } from '../config';

export class DelayLine {
  private buf: Float64Array;
  private head = 0;
  private count = 0;
  constructor(private dt: number, maxDelay: number) {
    this.buf = new Float64Array(Math.ceil(maxDelay / dt) + 4);
  }
  push(v: number) {
    this.head = (this.head + 1) % this.buf.length;
    this.buf[this.head] = v;
    this.count = Math.min(this.count + 1, this.buf.length);
  }
  /** value `delay` seconds ago (linear interpolation) */
  read(delay: number): number {
    const n = delay / this.dt;
    const i0 = Math.floor(n);
    const f = n - i0;
    const get = (k: number) => {
      if (k >= this.count) return this.buf[(this.head - (this.count - 1) + this.buf.length * 2) % this.buf.length];
      return this.buf[(this.head - k + this.buf.length * 2) % this.buf.length];
    };
    return get(i0) * (1 - f) + get(i0 + 1) * f;
  }
  fill(v: number) {
    this.buf.fill(v);
    this.count = this.buf.length;
  }
}

export interface BrakeInput {
  dt: number;
  time: number;
  pedal: number; // 0..1
  speed: number;
  omega: number[];
  slip: number[]; // braking slip ratio (+ when braking)
  fz: number[];
  /** -1..1 torque-vectoring demand (+ = moving/turning left) */
  tv: number;
}

export const T_MAX = [4800, 4800, 3300, 3300]; // N m per wheel

/** Common bookkeeping: per-wheel request/applied torque, response-time measurement. */
export abstract class BrakeSystem {
  abstract readonly name: string;
  abstract readonly short: string;
  abstract readonly nominalDelayMs: number;
  torque = [0, 0, 0, 0]; // applied
  request = [0, 0, 0, 0]; // requested (post distribution, pre delay)
  absActive = [false, false, false, false];
  responseMs = 0;
  hasResponse = false;
  tvTorque = [0, 0, 0, 0];
  protected tReqCross = -1;
  protected tAppCross = -1;
  protected wasIdle = true;
  protected measuring = false;
  protected pedalOnset = 0;

  abstract update(inp: BrakeInput): void;
  abstract reset(): void;

  protected measure(inp: BrakeInput) {
    const sumReq = this.request.reduce((a, b) => a + b, 0);
    const sumApp = this.torque.reduce((a, b) => a + b, 0);
    const lvl = 0.4 * T_MAX.reduce((a, b) => a + b, 0) * Math.min(1, 1);
    if (inp.pedal < 0.02) {
      this.wasIdle = true;
      this.measuring = false;
      this.tReqCross = this.tAppCross = -1;
      return;
    }
    if (this.wasIdle && inp.pedal >= 0.02) {
      this.wasIdle = false;
      this.measuring = true;
      this.tReqCross = this.tAppCross = -1;
    }
    if (!this.measuring) return;
    if (this.tReqCross < 0 && sumReq >= lvl) this.tReqCross = inp.time;
    if (this.tReqCross >= 0 && this.tAppCross < 0 && sumApp >= lvl) {
      this.tAppCross = inp.time;
      this.responseMs = (this.tAppCross - this.tReqCross) * 1000;
      this.hasResponse = true;
      this.measuring = false;
    }
  }

  /** brake force at the tyre contact per wheel [N] */
  forces(): number[] {
    return this.torque.map((t) => t / CAR.wheelRadius);
  }
}

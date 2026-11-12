// Modern hydraulic service brake approximation: pressure lag, load-sensitive EBD and
// continuous ABS slip regulation. Coefficients are estimates, not Xiaomi controller data.
import { BrakeSystem, BrakeInput, T_MAX } from './BrakeBase';
import { CAR, G } from '../config';

export class HydraulicBrake extends BrakeSystem {
  readonly name = '液压制动 + ABS / EBD';
  readonly short = '液压';
  readonly nominalDelayMs = 60;
  private pressure = 0;

  reset() {
    this.pressure = 0;
    this.torque.fill(0); this.request.fill(0); this.absActive.fill(false); this.tvTorque.fill(0);
    this.wasIdle = true; this.hasResponse = false; this.responseMs = 0;
    this.measuring = false; this.tReqCross = this.tAppCross = -1;
  }

  update(inp: BrakeInput) {
    const pedal = Math.max(0, Math.min(1, inp.pedal));
    this.pressure += (pedal - this.pressure) * (1 - Math.exp(-inp.dt / (pedal > this.pressure ? 0.06 : 0.035)));
    const totalLoad = Math.max(1, inp.fz.reduce((sum, f) => sum + f, 0));
    const demand = 1.5 * CAR.mass * G * CAR.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const share = Math.max(0, inp.fz[i]) / totalLoad;
      this.request[i] = Math.min(T_MAX[i], pedal * demand * share);
      const requested = Math.min(T_MAX[i], this.pressure * demand * share);
      // The feed-forward limit follows wheel load, feedback releases on excess slip.
      const gripTorque = CAR.tireMu * Math.max(0, inp.fz[i]) * CAR.wheelRadius;
      const cap = gripTorque * Math.max(0, Math.min(1.06, 0.99 + 3 * (0.12 - inp.slip[i])));
      const regulate = inp.speed > 2 && requested > cap;
      this.absActive[i] = regulate && pedal > 0.01;
      this.torque[i] = Math.max(0, regulate ? cap : requested);
    }
    this.measure(inp);
  }
}

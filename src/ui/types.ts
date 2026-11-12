import type { Vehicle } from '../physics/Vehicle';
import type { Scenarios } from '../game/Scenarios';

export interface BrakeEvent {
  active: boolean;
  done: boolean;
  v0: number; // km/h
  dist: number;
  time: number;
  system: string;
}

export interface PanelCtx {
  player: Vehicle;
  ref: Vehicle; // always simulated passive + hydraulic reference ("ghost")
  ghostVisible: boolean;
  brakeEv: { player: BrakeEvent; ref: BrakeEvent };
  scen: Scenarios;
  pedal: number;
}
